// tests/scenarios/seed.ts — real rows for one run, and the scoped views that keep a
// case from seeing anything else in a shared database.
//
// The suite runs against the dev database (#1956), which holds a real instance's
// outbound-context entries and bullpen threads. Seeded state is written through the
// real services, so the Dispatcher's block formatting and the runtime's bullpen
// injection are production's; but every read path an agent sees is narrowed to the
// rows this run created, and every row is deleted when the run ends. With real
// delegation (#2027) that includes what the specialists write: their conversations,
// the dispatch claims in pending_delegations, and changes to the run's entries.
import { randomUUID } from 'node:crypto';
import { encodeResumeToken } from '../../src/agents/resume-token.js';
import {
  OutboundContextService,
  type OutboundContextEntry,
  type OutboundContextRow,
  type SubjectClearResult,
} from '../../src/dispatch/outbound-context.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import type { TestModeStack } from '../../src/startup/test-mode-stack.js';
import { cleanupConversation, sweepConversations } from '../shared/turn-capture.js';
import { resolvePlaceholders } from './loader.js';
import { SCENARIO_DELEGATE_PREFIX } from './stub-layer.js';
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
  /** Entries the run seeded, plus any an agent registered during it. */
  readonly entryIds = new Set<string>();
  readonly threadIds = new Set<string>();
  /** Conversations real specialists ran in for this run (#2027); cleaned with the run's own. */
  readonly specialistConversations = new Set<string>();
  /**
   * Failures inside the scoped views. The Dispatcher and runtime log such a failure
   * and carry on WITHOUT the block — a case would then be scored on a premise it never
   * had — so the harness fails the run when this is non-empty.
   */
  readonly errors: string[] = [];

  clear(): void {
    this.entryIds.clear();
    this.threadIds.clear();
    this.specialistConversations.clear();
    this.errors.length = 0;
  }
}

/** The calling run's scope; undefined outside every run, which then sees nothing. */
export type CurrentScope = () => SeedScope | undefined;

/**
 * The outbound-context service narrowed to the calling run's entries: what the
 * Dispatcher reads for the [ACTIVE OUTBOUND CONTEXT] block, and what the ExecutionLayer
 * hands `delegate` and the context-bridge tools (#2027). Each method keeps production's
 * contract and SQL, applied only to the run's own entries. An id outside them reads as
 * no active entry, the way production treats an unknown id. An entry an agent registers
 * joins the run's scope (and its cleanup). Outside every run there is nothing to read,
 * and nothing may be written.
 */
export function scopedOutboundContext(real: OutboundContextService, currentScope: CurrentScope): OutboundContextService {
  /** The run's scope, or undefined when `entryId` is not one of its entries. */
  const owning = (entryId: string): SeedScope | undefined => {
    const scope = currentScope();
    return scope?.entryIds.has(entryId) ? scope : undefined;
  };
  const activeEntries = async (scope: SeedScope): Promise<OutboundContextRow[]> => {
    const rows = await Promise.all([...scope.entryIds].map(id => real.getEntry(id)));
    return rows.filter((r): r is OutboundContextRow => r !== null);
  };

  return Object.assign(Object.create(real) as OutboundContextService, {
    getActive: async (limit = 10): Promise<OutboundContextRow[]> => {
      const scope = currentScope();
      if (!scope) return [];
      try {
        return (await activeEntries(scope))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit);
      } catch (err) {
        scope.errors.push(`outbound-context read failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    getEntry: async (entryId: string): Promise<OutboundContextRow | null> =>
      owning(entryId) ? real.getEntry(entryId) : null,
    register: async (entry: OutboundContextEntry): Promise<string> => {
      const scope = currentScope();
      if (!scope) throw new Error('scenario harness: an outbound-context entry was registered outside every run');
      const id = await real.register(entry);
      scope.entryIds.add(id);
      return id;
    },
    release: async (entryId: string, conversationId?: string): Promise<void> => {
      if (owning(entryId)) await real.release(entryId, conversationId);
    },
    releaseEntry: async (entryId: string): Promise<void> => {
      if (owning(entryId)) await real.releaseEntry(entryId);
    },
    markExchangeOpen: async (entryId: string, mark: { agentId: string; taskEventId: string; reason?: string }): Promise<boolean> =>
      owning(entryId) ? real.markExchangeOpen(entryId, mark) : false,
    releaseUnlessKeptOpen: async (entryId: string, taskEventId: string): Promise<'released' | 'kept_open' | 'not_active'> =>
      owning(entryId) ? real.releaseUnlessKeptOpen(entryId, taskEventId) : 'not_active',
    // Production's scans the whole active table; this applies the same match (trimmed,
    // de-duplicated, case-insensitive subject) to the run's entries only.
    clearBySubjects: async (subjects: string[]): Promise<SubjectClearResult> => {
      const scope = currentScope();
      const cleaned: string[] = [];
      for (const raw of subjects) {
        const subject = typeof raw === 'string' ? raw.trim() : '';
        if (subject && !cleaned.some(c => c.toLowerCase() === subject.toLowerCase())) cleaned.push(subject);
      }
      const result: SubjectClearResult = { totalReleased: 0, perSubject: [], unmatched: [] };
      const active = scope ? await activeEntries(scope) : [];
      for (const subject of cleaned) {
        const matched = active.filter(e => {
          const value = e.metadata?.['subject'];
          return typeof value === 'string' && value.toLowerCase() === subject.toLowerCase();
        });
        for (const e of matched) await real.release(e.id);
        if (matched.length > 0) {
          result.perSubject.push({ subject, released: matched.length });
          result.totalReleased += matched.length;
        } else {
          result.unmatched.push(subject);
        }
      }
      return result;
    },
    cleanupExpired: async (): Promise<number> => {
      throw new Error('scenario harness: cleanupExpired would delete every instance\'s released entries');
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
      // A relayed clarification (#2027): production's token, where the relay send's
      // context_bridge puts it.
      const resumeToken = entry.resume ? encodeResumeToken(entry.resume) : undefined;
      const id = await outboundContext.register({
        conversationId: `${SCENARIO_ENTRY_ORIGIN}${entry.key}`,
        channelId: entry.channelId,
        agentId: entry.agentId,
        content: entry.content,
        expectedReply: entry.expectedReply,
        delegationHint: entry.delegationHint,
        metadata: resumeToken ? { ...entry.metadata, resume_token: resumeToken } : entry.metadata,
        expiresInHours: entry.expiresInHours ?? 6,
      });
      if (resumeToken) seeded.refs.set(`resume_token:${entry.key}`, resumeToken);
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
  // Seeded entries (scenario-origin-…), and any an agent registered from a run's own
  // conversation or a specialist's (#2027).
  await count('outbound_context',
    `DELETE FROM outbound_context WHERE conversation_id LIKE ANY($1::text[])`,
    [[`${SCENARIO_ENTRY_ORIGIN}%`, ...SCENARIO_CONVERSATION_PREFIXES.map(p => `${p}%`)]]);
  // Dispatch claims of real delegations: a real instance's late-delivery sweep would
  // otherwise act on them. Every specialist conversation carries the suite's prefix.
  await count('pending_delegations',
    `DELETE FROM pending_delegations
      WHERE delegate_conversation_id LIKE $1 OR origin_conversation_id LIKE ANY($2::text[])`,
    [`${SCENARIO_DELEGATE_PREFIX}%`, SCENARIO_CONVERSATION_PREFIXES.map(p => `${p}%`)]);
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

  // The seeded entries, and any an agent registered during the run.
  const entryIds = [...new Set([...seeded.entryIds, ...scope.entryIds])];
  if (entryIds.length > 0) {
    await attempt(() => stack.pool.query(`DELETE FROM outbound_context WHERE id = ANY($1::uuid[])`, [entryIds]));
  }
  const threadIds = [...seeded.threads.values()].map(t => t.threadId);
  if (threadIds.length > 0) {
    // Messages and read watermarks cascade.
    await attempt(() => stack.pool.query(`DELETE FROM bullpen_threads WHERE id = ANY($1::uuid[])`, [threadIds]));
  }
  if (conversationId) {
    await attempt(() => cleanupConversation(stack.pool, conversationId));
  }
  const specialists = [...scope.specialistConversations];
  for (const specialist of specialists) {
    await attempt(() => cleanupConversation(stack.pool, specialist));
  }
  if (conversationId || specialists.length > 0) {
    // A dispatch claim a timed-out delegation kept (#1893): nothing in test mode promotes
    // or sweeps it, and a real instance's sweep would act on it.
    await attempt(() => deletePendingDelegations(stack, conversationId ? [conversationId] : [], specialists));
  }
  for (const contact of seeded.contacts) {
    await attempt(() => deleteContact(stack, contact.id, contact.kgNodeId));
  }
  scope.clear();

  if (errors.length > 0) {
    throw new AggregateError(errors, `Scenario cleanup failed for ${errors.length} item(s) — check the database for leftovers`);
  }
}

/** pending_delegations rows a run's coordinator opened, or that a specialist of the run ran under. */
export async function deletePendingDelegations(
  stack: TestModeStack,
  originConversations: string[],
  specialistConversations: string[],
): Promise<void> {
  await stack.pool.query(
    `DELETE FROM pending_delegations
      WHERE origin_conversation_id = ANY($1::text[]) OR delegate_conversation_id = ANY($2::text[])`,
    [originConversations, specialistConversations],
  );
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

export async function resolveSender(
  scenario: ScenarioCase,
  stack: TestModeStack,
): Promise<ResolvedSender | 'bullpen' | 'scheduler'> {
  const { from, channel } = scenario.inbound;
  if (from === 'bullpen' || from === 'scheduler') return from;

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
