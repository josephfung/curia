// skills/async-offramp/handler.ts
//
// Voice → async coordinator handoff (#1614 / ADR-038 gate #3).
//
// Voice-only tool: advertised by the voice tool bridge (src/index.ts), NOT
// pinned on the coordinator. The coordinator is the async *destination* — pinning
// here would let text turns (and off-ramped tasks) call it recursively.
// allowed_callers stays ["coordinator"] because the bridge invokes with
// agentId: 'coordinator'; the channelId === 'voice' guard is the real gate.
//
// Voice bypasses normal inbound→coordinator dispatch (dispatcher.ts skips
// channelId === 'voice'). When a live-call request exceeds the slim brain's
// scope, this tool re-enters the normal path by publishing a coordinator
// agent.task directly (impersonating the dispatch layer, same as delegate).
//
// The async task deliberately does NOT forward liveTurn — crossing the async
// boundary must not preserve the elevated self-approval signal (#1126).
// channelId is 'internal' so agent.response is not auto-relayed to voice TTS;
// the coordinator reaches the principal via signal-send / email-send using
// the injected Principal Contact Details block.
//
// Idempotent: a process-local map keyed by (conversation + brief + channel)
// returns the prior task_event_id on retry instead of spawning duplicates.

import { createHash, randomUUID } from 'node:crypto';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';

const FOLLOW_UP_CHANNELS = new Set(['signal', 'email']);
const DEFAULT_FOLLOW_UP = 'email';
/**
 * Last-resort sender when originator and caller are both missing.
 * Same synthetic principal id the voice runtime / web chat use
 * (`DEFAULT_SENDER_ID` in voice-runtime.ts) — voice is principal-only today
 * (#1598), so attributing to that identity is safer than inventing a new one
 * or refusing a handoff the principal already agreed to.
 */
const FALLBACK_PRINCIPAL_SENDER_ID = 'ceo-web-user';
/** Cap the in-process dedup map so a long-lived process cannot grow without bound. */
const MAX_DEDUP_ENTRIES = 5_000;

interface DedupEntry {
  taskEventId: string;
  followUpChannel: string;
}

/** Module-scoped so duplicate tool calls in the same process hit the same map.
 *  Process restart clears it — a re-offramp after restart is rare for voice and
 *  at worst schedules one extra coordinator task the principal can ignore. */
const enqueuedByKey = new Map<string, DedupEntry>();

function normalizeBrief(brief: string): string {
  return brief.trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveFollowUpChannel(raw: unknown): string | { error: string } {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FOLLOW_UP;
  if (typeof raw !== 'string') {
    return { error: "follow_up_channel must be 'signal' or 'email'" };
  }
  const normalized = raw.trim().toLowerCase();
  if (!FOLLOW_UP_CHANNELS.has(normalized)) {
    return { error: "follow_up_channel must be 'signal' or 'email'" };
  }
  return normalized;
}

function buildIdempotencyKey(
  conversationId: string | undefined,
  brief: string,
  followUpChannel: string,
  explicitKey: string | undefined,
): string {
  // Always scope to conversation — an LLM-supplied key like "deck" must not
  // collide across sessions (CodeRabbit #1617).
  if (explicitKey) {
    return `explicit:${conversationId ?? 'unknown'}|${explicitKey}`;
  }
  const material = `${conversationId ?? 'unknown'}|${normalizeBrief(brief)}|${followUpChannel}`;
  return createHash('sha256').update(material).digest('hex');
}

function rememberDedup(key: string, entry: DedupEntry): void {
  if (enqueuedByKey.has(key)) enqueuedByKey.delete(key);
  enqueuedByKey.set(key, entry);
  while (enqueuedByKey.size > MAX_DEDUP_ENTRIES) {
    const oldest = enqueuedByKey.keys().next().value;
    if (oldest === undefined) break;
    enqueuedByKey.delete(oldest);
  }
}

/** Build the coordinator task content — clear provenance + follow-up instruction. */
function buildTaskContent(brief: string, followUpChannel: string, sourceConversationId: string | undefined): string {
  const channelSkill = followUpChannel === 'signal' ? 'signal-send' : 'email-send';
  const source = sourceConversationId ?? '(unknown voice conversation)';
  return [
    'Voice async off-ramp — the principal asked you during a live voice call to handle',
    'the following asynchronously. Complete the work, then reach the principal on',
    `${followUpChannel} using ${channelSkill} and their Principal Contact Details.`,
    'Do not try to reply on the voice channel.',
    '',
    '## Brief',
    brief.trim(),
    '',
    `## Follow-up channel: ${followUpChannel}`,
    `## Source voice conversation: ${source}`,
  ].join('\n');
}

/** Exported for tests — clears the process-local dedup map between cases. */
export function resetAsyncOfframpDedupForTests(): void {
  enqueuedByKey.clear();
}

export class AsyncOfframpHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // Voice-only backstop: not pinned on the coordinator, but discovery could
    // otherwise resurface it to a text turn (allowed_callers includes coordinator).
    // Reject anything that isn't a live voice channel invocation.
    if (ctx.channelId !== 'voice') {
      ctx.log.warn(
        { channelId: ctx.channelId, agentId: ctx.agentId },
        'async-offramp rejected — voice-only tool (not available on text/async turns)',
      );
      return {
        success: false,
        error: 'async-offramp is voice-only — use the normal coordinator path for async work',
      };
    }

    if (!ctx.bus) {
      return { success: false, error: 'async-offramp requires bus capability — handoff unavailable' };
    }

    const input = (ctx.input ?? {}) as Record<string, unknown>;
    const briefRaw = input.brief;
    if (typeof briefRaw !== 'string' || !briefRaw.trim()) {
      return { success: false, error: 'Missing required input: brief (string)' };
    }
    const brief = briefRaw.trim();

    const channelResult = resolveFollowUpChannel(input.follow_up_channel);
    if (typeof channelResult === 'object') {
      return { success: false, error: channelResult.error };
    }
    const followUpChannel = channelResult;

    const explicitKey =
      typeof input.idempotency_key === 'string' && input.idempotency_key.trim()
        ? input.idempotency_key.trim()
        : undefined;
    const idempotencyKey = buildIdempotencyKey(
      ctx.conversationId,
      brief,
      followUpChannel,
      explicitKey,
    );

    const prior = enqueuedByKey.get(idempotencyKey);
    if (prior) {
      ctx.log.info(
        {
          taskEventId: prior.taskEventId,
          followUpChannel: prior.followUpChannel,
          idempotencyKey,
          briefPreview: brief.slice(0, 80),
        },
        'voice off-ramped to async (deduplicated — prior enqueue reused)',
      );
      return {
        success: true,
        data: {
          accepted: true,
          task_event_id: prior.taskEventId,
          follow_up_channel: prior.followUpChannel,
          deduplicated: true,
          note: 'Already handed to async coordinator path; principal will be reached when done.',
        },
      };
    }

    const originator = ctx.taskMetadata?.originator as
      | { contactId?: string; systemRole?: string; channel?: string; initiatedAt?: string; tier?: string }
      | undefined;
    const senderId =
      originator?.contactId ??
      ctx.caller?.contactId ??
      FALLBACK_PRINCIPAL_SENDER_ID;

    const parentEventId = ctx.taskEventId ?? `async-offramp-${randomUUID()}`;
    const conversationId = `voice-offramp:${idempotencyKey.slice(0, 32)}`;

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId,
      channelId: 'internal',
      senderId,
      content: buildTaskContent(brief, followUpChannel, ctx.conversationId),
      metadata: {
        voiceOfframp: true,
        followUpChannel,
        sourceVoiceConversationId: ctx.conversationId,
        sourceVoiceSessionId: ctx.taskMetadata?.['voiceSessionId'],
        brief,
        idempotencyKey,
        ...(originator ? { originator } : {}),
      },
      // Deliberately omit liveTurn — async boundary (#1126).
      parentEventId,
    });

    // Claim before publish so a concurrent duplicate cannot enqueue twice.
    // Roll back on publish failure so an honest retry can succeed.
    rememberDedup(idempotencyKey, {
      taskEventId: taskEvent.id,
      followUpChannel,
    });

    try {
      // Publish as 'dispatch' — only dispatch/system may publish agent.task
      // (permissions.ts). Infrastructure skills are trusted to impersonate.
      await ctx.bus.publish('dispatch', taskEvent);
    } catch (err) {
      enqueuedByKey.delete(idempotencyKey);
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error(
        { err, briefPreview: brief.slice(0, 80), followUpChannel },
        'voice async off-ramp enqueue failed — do not confirm follow-up to principal',
      );
      return {
        success: false,
        error: `Failed to hand off to async path: ${message}`,
      };
    }

    ctx.log.info(
      {
        taskEventId: taskEvent.id,
        followUpChannel,
        idempotencyKey,
        sourceConversationId: ctx.conversationId,
        briefPreview: brief.slice(0, 80),
      },
      'voice off-ramped work to async coordinator',
    );

    return {
      success: true,
      data: {
        accepted: true,
        task_event_id: taskEvent.id,
        follow_up_channel: followUpChannel,
        deduplicated: false,
        note: 'Handed to async coordinator path; principal will be reached when done.',
      },
    };
  }
}
