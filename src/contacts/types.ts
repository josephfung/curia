// src/contacts/types.ts

export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  // Capability axis (issue #945). `tier` is the single ordered capability axis
  // that replaced the legacy status/trust_level read path (removed in #955).
  // `kind` is a descriptive facet. Added in migration 055.
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
  // `tier` is the capability axis from issue #945 (the legacy `status` option was removed in #955).
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
  // Capability axis (issue #945). Canonical read path; the legacy status/trust_level
  // fields were removed in #955.
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
  verified: boolean;
  kgNodeId: string | null;
  /** Facts from the KG about this person, formatted for prompt inclusion */
  knowledgeSummary: string;
  authorization: AuthorizationResult | null;
  // Trust scoring inputs — available when contact was found in DB. Not propagated to bus events.
  contactConfidence: number;      // 0.0–1.0
  // Capability axis (issue #945). Canonical read path; the legacy status/trust_level
  // fields were removed in #955.
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
  /**
   * Contact tier at the moment the task was initiated. Null for system/agent tasks
   * (no external contact). Absent on originators stamped before issue #950.
   * Used by execution-layer Gate C to apply the action policy from issue #948.
   */
  tier?: ContactTier | null;
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
// Kept for channel trust and permission sensitivity comparisons in authorization.ts
// (channel trust config uses TrustLevel, not ContactTier). The trust_level *column*
// is retired in #955; this constant stays for the channel/sensitivity read paths.
export const TRUST_RANK: Record<TrustLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ceo: 3,
};

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
 * - 'automated'    — automated sender e.g. mailing list (exempts from unknown-tier gate in dispatcher.ts, #953).
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
 * Return true when kind='automated'. Use this helper at call sites that need to
 * skip tier gates for automated senders (noreply, newsletters, notifications).
 *
 * The dispatch tier gate bypass is wired in dispatcher.ts (#953).
 * TODO(#953): Wire into the outbound filter.
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
}

export interface AuthConfig {
  roles: Record<string, RolePermissions>;
  /** Fallback permission defaults keyed by ContactTier ('principal'|'trusted'|'known'|'unknown').
   *  Used when a contact's free-text role doesn't match any key in `roles`. */
  tierDefaults?: Record<string, RolePermissions>;
  permissions: Record<string, PermissionDef>;
  channelTrust: Record<string, TrustLevel>;
  channelPolicies: Record<string, ChannelPolicyConfig>;
}

// -- Unknown sender policy --
// 'allow' routes unknown senders to the coordinator in low-trust mode (tier='unknown').
// 'ignore' silently drops the message.
export type UnknownSenderPolicy = 'allow' | 'ignore';

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
  // `tier` survivorship: blocked-on-either-side wins; else the higher TIER_RANK.
  // Replaced the legacy `status` field (most-restrictive-status-wins) in #955.
  tier: ContactTier;
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

// -- Grant recommendation types (issue #952) --

export type GrantRecommendationStatus = 'pending' | 'approved' | 'declined';

export interface GrantRecommendation {
  id: string;
  contactId: string;
  /** The permission string being recommended (e.g. 'schedule_meetings'). */
  permission: string;
  /** LLM-authored rationale surfaced to the CEO for context. */
  reasoning: string;
  status: GrantRecommendationStatus;
  suggestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
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
  /** Called after a contact's tier is automatically elevated to 'known'.
   *  Fired with the reason for observability/audit trail. Non-throwing. */
  onContactElevated?: (contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment') => void;
}
