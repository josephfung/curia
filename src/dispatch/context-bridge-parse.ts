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
    const parsed = JSON.parse(raw) as ContextBridgeInput;
    if (!parsed.agent_id || typeof parsed.agent_id !== 'string') {
      log.warn({ raw: raw.slice(0, 200) }, 'context_bridge: missing or invalid agent_id — skipping registration');
      return null;
    }
    return parsed;
  } catch {
    log.warn({ raw: raw.slice(0, 200) }, 'context_bridge: failed to parse JSON — skipping registration');
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
