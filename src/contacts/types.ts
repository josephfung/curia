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

export type UnknownSenderPolicy = 'allow' | 'hold_and_notify' | 'reject';

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
