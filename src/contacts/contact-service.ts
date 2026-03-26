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
import type {
  Contact,
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
  ) {}

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    entityMemory: EntityMemory | undefined,
    logger: Logger,
  ): ContactService {
    return new ContactService(new PostgresContactBackend(pool, logger), entityMemory);
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

    // Auto-create a KG person node if we have entityMemory and no explicit kgNodeId
    let kgNodeId: string | null = options.kgNodeId ?? null;
    if (!kgNodeId && this.entityMemory) {
      const entity = await this.entityMemory.createEntity({
        type: 'person',
        label: options.displayName,
        properties: options.role ? { role: options.role } : {},
        source: options.source,
      });
      kgNodeId = entity.id;
    }

    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: options.displayName,
      role: options.role ?? null,
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createContact(contact);
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
    const now = new Date();

    // Determine verification status: explicit override > auto-verify logic
    let verified: boolean;
    if (options.verified !== undefined) {
      verified = options.verified;
    } else {
      verified = AUTO_VERIFIED_SOURCES.has(options.source);
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
      `INSERT INTO contacts (id, kg_node_id, display_name, role, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.notes, contact.createdAt, contact.updatedAt],
    );
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, notes, created_at, updated_at
       FROM contacts WHERE id = $1`,
      [id],
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return this.rowToContact(row);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Case-insensitive exact match using lower()
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, notes, created_at, updated_at
       FROM contacts WHERE lower(display_name) = lower($1)`,
      [name],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, notes, created_at, updated_at
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
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, notes, created_at, updated_at
       FROM contacts ORDER BY created_at ASC`,
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async updateContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: updating contact');
    await this.pool.query(
      `UPDATE contacts SET kg_node_id = $2, display_name = $3, role = $4, notes = $5, updated_at = $6
       WHERE id = $1`,
      [contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.notes, contact.updatedAt],
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
      kg_node_id: string | null;
      verified: boolean;
    }>(
      `SELECT c.id, c.display_name, c.role, c.kg_node_id, cci.verified
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
      kgNodeId: row.kg_node_id,
      verified: row.verified,
    };
  }

  // -- Row mapping helpers --

  private rowToContact(row: {
    id: string;
    kg_node_id: string | null;
    display_name: string;
    role: string | null;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
  }): Contact {
    return {
      id: row.id,
      kgNodeId: row.kg_node_id,
      displayName: row.display_name,
      role: row.role,
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

  async createContact(contact: Contact): Promise<void> {
    this.contacts.set(contact.id, contact);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    const lowerName = name.toLowerCase();
    const results: Contact[] = [];
    for (const contact of this.contacts.values()) {
      if (contact.displayName.toLowerCase() === lowerName) {
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
            kgNodeId: contact.kgNodeId,
            verified: identity.verified,
          };
        }
      }
    }
    return null;
  }
}
