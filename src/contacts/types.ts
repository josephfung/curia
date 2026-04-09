// src/contacts/types.ts

export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  status: ContactStatus;
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
  | 'self_claimed';

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
}

/** Result of resolving an inbound sender */
export interface ResolvedSender {
  contactId: string;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  kgNodeId: string | null;
  verified: boolean;
}

/** Enriched context about a sender, assembled for the coordinator's prompt */
export interface SenderContext {
  resolved: true;
  contactId: string;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  verified: boolean;
  kgNodeId: string | null;
  /** Facts from the KG about this person, formatted for prompt inclusion */
  knowledgeSummary: string;
  authorization: AuthorizationResult | null;
}

export interface UnknownSenderContext {
  resolved: false;
  channel: string;
  senderId: string;
}

export type InboundSenderContext = SenderContext | UnknownSenderContext;

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

export type TrustLevel = 'high' | 'medium' | 'low';

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
}
