// src/dispatch/context-bridge-parse.ts
//
// Shared utility for parsing the context_bridge JSON input in send skills.
// Extracted to avoid duplication across signal-send, email-send, email-reply.

import type { Logger } from '../logger.js';
import type { OutboundContextCapability } from './outbound-context.js';

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
    // Validate optional field types — reject silently malformed payloads.
    if (obj.expected_reply != null && typeof obj.expected_reply !== 'string') return null;
    if (obj.delegation_hint != null && typeof obj.delegation_hint !== 'string') return null;
    if (obj.metadata != null && (typeof obj.metadata !== 'object' || Array.isArray(obj.metadata))) return null;
    if (obj.expires_in_hours != null && (typeof obj.expires_in_hours !== 'number' || !Number.isFinite(obj.expires_in_hours) || obj.expires_in_hours <= 0)) return null;
    return obj as unknown as ContextBridgeInput;
  } catch {
    log.warn({ rawLength: raw.length }, 'context_bridge: failed to parse JSON — skipping registration');
    return null;
  }
}

/**
 * Best-effort context bridge registration. Call after a successful send.
 * Logs warnings on failure but never throws.
 */
export async function registerContextBridge(
  outboundContext: OutboundContextCapability | undefined,
  bridge: ContextBridgeInput,
  channelId: string,
  content: string,
  log: Logger,
): Promise<void> {
  if (!outboundContext) return;
  try {
    await outboundContext.register({
      channelId,
      agentId: bridge.agent_id,
      content,
      ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
      ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
      ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
      ...(bridge.expires_in_hours != null ? { expiresInHours: bridge.expires_in_hours } : {}),
    });
  } catch (err) {
    log.warn({ err, channelId }, 'Failed to register context bridge entry — send succeeded');
  }
}

/**
 * Single-call outbound context registration that replaces the two-step
 * parse+conditional-register pattern in send skills.
 *
 * - If `outboundContext` is undefined → no-op (graceful when capability unavailable)
 * - If `contextBridgeRaw` parses successfully → registers with explicit metadata;
 *   TTL = bridge.expires_in_hours ?? outboundContext.explicitExpiryHours
 * - If absent/null/malformed → registers minimal entry (agentId + channelId + content);
 *   TTL = outboundContext.defaultExpiryHours
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
  },
): Promise<void> {
  if (!outboundContext) return;

  const { channelId, content, agentId, log } = opts;

  try {
    const bridge = parseContextBridge(contextBridgeRaw, log);

    if (bridge) {
      // Explicit registration — skill provided structured context_bridge metadata.
      // TTL: use the caller-specified expires_in_hours, falling back to the
      // capability's explicitExpiryHours (longer TTL for well-structured entries).
      await outboundContext.register({
        channelId,
        agentId: bridge.agent_id,
        content,
        ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
        ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
        ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
        expiresInHours: bridge.expires_in_hours ?? outboundContext.explicitExpiryHours,
      });
    } else {
      // Auto-registration — context_bridge was absent, null, or malformed.
      // Register a minimal entry so inbound replies can still be correlated.
      await outboundContext.register({
        channelId,
        agentId,
        content,
        expiresInHours: outboundContext.defaultExpiryHours,
      });
    }
  } catch (err) {
    log.warn({ err, channelId }, 'Failed to register outbound context — send succeeded');
  }
}
