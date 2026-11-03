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
import { parseExecutionPausedPayload } from '../../src/agents/resumable-task.js';

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
/**
 * A leak guard, not a deadline. A coordinator turn has no wall-clock limit (up
 * to 20 rounds of 10-minute model calls and 15-minute delegate waits, about
 * 8 hours at worst), and a late reply must still reach the principal.
 */
const LATE_FORWARD_WINDOW_MS = 24 * 60 * 60_000;
/** Cap the in-process dedup map so a long-lived process cannot grow without bound. */
const MAX_DEDUP_ENTRIES = 5_000;

interface DedupEntry {
  taskEventId: string;
  followUpChannel: FollowUpChannel;
  /**
   * A now hand-off that finished: a repeat of the brief gets this back instead
   * of a new task, so finished work and its sends are not redone.
   */
  settled?: { result: string; sent: string[] };
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
  mode: Mode,
): string {
  // Always scope to conversation — an LLM-supplied key like "deck" must not
  // collide across sessions (CodeRabbit #1617). A now hand-off waits for its
  // result, so it never reuses an after_call entry; the mode leads the key so
  // no key text can collide across modes.
  if (explicitKey) {
    return `explicit:${mode}:${conversationId ?? 'unknown'}|${explicitKey}`;
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
  | { kind: 'question'; question: string; context: string | null }
  | { kind: 'missed' };

/** Mirrors the runtime's clarification envelope (src/agents/runtime.ts). */
const CLARIFICATION_PROTOCOL = 'clarification_request';

/** Waits between attempts to publish a forward; the result is lost only if all fail. */
const FORWARD_RETRY_DELAYS_MS = [5_000, 30_000];

/**
 * What a coordinator reply means for a waiting hand-off. A paused execution is
 * not final: the task continues and replies again. A clarification is a
 * question, not a result (CodeRabbit on PR #2433).
 */
function classifyReply(response: AgentResponseEvent):
  | { kind: 'final' }
  | { kind: 'paused' }
  | { kind: 'question'; question: string; context: string | null } {
  const content = response.payload.content;
  if (response.payload.isError || !content.trimStart().startsWith('{')) return { kind: 'final' };
  if (parseExecutionPausedPayload(content)) return { kind: 'paused' };
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed['_curia_protocol'] === CLARIFICATION_PROTOCOL && typeof parsed['question'] === 'string') {
      const context = typeof parsed['context'] === 'string' && parsed['context'].trim() ? parsed['context'] : null;
      return { kind: 'question', question: parsed['question'], context };
    }
  } catch {
    // Not JSON after all: prose that happens to start with a brace is a final reply.
  }
  return { kind: 'final' };
}

/** The text a forward carries for a reply the caller did not hear. */
function forwardText(response: AgentResponseEvent): string {
  // An error reply can follow a send that already went out; keep its report so
  // the principal is not asked to redo work that happened.
  if (response.payload.isError) {
    const report = response.payload.content.trim();
    return report
      ? `The work failed before it finished. Its last report, which says what did happen: ${report}`
      : 'The work failed before it finished. Say so plainly.';
  }
  const reply = classifyReply(response);
  if (reply.kind === 'question') {
    return [
      `The work stopped with a question the principal needs to answer: ${reply.question}`,
      ...(reply.context ? [`What was done so far: ${reply.context}`] : []),
    ].join('\n');
  }
  return response.payload.content;
}

/** Mark this hand-off's entry finished, if it still owns it, so a repeat returns the result. */
function settleDedup(key: string, taskEventId: string, response: AgentResponseEvent): void {
  const entry = enqueuedByKey.get(key);
  if (entry?.taskEventId !== taskEventId) return;
  entry.settled = { result: response.payload.content, sent: response.payload.sends ?? [] };
}

/** Release a dedup entry only if it still belongs to this hand-off (eviction can replace it). */
function releaseDedup(key: string, taskEventId: string): void {
  if (enqueuedByKey.get(key)?.taskEventId === taskEventId) enqueuedByKey.delete(key);
}

/**
 * Pending now hand-offs, by the coordinator task's event id. One agent.response
 * subscriber per bus routes replies here: the bus has no unsubscribe, so a
 * subscriber per hand-off would stay for the life of the process (PR #2433 review).
 */
const pendingReplies = new Map<string, (response: AgentResponseEvent) => Promise<void>>();
const busesWithReplyRouter = new WeakSet<object>();

function ensureReplyRouter(bus: NonNullable<ToolContext['bus']>): void {
  if (busesWithReplyRouter.has(bus)) return;
  busesWithReplyRouter.add(bus);
  bus.subscribe('agent.response', 'system', async (event: BusEvent) => {
    const response = event as AgentResponseEvent;
    const listener = response.parentEventId ? pendingReplies.get(response.parentEventId) : undefined;
    if (listener) await listener(response);
  });
}

/** Exported for tests — clears the process-local dedup map between cases. */
export function resetAsyncOfframpDedupForTests(): void {
  enqueuedByKey.clear();
  pendingReplies.clear();
}

/** Exported for tests — hand-offs still waiting for a reply. */
export function pendingReplyCountForTests(): number {
  return pendingReplies.size;
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
      mode,
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
          ...(mode === 'now' && prior.settled
            ? {
              completed: true,
              result: prior.settled.result,
              sent: prior.settled.sent,
              note: 'This was already done. Tell the caller what happened; do not do it again.',
            }
            : mode === 'now'
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
      if (outcome.kind === 'question') {
        return {
          success: true,
          data: {
            accepted: true,
            mode,
            completed: false,
            needs_answer: true,
            question: outcome.question,
            ...(outcome.context ? { context: outcome.context } : {}),
            task_event_id: taskEvent.id,
            note: 'Ask the caller this. Then hand the work off again with a brief that has their answer and the context, '
              + 'so finished steps (and sends) are not repeated.',
          },
        };
      }
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
              result: payload.content,
              sent: payload.sends ?? [],
              task_event_id: taskEvent.id,
              note: 'The work failed. Tell the caller plainly what did and did not happen (result, sent); do not redo a send that went out.',
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
      pendingReplies.delete(taskEventId);
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
          pendingReplies.delete(taskEventId);
          releaseDedup(idempotencyKey, taskEventId);
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

      // Send a result the caller did not hear to the principal, once. A failed
      // publish is retried; the result is lost only when every attempt fails.
      let forwarded = false;
      const forward = async (response: AgentResponseEvent): Promise<void> => {
        if (forwarded) return;
        forwarded = true;
        // A finished result stays on the entry so a repeat is answered, not
        // redone. A failure or a question frees it: the next brief is new work.
        const settleOrRelease = (): void => {
          if (classifyReply(response).kind === 'final' && !response.payload.isError) {
            settleDedup(idempotencyKey, taskEventId, response);
          } else {
            releaseDedup(idempotencyKey, taskEventId);
          }
        };
        const task = createAgentTask({
          agentId: 'coordinator',
          conversationId: `voice-offramp-forward:${taskEventId.slice(0, 32)}`,
          channelId: 'internal',
          senderId,
          content: buildForwardContent(brief, followUpChannel, forwardText(response)),
          metadata: {
            voiceOfframp: true,
            offrampForwardOf: taskEventId,
            followUpChannel,
            ...(originator ? { originator } : {}),
          },
          parentEventId: response.id,
        });
        for (let attempt = 0; ; attempt += 1) {
          try {
            await bus.publishDetached('dispatch', task);
            settleOrRelease();
            ctx.log.info({ taskEventId, forwardTaskId: task.id }, 'voice hand-off: forward task queued for the coordinator to send');
            return;
          } catch (err) {
            const delay = FORWARD_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) {
              // The result was not delivered, but the work behind it happened:
              // a finished result stays settled so a repeat cannot redo its send.
              settleOrRelease();
              ctx.log.error({ err, taskEventId, attempts: attempt + 1 }, 'voice hand-off: result could not be forwarded; the principal was not told');
              return;
            }
            ctx.log.warn({ err, taskEventId, attempt: attempt + 1, retryInMs: delay }, 'voice hand-off: forward publish failed; retrying');
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      };

      ensureReplyRouter(bus);
      pendingReplies.set(taskEventId, async (response: AgentResponseEvent) => {
        if (phase === 'closed') return;
        const reply = classifyReply(response);
        // A paused execution replies again when it finishes; keep listening.
        if (reply.kind === 'paused') return;
        pendingReplies.delete(taskEventId);
        if (phase === 'waiting') {
          phase = 'closed';
          clearTimeout(waitTimer);
          // Finished on the call: a repeat is answered with this result. A failure
          // or a question frees the entry, so a retry or a fuller brief runs.
          if (reply.kind === 'final' && !response.payload.isError) settleDedup(idempotencyKey, taskEventId, response);
          else releaseDedup(idempotencyKey, taskEventId);
          // The turn can still be cancelled before the result is spoken (barge-in,
          // hang-up). A turn that finishes normally is never aborted afterwards, so
          // an abort from here on means the caller did not hear it all.
          if (signal) {
            signal.addEventListener('abort', () => { void forward(response); }, { once: true });
          }
          resolve(reply.kind === 'question'
            ? { kind: 'question', question: reply.question, context: reply.context }
            : { kind: 'reply', event: response });
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
