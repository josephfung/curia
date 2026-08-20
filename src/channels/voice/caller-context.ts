// caller-context.ts — resolve voice session caller identity once at create time.
//
// Voice bypasses the dispatcher turn loop (latency / per-session identity), but must
// reuse the same ContactResolver + stampOriginator path every other channel uses so
// the elevated-gate signal stays consistent (#1598). Console transport remains
// principal-proven by the bootstrap secret; token-based resolution is the seam for
// future transports (#1602) and is unit-tested here without a live entry point.

import type { ContactResolver } from '../../contacts/contact-resolver.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type {
  ChannelPolicyConfig,
  ContactTier,
  InboundSenderContext,
  SenderContext,
  SystemRole,
  TaskOriginator,
} from '../../contacts/types.js';
import { stampOriginator } from '../../dispatch/stamp-originator.js';
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

/**
 * Build a SenderContext for the principal contact (or the synthetic CLI/web fallback).
 * Used by the console voice transport — principal-proven by the bootstrap secret,
 * same standing as the `'web'` channel short-circuit, but deliberately NOT routed
 * through ContactResolver.resolve('voice', …) so a future real caller token still
 * hits resolveByChannelIdentity (#1598).
 */
export function buildPrincipalSenderContext(principal: {
  id: string;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  kgNodeId: string | null;
  tier?: ContactTier;
} | null): SenderContext {
  if (principal) {
    return {
      resolved: true,
      contactId: principal.id,
      displayName: principal.displayName,
      role: principal.role,
      systemRole: 'principal',
      verified: true,
      kgNodeId: principal.kgNodeId,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 1.0,
      tier: 'principal',
      kind: 'principal',
    };
  }
  // Fresh install / DB blip — same synthetic fallback ContactResolver uses for cli/web.
  return {
    resolved: true,
    contactId: 'primary-user',
    displayName: 'CEO',
    role: 'ceo',
    systemRole: 'principal',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1.0,
    tier: 'principal',
    kind: 'principal',
  };
}

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
  const senderContext = buildPrincipalSenderContext(principal);
  return toCallerContext(senderContext, 'voice', VOICE_CONSOLE_SENDER_ID);
}

/**
 * Resolve a transport-supplied caller token via ContactResolver + stampOriginator.
 * Honors the voice channel's unknown_sender policy (default: ignore → fail closed).
 *
 * `resolveVoiceCallerFromToken` remains the token seam for a future generic voice
 * transport. Real Signal-originated calls use `resolveSignalVoiceCaller` below
 * (#1672), which resolves against the `'signal'` channel key (shared with inbound
 * Signal texts) and follows the answer-everyone policy rather than this function's
 * fail-closed unknown_sender gate.
 *
 * Policy note (#1598 follow-up): the unknown_sender default (`?? 'ignore'`) and the
 * blocked-tier gate below duplicate dispatcher policy rather than reading the shared
 * channel-trust config. Reconcile against the dispatcher's config path when a real
 * token-based transport is wired — do not extend these independently.
 */
export async function resolveVoiceCallerFromToken(opts: {
  contactResolver: ContactResolver;
  callerToken: string;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
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
  // Blocked contacts are denied before constructing a caller — mirrors dispatcher.ts
  // which drops blocked senders before reaching the coordinator (#1598).
  // Distinct reason from unknown_sender so audit can tell "unknown" from "denied".
  if (senderContext.resolved && senderContext.tier === 'blocked') {
    return { ok: false, reason: 'blocked' };
  }
  if (!senderContext.resolved) {
    const policy = opts.channelPolicies?.voice?.unknownSender ?? 'ignore';
    if (policy === 'ignore') {
      return { ok: false, reason: 'unknown_sender' };
    }
    // 'allow' — admit with unknown-tier originator (not used by default voice policy).
    const senderId = opts.senderId ?? opts.callerToken;
    return { ok: true, caller: toCallerContext(senderContext, 'voice', senderId) };
  }

  const senderId = opts.senderId ?? senderContext.contactId;
  return { ok: true, caller: toCallerContext(senderContext, 'voice', senderId) };
}

export type ResolveSignalVoiceCallerResult =
  | { ok: true; caller: VoiceCallerContext }
  | { ok: false; reason: 'blocked' | 'no_identifier' };

/**
 * Resolve a Signal-originated voice call's caller identity.
 *
 * Resolves via the `'signal'` channel key — the SAME key inbound Signal texts use
 * (contact_channel_identities) — so an existing contact matches on their verified
 * Signal number and principal standing carries over from the text channel.
 *
 * Policy (answer-everyone, Joseph 2026-08-20, #1672): v1 admits both resolved
 * contacts AND unresolved strangers — unlike `resolveVoiceCallerFromToken`'s
 * fail-closed unknown_sender gate, a stranger calling in is not turned away; they
 * get 'unknown' tier and liveTurn=false via stampOriginator, so lower-trust callers
 * still fall out of elevated-skill / outbound-context gates even though the call
 * itself is answered. Only two conditions are rejected outright: a blocked-tier
 * contact (an explicit deny — mirrors resolveVoiceCallerFromToken and the
 * dispatcher's blocked-sender gate) and a null callerNumber (no stable channel
 * identifier to resolve or later create a contact from; the bridge logs the raw
 * uuid and rejects rather than admitting an untraceable caller).
 */
export async function resolveSignalVoiceCaller(opts: {
  contactResolver: ContactResolver;
  /** E.164 from callEvent.number; may be null (uuid-only callers). */
  callerNumber: string | null;
  logger: Logger;
}): Promise<ResolveSignalVoiceCallerResult> {
  if (opts.callerNumber === null) {
    return { ok: false, reason: 'no_identifier' };
  }
  const senderContext = await opts.contactResolver.resolve('signal', opts.callerNumber);
  if (senderContext.resolved && senderContext.tier === 'blocked') {
    return { ok: false, reason: 'blocked' };
  }
  // Resolved contact or unresolved stranger — both admitted (answer-everyone).
  return { ok: true, caller: toCallerContext(senderContext, 'voice', opts.callerNumber) };
}
