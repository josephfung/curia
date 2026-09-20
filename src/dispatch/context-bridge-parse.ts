// src/dispatch/context-bridge-parse.ts
//
// Shared utility for parsing the context_bridge JSON input in send skills.
// Extracted to avoid duplication across signal-send, email-send, email-reply.

import type { BoundTaskContext } from '../agents/resumable-task.js';
import type { Logger } from '../logger.js';
import type { OutboundContextCapability } from './outbound-context.js';
import { buildTaskWakeAutoBridge, TASK_WAKE_BIND_REPLY_KEY, TASK_WAKE_TASK_ID_KEY, TASK_WAKE_REPLY_TTL_HOURS } from './task-wake-reply.js';

export interface ContextBridgeInput {
  agent_id: string;
  expected_reply?: string;
  delegation_hint?: string;
  metadata?: Record<string, unknown>;
  expires_in_hours?: number;
}

/**
 * Parse the context_bridge JSON input. Returns null if absent, empty, or malformed.
 * Logs a warning if the input is present but can't be parsed.
 */
export function parseContextBridge(raw: unknown, log: Logger): ContextBridgeInput | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn({ rawLength: raw.length }, 'context_bridge: payload must be a JSON object — skipping registration');
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.agent_id !== 'string' || obj.agent_id.trim().length === 0) {
      log.warn({ rawLength: raw.length }, 'context_bridge: missing or invalid agent_id — skipping registration');
      return null;
    }
    // Validate optional fields — strip invalid ones but preserve valid agent_id.
    // Returning null here would discard the agent_id and misroute reply correlation.
    const result: ContextBridgeInput = { agent_id: obj.agent_id as string };

    if (typeof obj.expected_reply === 'string') {
      result.expected_reply = obj.expected_reply;
    } else if (obj.expected_reply != null) {
      log.warn({ field: 'expected_reply', type: typeof obj.expected_reply }, 'context_bridge: optional field has wrong type — dropping field');
    }

    if (typeof obj.delegation_hint === 'string') {
      result.delegation_hint = obj.delegation_hint;
    } else if (obj.delegation_hint != null) {
      log.warn({ field: 'delegation_hint', type: typeof obj.delegation_hint }, 'context_bridge: optional field has wrong type — dropping field');
    }

    if (obj.metadata != null && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)) {
      result.metadata = obj.metadata as Record<string, unknown>;
    } else if (obj.metadata != null) {
      log.warn({ field: 'metadata' }, 'context_bridge: metadata must be a plain object — dropping field');
    }

    if (typeof obj.expires_in_hours === 'number' && Number.isFinite(obj.expires_in_hours) && obj.expires_in_hours > 0) {
      result.expires_in_hours = obj.expires_in_hours;
    } else if (obj.expires_in_hours != null) {
      log.warn({ field: 'expires_in_hours', value: obj.expires_in_hours }, 'context_bridge: expires_in_hours must be a positive finite number — dropping field');
    }

    return result;
  } catch {
    log.warn({ rawLength: raw.length }, 'context_bridge: failed to parse JSON — skipping registration');
    return null;
  }
}


/**
 * Single-call outbound context registration that replaces the two-step
 * parse+conditional-register pattern in send skills.
 *
 * - If `outboundContext` is undefined → no-op (graceful when capability unavailable)
 * - If `contextBridgeRaw` parses successfully → registers with explicit metadata;
 *   TTL = bridge.expires_in_hours, else the larger of explicitExpiryHours and
 *   the channel's default window
 * - If absent/null/malformed → registers minimal entry (agentId + channelId + content);
 *   TTL = the channel's default window (defaultExpiryHoursFor)
 * - Never throws — logs warnings on failure
 */
export async function registerOutboundContext(
  outboundContext: OutboundContextCapability | undefined,
  contextBridgeRaw: unknown,
  opts: {
    channelId: string;
    content: string;
    agentId: string;
    log: Logger;
    /** When present (task-wake turns), auto-bind CEO replies to this task (#1299). */
    boundTask?: BoundTaskContext | null;
  },
): Promise<void> {
  if (!outboundContext) return;

  const { channelId, content, agentId, log, boundTask } = opts;

  try {
    let bridge = parseContextBridge(contextBridgeRaw, log);
    // Captured before the task-wake branches below can inject a TTL of their
    // own — afterwards there is no way to tell an agent's chosen window from
    // one the system supplied, and the log would credit the agent for both.
    const agentChoseTtl = bridge?.expires_in_hours != null;

    if (!bridge && boundTask) {
      // Task-wake send without explicit context_bridge — attach durable task binding.
      bridge = buildTaskWakeAutoBridge({
        taskId: boundTask.taskId,
        agentId,
        messageContent: content,
      });
      log.debug({ taskId: boundTask.taskId }, 'outbound context: auto-bound task-wake reply');
    } else if (bridge && boundTask && !bridge.metadata?.[TASK_WAKE_TASK_ID_KEY]) {
      bridge = {
        ...bridge,
        metadata: {
          ...(bridge.metadata ?? {}),
          [TASK_WAKE_BIND_REPLY_KEY]: true,
          [TASK_WAKE_TASK_ID_KEY]: boundTask.taskId,
        },
        expires_in_hours: bridge.expires_in_hours ?? TASK_WAKE_REPLY_TTL_HOURS,
      };
    }

    const channelDefaultHours = outboundContext.defaultExpiryHoursFor(channelId);

    if (bridge) {
      // Explicit registration — skill provided structured context_bridge metadata.
      //
      // TTL, in order of authority:
      //   1. The agent's own expires_in_hours wins outright, including when it
      //      is shorter than the channel default — a deliberate short window is
      //      a legitimate choice.
      //   2. A system-injected task-wake TTL is a floor, not a ceiling: raise it
      //      to the channel default if that is longer, so the binding cannot
      //      expire before a bare entry on the same channel would.
      //   3. Otherwise the explicit tier, likewise floored at the channel default.
      //
      // Both floors exist for the same reason: an entry carrying MORE context
      // must never expire sooner than a bare one on the same channel (#1816).
      // Only the task-wake branches above inject a TTL the agent did not ask
      // for, so a bridge TTL that is present but not the agent's is theirs.
      const systemInjectedTtl = !agentChoseTtl && bridge.expires_in_hours != null;
      await outboundContext.register({
        channelId,
        agentId: bridge.agent_id,
        content,
        ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
        ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
        ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
        expiresInHours: agentChoseTtl
          ? bridge.expires_in_hours
          : systemInjectedTtl
            ? Math.max(bridge.expires_in_hours!, channelDefaultHours)
            : Math.max(outboundContext.explicitExpiryHours, channelDefaultHours),
        ttlSource: agentChoseTtl ? 'agent' : systemInjectedTtl ? 'task-wake' : 'explicit-tier',
      });
    } else {
      // Auto-registration — context_bridge was absent, null, or malformed.
      // Register a minimal entry so inbound replies can still be correlated.
      // TTL follows the channel's reply rhythm, not a flat 6h (#1816).
      await outboundContext.register({
        channelId,
        agentId,
        content,
        expiresInHours: channelDefaultHours,
        ttlSource: 'channel-default',
      });
    }
  } catch (err) {
    // Swallowed by design: the message already went out, so failing the skill
    // would report a failure for a send that shipped. But the consequence is
    // not degraded service — it is a guaranteed future cold inbound, so name
    // it, and carry enough identity to tell which message will come back
    // unrecognised (#1816).
    log.warn(
      { err, channelId, agentId, hadBridge: contextBridgeRaw != null },
      'Failed to register outbound context — send succeeded, but any reply will arrive with no record of this message',
    );
  }
}
