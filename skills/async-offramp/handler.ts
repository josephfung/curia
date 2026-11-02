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
// the coordinator reaches the principal via signal-send / email-send with
// "principal" as the recipient (#2033).
//
// Idempotent: a process-local map keyed by (conversation + brief + channel)
// returns the prior task_event_id on retry instead of spawning duplicates.
//
// Two modes (#2428). after_call (the default) is the original fire-and-forget
// hand-off. now waits a bounded time for the coordinator's reply and returns it
// for the call to speak. A reply that misses the wait (the limit, or the caller
// talking) is forwarded to the principal by a second coordinator task, so the
// work is never silently dropped.

import { createHash, randomUUID } from 'node:crypto';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import type { AgentResponseEvent, BusEvent } from '../../src/bus/events.js';
import { principalSendTool, REACH_CHANNELS, type ReachChannel } from '../../src/agents/principal-reach.js';

/**
 * A follow-up goes on the channel the caller named, or else the principal's usual
 * one: the coordinator's "Reaching the principal" block orders the configured
 * channels and honours standing preferences. Hard-coding Signal or email here
 * would ignore both.
 */
type FollowUpChannel = ReachChannel | null;
/**
 * Last-resort sender when originator and caller are both missing.
 * Same synthetic principal id the voice runtime / web chat use
 * (`DEFAULT_SENDER_ID` in voice-runtime.ts) — voice is principal-only today
 * (#1598), so attributing to that identity is safer than inventing a new one
 * or refusing a handoff the principal already agreed to.
 */
const FALLBACK_PRINCIPAL_SENDER_ID = 'ceo-web-user';
const MODES = new Set(['now', 'after_call']);
type Mode = 'now' | 'after_call';
/** How long a now hand-off holds the call before it turns into a follow-up. */
export const NOW_MODE_WAIT_MS = 60_000;
/** A reply later than this is not forwarded; the listener stops (the bus has no unsubscribe). */
const LATE_FORWARD_WINDOW_MS = 30 * 60_000;
/** Cap the in-process dedup map so a long-lived process cannot grow without bound. */
const MAX_DEDUP_ENTRIES = 5_000;

interface DedupEntry {
  taskEventId: string;
  followUpChannel: FollowUpChannel;
}

/** Module-scoped so duplicate tool calls in the same process hit the same map.
 *  Process restart clears it — a re-offramp after restart is rare for voice and
 *  at worst schedules one extra coordinator task the principal can ignore. */
const enqueuedByKey = new Map<string, DedupEntry>();

function normalizeBrief(brief: string): string {
  return brief.trim().replace(/\s+/g, ' ').toLowerCase();
}

const CHANNEL_ERROR = `follow_up_channel must be one of ${REACH_CHANNELS.join(', ')}, or left out for the principal's usual channel`;

function resolveFollowUpChannel(raw: unknown): FollowUpChannel | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return { error: CHANNEL_ERROR };
  const normalized = raw.trim().toLowerCase();
  const channel = REACH_CHANNELS.find((candidate) => candidate === normalized);
  return channel ?? { error: CHANNEL_ERROR };
}

function resolveMode(raw: unknown): Mode | { error: string } {
  if (raw === undefined || raw === null || raw === '') return 'after_call';
  if (typeof raw === 'string' && MODES.has(raw.trim().toLowerCase())) return raw.trim().toLowerCase() as Mode;
  return { error: "mode must be 'now' or 'after_call'" };
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

/** How the coordinator should reach the principal with the result. */
function reachInstruction(followUpChannel: FollowUpChannel): string {
  return followUpChannel
    ? `on ${followUpChannel} with ${principalSendTool(followUpChannel)}, passing "principal" as the recipient.`
    : 'the way your "Reaching the principal" section says, passing "principal" as the recipient.';
}

/** How the call tells the caller the result will arrive. */
function spokenChannel(followUpChannel: FollowUpChannel): string {
  return followUpChannel ? `by ${followUpChannel}` : 'afterwards';
}

/** Build the coordinator task content — clear provenance + follow-up instruction. */
function buildTaskContent(
  brief: string,
  followUpChannel: FollowUpChannel,
  sourceConversationId: string | undefined,
  mode: Mode,
): string {
  const source = sourceConversationId ?? '(unknown voice conversation)';
  const opening = mode === 'now'
    ? [
      'Voice hand-off — the principal is still on the call and waiting while you do the',
      'following. Do the work now with your full tools, then reply in two or three plain',
      'sentences saying what you did and what happened; your reply is read to the principal',
      'on the call. Do not message the principal about this yourself: if the reply misses',
      'the call, the platform forwards it.',
    ]
    : [
      'Voice async off-ramp — the principal asked you during a live voice call to handle',
      'the following asynchronously. Complete the work, then reach the principal',
      reachInstruction(followUpChannel),
      'Do not try to reply on the voice channel.',
    ];
  return [
    ...opening,
    '',
    '## Brief',
    brief.trim(),
    '',
    `## Follow-up channel: ${followUpChannel ?? "the principal's usual channel"}`,
    `## Source voice conversation: ${source}`,
  ].join('\n');
}

/** A now reply that missed the call goes to the principal through a fresh coordinator task. */
function buildForwardContent(brief: string, followUpChannel: FollowUpChannel, reply: string): string {
  return [
    'Voice hand-off follow-up — the principal asked for the work below during a live call,',
    'and your result came back after the call had moved on. Send the result to the principal',
    reachInstruction(followUpChannel),
    'Keep it short. Do not redo the work.',
    '',
    '## Brief',
    brief,
    '',
    '## Result',
    reply,
  ].join('\n');
}

type NowOutcome =
  | { kind: 'reply'; event: AgentResponseEvent }
  | { kind: 'missed' };

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
    if (channelResult !== null && typeof channelResult === 'object') {
      return { success: false, error: channelResult.error };
    }
    const followUpChannel = channelResult;

    const modeResult = resolveMode(input.mode);
    if (typeof modeResult === 'object') {
      return { success: false, error: modeResult.error };
    }
    const mode = modeResult;

    const explicitKey =
      typeof input.idempotency_key === 'string' && input.idempotency_key.trim()
        ? input.idempotency_key.trim()
        : undefined;
    const idempotencyKey = buildIdempotencyKey(
      ctx.conversationId,
      brief,
      `${followUpChannel ?? 'usual'}${mode === 'now' ? '|now' : ''}`,
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
      // A now entry stays only while its result is pending (on the call or forwarded).
      return {
        success: true,
        data: {
          accepted: true,
          mode,
          task_event_id: prior.taskEventId,
          follow_up_channel: prior.followUpChannel,
          deduplicated: true,
          ...(mode === 'now'
            ? {
              completed: false,
              still_working: true,
              note: `Still working on that. Tell the caller the result will come ${spokenChannel(prior.followUpChannel)}.`,
            }
            : { note: 'Already handed to async coordinator path; principal will be reached when done.' }),
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
      content: buildTaskContent(brief, followUpChannel, ctx.conversationId, mode),
      metadata: {
        voiceOfframp: true,
        offrampMode: mode,
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

    // A now hand-off listens before publishing so a fast reply is not missed.
    const nowWait = mode === 'now'
      ? this.awaitReply(ctx, taskEvent.id, brief, followUpChannel, senderId, originator, idempotencyKey)
      : null;

    try {
      // Publish as 'dispatch' — only dispatch/system may publish agent.task
      // (permissions.ts). Infrastructure skills are trusted to impersonate.
      // publishDetached returns once the audit write-ahead commits. The
      // coordinator subscriber keeps running after this tool returns, so a
      // long async task cannot hold the spoken turn until the 15s skill
      // timeout (#2265). A write-ahead failure still rejects and the catch
      // below clears the dedup claim.
      await ctx.bus.publishDetached('dispatch', taskEvent);
    } catch (err) {
      nowWait?.cancel();
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
        mode,
        idempotencyKey,
        sourceConversationId: ctx.conversationId,
        briefPreview: brief.slice(0, 80),
      },
      'voice off-ramped work to async coordinator',
    );

    if (nowWait) {
      const outcome = await nowWait.outcome;
      if (outcome.kind === 'reply') {
        const { payload } = outcome.event;
        if (payload.isError) {
          return {
            success: true,
            data: {
              accepted: true,
              mode,
              completed: false,
              failed: true,
              task_event_id: taskEvent.id,
              note: 'The work failed. Tell the caller plainly that it did not get done and offer to try again.',
            },
          };
        }
        return {
          success: true,
          data: {
            accepted: true,
            mode,
            completed: true,
            result: payload.content,
            sent: payload.sends ?? [],
            task_event_id: taskEvent.id,
            note: 'Tell the caller the result in your own words. Only messages listed in sent went out.',
          },
        };
      }
      return {
        success: true,
        data: {
          accepted: true,
          mode,
          completed: false,
          still_working: true,
          follow_up_channel: followUpChannel,
          task_event_id: taskEvent.id,
          note: `Still working. Tell the caller you will send the result ${spokenChannel(followUpChannel)} when it is done.`,
        },
      };
    }

    return {
      success: true,
      data: {
        accepted: true,
        mode,
        task_event_id: taskEvent.id,
        follow_up_channel: followUpChannel,
        deduplicated: false,
        note: 'Handed to async coordinator path; principal will be reached when done.',
      },
    };
  }

  /**
   * Wait for the coordinator's reply to a now hand-off. Resolves with the reply,
   * or `missed` at the limit or when the caller speaks. A reply that arrives
   * after `missed` is forwarded to the principal (#2428).
   */
  private awaitReply(
    ctx: ToolContext,
    taskEventId: string,
    brief: string,
    followUpChannel: FollowUpChannel,
    senderId: string,
    originator: Record<string, unknown> | undefined,
    idempotencyKey: string,
  ): { outcome: Promise<NowOutcome>; cancel: () => void } {
    const bus = ctx.bus!;
    let phase: 'waiting' | 'late' | 'closed' = 'waiting';
    let waitTimer: NodeJS.Timeout | undefined;
    let lateTimer: NodeJS.Timeout | undefined;
    // The task never published: nothing will reply, so stop without logging a miss.
    const cancel = (): void => {
      phase = 'closed';
      clearTimeout(waitTimer);
      clearTimeout(lateTimer);
    };
    const outcome = new Promise<NowOutcome>((resolve) => {
      const miss = (why: string): void => {
        if (phase !== 'waiting') return;
        phase = 'late';
        clearTimeout(waitTimer);
        ctx.log.info({ taskEventId, why }, 'voice hand-off: reply missed the call; it will be forwarded');
        lateTimer = setTimeout(() => {
          if (phase !== 'late') return;
          phase = 'closed';
          enqueuedByKey.delete(idempotencyKey);
          ctx.log.warn({ taskEventId }, 'voice hand-off: no reply within the forward window; nothing forwarded');
        }, LATE_FORWARD_WINDOW_MS);
        lateTimer.unref?.();
        resolve({ kind: 'missed' });
      };
      waitTimer = setTimeout(() => miss('limit'), NOW_MODE_WAIT_MS);
      const signal = ctx.inputSignal;
      if (signal) {
        if (signal.aborted) miss('caller spoke');
        else signal.addEventListener('abort', () => miss('caller spoke'), { once: true });
      }

      // Send a result the caller did not hear to the principal, once.
      let forwarded = false;
      const forward = async (response: AgentResponseEvent): Promise<void> => {
        if (forwarded) return;
        forwarded = true;
        enqueuedByKey.delete(idempotencyKey);
        const task = createAgentTask({
          agentId: 'coordinator',
          conversationId: `voice-offramp-forward:${taskEventId.slice(0, 32)}`,
          channelId: 'internal',
          senderId,
          content: buildForwardContent(
            brief,
            followUpChannel,
            response.payload.isError ? 'The work failed before it finished. Say so plainly.' : response.payload.content,
          ),
          metadata: {
            voiceOfframp: true,
            offrampForwardOf: taskEventId,
            followUpChannel,
            ...(originator ? { originator } : {}),
          },
          parentEventId: response.id,
        });
        try {
          await bus.publishDetached('dispatch', task);
          ctx.log.info({ taskEventId, forwardTaskId: task.id }, 'voice hand-off: result forwarded to the principal');
        } catch (err) {
          ctx.log.error({ err, taskEventId }, 'voice hand-off: result could not be forwarded; the principal was not told');
        }
      };

      // The bus has no unsubscribe; the phase guard makes this a no-op once closed.
      bus.subscribe('agent.response', 'system', async (event: BusEvent) => {
        const response = event as AgentResponseEvent;
        if (response.parentEventId !== taskEventId || phase === 'closed') return;
        if (phase === 'waiting') {
          phase = 'closed';
          clearTimeout(waitTimer);
          // Settled on the call: a repeat of this brief is a new request (a retry after a failure).
          enqueuedByKey.delete(idempotencyKey);
          // The turn can still be cancelled before the result is spoken (barge-in,
          // hang-up). A turn that finishes normally is never aborted afterwards, so
          // an abort from here on means the caller did not hear it all.
          if (signal && !response.payload.isError) {
            signal.addEventListener('abort', () => { void forward(response); }, { once: true });
          }
          resolve({ kind: 'reply', event: response });
          return;
        }
        phase = 'closed';
        clearTimeout(lateTimer);
        await forward(response);
      });
    });
    return { outcome, cancel };
  }
}
