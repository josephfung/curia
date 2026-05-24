// src/contacts/types.ts

export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  systemRole: ContactSystemRole | null;
  status: ContactStatus;
  // Trust scoring fields (migration 020)
  contactConfidence: number;         // 0.0–1.0; accumulated over time
  trustLevel: TrustLevel | null;     // nullable per-contact override
  lastSeenAt: Date | null;
  // Message count fields (migration 034) — scoring-owned
  inboundMessageCount: number;
  outboundMessageCount: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  status?: ContactStatus;
  notes?: string;
  /** If provided, links to this existing KG node. Otherwise auto-creates one. */
  kgNodeId?: string;
  source: string;
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
  systemRole: ContactSystemRole | null;
  status: ContactStatus;
  kgNodeId: string | null;
  verified: boolean;
  contactConfidence: number;      // 0.0–1.0
  trustLevel: TrustLevel | null;  // per-contact override, or null
}

/** Enriched context about a sender, assembled for the coordinator's prompt */
export interface SenderContext {
  resolved: true;
  contactId: string;
  displayName: string;
  role: string | null;
  systemRole: ContactSystemRole | null;
  status: ContactStatus;
  verified: boolean;
  kgNodeId: string | null;
  /** Facts from the KG about this person, formatted for prompt inclusion */
  knowledgeSummary: string;
  authorization: AuthorizationResult | null;
  // Trust scoring inputs — available when contact was found in DB. Not propagated to bus events.
  contactConfidence: number;      // 0.0–1.0
  trustLevel: TrustLevel | null;  // per-contact override, or null
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

/** DB-safe subset — matches the CHECK constraint on contacts.system_role (migration 035).
 *  Use this for Contact, ResolvedSender, SenderContext, and findContactBySystemRole(). */
export type ContactSystemRole = 'principal' | 'agent';

/** Full system designation — includes 'system' for operator-configured, platform-executed
 *  work (e.g. declarative YAML jobs). Used by TaskOriginator.systemRole (stored as JSONB,
 *  not in the contacts table).
 *  - 'principal' — the human CEO who Curia serves
 *  - 'agent'     — Curia itself or another autonomous agent
 *  - 'system'    — operator-configured, platform-executed (e.g. declarative YAML jobs)
 */
export type SystemRole = ContactSystemRole | 'system';

// Ordinal ranking for trust level comparison. Higher rank = more trusted.
// Used by meetsMinimumTrust() so callers don't need to enumerate every level.
// Exported so authorization.ts and other consumers share the same single source of truth.
export const TRUST_RANK: Record<TrustLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ceo: 3,
};

/**
 * Check whether an actual trust level meets or exceeds a required minimum.
 * Returns false for null (unknown contacts default to untrusted).
 */
export function meetsMinimumTrust(
  actual: TrustLevel | null,
  required: TrustLevel,
): boolean {
  if (actual === null) return false;
  return TRUST_RANK[actual] >= TRUST_RANK[required];
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
  contactStatus: ContactStatus;
}

export interface AuthConfig {
  roles: Record<string, RolePermissions>;
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
