// caller-context.ts — resolve voice session caller identity once at create time.
//
// Voice bypasses the dispatcher turn loop (latency / per-session identity), but must
// reuse the same ContactResolver + stampOriginator path every other channel uses so
// the elevated-gate signal stays consistent (#1598). Unknown-sender / blocked
// admission reads the shared channelPolicies map (#1626). Console transport remains
// principal-proven by the bootstrap secret; token-based resolution is the seam for
// a future generic voice transport and is unit-tested here without a live entry point.

import type { ContactResolver } from '../../contacts/contact-resolver.js';
import type { ContactService } from '../../contacts/contact-service.js';
import { buildPrincipalSenderContext } from '../../contacts/build-principal-sender-context.js';
import { isBlockedSender, isUnknownSenderIgnored } from '../../contacts/channel-sender-policy.js';
import type {
  ChannelPolicyConfig,
  ContactTier,
  InboundSenderContext,
  SystemRole,
  TaskOriginator,
} from '../../contacts/types.js';
import { stampOriginator } from '../../contacts/stamp-originator.js';
import type { Logger } from '../../logger.js';

/** Synthetic principal sender id shared with the web console chat path. */
export const VOICE_CONSOLE_SENDER_ID = 'ceo-web-user';

export interface VoiceCallerContext {
  contactId: string;
  displayName: string;
  systemRole: SystemRole | null;
  tier: ContactTier;
  /** Live-principal-turn signal — gates elevated skills and outbound-context injection. */
  liveTurn: boolean;
  originator: TaskOriginator;
  /** senderId stamped on inbound.message for this session. */
  senderId: string;
  /** Resolved (or synthetic) sender context that produced originator/liveTurn. */
  senderContext: InboundSenderContext;
}

export type ResolveVoiceCallerResult =
  | { ok: true; caller: VoiceCallerContext }
  | { ok: false; reason: 'unknown_sender' | 'blocked' };

function toCallerContext(
  senderContext: InboundSenderContext,
  channel: string,
  senderId: string,
): VoiceCallerContext {
  const { originator, liveTurn } = stampOriginator({ senderContext, channel, senderId });
  if (senderContext.resolved) {
    return {
      contactId: senderContext.contactId,
      displayName: senderContext.displayName,
      systemRole: senderContext.systemRole,
      tier: senderContext.tier,
      liveTurn,
      originator,
      senderId,
      senderContext,
    };
  }
  return {
    contactId: senderId,
    displayName: 'Unknown caller',
    systemRole: null,
    tier: 'unknown',
    liveTurn,
    originator,
    senderId,
    senderContext,
  };
}

/**
 * Console (CEO web) voice transport: resolve the principal explicitly, then stamp
 * originator/liveTurn via the shared helper. Never falls back to a non-principal
 * identity — the bootstrap secret already proved the caller is the CEO.
 */
export async function resolveConsoleVoiceCaller(opts: {
  contactService: ContactService;
  logger: Logger;
}): Promise<VoiceCallerContext> {
  let principal: Awaited<ReturnType<ContactService['findContactBySystemRole']>> = null;
  try {
    principal = await opts.contactService.findContactBySystemRole('principal');
  } catch (err) {
    // Narrow to real pg/SQLSTATE errors (five-character alphanumeric code) before
    // suppressing — a TypeError or programming bug must not be silently promoted to
    // a synthetic principal identity. Mirrors contact-resolver.ts:79-89 (#1598).
    const sqlState = err !== null && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    const isDbError = typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState);
    if (!isDbError) throw err;
    opts.logger.warn({ err }, 'Unable to resolve principal contact for voice session (DB error); using synthetic principal');
  }
  if (!principal) {
    opts.logger.warn('No principal contact found for voice session; using synthetic principal');
  }
  // Console voice is principal-proven by the bootstrap secret (same standing as the
  // `'web'` channel short-circuit), but deliberately NOT routed through
  // ContactResolver.resolve('voice', …) so a future real caller token still hits
  // resolveByChannelIdentity (#1598). Construction shares buildPrincipalSenderContext
  // with ContactResolver so the migration-055 kind warning cannot drift (#1627).
  const senderContext = buildPrincipalSenderContext(principal, opts.logger);
  return toCallerContext(senderContext, 'voice', VOICE_CONSOLE_SENDER_ID);
}

/**
 * Resolve a transport-supplied caller token via ContactResolver + stampOriginator.
 * Honors the voice channel's unknown_sender policy from the same channelPolicies
 * map the dispatcher uses (`loadAuthConfig` → `config/channel-trust.yaml`).
 *
 * `resolveVoiceCallerFromToken` remains the token seam for a future generic voice
 * transport. Real Signal-originated calls use `resolveSignalVoiceCaller` below
 * (#1672), which resolves against the `'signal'` channel key (shared with inbound
 * Signal texts) and consults `signal.unknown_sender` rather than `voice`.
 */
export async function resolveVoiceCallerFromToken(opts: {
  contactResolver: ContactResolver;
  callerToken: string;
  channelPolicies: Record<string, ChannelPolicyConfig>;
  /**
   * senderId stamped on inbound.message when resolved. Defaults to the contact id
   * (or the raw token when unresolved and admitted).
   * Note: for a token-resolved caller this is the contact UUID, not a channel address —
   * safe because the dispatcher skips voice inbound.message (dispatcher.ts:258) so it
   * is audit-only and never re-resolved as a channel identity.
   */
  senderId?: string;
}): Promise<ResolveVoiceCallerResult> {
  const senderContext = await opts.contactResolver.resolve('voice', opts.callerToken);
  // Distinct reason from unknown_sender so audit can tell "unknown" from "denied".
  if (isBlockedSender(senderContext)) {
    return { ok: false, reason: 'blocked' };
  }
  if (isUnknownSenderIgnored(senderContext, opts.channelPolicies, 'voice')) {
    return { ok: false, reason: 'unknown_sender' };
  }
  // Missing voice key → allow, matching dispatcher (not a voice-only fail-closed default).
  const senderId = opts.senderId ?? (senderContext.resolved ? senderContext.contactId : opts.callerToken);
  return { ok: true, caller: toCallerContext(senderContext, 'voice', senderId) };
}

export type ResolveSignalVoiceCallerResult =
  | { ok: true; caller: VoiceCallerContext }
  | { ok: false; reason: 'blocked' | 'no_identifier' | 'unknown_sender' };

/**
 * Resolve a Signal-originated voice call's caller identity.
 *
 * Resolves via the `'signal'` channel key — the SAME key inbound Signal texts use
 * (contact_channel_identities) — so an existing contact matches on their verified
 * Signal number and principal standing carries over from the text channel.
 *
 * Unknown-caller admission follows `channels.signal.unknown_sender` in
 * channel-trust.yaml (currently `allow` — a stranger is answered, stamped
 * unknown-tier / liveTurn=false). The ignore gate matches the dispatcher:
 * unresolved numbers *and* resolved `tier: 'unknown'` contacts (except
 * automated) are rejected when the YAML is `ignore`. A blocked-tier contact
 * is always denied. A null callerNumber (uuid-only, no stable identifier) is
 * also rejected — nothing to resolve or later create a contact from; the
 * bridge logs the raw uuid rather than admitting an untraceable caller.
 */
export async function resolveSignalVoiceCaller(opts: {
  contactResolver: ContactResolver;
  /** E.164 from callEvent.number; may be null (uuid-only callers). */
  callerNumber: string | null;
  channelPolicies: Record<string, ChannelPolicyConfig>;
  logger: Logger;
}): Promise<ResolveSignalVoiceCallerResult> {
  if (opts.callerNumber === null) {
    return { ok: false, reason: 'no_identifier' };
  }
  const senderContext = await opts.contactResolver.resolve('signal', opts.callerNumber);
  if (isBlockedSender(senderContext)) {
    return { ok: false, reason: 'blocked' };
  }
  if (isUnknownSenderIgnored(senderContext, opts.channelPolicies, 'signal')) {
    return { ok: false, reason: 'unknown_sender' };
  }
  return { ok: true, caller: toCallerContext(senderContext, 'voice', opts.callerNumber) };
}
