// src/contacts/types.ts

export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
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
  kgNodeId: string | null;
  verified: boolean;
}

/** Enriched context about a sender, assembled for the coordinator's prompt */
export interface SenderContext {
  resolved: true;
  contactId: string;
  displayName: string;
  role: string | null;
  verified: boolean;
  kgNodeId: string | null;
  /** Facts from the KG about this person, formatted for prompt inclusion */
  knowledgeSummary: string;
}

export interface UnknownSenderContext {
  resolved: false;
  channel: string;
  senderId: string;
}

export type InboundSenderContext = SenderContext | UnknownSenderContext;
