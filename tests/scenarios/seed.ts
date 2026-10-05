// tests/scenarios/seed.ts — real rows for one run, and the scoped views that keep a
// case from seeing anything else in a shared database.
//
// The suite runs against the dev database (#1956), which holds a real instance's
// outbound-context entries and bullpen threads. Seeded state is written through the
// real services, so the Dispatcher's block formatting and the runtime's bullpen
// injection are production's; but every read path an agent sees is narrowed to the
// rows this run created, and every row is deleted when the run ends.
import { randomUUID } from 'node:crypto';
import { OutboundContextService, type OutboundContextRow } from '../../src/dispatch/outbound-context.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import type { TestModeStack } from '../../src/startup/test-mode-stack.js';
import { cleanupConversation, sweepConversations } from '../shared/turn-capture.js';
import { resolvePlaceholders } from './loader.js';
import type { ScenarioCase, SeedContact } from './types.js';

/**
 * Stamped into `notes` on every seeded contact — contacts have no source column, and
 * this is what lets a later run tell its own leftover from a real contact. Leftover
 * removal refuses any contact without it.
 */
export const SCENARIO_CONTACT_NOTE = 'Scenario-suite fixture (#1956) — safe to delete.';

/** `kg_nodes.source` of every node the suite mints. Only nodes with it are ever deleted. */
export const SCENARIO_KG_SOURCE = 'scenario-test';

/** Prefix of `bullpen_threads.source_message_id` on every seeded thread (not shown to agents). */
const SCENARIO_THREAD_MARKER = 'scenario:';

/** conversation_id prefix of seeded outbound-context entries. */
const SCENARIO_ENTRY_ORIGIN = 'scenario-origin-';

/** Channels the ContactResolver maps to the principal without an identity lookup. */
const PRINCIPAL_LOCAL_CHANNELS = new Set(['cli', 'smoke-test', 'web']);

/**
 * The ids one run seeded. Each run has its own (#1980: runs of different cases overlap),
 * and the scoped views find the calling run's through the case context
 * (tests/shared/case-scope.ts), so one view built at boot serves every run.
 */
export class SeedScope {
  readonly entryIds = new Set<string>();
  readonly threadIds = new Set<string>();
  /**
   * Failures inside the scoped views. The Dispatcher and runtime log such a failure
   * and carry on WITHOUT the block — a case would then be scored on a premise it never
   * had — so the harness fails the run when this is non-empty.
   */
  readonly errors: string[] = [];

  clear(): void {
    this.entryIds.clear();
    this.threadIds.clear();
    this.errors.length = 0;
  }
}

/** The calling run's scope; undefined outside every run, which then sees nothing. */
export type CurrentScope = () => SeedScope | undefined;

/**
 * The Dispatcher's outbound-context service, narrowed to the calling run's entries.
 * `getActive()` keeps production's contract (active only, newest first, limit) but
 * reads each seeded entry through the real `getEntry` SQL, so a released or expired
 * entry drops out exactly as it would in production.
 */
export function scopedOutboundContext(real: OutboundContextService, currentScope: CurrentScope): OutboundContextService {
  return Object.assign(Object.create(real) as OutboundContextService, {
    getActive: async (limit = 10): Promise<OutboundContextRow[]> => {
      const scope = currentScope();
      if (!scope) return [];
      try {
        const rows = await Promise.all([...scope.entryIds].map(id => real.getEntry(id)));
        return rows
          .filter((r): r is OutboundContextRow => r !== null)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit);
      } catch (err) {
        scope.errors.push(`outbound-context read failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  });
}

/** The bullpen as runtimes see it, narrowed to the calling run's threads (real SQL underneath). */
export function scopedBullpen(real: BullpenService, currentScope: CurrentScope): BullpenService {
  return Object.assign(Object.create(real) as BullpenService, {
    getPendingThreadsForAgent: async (agentId: string, windowMinutes: number) => {
      const scope = currentScope();
      if (!scope) return [];
      try {
        return (await real.getPendingThreadsForAgent(agentId, windowMinutes))
          .filter(t => scope.threadIds.has(t.threadId));
      } catch (err) {
        scope.errors.push(`bullpen read failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  });
}

/** Everything a run created, for cleanup and placeholder resolution. */
export interface SeededRun {
  /** `kind:key` → id, for {{…}} placeholders. */
  refs: Map<string, string>;
  contacts: Array<{ id: string; kgNodeId: string | null }>;
  entryIds: string[];
  threads: Map<string, { threadId: string; messageId: string; topic: string; participants: string[] }>;
}

export interface SeedDeps {
  stack: TestModeStack;
  outboundContext: OutboundContextService;
  scope: SeedScope;
}

/**
 * Create the case's rows. On any failure, removes what it already created before
 * rethrowing, so a half-seeded run never leaks into the next.
 */
export async function seedRun(scenario: ScenarioCase, deps: SeedDeps): Promise<SeededRun> {
  const { stack, outboundContext, scope } = deps;
  const seeded: SeededRun = { refs: new Map(), contacts: [], entryIds: [], threads: new Map() };
  if (stack.principalContactId) seeded.refs.set('principal_contact_id', stack.principalContactId);

  try {
    for (const contact of scenario.seed.contacts) {
      const created = await seedContact(stack, contact);
      seeded.contacts.push(created);
      seeded.refs.set(`contact:${contact.key}`, created.id);
    }

    for (const raw of scenario.seed.outboundContext) {
      const entry = resolvePlaceholders(raw, seeded.refs);
      const id = await outboundContext.register({
        conversationId: `${SCENARIO_ENTRY_ORIGIN}${entry.key}`,
        channelId: entry.channelId,
        agentId: entry.agentId,
        content: entry.content,
        expectedReply: entry.expectedReply,
        delegationHint: entry.delegationHint,
        metadata: entry.metadata,
        expiresInHours: entry.expiresInHours ?? 6,
      });
      seeded.entryIds.push(id);
      scope.entryIds.add(id);
      seeded.refs.set(`entry:${entry.key}`, id);
      // Backdate so the block reads "sent N minutes ago", as a real reply would see it.
      await stack.pool.query(
        `UPDATE outbound_context SET created_at = now() - make_interval(mins => $2) WHERE id = $1`,
        [id, entry.sentMinutesAgo ?? 10],
      );
    }

    for (const raw of scenario.seed.bullpen) {
      const thread = resolvePlaceholders(raw, seeded.refs);
      const opened = await stack.bullpenService.openThread(
        thread.topic,
        thread.creatorAgentId,
        thread.participants,
        thread.content,
        thread.mentionedAgentIds,
        undefined,
        // The marker sweepLeftovers() finds a crashed run's threads by. It is the dedup
        // key, which agents never see, so it does not change the prompt.
        `${SCENARIO_THREAD_MARKER}${randomUUID()}`,
      );
      seeded.threads.set(thread.key, {
        threadId: opened.thread.id,
        messageId: opened.message.id,
        topic: thread.topic,
        participants: thread.participants,
      });
      scope.threadIds.add(opened.thread.id);
      seeded.refs.set(`thread:${thread.key}`, opened.thread.id);
    }
  } catch (err) {
    // Keep the seed error as the cause; a cleanup failure on top of it is attached, not
    // substituted — otherwise the reason the seed failed is lost.
    try {
      await cleanupRun(stack, seeded, scope);
    } catch (cleanupErr) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} (and removing the partial seed failed: ` +
        `${describeError(cleanupErr)})`,
        { cause: err },
      );
    }
    throw err;
  }
  return seeded;
}

async function seedContact(stack: TestModeStack, contact: SeedContact): Promise<{ id: string; kgNodeId: string | null }> {
  // A leftover from a crashed run would make linkIdentity fail on the unique identity.
  // Remove it — but only if it is ours. A real contact on that identity is a fixture
  // collision someone must look at, not something a test run deletes.
  const existing = await stack.contactService.resolveByChannelIdentity(contact.channel, contact.identifier);
  if (existing) {
    const row = await stack.contactService.getContact(existing.contactId);
    if (row?.notes !== SCENARIO_CONTACT_NOTE) {
      throw new Error(
        `Seed contact '${contact.key}': ${contact.channel} identity ${contact.identifier} already belongs to a ` +
        `real contact (${existing.contactId}). Use an identifier under example.test.`,
      );
    }
    await deleteContact(stack, existing.contactId, row.kgNodeId ?? null);
  }

  // Mint the contact's own KG node and hand it to createContact. Left to itself,
  // createContact may ADOPT an existing node — an unanchored person node with the same
  // label, or a shared organization node for the domain (ADR-040) — and cleanup would
  // then remove a real node with all its edges. A node we mint is tagged, anchored
  // (outside the label-uniqueness index, so it cannot collide) and the only kind
  // deleteContact() below will ever remove. No embedding: fixtures are found by
  // channel identity, not by semantic search.
  const node = await stack.pool.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, source, identity_source)
     VALUES ($1, $2, $3, $4, 'contact')
     RETURNING id`,
    [
      contact.kind === 'organization' ? 'organization' : 'person',
      contact.displayName,
      JSON.stringify(contact.role ? { role: contact.role } : {}),
      SCENARIO_KG_SOURCE,
    ],
  );
  const kgNodeId = node.rows[0]!.id;

  let created: { id: string };
  try {
    created = await stack.contactService.createContact({
      displayName: contact.displayName,
      tier: contact.tier,
      kind: contact.kind,
      role: contact.role,
      notes: SCENARIO_CONTACT_NOTE,
      source: SCENARIO_KG_SOURCE,
      kgNodeId,
      ...(contact.channel === 'email' ? { primaryEmail: contact.identifier } : {}),
    });
  } catch (err) {
    await stack.pool.query(`DELETE FROM kg_nodes WHERE id = $1 AND source = $2`, [kgNodeId, SCENARIO_KG_SOURCE]);
    throw err;
  }
  try {
    await stack.contactService.linkIdentity({
      contactId: created.id,
      channel: contact.channel,
      channelIdentifier: contact.identifier,
      source: 'ceo_stated',
      verified: true,
    });
  } catch (err) {
    await deleteContact(stack, created.id, kgNodeId);
    throw err;
  }
  return { id: created.id, kgNodeId };
}

/**
 * Remove a fixture contact and, if the suite minted it, its KG node (edges cascade).
 * The node delete requires `source = 'scenario-test'`, so a node that is anyone else's
 * survives even if a bug ever linked one to a fixture.
 */
async function deleteContact(stack: TestModeStack, id: string, kgNodeId: string | null): Promise<void> {
  // Not archiveAnchoredNode: the node is removed outright below, scoped to our tag.
  await stack.contactService.deleteContact(id, { archiveAnchoredNode: false });
  if (kgNodeId) {
    await stack.pool.query(`DELETE FROM kg_nodes WHERE id = $1 AND source = $2`, [kgNodeId, SCENARIO_KG_SOURCE]);
  }
}

/**
 * Remove whatever a crashed or interrupted run left, found only by the suite's own
 * markers: tagged contacts and nodes, entries from `scenario-origin-*`, marked bullpen
 * threads, and conversation rows of `scenario-*` / `email:scenario-*` conversations.
 * Run at start-up and on SIGINT/SIGTERM. Returns what it removed, for the log.
 */
export async function sweepLeftovers(stack: TestModeStack): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const count = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    const result = await stack.pool.query(sql, params);
    if ((result.rowCount ?? 0) > 0) removed[label] = result.rowCount ?? 0;
  };

  const contacts = await stack.pool.query<{ id: string; kg_node_id: string | null }>(
    `SELECT id, kg_node_id FROM contacts WHERE notes = $1`,
    [SCENARIO_CONTACT_NOTE],
  );
  for (const c of contacts.rows) await deleteContact(stack, c.id, c.kg_node_id);
  if (contacts.rows.length > 0) removed['contacts'] = contacts.rows.length;

  // Nodes minted for a contact whose creation then failed.
  await count('kg_nodes',
    `DELETE FROM kg_nodes n WHERE n.source = $1
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.kg_node_id = n.id)`,
    [SCENARIO_KG_SOURCE]);
  await count('outbound_context',
    `DELETE FROM outbound_context WHERE conversation_id LIKE $1`,
    [`${SCENARIO_ENTRY_ORIGIN}%`]);
  await count('bullpen_threads',
    `DELETE FROM bullpen_threads WHERE source_message_id LIKE $1`,
    [`${SCENARIO_THREAD_MARKER}%`]);
  const conversations = await sweepConversations(stack.pool, SCENARIO_CONVERSATION_PREFIXES);
  for (const [table, rows] of Object.entries(conversations)) {
    if (rows > 0) removed[table] = rows;
  }
  return removed;
}

/**
 * What two concurrently running cases must not share (#1980). seedContact deletes a
 * fixture contact already on its identity, which would pull another run's contact out
 * from under it; and a run's coordinator can find another case's fixture by name with a
 * real contact read. Cases with a key in common never run at the same time.
 */
export function seedConflictKeys(scenario: ScenarioCase): string[] {
  return scenario.seed.contacts.flatMap(c => [
    `identity:${c.channel}:${c.identifier.toLowerCase()}`,
    `name:${c.displayName.trim().toLowerCase()}`,
  ]);
}

/** Conversation ids a run uses (harness.ts); the sweep finds leftovers by them. */
export const SCENARIO_CONVERSATION_PREFIXES = ['scenario-', 'email:scenario-'] as const;

export async function cleanupRun(
  stack: TestModeStack,
  seeded: SeededRun,
  scope: SeedScope,
  conversationId?: string,
): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };

  if (seeded.entryIds.length > 0) {
    await attempt(() => stack.pool.query(`DELETE FROM outbound_context WHERE id = ANY($1::uuid[])`, [seeded.entryIds]));
  }
  const threadIds = [...seeded.threads.values()].map(t => t.threadId);
  if (threadIds.length > 0) {
    // Messages and read watermarks cascade.
    await attempt(() => stack.pool.query(`DELETE FROM bullpen_threads WHERE id = ANY($1::uuid[])`, [threadIds]));
  }
  if (conversationId) {
    await attempt(() => cleanupConversation(stack.pool, conversationId));
  }
  for (const contact of seeded.contacts) {
    await attempt(() => deleteContact(stack, contact.id, contact.kgNodeId));
  }
  scope.clear();

  if (errors.length > 0) {
    throw new AggregateError(errors, `Scenario cleanup failed for ${errors.length} item(s) — check the database for leftovers`);
  }
}

/** An error's message, including every inner error of an AggregateError (its stack omits them). */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return `${err.message}: ${err.errors.map(e => (e instanceof Error ? e.message : String(e))).join('; ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Where a seeded case's inbound comes from: the Dispatcher's view of the sender. */
export interface ResolvedSender {
  channelId: string;
  senderId: string;
}

export async function resolveSender(scenario: ScenarioCase, stack: TestModeStack): Promise<ResolvedSender | 'bullpen'> {
  const { from, channel } = scenario.inbound;
  if (from === 'bullpen') return 'bullpen';

  if (from === 'principal') {
    const channelId = channel ?? 'cli';
    if (PRINCIPAL_LOCAL_CHANNELS.has(channelId)) return { channelId, senderId: 'scenario-principal' };
    if (!stack.principalContactId) throw new Error('No principal contact in this database');
    // A real channel needs the principal's own identity on it, or the resolver would
    // treat the sender as a stranger and the case would test the wrong audience.
    const identities = await stack.contactService.getIdentitiesForContact(stack.principalContactId);
    const identity = identities.find(i => i.channel === channelId);
    if (!identity) {
      throw new Error(
        `Case '${scenario.name}' sends as the principal on '${channelId}', but the principal has no ` +
        `${channelId} identity in this database. Use channel: cli, or a channel the principal has.`,
      );
    }
    return { channelId, senderId: identity.channelIdentifier };
  }

  const contact = scenario.seed.contacts.find(c => c.key === from)!;
  return { channelId: contact.channel, senderId: contact.identifier };
}

/** A fresh outbound-context service on the stack's pool (the stack does not build one). */
export function createOutboundContextService(stack: TestModeStack): OutboundContextService {
  return new OutboundContextService(stack.pool, stack.logger);
}
