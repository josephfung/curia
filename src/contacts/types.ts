// src/contacts/types.ts

export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  // Legacy columns (deprecated, kept until #955 drops them). New code reads `tier`.
  status: ContactStatus;
  trustLevel: TrustLevel | null;
  // New capability axis (issue #945). `tier` is the single ordered capability axis
  // that replaces the status/trust_level read path. `kind` is a descriptive facet.
  // Added in migration 055.
  tier: ContactTier;
  kind: ContactKind;
  // Trust scoring fields (migration 020)
  contactConfidence: number;         // 0.0–1.0; accumulated over time
  lastSeenAt: Date | null;
  // Message count fields (migration 034) — scoring-owned
  inboundMessageCount: number;
  outboundMessageCount: number;
  notes: string | null;
  // Canonical profile attributes (migration 048). All nullable — populated by
  // backfill script or via updateContactFields(). Source of truth for specialists.
  preferredName: string | null;
  title: string | null;
  organization: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  birthday: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Subset of Contact fields that can be written via updateContactFields(). */
export interface ContactCanonicalFields {
  preferredName?: string | null;
  title?: string | null;
  organization?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  timezone?: string | null;
  locale?: string | null;
  location?: string | null;
  pronouns?: string | null;
  linkedinUrl?: string | null;
  bio?: string | null;
  birthday?: string | null;
}

export interface ChannelIdentity {
  id: string;
  contactId: string;
  channel: string;
  channelIdentifier: string;
  label: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  status: IdentityStatus;
  source: IdentitySource;
  createdAt: Date;
  updatedAt: Date;
}

export type IdentitySource =
  | 'ceo_stated'
  | 'email_participant'
  | 'signal_participant'
  | 'crm_import'
  | 'calendar_attendee'
  | 'self_claimed'
  // Contact registered by an agent calling the contact-register skill directly,
  // outside the normal dispatcher pipeline. Treated with the same trust as
  // email_participant — the agent is responsible for sourcing the identifier.
  | 'agent_called';

// -- Identity status --
// active: address is believed to be valid and usable (default)
// defunct: address is known to be no longer in use (e.g. left the company)
// bounced: delivery to this address has failed
// Orthogonal to `verified` — an address can be verified-but-bounced.
export type IdentityStatus = 'active' | 'defunct' | 'bounced';

// -- Contact status --
// confirmed: CEO has verified this contact
// provisional: system-created, awaiting CEO confirmation
// blocked: CEO explicitly rejected/blocked this sender
export type ContactStatus = 'confirmed' | 'provisional' | 'blocked';

export interface AuthOverride {
  id: string;
  contactId: string;
  permission: string;
  granted: boolean;
  grantedBy: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** Options for creating a new contact */
export interface CreateContactOptions {
  displayName: string;
  /**
   * Fallback display name if the primary name sanitizes to empty.
   * Useful when the name comes from an external source (e.g., email participant)
   * and the email address is a reasonable fallback. Also sanitized before use.
   */
  fallbackDisplayName?: string;
  role?: string;
  // `status` is the legacy field; callers may still set it. When `tier` is also provided,
  // `tier` takes precedence. When only `status` is set, tier is derived from it.
  status?: ContactStatus;
  // `tier` is the new capability axis from issue #945. Preferred over `status` for new callers.
  tier?: ContactTier;
  // `kind` is the descriptive facet from issue #945.
  kind?: ContactKind;
  notes?: string;
  /** If provided, links to this existing KG node. Otherwise auto-creates one. */
  kgNodeId?: string;
  source: string;
  // Canonical profile attributes — optional on create, used by CRM import paths.
  preferredName?: string | null;
  title?: string | null;
  organization?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  timezone?: string | null;
  locale?: string | null;
  location?: string | null;
  pronouns?: string | null;
  linkedinUrl?: string | null;
  bio?: string | null;
  birthday?: string | null;
}

/** Options for adding a channel identity to a contact */
export interface LinkIdentityOptions {
  contactId: string;
  channel: string;
  channelIdentifier: string;
  label?: string;
  source: IdentitySource;
  verified?: boolean;
  status?: IdentityStatus;
}

/** Result of resolving an inbound sender */
export interface ResolvedSender {
  contactId: string;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  // Legacy columns — kept until #955 drops them. New code reads `tier`.
  status: ContactStatus;
  trustLevel: TrustLevel | null;  // per-contact override, or null
  // New capability axis (issue #945). Canonical read path going forward.
  tier: ContactTier;
  kind: ContactKind;
  kgNodeId: string | null;
  verified: boolean;
  contactConfidence: number;      // 0.0–1.0
}

/** Enriched context about a sender, assembled for the coordinator's prompt */
export interface SenderContext {
  resolved: true;
  contactId: string;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  // Legacy columns — kept until #955 drops them. New code reads `tier`.
  status: ContactStatus;
  verified: boolean;
  kgNodeId: string | null;
  /** Facts from the KG about this person, formatted for prompt inclusion */
  knowledgeSummary: string;
  authorization: AuthorizationResult | null;
  // Trust scoring inputs — available when contact was found in DB. Not propagated to bus events.
  contactConfidence: number;      // 0.0–1.0
  trustLevel: TrustLevel | null;  // per-contact override, or null
  // New capability axis (issue #945). Canonical read path going forward.
  tier: ContactTier;
  kind: ContactKind;
}

export interface UnknownSenderContext {
  resolved: false;
  channel: string;
  senderId: string;
}

export type InboundSenderContext = SenderContext | UnknownSenderContext;

/**
 * Identifies who originally initiated a task chain. Stamped by the dispatcher
 * on every task — not just principal-originated ones. Survives task delegation
 * when the creating code copies originator from the parent task.
 *
 * See docs/wip/2026-05-10-principal-identity-design.md
 */
export interface TaskOriginator {
  /** Contact ID of the person or agent that started this chain */
  contactId: string;
  /** System designation at the time the task was created */
  systemRole: SystemRole | null;
  /** Channel the task was initiated from (email, signal, cli, scheduler, etc.) */
  channel: string;
  /** ISO timestamp — when the chain started */
  initiatedAt: string;
}

// -- Authorization types --

export interface RolePermissions {
  description: string;
  defaultPermissions: string[];
  defaultDeny: string[];
}

export interface PermissionDef {
  description: string;
  sensitivity: 'high' | 'medium' | 'low';
}

export type TrustLevel = 'ceo' | 'high' | 'medium' | 'low';

/** System designation — drives authorization. Separate from the free-text `role` field.
 *  - 'principal' — the human CEO who Curia serves
 *  - 'agent'     — Curia itself or another autonomous agent
 *  - 'system'    — operator-configured, platform-executed (e.g. declarative YAML jobs)
 *
 *  DB CHECK constraint widened in migration 048 to include 'system'.
 */
export type SystemRole = 'principal' | 'agent' | 'system';

// Ordinal ranking for trust level comparison. Higher rank = more trusted.
// Used by meetsMinimumTrust() so callers don't need to enumerate every level.
// Exported so authorization.ts and other consumers share the same single source of truth.
// TODO(#955): Remove TRUST_RANK once all callers have migrated to TIER_RANK + ContactTier.
export const TRUST_RANK: Record<TrustLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ceo: 3,
};

/**
 * Check whether an actual trust level meets or exceeds a required minimum.
 * Returns false for null (unknown contacts default to untrusted).
 *
 * @deprecated Prefer meetsMinimumTier() against contact.tier. This function
 *   operates on the legacy trust_level column. Kept alive until #955 completes
 *   the column drop — existing call sites in authorization.ts and pii-redactor.ts
 *   still need it for channel-level TrustLevel comparisons (channel trust is
 *   config-driven and not mapped to tier).
 */
export function meetsMinimumTrust(
  actual: TrustLevel | null,
  required: TrustLevel,
): boolean {
  if (actual === null) return false;
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}

// ---------------------------------------------------------------------------
// New tier + kind system (issue #945)
// ---------------------------------------------------------------------------

/**
 * Unified capability axis replacing the old `status` / `trust_level` split.
 * Ordered ascending: blocked < unknown < known < trusted < principal.
 *
 * - 'blocked'   — CEO explicitly rejected this contact; messages are dropped.
 * - 'unknown'   — contact exists but has not been confirmed (was: 'provisional' / trust_level='low').
 * - 'known'     — CEO-confirmed, no special trust grant (was: 'confirmed' + no trust_level).
 * - 'trusted'   — CEO granted elevated trust (was: trust_level='high').
 * - 'principal' — the human CEO Curia serves (was: system_role='principal' / trust_level='ceo').
 *
 * Added in migration 055. See docs/wip/ for the contacts redesign design memo.
 */
export type ContactTier = 'blocked' | 'unknown' | 'known' | 'trusted' | 'principal';

/**
 * Descriptive facet for a contact row — what kind of entity it represents.
 * Gates nothing directly in this issue; 'automated' will opt a row out of tier
 * gates in issue #953.
 *
 * - 'person'       — individual human contact (default).
 * - 'organization' — a company or institution (linked KG node type='organization').
 * - 'automated'    — automated sender e.g. mailing list (TODO #953: exempts from tier gates).
 * - 'principal'    — the human CEO Curia serves.
 * - 'agent'        — Curia itself or another autonomous agent.
 *
 * Added in migration 055.
 */
export type ContactKind = 'person' | 'organization' | 'automated' | 'principal' | 'agent';

// Ordinal ranking for tier comparison. Higher rank = more capability.
// Used by meetsMinimumTier() so call sites never need to enumerate specific tiers.
export const TIER_RANK: Record<ContactTier, number> = {
  blocked:   0,
  unknown:   1,
  known:     2,
  trusted:   3,
  principal: 4,
};

/**
 * Check whether an actual contact tier meets or exceeds a required minimum.
 *
 * This is the canonical helper for tier comparisons. ALL call sites must use this
 * function — never compare specific tier values directly. This ensures a single
 * source of truth for the ordering and makes future reorderings safe.
 *
 * Throws if either argument is not a recognized tier value. Matches the convention
 * in authorization.ts (which throws on unknown trustLevel) — a silent wrong answer
 * at a trust comparison is worse than an early crash.
 */
export function meetsMinimumTier(
  actual: ContactTier,
  required: ContactTier,
): boolean {
  const actualRank = TIER_RANK[actual];
  const requiredRank = TIER_RANK[required];
  if (actualRank === undefined || requiredRank === undefined) {
    throw new Error(
      `meetsMinimumTier: unrecognized tier value(s) — actual='${actual}', required='${required}'`,
    );
  }
  return actualRank >= requiredRank;
}

/**
 * Return true when kind='automated'. Call sites that need to skip tier gates
 * for automated senders (mailing lists, notifications) should use this helper
 * rather than comparing kind directly — keeps the gate logic in one place.
 *
 * Full gate-skipping behaviour will be wired in issue #953; for now this is
 * a typed helper so callers can be written ahead of the gate implementation.
 *
 * TODO(#953): Wire this into the dispatch gate and outbound filter.
 */
export function isAutomatedKind(kind: ContactKind): boolean {
  return kind === 'automated';
}

export interface AuthorizationResult {
  allowed: string[];
  denied: string[];
  /** Permissions that require escalation (not in role defaults, needs CEO decision) */
  escalate: string[];
  /** Channel trust level for this message's originating channel */
  channelTrust: TrustLevel;
  /** Permissions blocked by insufficient channel trust (allowed by role but channel too low) */
  trustBlocked: string[];
  // TODO(#955): Replace contactStatus with contactTier once all callers have migrated.
  contactStatus: ContactStatus;
}

export interface AuthConfig {
  roles: Record<string, RolePermissions>;
  /** Fallback permission defaults keyed by trust_level tier ('ceo'|'high'|'medium'|'low').
   *  Used when a contact's free-text role doesn't match any key in `roles`. */
  trustLevelDefaults?: Record<string, RolePermissions>;
  permissions: Record<string, PermissionDef>;
  channelTrust: Record<string, TrustLevel>;
  channelPolicies: Record<string, ChannelPolicyConfig>;
}

// -- Unknown sender policy --

export type UnknownSenderPolicy = 'allow' | 'hold_and_notify' | 'ignore';

export type HeldMessageStatus = 'pending' | 'processed' | 'discarded';

export interface HeldMessage {
  id: string;
  channel: string;
  senderId: string;
  conversationId: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
  status: HeldMessageStatus;
  /** Contact ID if the CEO identified the sender */
  resolvedContactId: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface ChannelPolicyConfig {
  trust: TrustLevel;
  unknownSender: UnknownSenderPolicy;
  /** Whether this channel structurally links replies to their parent messages.
   *  Email is threaded (subject + in-reply-to headers); Signal/SMS/CLI are not.
   *  The dispatch layer uses this to decide whether to write/read outbound context memos. */
  threaded: boolean;
}

// -- Calendar registry types --
export type { ContactCalendar, CreateCalendarLinkOptions } from './calendar-types.js';

// -- Deduplication types --

export type DedupConfidence = 'certain' | 'probable';

export interface DuplicatePairContact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  identities: ChannelIdentity[];
}

export interface DuplicatePair {
  contactA: DuplicatePairContact;
  contactB: DuplicatePairContact;
  score: number;         // 0–1
  confidence: DedupConfidence;
  reason: string;        // human-readable: "Same email address", "Similar name (0.91)"
}

// -- Merge types --

export interface MergeGoldenRecord {
  displayName: string;
  role: string | null;
  notes: string | null;
  status: ContactStatus;
  identities: ChannelIdentity[];  // union of both contacts' identities
  authOverrides: Array<{ permission: string; granted: boolean }>;
}

export interface MergeProposal {
  primaryContactId: string;
  secondaryContactId: string;
  goldenRecord: MergeGoldenRecord;
  dryRun: true;
}

export interface MergeResult {
  primaryContactId: string;
  secondaryContactId: string;
  goldenRecord: MergeGoldenRecord;
  dryRun: false;
  mergedAt: Date;
}

/** Thrown by ContactService when the requested identity does not exist. */
export class IdentityNotFoundError extends Error {
  // Stable code for callers that need string-based discrimination (e.g. classifyError)
  readonly code = 'IDENTITY_NOT_FOUND' as const;

  constructor(identityId: string) {
    super(`Identity not found: ${identityId}`);
    this.name = 'IdentityNotFoundError';
  }
}

// -- ContactService dependency injection for dedup wiring --

export interface ContactServiceOptions {
  dedupService?: import('./dedup-service.js').DedupService;
  onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;
  /** Called after a successful non-dry-run merge to notify subscribers (e.g., for audit logging). */
  onContactMerged?: (primaryId: string, secondaryId: string, mergedAt: Date) => void;
  /** Called when a verified identity is linked — triggers confidence recompute.
   *  May return a Promise; rejections are caught by ContactService (non-fatal). */
  onIdentityVerified?: (contactId: string) => void | Promise<void>;
}
