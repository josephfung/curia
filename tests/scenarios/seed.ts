// tests/scenarios/seed.ts — real rows for one run, and the scoped views that keep a
// case from seeing anything else in a shared database.
//
// The suite runs against the dev database (#1956), which holds a real instance's
// outbound-context entries and bullpen threads. Seeded state is written through the
// real services, so the Dispatcher's block formatting and the runtime's bullpen
// injection are production's; but every read path an agent sees is narrowed to the
// rows this run created, and every row is deleted when the run ends.
import type { DbPool } from '../../src/db/connection.js';
import { OutboundContextService, type OutboundContextRow } from '../../src/dispatch/outbound-context.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import type { TestModeStack } from '../../src/startup/test-mode-stack.js';
import { resolvePlaceholders } from './loader.js';
import type { ScenarioCase, SeedContact } from './types.js';

/**
 * Stamped into `notes` on every seeded contact — contacts have no source column, and
 * this is what lets a later run tell its own leftover from a real contact. Leftover
 * removal refuses any contact without it.
 */
export const SCENARIO_CONTACT_NOTE = 'Scenario-suite fixture (#1956) — safe to delete.';

/** Channels the ContactResolver maps to the principal without an identity lookup. */
const PRINCIPAL_LOCAL_CHANNELS = new Set(['cli', 'smoke-test', 'web']);

/**
 * The ids the current run seeded. The scoped views read it on every call, so one view
 * built at boot serves every run.
 */
export class SeedScope {
  readonly entryIds = new Set<string>();
  readonly threadIds = new Set<string>();

  clear(): void {
    this.entryIds.clear();
    this.threadIds.clear();
  }
}

/**
 * The Dispatcher's outbound-context service, narrowed to this run's entries.
 * `getActive()` keeps production's contract (active only, newest first, limit) but
 * reads each seeded entry through the real `getEntry` SQL, so a released or expired
 * entry drops out exactly as it would in production.
 */
export function scopedOutboundContext(real: OutboundContextService, scope: SeedScope): OutboundContextService {
  return Object.assign(Object.create(real) as OutboundContextService, {
    getActive: async (limit = 10): Promise<OutboundContextRow[]> => {
      const rows = await Promise.all([...scope.entryIds].map(id => real.getEntry(id)));
      return rows
        .filter((r): r is OutboundContextRow => r !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },
  });
}

/** The bullpen as runtimes see it, narrowed to this run's threads (real SQL underneath). */
export function scopedBullpen(real: BullpenService, scope: SeedScope): BullpenService {
  return Object.assign(Object.create(real) as BullpenService, {
    getPendingThreadsForAgent: async (agentId: string, windowMinutes: number) =>
      (await real.getPendingThreadsForAgent(agentId, windowMinutes))
        .filter(t => scope.threadIds.has(t.threadId)),
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
        conversationId: `scenario-origin-${entry.key}`,
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
    await cleanupRun(stack, seeded, scope);
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
    await deleteContact(stack.pool, stack, existing.contactId, row.kgNodeId ?? null);
  }

  const created = await stack.contactService.createContact({
    displayName: contact.displayName,
    tier: contact.tier,
    kind: contact.kind,
    role: contact.role,
    notes: SCENARIO_CONTACT_NOTE,
    source: 'scenario-test',
    ...(contact.channel === 'email' ? { primaryEmail: contact.identifier } : {}),
  });
  try {
    await stack.contactService.linkIdentity({
      contactId: created.id,
      channel: contact.channel,
      channelIdentifier: contact.identifier,
      source: 'ceo_stated',
      verified: true,
    });
  } catch (err) {
    await deleteContact(stack.pool, stack, created.id, created.kgNodeId ?? null);
    throw err;
  }
  return { id: created.id, kgNodeId: created.kgNodeId ?? null };
}

async function deleteContact(pool: DbPool, stack: TestModeStack, id: string, kgNodeId: string | null): Promise<void> {
  await stack.contactService.deleteContact(id);
  // deleteContact archives the contact's KG node rather than removing it. A scenario
  // node holds nothing anyone needs, so remove it (edges cascade). Scoped to a node
  // whose label is still the scenario contact's, never a node someone else adopted.
  if (kgNodeId) {
    await pool.query(
      `DELETE FROM kg_nodes WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM contacts WHERE kg_node_id = $1)`,
      [kgNodeId],
    );
  }
}

/**
 * Remove every row the run created, and anything the coordinator wrote that hangs off
 * them. Collects errors and throws once at the end, so one failed delete does not
 * leave the rest behind.
 */
export async function cleanupRun(stack: TestModeStack, seeded: SeededRun, scope: SeedScope): Promise<void> {
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
  for (const contact of seeded.contacts) {
    await attempt(() => deleteContact(stack.pool, stack, contact.id, contact.kgNodeId));
  }
  scope.clear();

  if (errors.length > 0) {
    throw new AggregateError(errors, `Scenario cleanup failed for ${errors.length} item(s) — check the database for leftovers`);
  }
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
