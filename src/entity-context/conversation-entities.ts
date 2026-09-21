// conversation-entities.ts — durable contact IDs for one conversation (#1818).
//
// Stores the contact id only. Every later turn reads the contact row again,
// so a rename or a new email shows up instead of the wording from the turn
// that first resolved the person.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { ResolvedEntityCard } from '../agents/resolved-entities.js';
import { MAX_RESOLVED_ENTITIES } from '../agents/resolved-entities.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ContactCardSource {
  get(contactId: string): ResolvedEntityCard | undefined;
}

interface EntityStore {
  record(conversationId: string, agentId: string, contactIds: readonly string[]): Promise<ResolvedEntityCard[]>;
  load(conversationId: string, agentId: string, limit: number): Promise<ResolvedEntityCard[]>;
}

/**
 * Contact cards resolved during one agent task. The outbound gateway reads
 * this so a send in the same turn can require those identities, including
 * ones a delegation discovered after the prompt was assembled.
 */
export class TurnIdentityRegistry {
  private turns = new Map<string, ResolvedEntityCard[]>();

  begin(taskEventId: string): void {
    if (!this.turns.has(taskEventId)) this.turns.set(taskEventId, []);
  }

  has(taskEventId: string): boolean {
    return this.turns.has(taskEventId);
  }

  get(taskEventId: string): ResolvedEntityCard[] {
    return this.turns.get(taskEventId) ?? [];
  }

  replace(taskEventId: string, cards: readonly ResolvedEntityCard[]): void {
    this.turns.set(taskEventId, [...cards]);
  }

  merge(taskEventId: string, cards: readonly ResolvedEntityCard[]): void {
    const current = this.turns.get(taskEventId);
    if (!current) return;
    const byId = new Map(current.map(card => [card.contactId, card]));
    for (const card of cards) byId.set(card.contactId, card);
    this.turns.set(taskEventId, [...byId.values()]);
  }

  end(taskEventId: string): void {
    this.turns.delete(taskEventId);
  }
}

/**
 * Conversation-scoped resolved contacts, plus the in-process set for the
 * turn that is running now.
 */
export class ConversationEntityState {
  readonly turnIdentities = new TurnIdentityRegistry();

  private constructor(
    private readonly store: EntityStore,
    /** Display names of the principal, used when a live contact lookup is unavailable. */
    readonly principalNames: readonly string[],
  ) {}

  static createWithPostgres(
    pool: DbPool,
    logger: Logger,
    principalNames: readonly string[],
  ): ConversationEntityState {
    return new ConversationEntityState(new PostgresEntityStore(pool, logger), principalNames);
  }

  static createInMemory(
    source: ContactCardSource,
    principalNames: readonly string[] = [],
  ): ConversationEntityState {
    return new ConversationEntityState(new MemoryEntityStore(source), principalNames);
  }

  /**
   * Remember these contacts for the conversation and return their current
   * rows. Unknown ids (not a contact) are dropped.
   */
  record(
    conversationId: string,
    agentId: string,
    contactIds: readonly string[],
  ): Promise<ResolvedEntityCard[]> {
    const ids = normalizeIds(contactIds);
    if (ids.length === 0) return Promise.resolve([]);
    return this.store.record(conversationId, agentId, ids);
  }

  /** Most recently resolved contacts, read from the current contact row. */
  loadCurrent(
    conversationId: string,
    agentId: string,
    limit: number = MAX_RESOLVED_ENTITIES,
  ): Promise<ResolvedEntityCard[]> {
    return this.store.load(conversationId, agentId, limit);
  }
}

function normalizeIds(contactIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of contactIds) {
    if (!UUID_RE.test(id)) continue;
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

class MemoryEntityStore implements EntityStore {
  private order = new Map<string, string[]>();

  constructor(private readonly source: ContactCardSource) {}

  async record(
    conversationId: string,
    agentId: string,
    contactIds: readonly string[],
  ): Promise<ResolvedEntityCard[]> {
    const key = storeKey(conversationId, agentId);
    const existing = this.order.get(key) ?? [];
    for (const id of contactIds) {
      if (!this.source.get(id)) continue;
      const idx = existing.indexOf(id);
      if (idx >= 0) existing.splice(idx, 1);
      existing.unshift(id);
    }
    this.order.set(key, existing);
    return hydrate(existing.filter(id => contactIds.includes(id)), this.source);
  }

  async load(conversationId: string, agentId: string, limit: number): Promise<ResolvedEntityCard[]> {
    const ids = (this.order.get(storeKey(conversationId, agentId)) ?? []).slice(0, limit);
    return hydrate(ids, this.source);
  }
}

function hydrate(ids: readonly string[], source: ContactCardSource): ResolvedEntityCard[] {
  const cards: ResolvedEntityCard[] = [];
  for (const id of ids) {
    const card = source.get(id);
    if (card) cards.push(card);
  }
  return cards;
}

function storeKey(conversationId: string, agentId: string): string {
  return `${conversationId}\0${agentId}`;
}

interface ContactRow {
  id: string;
  display_name: string;
  preferred_name: string | null;
  role: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
}

class PostgresEntityStore implements EntityStore {
  constructor(
    private readonly pool: DbPool,
    private readonly logger: Logger,
  ) {}

  async record(
    conversationId: string,
    agentId: string,
    contactIds: readonly string[],
  ): Promise<ResolvedEntityCard[]> {
    // Insert only ids that are real contacts. A specialist that echoes a
    // non-contact UUID must not abort the turn, and must not be remembered.
    await this.pool.query(
      `INSERT INTO conversation_resolved_entities (conversation_id, agent_id, contact_id)
       SELECT $1, $2, c.id
       FROM contacts c
       WHERE c.id = ANY($3::uuid[])
       ON CONFLICT (conversation_id, agent_id, contact_id)
       DO UPDATE SET resolved_at = now()`,
      [conversationId, agentId, contactIds],
    );
    const result = await this.pool.query<ContactRow>(
      `SELECT c.id, c.display_name, c.preferred_name, c.role, c.organization,
              c.primary_email, c.primary_phone
       FROM contacts c
       WHERE c.id = ANY($1::uuid[])`,
      [contactIds],
    );
    if (result.rows.length < contactIds.length) {
      this.logger.warn(
        { conversationId, agentId, requested: contactIds.length, stored: result.rows.length },
        'resolved entities: some contact IDs did not match a contact row and were not stored',
      );
    }
    return result.rows.map(rowToCard);
  }

  async load(conversationId: string, agentId: string, limit: number): Promise<ResolvedEntityCard[]> {
    const result = await this.pool.query<ContactRow>(
      `SELECT c.id, c.display_name, c.preferred_name, c.role, c.organization,
              c.primary_email, c.primary_phone
       FROM conversation_resolved_entities r
       JOIN contacts c ON c.id = r.contact_id
       WHERE r.conversation_id = $1 AND r.agent_id = $2
       ORDER BY r.resolved_at DESC
       LIMIT $3`,
      [conversationId, agentId, limit],
    );
    return result.rows.map(rowToCard);
  }
}

function rowToCard(row: ContactRow): ResolvedEntityCard {
  return {
    contactId: row.id.toLowerCase(),
    displayName: row.display_name,
    preferredName: row.preferred_name,
    role: row.role,
    organization: row.organization,
    primaryEmail: row.primary_email,
    primaryPhone: row.primary_phone,
  };
}
