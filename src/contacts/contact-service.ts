// src/contacts/contact-service.ts
//
// ContactService: CRUD operations for contacts and their channel identities,
// with automatic KG person-node creation and identity auto-verification.
//
// Follows the backend-interface pattern from WorkingMemory / KnowledgeGraphStore:
// - Private constructor, static factory methods
// - InMemoryContactBackend for tests, PostgresContactBackend for production
// - Business logic (auto-verify, KG linking) lives in ContactService,
//   backends are pure storage

import { randomUUID } from 'node:crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { sanitizeDisplayName } from '../skills/sanitize.js';
import { TRUST_RANK, IdentityNotFoundError } from './types.js';
import type {
  AuthOverride,
  Contact,
  ContactCanonicalFields,
  ContactStatus,
  ChannelIdentity,
  ContactServiceOptions,
  CreateContactOptions,
  DedupConfidence,
  DuplicatePair,
  LinkIdentityOptions,
  MergeGoldenRecord,
  MergeProposal,
  MergeResult,
  ResolvedSender,
  IdentitySource,
  IdentityStatus,
  SystemRole,
  TrustLevel,
} from './types.js';
import type { DedupService } from './dedup-service.js';
import type { ContactCalendar, CreateCalendarLinkOptions, ResolvedCalendar } from './calendar-types.js';

/** Thrown when a caller provides invalid data for a contact field (e.g., primaryEmail not in CCI). */
export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

// -- Backend interface --

interface ContactServiceBackend {
  createContact(contact: Contact): Promise<void>;
  getContact(id: string): Promise<Contact | undefined>;
  findContactByName(name: string): Promise<Contact[]>;
  findContactByRole(role: string): Promise<Contact[]>;
  findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null>;
  listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]>;
  updateContact(contact: Contact): Promise<void>;
  createIdentity(identity: ChannelIdentity): Promise<void>;
  getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]>;
  resolveByChannelIdentity(channel: string, channelIdentifier: string): Promise<ResolvedSender | null>;
  unlinkIdentity(identityId: string): Promise<boolean>;
  setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity>;

  /**
   * Atomically promote a contact from provisional → confirmed only if the contact's
   * current status is still 'provisional' at write time. Returns true if the row was
   * updated, false if the contact was not provisional (concurrent block or already
   * confirmed) — callers should treat false as "promotion did not happen".
   */
  promoteToConfirmed(contactId: string): Promise<boolean>;

  getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>>;
  createAuthOverride(override: AuthOverride): Promise<void>;
  revokeAuthOverride(contactId: string, permission: string): Promise<boolean>;
  createCalendarLink(calendar: ContactCalendar): Promise<void>;
  deleteCalendarLink(nylasCalendarId: string): Promise<boolean>;
  getCalendarsForContact(contactId: string): Promise<ContactCalendar[]>;
  resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null>;
  getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null>;

  /**
   * Re-point all channel identities from fromContactId → toContactId.
   * Identities that would violate UNIQUE(channel, channelIdentifier) are deleted.
   */
  reattachIdentities(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Re-point active auth overrides from fromContactId → toContactId.
   * If primary already has an override for the same permission, secondary's is discarded.
   */
  reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Delete a contact by ID. Call only after FK-referenced rows have been re-pointed.
   */
  deleteContact(id: string): Promise<void>;

  /**
   * Update scoring-owned fields on a contact. Uses atomic increments for message
   * counts to avoid read-modify-write races. Only touches scoring-owned columns —
   * does not modify display_name, role, status, notes, or trust_level.
   */
  updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void>;
}

// -- Auto-verification sources --
// Per spec: ceo_stated, email_participant, crm_import, calendar_attendee are auto-verified.
// signal_participant is also auto-verified — Signal's phone-number identity is stronger than
// email (no header spoofing), so we trust the source number at the same level as email_participant.
// agent_called is auto-verified — the agent extracted the identifier mechanically from the channel
// (e.g. an email sender address), not from LLM-generated content. Same trust level as email_participant.
// Only self_claimed starts unverified and cannot be force-verified.
const AUTO_VERIFIED_SOURCES: ReadonlySet<IdentitySource> = new Set([
  'ceo_stated',
  'email_participant',
  'signal_participant',
  'crm_import',
  'calendar_attendee',
  'agent_called',
]);

/**
 * ContactService manages the lifecycle of contacts and their channel identities.
 *
 * Key behaviors:
 * - Auto-creates a KG person node when a contact is created (if entityMemory is available
 *   and no kgNodeId is provided)
 * - Auto-verifies identities from trusted sources (ceo_stated, email_participant, etc.)
 * - Resolves inbound senders by channel + identifier for dispatch routing
 */
export class ContactService {
  private onContactMerged?: (primaryId: string, secondaryId: string, mergedAt: Date) => void;
  private onIdentityVerified?: (contactId: string) => void;
  private dedupService?: DedupService;
  private onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;

  private constructor(
    private backend: ContactServiceBackend,
    private entityMemory: EntityMemory | undefined,
    private logger?: Logger,
    options?: ContactServiceOptions,
  ) {
    this.onContactMerged = options?.onContactMerged;
    this.onIdentityVerified = options?.onIdentityVerified;
    this.dedupService = options?.dedupService;
    this.onDuplicateDetected = options?.onDuplicateDetected;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    entityMemory: EntityMemory | undefined,
    logger: Logger,
    options?: ContactServiceOptions,
  ): ContactService {
    return new ContactService(new PostgresContactBackend(pool, logger), entityMemory, logger, options);
  }

  /** Create an in-memory instance for testing */
  static createInMemory(entityMemory?: EntityMemory, options?: ContactServiceOptions): ContactService {
    return new ContactService(new InMemoryContactBackend(), entityMemory, undefined, options);
  }

  /**
   * Create a new contact. If entityMemory is available and no kgNodeId is provided,
   * auto-creates a KG person node and links it to the contact.
   */
  async createContact(options: CreateContactOptions): Promise<Contact> {
    const now = new Date();

    // Defense-in-depth: sanitize display names at storage time to prevent
    // stored prompt injection. External sources (email participants, CRM imports)
    // may contain arbitrary content in the name field. See issue #39.
    const safeName = sanitizeDisplayName(
      options.displayName,
      options.fallbackDisplayName,
    );

    // Log when sanitization modifies a display name — important for debugging
    // "why is this contact named X?" questions and for audit-trailing blocked
    // prompt injection attempts.
    if (safeName !== options.displayName && this.logger) {
      // Truncate and strip newlines from the raw value before logging to prevent
      // log injection (a crafted name with embedded newlines + JSON could forge
      // synthetic log entries in line-oriented log viewers).
      const safeOriginal = options.displayName.slice(0, 500).replace(/[\r\n]/g, '\\n');
      this.logger.warn(
        { original: safeOriginal, sanitized: safeName, source: options.source },
        'Display name was modified by sanitization',
      );
    }

    // Auto-create a KG person node if we have entityMemory and no explicit kgNodeId
    let kgNodeId: string | null = options.kgNodeId ?? null;
    if (!kgNodeId && this.entityMemory) {
      const { entity, created } = await this.entityMemory.createEntity({
        type: 'person',
        label: safeName,
        properties: options.role ? { role: options.role } : {},
        source: options.source,
      });
      if (!created && options.role) {
        // A KG node already existed for this label. Apply the role property if
        // it isn't already set — the existing node may have been created without
        // one (e.g. by extract-relationships which always passes empty properties).
        const { node } = await this.entityMemory.updateNode(entity.id, {
          properties: { ...entity.properties, role: options.role },
        });
        kgNodeId = node.id;
      } else {
        kgNodeId = entity.id;
      }
    }

    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: safeName,
      role: options.role ?? null,
      // system_role is set only by bootstrap via direct SQL or updateContact; new contacts
      // created through the normal flow always start with null and get assigned explicitly.
      systemRole: null,
      status: options.status ?? 'confirmed',
      // Trust scoring fields default to zero/null on creation; updated by the scoring pipeline
      contactConfidence: 0,
      trustLevel: null,
      lastSeenAt: null,
      inboundMessageCount: 0,
      outboundMessageCount: 0,
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
      // Canonical fields (migration 048)
      preferredName: options.preferredName ?? null,
      title: options.title ?? null,
      organization: options.organization ?? null,
      primaryEmail: options.primaryEmail?.toLowerCase() ?? null,
      primaryPhone: options.primaryPhone ?? null,
      timezone: options.timezone ?? null,
      locale: options.locale ?? null,
      location: options.location ?? null,
      pronouns: options.pronouns ?? null,
      linkedinUrl: options.linkedinUrl ?? null,
      bio: options.bio ?? null,
      birthday: options.birthday ?? null,
    };

    try {
      await this.backend.createContact(contact);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const constraint = (err as { constraint?: string }).constraint;
      // idx_contacts_kg_node_unique (partial unique index on kg_node_id) fires when
      // upsertNode returned an existing kg_node that is already claimed by another
      // contact — e.g. two people both named "Alice Smith". Retry without a KG link;
      // the two contacts can be merged later via the contact-merge flow.
      if (pgCode === '23505' && constraint === 'idx_contacts_kg_node_unique') {
        this.logger?.warn(
          { contactId: contact.id, kgNodeId: contact.kgNodeId },
          'KG node already claimed by another contact — creating contact without KG link',
        );
        contact.kgNodeId = null;
        await this.backend.createContact(contact);
      } else {
        // TODO: The KG node auto-created above is now orphaned — it exists in the knowledge
        // graph with no corresponding contact row. Clean up once EntityMemory exposes a
        // delete method. For now the orphan is harmless (person node with no contact link).
        this.logger?.error({ err, contactId: contact.id }, 'Contact creation failed');
        throw err;
      }
    }

    // Fire-and-forget dedup check. Runs asynchronously — never blocks the create.
    // A failure here is logged and swallowed; it must not fail the contact creation.
    // Capture references before the closure so TypeScript narrowing is preserved
    // and no non-null assertions (!!) are needed inside the async callback.
    const { dedupService, onDuplicateDetected } = this;
    if (dedupService && onDuplicateDetected) {
      setImmediate(async () => {
        try {
          const allContacts = await this.backend.listContacts();
          const others = allContacts.filter((c) => c.id !== contact.id);
          const identitiesMap = new Map<string, ChannelIdentity[]>();
          for (const c of others) {
            identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
          }
          const newIdentities = await this.backend.getIdentitiesForContact(contact.id);
          const pairs = dedupService.checkForDuplicates(
            contact,
            newIdentities,
            others,
            identitiesMap,
          );
          for (const pair of pairs) {
            const matchId = pair.contactB.id === contact.id ? pair.contactA.id : pair.contactB.id;
            try {
              onDuplicateDetected(contact.id, matchId, pair.confidence, pair.reason);
            } catch (callbackErr) {
              this.logger?.warn({ err: callbackErr }, 'onDuplicateDetected callback threw (ignored)');
            }
          }
        } catch (err) {
          this.logger?.warn({ err, contactId: contact.id }, 'Dedup check failed (non-fatal)');
        }
      });
    }

    return contact;
  }

  /** Retrieve a contact by ID. Returns undefined if not found. */
  async getContact(id: string): Promise<Contact | undefined> {
    return this.backend.getContact(id);
  }

  /** Find contacts by display name (case-insensitive exact match). */
  async findContactByName(name: string): Promise<Contact[]> {
    return this.backend.findContactByName(name);
  }

  /** Find contacts by role. */
  async findContactByRole(role: string): Promise<Contact[]> {
    return this.backend.findContactByRole(role);
  }

  /** Find the single contact with the given system role, or null. */
  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    return this.backend.findContactBySystemRole(systemRole);
  }

  /** List contacts, optionally filtered by status and/or capped by limit. */
  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    return this.backend.listContacts(filters);
  }

  /**
   * Scan all contacts for probable duplicates.
   *
   * Fetches all contacts and their identities, then delegates to DedupService
   * for scoring. Returns empty list if no DedupService is wired.
   *
   * @param minConfidence - filter threshold (default: 'probable')
   */
  async findDuplicates(minConfidence: DedupConfidence = 'probable'): Promise<DuplicatePair[]> {
    if (!this.dedupService) {
      this.logger?.warn('findDuplicates() called but no DedupService wired — returning empty');
      return [];
    }
    try {
      const contacts = await this.backend.listContacts();
      const identitiesMap = new Map<string, ChannelIdentity[]>();
      for (const c of contacts) {
        identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
      }
      return this.dedupService.findAllDuplicates(contacts, identitiesMap, minConfidence);
    } catch (err) {
      // Log context before rethrowing — the skill handler's error will reference the raw
      // backend error with no indication it came from a full-contact-list scan.
      this.logger?.error({ err }, 'findDuplicates() failed during contact scan');
      throw err;
    }
  }

  /**
   * Sanitize the display name before persisting any contact update.
   * Defense-in-depth: catches names that were stored before the creation-time
   * sanitization gate (PR #63), and ensures any future update path that
   * routes through here cannot bypass sanitization. See issue #64 / #39.
   */
  private async updateStoredContact(contact: Contact): Promise<Contact> {
    const safeName = sanitizeDisplayName(contact.displayName);
    const updatedContact =
      safeName === contact.displayName
        ? contact
        : {
            ...contact,
            displayName: safeName,
          };

    if (safeName !== contact.displayName && this.logger) {
      const safeOriginal = contact.displayName.slice(0, 500).replace(/[\r\n]/g, '\\n');
      this.logger.warn(
        { contactId: contact.id, original: safeOriginal, sanitized: safeName },
        'Display name was modified by sanitization during contact update',
      );
    }

    await this.backend.updateContact(updatedContact);
    return updatedContact;
  }

  /**
   * Update a contact's display name with sanitization.
   * This is the only sanctioned way to change a display name after creation —
   * callers must go through this method so the sanitization gate is enforced.
   */
  async updateDisplayName(contactId: string, displayName: string): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      displayName,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }

  /** Update a contact's role and updatedAt timestamp. */
  async setRole(contactId: string, role: string): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      role,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }

  /**
   * Set or clear a contact's per-contact trust level override.
   *
   * trust_level = 'high' grants the contact access to third-party contact data
   * in outbound responses (same as the CEO). Use for the CEO's EA, CFO, or any
   * other party the CEO explicitly trusts with contact information.
   *
   * Pass null to remove the override and revert to the channel default.
   */
  async setTrustLevel(contactId: string, trustLevel: TrustLevel | null): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      trustLevel,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }

  /**
   * Link a channel identity to a contact.
   *
   * Auto-verification logic: sources ceo_stated, email_participant, crm_import,
   * and calendar_attendee are auto-verified. self_claimed starts unverified.
   * If options.verified is explicitly provided, that takes precedence.
   */
  async linkIdentity(options: LinkIdentityOptions): Promise<ChannelIdentity> {
    // Validate the contact exists before creating an identity for it.
    // Postgres would catch this via FK constraint, but the in-memory backend
    // would silently create a dangling reference without this check.
    const contact = await this.backend.getContact(options.contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${options.contactId}`);
    }

    const now = new Date();

    // Determine verification status: explicit override > auto-verify logic
    let verified: boolean;
    if (options.verified !== undefined) {
      verified = options.verified;
    } else {
      verified = AUTO_VERIFIED_SOURCES.has(options.source);
    }

    // Prevent force-verifying self-claimed identities — they must go through
    // the CEO confirmation flow to become verified.
    if (options.source === 'self_claimed' && verified) {
      throw new Error('Cannot force-verify a self_claimed identity — CEO confirmation required');
    }

    // Normalize email addresses to lowercase for case-insensitive matching.
    // RFC 5321 allows case-sensitive local-parts, but in practice no major
    // provider enforces this — storing mixed-case causes lookup misses when
    // the LLM or inbound adapter uses a different casing.
    const normalizedIdentifier = options.channel === 'email'
      ? options.channelIdentifier.toLowerCase()
      : options.channelIdentifier;

    const identity: ChannelIdentity = {
      id: randomUUID(),
      contactId: options.contactId,
      channel: options.channel,
      channelIdentifier: normalizedIdentifier,
      label: options.label ?? null,
      verified,
      verifiedAt: verified ? now : null,
      status: options.status ?? 'active',
      source: options.source,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createIdentity(identity);

    // Fire-and-forget: notify scoring pipeline when a verified identity is linked.
    // The callback may return a promise (async pipeline update), so we handle both
    // sync throws and async rejections. Scoring is non-blocking — must not fail
    // the linkIdentity operation.
    if (verified && this.onIdentityVerified) {
      try {
        const maybePromise = this.onIdentityVerified(options.contactId) as void | Promise<void>;
        // Handle async callbacks — catch unhandled rejections
        if (maybePromise instanceof Promise) {
          maybePromise.catch(err => {
            this.logger?.warn({ err, contactId: options.contactId }, 'onIdentityVerified callback rejected (non-fatal)');
          });
        }
      } catch (err) {
        this.logger?.warn({ err, contactId: options.contactId }, 'onIdentityVerified callback threw (non-fatal)');
      }
    }

    return identity;
  }

  /**
   * Resolve an inbound sender by channel + identifier.
   * Joins contacts with contact_channel_identities to find the matching contact.
   * Returns null if no match.
   */
  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    return this.backend.resolveByChannelIdentity(channel, channelIdentifier);
  }

  /** Get a contact together with all its linked channel identities. */
  async getContactWithIdentities(
    id: string,
  ): Promise<{ contact: Contact; identities: ChannelIdentity[] } | undefined> {
    const contact = await this.backend.getContact(id);
    if (!contact) {
      return undefined;
    }

    const identities = await this.backend.getIdentitiesForContact(id);
    return { contact, identities };
  }

  /** Update a contact's status (confirmed, provisional, blocked). */
  async setStatus(contactId: string, status: ContactStatus): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      status,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }

  /**
   * Validate that `primaryEmail` is present in `contact_channel_identities` for this
   * contact (channel = 'email', case-insensitive). Throws `ContactValidationError` if not.
   * Call this before any writes when the PATCH handler needs to reject invalid emails
   * without producing partial mutations.
   */
  async validatePrimaryEmail(contactId: string, primaryEmail: string): Promise<void> {
    const identities = await this.backend.getIdentitiesForContact(contactId);
    const emailLower = primaryEmail.toLowerCase();
    const match = identities.find(
      (i) => i.channel === 'email' && i.channelIdentifier.toLowerCase() === emailLower,
    );
    if (!match) {
      throw new ContactValidationError(
        `primaryEmail '${primaryEmail}' not found in contact_channel_identities for contact ${contactId}`,
      );
    }
  }

  /**
   * Update canonical profile attributes on a contact.
   *
   * Only fields present in `fields` are changed — absent keys leave the current
   * value untouched. If `fields.primaryEmail` is non-null, validates that the
   * email exists in `contact_channel_identities` for this contact (channel = 'email'),
   * case-insensitively. Throws with a descriptive message if not found.
   */
  async updateContactFields(
    contactId: string,
    fields: ContactCanonicalFields,
  ): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    // Validate primaryEmail against channel identities before writing.
    if (fields.primaryEmail != null) {
      const identities = await this.backend.getIdentitiesForContact(contactId);
      const emailLower = fields.primaryEmail.toLowerCase();
      const match = identities.find(
        (i) => i.channel === 'email' && i.channelIdentifier.toLowerCase() === emailLower,
      );
      if (!match) {
        throw new ContactValidationError(
          `primaryEmail '${fields.primaryEmail}' not found in contact_channel_identities for contact ${contactId}`,
        );
      }
    }

    // Filter undefined entries — spreading undefined values would clear existing columns on
    // a partial PATCH (Object spread copies undefined keys, which overwrite non-undefined values).
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as ContactCanonicalFields;

    // Normalize primaryEmail to lowercase for consistent storage and CCI comparison.
    if (definedFields.primaryEmail != null) {
      definedFields.primaryEmail = definedFields.primaryEmail.toLowerCase();
    }

    const updated: Contact = {
      ...contact,
      ...definedFields,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }

  /**
   * Atomically promote a contact from provisional → confirmed.
   * Returns true if the promotion happened, false if the contact was not provisional
   * at write time (concurrent block or already confirmed). This is the preferred
   * method for auto-promotion: it prevents TOCTOU races where a concurrent admin
   * block could be silently overwritten by an unconditional setStatus call.
   */
  async promoteToConfirmed(contactId: string): Promise<boolean> {
    return this.backend.promoteToConfirmed(contactId);
  }

  /** Remove a channel identity by its ID. Returns true if found and removed, false if not found. */
  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.backend.unlinkIdentity(identityId);
  }

  /** Update the status of a channel identity (active, defunct, bounced). */
  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    return this.backend.setIdentityStatus(identityId, status);
  }

  /** Get active (non-revoked) auth overrides for a contact. */
  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    return this.backend.getAuthOverrides(contactId);
  }

  /**
   * Grant or deny a specific permission for a contact.
   * Uses upsert — if an active override already exists for this contact+permission,
   * it gets replaced.
   */
  async grantPermission(contactId: string, permission: string, granted: boolean, grantedBy: string): Promise<void> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const override: AuthOverride = {
      id: randomUUID(),
      contactId,
      permission,
      granted,
      grantedBy,
      createdAt: new Date(),
      revokedAt: null,
    };

    await this.backend.createAuthOverride(override);
  }

  /** Soft-revoke an auth override for a specific contact+permission. Returns true if an active override was found and revoked, false if nothing matched. */
  async revokePermission(contactId: string, permission: string): Promise<boolean> {
    return this.backend.revokeAuthOverride(contactId, permission);
  }

  /**
   * Link a calendar to a contact (or null for org-wide calendars).
   * Validates the contact exists (if contactId is non-null) and enforces
   * uniqueness on nylas_calendar_id and at-most-one-primary-per-contact.
   */
  async linkCalendar(options: CreateCalendarLinkOptions): Promise<ContactCalendar> {
    // Validate the contact exists if a contactId is provided
    if (options.contactId !== null) {
      const contact = await this.backend.getContact(options.contactId);
      if (!contact) {
        throw new Error(`Contact not found: ${options.contactId}`);
      }
    }

    const now = new Date();
    const calendar: ContactCalendar = {
      id: randomUUID(),
      nylasCalendarId: options.nylasCalendarId,
      contactId: options.contactId,
      label: options.label,
      isPrimary: options.isPrimary ?? false,
      readOnly: options.readOnly ?? false,
      timezone: options.timezone ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createCalendarLink(calendar);
    return calendar;
  }

  /** Remove a calendar association by its Nylas calendar ID. */
  async unlinkCalendar(nylasCalendarId: string): Promise<boolean> {
    return this.backend.deleteCalendarLink(nylasCalendarId);
  }

  /** Get all calendars linked to a contact. */
  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    return this.backend.getCalendarsForContact(contactId);
  }

  /** Resolve a Nylas calendar ID to its registry entry. Returns null if unregistered. */
  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    return this.backend.resolveCalendar(nylasCalendarId);
  }

  /** Get the primary calendar for a contact. Returns null if no primary is set. */
  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    return this.backend.getPrimaryCalendar(contactId);
  }

  /**
   * Merge secondary contact into primary.
   *
   * Golden record survivorship rules:
   * - display_name, role: most-recent-wins (primary wins on tie)
   * - notes: concatenate with separator
   * - status: most-restrictive wins (blocked > provisional > confirmed)
   * - channel identities: union (duplicates discarded)
   * - auth overrides: union (primary wins on same-permission conflict)
   * - KG nodes: merged via entityMemory.mergeEntities() (Phase 1: scalar + facts)
   *
   * @param dryRun - if true, return proposal without writing (default: false)
   */
  async mergeContacts(
    primaryId: string,
    secondaryId: string,
    dryRun = false,
  ): Promise<MergeProposal | MergeResult> {
    if (primaryId === secondaryId) {
      throw new Error('primary_contact_id and secondary_contact_id must be different');
    }

    const primary = await this.backend.getContact(primaryId);
    if (!primary) throw new Error(`Contact not found: ${primaryId}`);
    const secondary = await this.backend.getContact(secondaryId);
    if (!secondary) throw new Error(`Contact not found: ${secondaryId}`);

    const primaryIdentities = await this.backend.getIdentitiesForContact(primaryId);
    const secondaryIdentities = await this.backend.getIdentitiesForContact(secondaryId);
    const primaryOverrides = await this.backend.getAuthOverrides(primaryId);
    const secondaryOverrides = await this.backend.getAuthOverrides(secondaryId);

    const goldenRecord = this.computeGoldenRecord(
      primary, primaryIdentities, primaryOverrides,
      secondary, secondaryIdentities, secondaryOverrides,
    );

    if (dryRun) {
      return { primaryContactId: primaryId, secondaryContactId: secondaryId, goldenRecord, dryRun: true };
    }

    // Merge KG nodes (best-effort — failure does not abort the contact merge)
    if (primary.kgNodeId && secondary.kgNodeId && this.entityMemory) {
      try {
        await this.entityMemory.mergeEntities(primary.kgNodeId, secondary.kgNodeId);
      } catch (err) {
        this.logger?.warn({ err, primaryId, secondaryId, primaryKgNodeId: primary.kgNodeId, secondaryKgNodeId: secondary.kgNodeId }, 'KG node merge failed (non-fatal)');
      }
    }

    try {
      await this.backend.reattachIdentities(secondaryId, primaryId);
      await this.backend.reattachAuthOverrides(secondaryId, primaryId);

      // Write the golden record fields onto the primary contact
      const updatedPrimary: Contact = {
        ...primary,
        displayName: goldenRecord.displayName,
        role: goldenRecord.role,
        notes: goldenRecord.notes,
        status: goldenRecord.status,
        updatedAt: new Date(),
      };
      await this.backend.updateContact(updatedPrimary);
      await this.backend.deleteContact(secondaryId);
    } catch (err) {
      this.logger?.error({ err, primaryId, secondaryId }, 'Contact merge write failed — DB may be in partial state');
      throw err;
    }

    const mergedAt = new Date();

    if (this.onContactMerged) {
      try {
        this.onContactMerged(primaryId, secondaryId, mergedAt);
      } catch (callbackErr) {
        // The merge is already fully committed at this point — swallow the callback error
        // so the caller sees a successful merge result rather than a spurious failure.
        this.logger?.warn({ err: callbackErr }, 'onContactMerged callback threw (non-fatal, merge already committed)');
      }
    }

    this.logger?.info({ primaryId, secondaryId }, 'Contacts merged');

    return {
      primaryContactId: primaryId,
      secondaryContactId: secondaryId,
      goldenRecord,
      dryRun: false,
      mergedAt,
    };
  }

  /**
   * Delete a contact by ID. Should only be called after any FK-referenced rows
   * (identities, auth overrides) have been re-pointed or deleted, otherwise the
   * DB will reject with a foreign-key constraint error.
   *
   * Primarily used during contact merge (to remove the secondary) and during
   * error recovery (to remove orphaned contacts created by a failed identify).
   */
  async deleteContact(id: string): Promise<void> {
    await this.backend.deleteContact(id);
  }

  /**
   * Update scoring-owned fields. Delegates to the backend's atomic increment path.
   * Called by ConfidencePipeline — not intended for direct use by skills or other callers.
   */
  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    // Reject NaN/Infinity — these would silently corrupt the DB or cause a Postgres error
    // depending on the column type. Better to fail loudly here than silently at write-time.
    if (!Number.isFinite(updates.contactConfidence)) {
      throw new Error(`contact-service: contactConfidence must be a finite number, got ${updates.contactConfidence}`);
    }
    // Clamp to [0, 1] as a last-resort safety net. computeConfidence() already clamps,
    // but this guards against callers that bypass the pipeline.
    const contactConfidence = Math.max(0, Math.min(1, updates.contactConfidence));
    await this.backend.updateScoringFields(contactId, { ...updates, contactConfidence });
  }

  private computeGoldenRecord(
    primary: Contact,
    primaryIdentities: ChannelIdentity[],
    primaryOverrides: Array<{ permission: string; granted: boolean }>,
    secondary: Contact,
    secondaryIdentities: ChannelIdentity[],
    secondaryOverrides: Array<{ permission: string; granted: boolean }>,
  ): MergeGoldenRecord {
    const primaryIsMoreRecent = primary.updatedAt.getTime() >= secondary.updatedAt.getTime();

    const displayName = primaryIsMoreRecent
      ? (primary.displayName || secondary.displayName)
      : (secondary.displayName || primary.displayName);

    const role = primaryIsMoreRecent
      ? (primary.role ?? secondary.role)
      : (secondary.role ?? primary.role);

    // Both notes are preserved — neither is discarded
    const noteParts = [primary.notes, secondary.notes].filter(Boolean);
    const notes = noteParts.length > 0 ? noteParts.join('\n---\n') : null;

    // Most-restrictive status wins: blocked > provisional > confirmed
    const STATUS_RANK: Record<ContactStatus, number> = { blocked: 3, provisional: 2, confirmed: 1 };
    const status: ContactStatus =
      STATUS_RANK[primary.status] >= STATUS_RANK[secondary.status]
        ? primary.status
        : secondary.status;

    // Union of identities — deduplicated by channel:channelIdentifier key
    const identityKeys = new Set<string>();
    const identities: ChannelIdentity[] = [];
    for (const identity of [...primaryIdentities, ...secondaryIdentities]) {
      const key = `${identity.channel}:${identity.channelIdentifier}`;
      if (!identityKeys.has(key)) {
        identityKeys.add(key);
        identities.push(identity);
      }
    }

    // Union of auth overrides — primary wins on same-permission conflict
    const overridePerms = new Set<string>(primaryOverrides.map(o => o.permission));
    const authOverrides = [...primaryOverrides];
    for (const override of secondaryOverrides) {
      if (!overridePerms.has(override.permission)) {
        authOverrides.push(override);
      }
    }

    return { displayName, role, notes, status, identities, authOverrides };
  }
}

// -- Postgres-specific row shape (all 26 columns) --
// Shared across all queries that return a full Contact record.
// The 12 canonical fields (added in migration 048) are always
// null-safe — they default to null when the column was added after
// the row was first written.
type ContactRow = {
  id: string;
  kg_node_id: string | null;
  display_name: string;
  role: string | null;
  system_role: string | null;
  status: string;
  contact_confidence: string;
  trust_level: string | null;
  last_seen_at: Date | null;
  inbound_message_count: string;
  outbound_message_count: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  // Canonical fields (migration 048)
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
};

// Column list for all SELECT queries that return a full Contact row.
const CONTACT_COLS =
  'id, kg_node_id, display_name, role, system_role, status, contact_confidence, trust_level, ' +
  'last_seen_at, inbound_message_count, outbound_message_count, notes, created_at, updated_at, ' +
  'preferred_name, title, organization, primary_email, primary_phone, timezone, locale, location, ' +
  'pronouns, linkedin_url, bio, birthday';

// -- Postgres backend --

/**
 * Postgres-backed storage for contacts and channel identities.
 * Uses parameterized queries throughout — never interpolates user input into SQL.
 */
class PostgresContactBackend implements ContactServiceBackend {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  async createContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: creating contact');
    await this.pool.query(
      `INSERT INTO contacts (
         id, kg_node_id, display_name, role, system_role, status, notes, created_at, updated_at,
         preferred_name, title, organization, primary_email, primary_phone, timezone, locale,
         location, pronouns, linkedin_url, bio, birthday
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.status, contact.notes, contact.createdAt, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.rowToContact(row);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) so partial names like "Jo" match "Jo Brennan".
    // Uses ILIKE with wildcards — the idx_contacts_display_name btree index won't help here,
    // but the contacts table is small (hundreds, not millions) so a seq scan is fine.
    // For exact match, the caller can filter the results further.
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE display_name ILIKE $1`,
      [`%${name}%`],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE role = $1 ORDER BY created_at ASC`,
      [role],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE system_role = $1 LIMIT 1`,
      [systemRole],
    );

    const row = result.rows[0];
    if (!row) return null;
    return this.rowToContact(row);
  }

  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status != null) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${CONTACT_COLS} FROM contacts${where} ORDER BY created_at ASC`;

    if (filters?.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const result = await this.pool.query<ContactRow>(sql, params);

    return result.rows.map((row) => this.rowToContact(row));
  }

  async updateContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: updating contact');
    // trust_level is included because ContactService.setTrustLevel writes through this path.
    // system_role is included so bootstrap and any future setter can persist it through the standard update path.
    // contact_confidence and last_seen_at remain scoring-owned and are not updated here.
    await this.pool.query(
      `UPDATE contacts SET
         kg_node_id = $2, display_name = $3, role = $4, system_role = $5, status = $6,
         notes = $7, trust_level = $8, updated_at = $9,
         preferred_name = $10, title = $11, organization = $12, primary_email = $13,
         primary_phone = $14, timezone = $15, locale = $16, location = $17,
         pronouns = $18, linkedin_url = $19, bio = $20, birthday = $21
       WHERE id = $1`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.status, contact.notes, contact.trustLevel, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }

  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    this.logger.debug({ contactId }, 'contacts: updating scoring fields');
    await this.pool.query(
      `UPDATE contacts
       SET contact_confidence = $2,
           inbound_message_count = inbound_message_count + $3,
           outbound_message_count = outbound_message_count + $4,
           last_seen_at = COALESCE($5, last_seen_at),
           updated_at = now()
       WHERE id = $1`,
      [
        contactId,
        updates.contactConfidence,
        updates.inboundMessageCountDelta ?? 0,
        updates.outboundMessageCountDelta ?? 0,
        updates.lastSeenAt ?? null,
      ],
    );
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    this.logger.debug(
      { identityId: identity.id, contactId: identity.contactId, channel: identity.channel },
      'contacts: creating channel identity',
    );
    await this.pool.query(
      `INSERT INTO contact_channel_identities
         (id, contact_id, channel, channel_identifier, label, verified, verified_at, source, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        identity.id,
        identity.contactId,
        identity.channel,
        identity.channelIdentifier,
        identity.label,
        identity.verified,
        identity.verifiedAt,
        identity.source,
        identity.status,
        identity.createdAt,
        identity.updatedAt,
      ],
    );
  }

  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at
       FROM contact_channel_identities WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );

    return result.rows.map((row) => this.rowToIdentity(row));
  }

  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    // Normalize email lookups to lowercase so mixed-case entries (stored before
    // write-time normalization was added) are still matched.
    const normalizedId = channel === 'email'
      ? channelIdentifier.toLowerCase()
      : channelIdentifier;

    const result = await this.pool.query<{
      id: string;
      display_name: string;
      role: string | null;
      system_role: string | null;
      status: string;
      kg_node_id: string | null;
      verified: boolean;
      contact_confidence: string;  // NUMERIC returned as string by node-pg
      trust_level: string | null;
    }>(
      `SELECT c.id, c.display_name, c.role, c.system_role, c.status, c.kg_node_id, cci.verified,
              c.contact_confidence, c.trust_level
       FROM contact_channel_identities cci
       JOIN contacts c ON c.id = cci.contact_id
       WHERE cci.channel = $1
         AND CASE WHEN $1 = 'email' THEN LOWER(cci.channel_identifier) = $2
                  ELSE cci.channel_identifier = $2 END`,
      [channel, normalizedId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      contactId: row.id,
      displayName: row.display_name,
      role: row.role,
      // Validate system_role — DB CHECK constraint normally prevents invalid values, but
      // guard defensively the same way we guard trust_level below.
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent') ? row.system_role : null,
      status: row.status as ContactStatus,
      kgNodeId: row.kg_node_id,
      verified: row.verified,
      // PostgreSQL returns NUMERIC as a string via node-pg.
      // Guard against NaN — if migration 020 hasn't run, the column is absent and
      // parseFloat(undefined) = NaN, which would silently corrupt trust score computation.
      contactConfidence: (() => {
        const v = parseFloat(row.contact_confidence);
        return isFinite(v) ? v : 0.0;
      })(),
      // Validate trust_level against the allowed enum — the DB CHECK constraint prevents
      // invalid values under normal operation, but a direct DB edit or future migration
      // could introduce an unexpected value that produces NaN via an undefined lookup.
      trustLevel: (Object.keys(TRUST_RANK) as TrustLevel[]).includes(row.trust_level as TrustLevel)
        ? row.trust_level as TrustLevel
        : null,
    };
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    this.logger.debug({ identityId }, 'Unlinking channel identity');
    const result = await this.pool.query('DELETE FROM contact_channel_identities WHERE id = $1', [identityId]);
    return (result.rowCount ?? 0) > 0;
  }

  async promoteToConfirmed(contactId: string): Promise<boolean> {
    // Atomic conditional update — only flips to confirmed when status is STILL
    // 'provisional' at DB write time. Guards against concurrent blocks between
    // the caller's last getContact check and this write (TOCTOU mitigation).
    const result = await this.pool.query(
      `UPDATE contacts SET status = 'confirmed', updated_at = now() WHERE id = $1 AND status = 'provisional'`,
      [contactId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    this.logger.debug({ identityId, status }, 'contacts: updating identity status');
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE contact_channel_identities
       SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at`,
      [status, identityId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new IdentityNotFoundError(identityId);
    }
    return this.rowToIdentity(row);
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    const result = await this.pool.query<{
      permission: string;
      granted: boolean;
    }>(
      `SELECT permission, granted FROM contact_auth_overrides
       WHERE contact_id = $1 AND revoked_at IS NULL`,
      [contactId],
    );

    return result.rows.map((row) => ({
      permission: row.permission,
      granted: row.granted,
    }));
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    this.logger.debug(
      { contactId: override.contactId, permission: override.permission, granted: override.granted },
      'contacts: creating auth override',
    );
    // Upsert: if an active override exists for this contact+permission, update it.
    // The UNIQUE(contact_id, permission) constraint on the table supports this.
    await this.pool.query(
      `INSERT INTO contact_auth_overrides (id, contact_id, permission, granted, granted_by, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (contact_id, permission) DO UPDATE
         SET granted = EXCLUDED.granted,
             granted_by = EXCLUDED.granted_by,
             created_at = EXCLUDED.created_at,
             revoked_at = NULL`,
      [override.id, override.contactId, override.permission, override.granted, override.grantedBy, override.createdAt, override.revokedAt],
    );
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<boolean> {
    this.logger.debug({ contactId, permission }, 'Revoking auth override');
    const result = await this.pool.query(
      `UPDATE contact_auth_overrides SET revoked_at = now()
       WHERE contact_id = $1 AND permission = $2 AND revoked_at IS NULL`,
      [contactId, permission],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    this.logger.debug({ calendarId: calendar.id, nylasCalendarId: calendar.nylasCalendarId }, 'contacts: linking calendar');
    await this.pool.query(
      `INSERT INTO contact_calendars (id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [calendar.id, calendar.nylasCalendarId, calendar.contactId, calendar.label, calendar.isPrimary, calendar.readOnly, calendar.timezone, calendar.createdAt, calendar.updatedAt],
    );
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    this.logger.debug({ nylasCalendarId }, 'contacts: unlinking calendar');
    const result = await this.pool.query(
      'DELETE FROM contact_calendars WHERE nylas_calendar_id = $1',
      [nylasCalendarId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );
    return result.rows.map((row) => this.rowToCalendar(row));
  }

  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    const result = await this.pool.query<{
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
    }>(
      `SELECT contact_id, label, is_primary, read_only
       FROM contact_calendars WHERE nylas_calendar_id = $1`,
      [nylasCalendarId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
    };
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 AND is_primary = true`,
      [contactId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToCalendar(row);
  }

  async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
    // Delete identities that would conflict with the primary's existing ones
    await this.pool.query(
      `DELETE FROM contact_channel_identities
       WHERE contact_id = $1
         AND (channel, channel_identifier) IN (
           SELECT channel, channel_identifier
           FROM contact_channel_identities
           WHERE contact_id = $2
         )`,
      [fromContactId, toContactId],
    );
    await this.pool.query(
      `UPDATE contact_channel_identities SET contact_id = $1 WHERE contact_id = $2`,
      [toContactId, fromContactId],
    );
  }

  async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM contact_auth_overrides
       WHERE contact_id = $1
         AND revoked_at IS NULL
         AND permission IN (
           SELECT permission FROM contact_auth_overrides
           WHERE contact_id = $2 AND revoked_at IS NULL
         )`,
      [fromContactId, toContactId],
    );
    // Only re-point active (non-revoked) rows; revoked rows stay on the secondary
    // and will be effectively deleted when the secondary contact is deleted.
    await this.pool.query(
      `UPDATE contact_auth_overrides SET contact_id = $1 WHERE contact_id = $2 AND revoked_at IS NULL`,
      [toContactId, fromContactId],
    );
  }

  async deleteContact(id: string): Promise<void> {
    this.logger.debug({ contactId: id }, 'contacts: deleting contact');
    await this.pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
  }

  // -- Row mapping helpers --

  private rowToContact(row: ContactRow): Contact {
    return {
      id: row.id,
      kgNodeId: row.kg_node_id,
      displayName: row.display_name,
      role: row.role,
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent' || row.system_role === 'system')
        ? row.system_role
        : null,
      status: row.status as ContactStatus,
      // PostgreSQL returns NUMERIC as a string via node-pg.
      // Guard against NaN — if migration 020 hasn't run, the column is absent and
      // parseFloat(undefined) = NaN, which would silently corrupt trust score computation.
      contactConfidence: (() => {
        const v = parseFloat(row.contact_confidence);
        return isFinite(v) ? v : 0.0;
      })(),
      trustLevel: (Object.keys(TRUST_RANK) as TrustLevel[]).includes(row.trust_level as TrustLevel)
        ? row.trust_level as TrustLevel
        : null,
      lastSeenAt: row.last_seen_at,
      inboundMessageCount: parseInt(row.inbound_message_count, 10) || 0,
      outboundMessageCount: parseInt(row.outbound_message_count, 10) || 0,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Canonical fields (migration 048)
      preferredName: row.preferred_name,
      title: row.title,
      organization: row.organization,
      primaryEmail: row.primary_email,
      primaryPhone: row.primary_phone,
      timezone: row.timezone,
      locale: row.locale,
      location: row.location,
      pronouns: row.pronouns,
      linkedinUrl: row.linkedin_url,
      bio: row.bio,
      birthday: row.birthday,
    };
  }

  private rowToIdentity(row: {
    id: string;
    contact_id: string;
    channel: string;
    channel_identifier: string;
    label: string | null;
    verified: boolean;
    verified_at: Date | null;
    status: string;
    source: string;
    created_at: Date;
    updated_at: Date;
  }): ChannelIdentity {
    return {
      id: row.id,
      contactId: row.contact_id,
      channel: row.channel,
      channelIdentifier: row.channel_identifier,
      label: row.label,
      verified: row.verified,
      verifiedAt: row.verified_at,
      status: row.status as IdentityStatus,
      source: row.source as IdentitySource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToCalendar(row: {
    id: string;
    nylas_calendar_id: string;
    contact_id: string | null;
    label: string;
    is_primary: boolean;
    read_only: boolean;
    timezone: string | null;
    created_at: Date;
    updated_at: Date;
  }): ContactCalendar {
    return {
      id: row.id,
      nylasCalendarId: row.nylas_calendar_id,
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
      timezone: row.timezone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// -- In-memory backend --

/**
 * In-memory storage for testing. No database required.
 * Uses Maps for contacts and identities, with array scans for search operations.
 */
class InMemoryContactBackend implements ContactServiceBackend {
  private contacts = new Map<string, Contact>();
  private identities = new Map<string, ChannelIdentity>();
  private overrides = new Map<string, AuthOverride>();
  private calendars = new Map<string, ContactCalendar>();

  async createContact(contact: Contact): Promise<void> {
    // Enforce the partial unique index idx_contacts_kg_node_unique to match Postgres.
    if (contact.kgNodeId !== null) {
      for (const existing of this.contacts.values()) {
        if (existing.kgNodeId === contact.kgNodeId) {
          const err = Object.assign(new Error('duplicate key value violates unique constraint "idx_contacts_kg_node_unique"'), {
            code: '23505',
            constraint: 'idx_contacts_kg_node_unique',
          });
          throw err;
        }
      }
    }
    // Enforce system_role uniqueness to match Postgres partial unique indexes
    if (contact.systemRole) {
      for (const existing of this.contacts.values()) {
        if (existing.systemRole === contact.systemRole) {
          const err = Object.assign(
            new Error(`duplicate key value violates unique constraint "idx_contacts_system_role_${contact.systemRole}"`),
            { code: '23505', constraint: `idx_contacts_system_role_${contact.systemRole}` },
          );
          throw err;
        }
      }
    }
    this.contacts.set(contact.id, contact);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) to match the Postgres ILIKE behavior
    const lowerName = name.toLowerCase();
    const results: Contact[] = [];
    for (const contact of this.contacts.values()) {
      if (contact.displayName.toLowerCase().includes(lowerName)) {
        results.push(contact);
      }
    }
    return results;
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const results: Contact[] = [];
    for (const contact of this.contacts.values()) {
      if (contact.role === role) {
        results.push(contact);
      }
    }
    return results;
  }

  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    for (const contact of this.contacts.values()) {
      if (contact.systemRole === systemRole) return contact;
    }
    return null;
  }

  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    let results = [...this.contacts.values()];

    if (filters?.status != null) {
      results = results.filter((c) => c.status === filters.status);
    }

    // Sort by createdAt ascending to match Postgres ORDER BY created_at ASC
    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (filters?.limit != null) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  async updateContact(contact: Contact): Promise<void> {
    // Enforce system_role uniqueness on update, to match Postgres partial unique indexes.
    // Exclude the contact being updated from the duplicate check.
    if (contact.systemRole) {
      for (const [existingId, existing] of this.contacts.entries()) {
        if (existingId !== contact.id && existing.systemRole === contact.systemRole) {
          const err = Object.assign(
            new Error(`duplicate key value violates unique constraint "idx_contacts_system_role_${contact.systemRole}"`),
            { code: '23505', constraint: `idx_contacts_system_role_${contact.systemRole}` },
          );
          throw err;
        }
      }
    }
    this.contacts.set(contact.id, contact);
  }

  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    const contact = this.contacts.get(contactId);
    if (!contact) return;
    this.contacts.set(contactId, {
      ...contact,
      contactConfidence: updates.contactConfidence,
      inboundMessageCount: contact.inboundMessageCount + (updates.inboundMessageCountDelta ?? 0),
      outboundMessageCount: contact.outboundMessageCount + (updates.outboundMessageCountDelta ?? 0),
      lastSeenAt: updates.lastSeenAt ?? contact.lastSeenAt,
      updatedAt: new Date(),
    });
  }

  async promoteToConfirmed(contactId: string): Promise<boolean> {
    // JS is single-threaded, so check-and-set here is effectively atomic for tests.
    // The same conditional-update semantics as the Postgres implementation apply.
    const contact = this.contacts.get(contactId);
    if (!contact || contact.status !== 'provisional') return false;
    this.contacts.set(contactId, { ...contact, status: 'confirmed', updatedAt: new Date() });
    return true;
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    // Enforce UNIQUE(channel, channel_identifier) to match Postgres behavior.
    // Without this, the in-memory backend would silently allow duplicates
    // that Postgres would reject via its unique index.
    for (const existing of this.identities.values()) {
      if (existing.channel === identity.channel && existing.channelIdentifier === identity.channelIdentifier) {
        // Throw with the same shape as Postgres unique-violation errors (code 23505)
        // so callers can detect duplicates uniformly across backends.
        throw Object.assign(
          new Error(`duplicate key value violates unique constraint "contact_channel_identities_channel_channel_identifier_key"`),
          { code: '23505', constraint: 'contact_channel_identities_channel_channel_identifier_key' },
        );
      }
    }
    this.identities.set(identity.id, identity);
  }

  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    const results: ChannelIdentity[] = [];
    for (const identity of this.identities.values()) {
      if (identity.contactId === contactId) {
        results.push(identity);
      }
    }
    return results;
  }

  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    // Normalize email lookups to lowercase (mirrors Postgres backend).
    const normalizedId = channel === 'email'
      ? channelIdentifier.toLowerCase()
      : channelIdentifier;

    // Find the matching identity, then look up the contact
    for (const identity of this.identities.values()) {
      const storedId = channel === 'email'
        ? identity.channelIdentifier.toLowerCase()
        : identity.channelIdentifier;
      if (identity.channel === channel && storedId === normalizedId) {
        const contact = this.contacts.get(identity.contactId);
        if (contact) {
          return {
            contactId: contact.id,
            displayName: contact.displayName,
            role: contact.role,
            systemRole: contact.systemRole,
            status: contact.status,
            kgNodeId: contact.kgNodeId,
            verified: identity.verified,
            contactConfidence: contact.contactConfidence ?? 0,
            trustLevel: contact.trustLevel ?? null,
          };
        }
      }
    }
    return null;
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.identities.delete(identityId);
  }

  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    const identity = this.identities.get(identityId);
    if (!identity) {
      throw new IdentityNotFoundError(identityId);
    }
    const updated: ChannelIdentity = {
      ...identity,
      status,
      updatedAt: new Date(),
    };
    this.identities.set(identityId, updated);
    return updated;
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    const results: Array<{ permission: string; granted: boolean }> = [];
    for (const override of this.overrides.values()) {
      if (override.contactId === contactId && override.revokedAt === null) {
        results.push({ permission: override.permission, granted: override.granted });
      }
    }
    return results;
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    // Upsert: find and replace any existing active override for the same contact+permission
    for (const [key, existing] of this.overrides.entries()) {
      if (
        existing.contactId === override.contactId &&
        existing.permission === override.permission &&
        existing.revokedAt === null
      ) {
        this.overrides.delete(key);
        break;
      }
    }
    this.overrides.set(override.id, override);
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<boolean> {
    for (const [id, override] of this.overrides) {
      if (override.contactId === contactId &&
          override.permission === permission &&
          override.revokedAt === null) {
        this.overrides.set(id, { ...override, revokedAt: new Date() });
        return true;
      }
    }
    return false;
  }

  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    // Enforce UNIQUE(nylas_calendar_id)
    for (const existing of this.calendars.values()) {
      if (existing.nylasCalendarId === calendar.nylasCalendarId) {
        throw new Error(`Calendar already registered: ${calendar.nylasCalendarId}`);
      }
    }
    // Enforce at-most-one-primary per contact
    if (calendar.isPrimary && calendar.contactId !== null) {
      for (const existing of this.calendars.values()) {
        if (existing.contactId === calendar.contactId && existing.isPrimary) {
          throw new Error(`Contact ${calendar.contactId} already has a primary calendar`);
        }
      }
    }
    this.calendars.set(calendar.id, calendar);
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    for (const [id, cal] of this.calendars) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        this.calendars.delete(id);
        return true;
      }
    }
    return false;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const results: ContactCalendar[] = [];
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId) {
        results.push(cal);
      }
    }
    return results;
  }

  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        return {
          contactId: cal.contactId,
          label: cal.label,
          isPrimary: cal.isPrimary,
          readOnly: cal.readOnly,
        };
      }
    }
    return null;
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId && cal.isPrimary) {
        return cal;
      }
    }
    return null;
  }

  async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
    // Build set of channel:channelIdentifier keys already owned by the primary
    const primaryKeys = new Set<string>();
    for (const identity of this.identities.values()) {
      if (identity.contactId === toContactId) {
        primaryKeys.add(`${identity.channel}:${identity.channelIdentifier}`);
      }
    }
    // Re-point secondary's identities onto primary, discarding any that conflict
    for (const [id, identity] of this.identities) {
      if (identity.contactId !== fromContactId) continue;
      const key = `${identity.channel}:${identity.channelIdentifier}`;
      if (primaryKeys.has(key)) {
        // Duplicate — would violate UNIQUE constraint in Postgres, so discard
        this.identities.delete(id);
      } else {
        this.identities.set(id, { ...identity, contactId: toContactId });
        primaryKeys.add(key);
      }
    }
  }

  async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
    // Build set of permissions already held (active) by the primary
    const primaryPerms = new Set<string>();
    for (const override of this.overrides.values()) {
      if (override.contactId === toContactId && !override.revokedAt) {
        primaryPerms.add(override.permission);
      }
    }
    // Re-point secondary's active overrides; discard if primary already has one for same permission
    for (const [id, override] of this.overrides) {
      if (override.contactId !== fromContactId || override.revokedAt) continue;
      if (primaryPerms.has(override.permission)) {
        this.overrides.delete(id);
      } else {
        this.overrides.set(id, { ...override, contactId: toContactId });
        primaryPerms.add(override.permission);
      }
    }
  }

  async deleteContact(id: string): Promise<void> {
    this.contacts.delete(id);
    // Cascade-delete related rows, matching Postgres ON DELETE CASCADE behavior.
    // Without this, deleted contacts leave dangling identities/overrides in the in-memory
    // store that can bleed into subsequent tests.
    for (const [iid, identity] of this.identities) {
      if (identity.contactId === id) this.identities.delete(iid);
    }
    for (const [oid, override] of this.overrides) {
      if (override.contactId === id) this.overrides.delete(oid);
    }
  }
}
