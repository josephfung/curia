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
import type { PrincipalBacklogCounts } from '../../src/agents/prompts/backlog-line.js';
import { encodeResumeToken } from '../../src/agents/resume-token.js';
import {
  OutboundContextService,
  isEntryAddressedTo,
  type OutboundContextEntry,
  type OutboundContextRow,
  type RecordedReply,
  type SubjectClearResult,
} from '../../src/dispatch/outbound-context.js';
import type { PrincipalBacklogSource } from '../../src/dispatch/principal-backlog.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import type { TestModeStack } from '../../src/startup/test-mode-stack.js';
import { registrableDomain } from '../../src/verification/domain.js';
import type { VerificationRuntime } from '../../src/verification/index.js';
import type { Verification } from '../../src/verification/types.js';
import { cleanupConversation, sweepConversations } from '../shared/turn-capture.js';
import { resolvePlaceholders } from './loader.js';
import { SCENARIO_DELEGATE_PREFIX } from './stub-layer.js';
import type { DbPool } from '../../src/db/connection.js';
import type { ScenarioCase, SeedContact, SeedPrincipalIdentity } from './types.js';

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
  /** Sign-in verifications the run seeded (#2017), plus any opened during it. */
  readonly verificationIds = new Set<string>();
  /** Browser session ids the run's verification block reads as alive (#2017). */
  readonly aliveSessions = new Set<string>();
  /** Addresses the principal has sent mail to (seed.contacts principal_wrote, #2227), lowercased. */
  readonly principalWroteTo = new Set<string>();
  /** What the run says is waiting on the principal (`seed.backlog`); none when unset. */
  backlog: PrincipalBacklogCounts | undefined;
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
    this.verificationIds.clear();
    this.aliveSessions.clear();
    this.principalWroteTo.clear();
    this.backlog = undefined;
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

  /** Read the run's active entries, recording a failure on the run before rethrowing. */
  const readScoped = async <T>(scope: SeedScope, read: (rows: OutboundContextRow[]) => T): Promise<T> => {
    try {
      return read(await activeEntries(scope));
    } catch (err) {
      // The Dispatcher and runtime log a failed read and carry on without the block, so the
      // run would be scored on a premise it never had; the harness fails it instead.
      scope.errors.push(`outbound-context read failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
  const lastMessageAt = (e: OutboundContextRow): number => e.recipientMessages.at(-1)?.at.getTime() ?? 0;

  return Object.assign(Object.create(real) as OutboundContextService, {
    getActive: async (limit = 10): Promise<OutboundContextRow[]> => {
      const scope = currentScope();
      if (!scope) return [];
      return readScoped(scope, rows => rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit));
    },
    // #2261: the same recipient match, recorded messages and wake list as production's SQL,
    // over the run's entries only. Without these the prototype's methods would read the
    // whole table and show one run's entries to another.
    getActiveForRecipient: async (contactId: string, limit = 10): Promise<OutboundContextRow[]> => {
      const scope = currentScope();
      if (!scope) return [];
      return readScoped(scope, rows => rows
        .filter(e => isEntryAddressedTo(e, contactId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit));
    },
    recordReply: async (entryIds: readonly string[], reply: RecordedReply): Promise<void> => {
      const owned = entryIds.filter(id => owning(id));
      if (owned.length > 0) await real.recordReply(owned, reply);
    },
    getActiveWithReplies: async (
      agentId: string,
      opts: { taskId?: string; recipientContactId?: string; limit?: number } = {},
    ): Promise<OutboundContextRow[]> => {
      const scope = currentScope();
      if (!scope) return [];
      const { taskId, recipientContactId, limit = 10 } = opts;
      const forTask = (e: OutboundContextRow): number =>
        taskId !== undefined && e.metadata?.['task_id'] === taskId ? 1 : 0;
      return readScoped(scope, rows => rows
        .filter(e => e.recipientMessages.length > 0 && e.agentId === agentId)
        .filter(e => recipientContactId === undefined || isEntryAddressedTo(e, recipientContactId))
        .sort((a, b) => forTask(b) - forTask(a) || lastMessageAt(b) - lastMessageAt(a))
        .slice(0, limit));
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

/**
 * The sign-in verification runtime narrowed to the calling run's rows (#2017): what the
 * coordinator's "## Sign-in verifications" block, the Dispatcher's code tracking and the
 * ExecutionLayer read. listActive() is production's (it also persists lazy expiry and keeps
 * the code tracker's TTL in step with the whole table), filtered to the run's ids; any
 * other id reads as unknown. A verification opened during a run joins the run's scope.
 * The code tracker is the real one, shared by every run: cases that seed one site never
 * overlap (seedConflictKeys), and a tracked value only scrubs.
 */
export function scopedVerification(real: VerificationRuntime, currentScope: CurrentScope): VerificationRuntime {
  const owning = (id: string): SeedScope | undefined => {
    const scope = currentScope();
    return scope?.verificationIds.has(id) ? scope : undefined;
  };
  const owned = (v: Verification | null): Verification | null => (v && owning(v.id) ? v : null);
  const service = Object.assign(Object.create(real.service) as VerificationRuntime['service'], {
    get: async (id: string) => (owning(id) ? real.service.get(id) : null),
    liveForTask: async (taskId: string, now?: Date) => owned(await real.service.liveForTask(taskId, now)),
    open: async () => { throw new Error('scenario harness: open verifications through the runtime, not its service'); },
    listActive: async () => { throw new Error('scenario harness: list verifications through the runtime, not its service'); },
    close: async () => { throw new Error('scenario harness: close verifications through the runtime, not its service'); },
  });
  return {
    service,
    tracker: real.tracker,
    open: async (input) => {
      const scope = currentScope();
      if (!scope) throw new Error('scenario harness: a verification was opened outside every run');
      // Another run's pending row, or a real instance's, for the same site: production
      // would reuse it, which here would hand this run someone else's challenge. Refuse
      // before open(): its reuse rewrites the row's session, page domain, delivery and
      // expiry, so refusing afterwards would already have changed the other run's row.
      const site = registrableDomain(input.site);
      const foreign = site === null
        ? undefined
        : (await real.listActive()).find(v => v.status === 'pending' && v.site === site && !scope.verificationIds.has(v.id));
      if (foreign) {
        throw new Error(`scenario harness: ${foreign.site} already has a pending verification outside this run`);
      }
      const result = await real.open(input);
      // Backstop: a row that turned pending between the check and the open.
      if (result.reused && !scope.verificationIds.has(result.verification.id)) {
        throw new Error(`scenario harness: ${result.verification.site} already has a pending verification outside this run`);
      }
      scope.verificationIds.add(result.verification.id);
      return result;
    },
    listActive: async (now?: Date) => {
      const scope = currentScope();
      if (!scope) return [];
      try {
        return (await real.listActive(now)).filter(v => scope.verificationIds.has(v.id));
      } catch (err) {
        scope.errors.push(`verification read failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    close: async (id, status) => (owning(id) ? real.close(id, status) : null),
    askChannel: () => real.askChannel(),
  };
}

/** The browser sessions the calling run's verification block reads as alive (#2017). */
export function scopedBrowserSessionAlive(currentScope: CurrentScope): (sessionId: string) => boolean {
  return (sessionId) => currentScope()?.aliveSessions.has(sessionId) ?? false;
}

/** Nothing waiting: what a run without `seed.backlog`, or any call outside a run, sees. */
const NO_BACKLOG: PrincipalBacklogCounts = { decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 };

/**
 * The backlog counts the Dispatcher reads on a principal turn (prompt trim PR 7), from the
 * calling run's `seed.backlog` rather than the shared database. Production's counts span
 * every row, so a real one would hand each run whatever the instance and the other runs
 * hold. The SQL has its own test (tests/integration/principal-backlog.test.ts); a case
 * stubs the list tools to show what its counts promise.
 */
export function scopedPrincipalBacklog(currentScope: CurrentScope): PrincipalBacklogSource {
  return {
    counts: async (): Promise<PrincipalBacklogCounts> => currentScope()?.backlog ?? NO_BACKLOG,
  };
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
  verificationIds: string[];
  /** Principal identities this run added (seed.principal_identities), and only those. */
  principalIdentityIds: string[];
}

export interface SeedDeps {
  stack: TestModeStack;
  outboundContext: OutboundContextService;
  scope: SeedScope;
}

/** conversation_id of a seeded verification: where the sign-in was "requested". */
const SCENARIO_VERIFICATION_ORIGIN = `${SCENARIO_ENTRY_ORIGIN}verification-`;

/**
 * `contact_channel_identities.label` of every principal identity the suite adds. Cleanup
 * and the sweep delete only rows carrying it, so the principal's own identities survive.
 */
export const SCENARIO_IDENTITY_LABEL = 'scenario-fixture (#2017)';

/**
 * Give the principal `identity` for the run, unless they already have an active identity on
 * that channel (theirs is then used as it is). Returns the added row's id, or null when
 * nothing was added. A raw insert, not ContactService.linkIdentity: that refreshes the
 * principal's identity list every agent's prompt is built from, mid-suite, for every run.
 */
export async function seedPrincipalIdentity(
  pool: DbPool,
  principalContactId: string,
  identity: SeedPrincipalIdentity,
): Promise<string | null> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM contact_channel_identities WHERE contact_id = $1 AND channel = $2 AND status = 'active'`,
    [principalContactId, identity.channel],
  );
  if (existing.rows.length > 0) return null;
  const added = await pool.query<{ id: string }>(
    `INSERT INTO contact_channel_identities
       (contact_id, channel, channel_identifier, label, verified, verified_at, source, status)
     VALUES ($1, $2, $3, $4, true, now(), 'ceo_stated', 'active')
     RETURNING id`,
    [principalContactId, identity.channel, identity.identifier, SCENARIO_IDENTITY_LABEL],
  );
  return added.rows[0]!.id;
}

/** Remove principal identities a run added: only these ids, and only rows carrying the marker. */
export async function removeSeededPrincipalIdentities(pool: DbPool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `DELETE FROM contact_channel_identities WHERE id = ANY($1::uuid[]) AND label = $2`,
    [ids, SCENARIO_IDENTITY_LABEL],
  );
}

/**
 * Create the case's rows. On any failure, removes what it already created before
 * rethrowing, so a half-seeded run never leaks into the next.
 */
export async function seedRun(scenario: ScenarioCase, deps: SeedDeps): Promise<SeededRun> {
  const { stack, outboundContext, scope } = deps;
  const seeded: SeededRun = {
    refs: new Map(), contacts: [], entryIds: [], threads: new Map(), verificationIds: [], principalIdentityIds: [],
  };
  if (stack.principalContactId) seeded.refs.set('principal_contact_id', stack.principalContactId);

  scope.backlog = scenario.seed.backlog;
  try {
    for (const identity of scenario.seed.principalIdentities) {
      if (!stack.principalContactId) throw new Error('No principal contact in this database');
      const added = await seedPrincipalIdentity(stack.pool, stack.principalContactId, identity);
      if (added) seeded.principalIdentityIds.push(added);
    }

    for (const contact of scenario.seed.contacts) {
      const created = await seedContact(stack, contact);
      seeded.contacts.push(created);
      seeded.refs.set(`contact:${contact.key}`, created.id);
      if (contact.principalWrote) scope.principalWroteTo.add(contact.identifier.trim().toLowerCase());
    }

    for (const raw of scenario.seed.outboundContext) {
      const entry = resolvePlaceholders(raw, seeded.refs);
      // A relayed clarification (#2027): production's token, where the relay send's
      // context_bridge puts it.
      const resumeToken = entry.resume ? encodeResumeToken(entry.resume) : undefined;
      const recipientContactIds = (entry.recipients ?? []).map((k) => {
        const id = seeded.refs.get(`contact:${k}`);
        if (!id) throw new Error(`seed.outbound_context '${entry.key}': recipient '${k}' is not a seeded contact key`);
        return id;
      });
      const id = await outboundContext.register({
        conversationId: `${SCENARIO_ENTRY_ORIGIN}${entry.key}`,
        channelId: entry.channelId,
        agentId: entry.agentId,
        content: entry.content,
        expectedReply: entry.expectedReply,
        delegationHint: entry.delegationHint,
        metadata: resumeToken ? { ...entry.metadata, resume_token: resumeToken } : entry.metadata,
        expiresInHours: entry.expiresInHours ?? 6,
        ...(recipientContactIds.length > 0 ? { recipientContactIds } : {}),
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

    for (const raw of scenario.seed.verifications) {
      const v = resolvePlaceholders(raw, seeded.refs);
      // Through the runtime the run's agents see (the scoped view), so the row joins the
      // run's scope, and a pending row the site already has elsewhere fails the seed.
      const { verification } = await stack.verification.open({
        purpose: 'sign_in',
        kind: 'code',
        delivery: v.delivery,
        site: v.site,
        pageDomain: v.pageDomain,
        browserSessionId: v.browserSessionId,
        ...(v.taskId ? { taskId: v.taskId } : {}),
        conversationId: `${SCENARIO_VERIFICATION_ORIGIN}${v.key}`,
      });
      seeded.verificationIds.push(verification.id);
      seeded.refs.set(`verification:${v.key}`, verification.id);
      if (v.sessionAlive) scope.aliveSessions.add(v.browserSessionId);
      // Backdate the request, keep production's expiry after it, and close a non-pending
      // row: an expired one at its expiry (as listActive persists it), any other now.
      await stack.pool.query(
        `UPDATE verifications
            SET requested_at = now() - make_interval(mins => $2),
                expires_at = now() - make_interval(mins => $2) + make_interval(mins => $3),
                status = $4,
                resolved_at = CASE $4 WHEN 'pending' THEN NULL
                                      WHEN 'expired' THEN now() - make_interval(mins => $2) + make_interval(mins => $3)
                                      ELSE now() END
          WHERE id = $1`,
        [verification.id, v.requestedMinutesAgo, stack.verification.service.config.defaultExpiryMinutes, v.status],
      );
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
  await count('principal_identities',
    `DELETE FROM contact_channel_identities WHERE label = $1`,
    [SCENARIO_IDENTITY_LABEL]);
  // Seeded verifications (scenario-origin-verification-…), and any opened in a run's conversation.
  await count('verifications',
    `DELETE FROM verifications WHERE conversation_id LIKE ANY($1::text[])`,
    [[`${SCENARIO_VERIFICATION_ORIGIN}%`, ...SCENARIO_CONVERSATION_PREFIXES.map(p => `${p}%`)]]);
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
  return [
    ...scenario.seed.contacts.flatMap(c => [
      `identity:${c.channel}:${c.identifier.toLowerCase()}`,
      `name:${c.displayName.trim().toLowerCase()}`,
    ]),
    // One pending verification per site (#2017). Every seeded row is opened as pending
    // before its status is set, so two runs seeding one site collide whatever the status.
    ...scenario.seed.verifications.map(v => `verification-site:${registrableDomain(v.site) ?? v.site.toLowerCase()}`),
    // A principal identity a run adds is visible to every run while it lasts, and a second
    // case adding one on the same channel could remove the first's mid-run.
    ...scenario.seed.principalIdentities.map(p => `principal-identity:${p.channel}`),
  ];
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
  const verificationIds = [...new Set([...seeded.verificationIds, ...scope.verificationIds])];
  if (verificationIds.length > 0) {
    await attempt(() => stack.pool.query(`DELETE FROM verifications WHERE id = ANY($1::uuid[])`, [verificationIds]));
  }
  await attempt(() => removeSeededPrincipalIdentities(stack.pool, seeded.principalIdentityIds));
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
): Promise<ResolvedSender | 'bullpen' | 'scheduler' | 'task-wake' | { delegate: ResolvedSender }> {
  const { from, channel } = scenario.inbound;
  if (from === 'bullpen' || from === 'scheduler' || from === 'task-wake') return from;
  // A delegated task has no channel sender: the coordinator sends it. What carries over is
  // the requester the coordinator was serving, as the originator the delegate handler
  // forwards (#2025).
  if (from === 'delegate') {
    const requester = scenario.inbound.requester ?? 'principal';
    const resolved = await resolveSender({ ...scenario, inbound: { ...scenario.inbound, from: requester } }, stack);
    if (typeof resolved === 'string' || 'delegate' in resolved) throw new Error(`unreachable: requester '${requester}'`);
    return { delegate: resolved };
  }

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

/**
 * Curia's own address in a scenario's email envelope (`curia` in inbound.email.to / cc).
 * The harness Dispatcher takes it as its selfEmail, so the participants block shows "you".
 */
export const SCENARIO_CURIA_EMAIL = 'curia@example.test';

/** An inbound email's To and CC as addresses (types.ts: inbound.email.to / cc). */
export interface ResolvedEnvelope {
  to: string[];
  cc: string[];
}

/** Resolve inbound.email.to / cc tokens to addresses; undefined when the case names neither. */
export async function resolveEnvelope(scenario: ScenarioCase, stack: TestModeStack): Promise<ResolvedEnvelope | undefined> {
  const { to, cc } = scenario.inbound.email ?? {};
  if (to === undefined && cc === undefined) return undefined;
  let principalEmail: string | undefined;
  const address = async (token: string): Promise<string> => {
    if (token === 'curia') return SCENARIO_CURIA_EMAIL;
    if (token === 'principal') {
      if (principalEmail === undefined) {
        if (!stack.principalContactId) throw new Error('No principal contact in this database');
        const identities = await stack.contactService.getIdentitiesForContact(stack.principalContactId);
        const email = identities.find(i => i.channel === 'email');
        if (!email) throw new Error(`Case '${scenario.name}' names the principal in its envelope, but the principal has no email identity in this database.`);
        principalEmail = email.channelIdentifier;
      }
      return principalEmail;
    }
    const contact = scenario.seed.contacts.find(c => c.key === token);
    // The loader allows only curia, principal, a seeded key or an example.test address.
    return contact ? contact.identifier : token;
  };
  const resolveAll = async (tokens: string[] | undefined): Promise<string[]> => {
    const out: string[] = [];
    for (const t of tokens ?? []) out.push(await address(t));
    return out;
  };
  return { to: await resolveAll(to), cc: await resolveAll(cc) };
}

/** A fresh outbound-context service on the stack's pool (the stack does not build one). */
export function createOutboundContextService(stack: TestModeStack): OutboundContextService {
  return new OutboundContextService(stack.pool, stack.logger);
}
