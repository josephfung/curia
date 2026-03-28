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
import type {
  AuthOverride,
  Contact,
  ContactStatus,
  ChannelIdentity,
  CreateContactOptions,
  LinkIdentityOptions,
  ResolvedSender,
  IdentitySource,
} from './types.js';

// -- Backend interface --

interface ContactServiceBackend {
  createContact(contact: Contact): Promise<void>;
  getContact(id: string): Promise<Contact | undefined>;
  findContactByName(name: string): Promise<Contact[]>;
  findContactByRole(role: string): Promise<Contact[]>;
  listContacts(): Promise<Contact[]>;
  updateContact(contact: Contact): Promise<void>;
  createIdentity(identity: ChannelIdentity): Promise<void>;
  getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]>;
  resolveByChannelIdentity(channel: string, channelIdentifier: string): Promise<ResolvedSender | null>;
  unlinkIdentity(identityId: string): Promise<boolean>;
  getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>>;
  createAuthOverride(override: AuthOverride): Promise<void>;
  revokeAuthOverride(contactId: string, permission: string): Promise<boolean>;
}

// -- Auto-verification sources --
// Per spec: ceo_stated, email_participant, crm_import, calendar_attendee are auto-verified.
// Only self_claimed starts unverified.
const AUTO_VERIFIED_SOURCES: ReadonlySet<IdentitySource> = new Set([
  'ceo_stated',
  'email_participant',
  'crm_import',
  'calendar_attendee',
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
  private constructor(
    private backend: ContactServiceBackend,
    private entityMemory: EntityMemory | undefined,
    private logger?: Logger,
  ) {}

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    entityMemory: EntityMemory | undefined,
    logger: Logger,
  ): ContactService {
    return new ContactService(new PostgresContactBackend(pool, logger), entityMemory, logger);
  }

  /** Create an in-memory instance for testing */
  static createInMemory(entityMemory?: EntityMemory): ContactService {
    return new ContactService(new InMemoryContactBackend(), entityMemory);
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
      const entity = await this.entityMemory.createEntity({
        type: 'person',
        label: safeName,
        properties: options.role ? { role: options.role } : {},
        source: options.source,
      });
      kgNodeId = entity.id;
    }

    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: safeName,
      role: options.role ?? null,
      status: options.status ?? 'confirmed',
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.backend.createContact(contact);
    } catch (err) {
      // If the DB insert fails after we auto-created a KG node, that node is now
      // orphaned — it exists in the knowledge graph with no corresponding contact row.
      // TODO: Clean up the orphaned KG node once EntityMemory exposes a delete method.
      // For now, the orphan will remain. It won't cause functional issues (it's just a
      // person node with no contact link), but should be cleaned up when entity deletion
      // is added. Tracked by: https://github.com/curia-ai/curia/issues/TBD
      throw err;
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

  /** List all contacts. */
  async listContacts(): Promise<Contact[]> {
    return this.backend.listContacts();
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

    await this.backend.updateContact(updated);
    return updated;
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

    const identity: ChannelIdentity = {
      id: randomUUID(),
      contactId: options.contactId,
      channel: options.channel,
      channelIdentifier: options.channelIdentifier,
      label: options.label ?? null,
      verified,
      verifiedAt: verified ? now : null,
      source: options.source,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createIdentity(identity);
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

    await this.backend.updateContact(updated);
    return updated;
  }

  /** Remove a channel identity by its ID. Returns true if found and removed, false if not found. */
  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.backend.unlinkIdentity(identityId);
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
}

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
      `INSERT INTO contacts (id, kg_node_id, display_name, role, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.status, contact.notes, contact.createdAt, contact.updatedAt],
    );
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, status, notes, created_at, updated_at
       FROM contacts WHERE id = $1`,
      [id],
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return this.rowToContact(row);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) so partial names like "Joe" match "Joseph Brennan".
    // Uses ILIKE with wildcards — the idx_contacts_display_name btree index won't help here,
    // but the contacts table is small (hundreds, not millions) so a seq scan is fine.
    // For exact match, the caller can filter the results further.
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, status, notes, created_at, updated_at
       FROM contacts WHERE display_name ILIKE $1`,
      [`%${name}%`],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, status, notes, created_at, updated_at
       FROM contacts WHERE role = $1`,
      [role],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async listContacts(): Promise<Contact[]> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, status, notes, created_at, updated_at
       FROM contacts ORDER BY created_at ASC`,
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async updateContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: updating contact');
    await this.pool.query(
      `UPDATE contacts SET kg_node_id = $2, display_name = $3, role = $4, status = $5, notes = $6, updated_at = $7
       WHERE id = $1`,
      [contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.status, contact.notes, contact.updatedAt],
    );
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    this.logger.debug(
      { identityId: identity.id, contactId: identity.contactId, channel: identity.channel },
      'contacts: creating channel identity',
    );
    await this.pool.query(
      `INSERT INTO contact_channel_identities
         (id, contact_id, channel, channel_identifier, label, verified, verified_at, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        identity.id,
        identity.contactId,
        identity.channel,
        identity.channelIdentifier,
        identity.label,
        identity.verified,
        identity.verifiedAt,
        identity.source,
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
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, contact_id, channel, channel_identifier, label, verified, verified_at, source, created_at, updated_at
       FROM contact_channel_identities WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );

    return result.rows.map((row) => this.rowToIdentity(row));
  }

  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      role: string | null;
      status: string;
      kg_node_id: string | null;
      verified: boolean;
    }>(
      `SELECT c.id, c.display_name, c.role, c.status, c.kg_node_id, cci.verified
       FROM contact_channel_identities cci
       JOIN contacts c ON c.id = cci.contact_id
       WHERE cci.channel = $1 AND cci.channel_identifier = $2`,
      [channel, channelIdentifier],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      contactId: row.id,
      displayName: row.display_name,
      role: row.role,
      status: row.status as ContactStatus,
      kgNodeId: row.kg_node_id,
      verified: row.verified,
    };
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    this.logger.debug({ identityId }, 'Unlinking channel identity');
    const result = await this.pool.query('DELETE FROM contact_channel_identities WHERE id = $1', [identityId]);
    return (result.rowCount ?? 0) > 0;
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

  // -- Row mapping helpers --

  private rowToContact(row: {
    id: string;
    kg_node_id: string | null;
    display_name: string;
    role: string | null;
    status: string;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
  }): Contact {
    return {
      id: row.id,
      kgNodeId: row.kg_node_id,
      displayName: row.display_name,
      role: row.role,
      status: row.status as ContactStatus,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
      source: row.source as IdentitySource,
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

  async createContact(contact: Contact): Promise<void> {
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

  async listContacts(): Promise<Contact[]> {
    return [...this.contacts.values()];
  }

  async updateContact(contact: Contact): Promise<void> {
    this.contacts.set(contact.id, contact);
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    // Enforce UNIQUE(channel, channel_identifier) to match Postgres behavior.
    // Without this, the in-memory backend would silently allow duplicates
    // that Postgres would reject via its unique index.
    for (const existing of this.identities.values()) {
      if (existing.channel === identity.channel && existing.channelIdentifier === identity.channelIdentifier) {
        throw new Error(`Channel identity already exists: ${identity.channel}:${identity.channelIdentifier}`);
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
    // Find the matching identity, then look up the contact
    for (const identity of this.identities.values()) {
      if (identity.channel === channel && identity.channelIdentifier === channelIdentifier) {
        const contact = this.contacts.get(identity.contactId);
        if (contact) {
          return {
            contactId: contact.id,
            displayName: contact.displayName,
            role: contact.role,
            status: contact.status,
            kgNodeId: contact.kgNodeId,
            verified: identity.verified,
          };
        }
      }
    }
    return null;
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.identities.delete(identityId);
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
}
