// tests/integration/dedup-contacts-merge.test.ts
//
// Integration test for the dedup-contacts script's merge path.
//
// Specifically verifies that the REAL ContactService.mergeContacts() path is used,
// not the old hand-rolled SQL — the real path re-points the loser's channel
// identities onto the survivor (reattachIdentities) and records an audit row,
// which the hand-rolled UPDATE did neither of.
//
// Requires a running Postgres with all migrations applied.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import { DedupService } from '../../src/contacts/dedup-service.js';
import { createContactMerged } from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;

// Skip the entire suite if DATABASE_URL is not set — no database available
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

// Tracked IDs for explicit DELETE cleanup in afterAll
const createdContactIds: string[] = [];
const createdKgNodeIds: string[] = [];

describeIf('dedup-contacts merge integration', () => {
  let pool: pg.Pool;
  let contactService: ContactService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Use the same service construction as the rewritten CLI entry point, but with
    // a fake embedding service (no OPENAI_API_KEY required in CI) and a silent logger.
    // This confirms the real service stack wiring is used for merges.
    const logger = createSilentLogger();

    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);

    const auditLogger = new AuditLogger(pool, logger);
    // Wire EventBus with the write-ahead audit hook — identical to the CLI entry point.
    const bus = new EventBus(
      logger,
      (e) => auditLogger.log(e),
      (id) => auditLogger.markAcknowledged(id),
    );

    const dedupService = new DedupService();
    contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
      dedupService,
      // Publish contact.merged to the bus so the audit hook records it.
      // This is the acceptance criterion path: bus.publish → auditLogger.log → audit_log row.
      onContactMerged: (primaryContactId, secondaryContactId, mergedAt) => {
        bus.publish('dispatch', createContactMerged({ primaryContactId, secondaryContactId, mergedAt }))
          .catch(() => {
            // Swallow in tests — the test assertions verify the row exists; a logging error
            // here would mask the actual assertion failure.
          });
      },
    });

    // Verify that the contacts table is accessible — fails fast if migrations haven't run
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
  });

  afterAll(async () => {
    // Clean up in FK-constraint order:
    //   channel identities → auth overrides → contacts → kg edges → kg nodes
    // We use explicit ID lists rather than DELETE FROM table (which would nuke data
    // created by other test suites running in parallel).
    if (createdContactIds.length > 0) {
      await pool.query(
        'DELETE FROM contact_channel_identities WHERE contact_id = ANY($1)',
        [createdContactIds],
      );
      await pool.query(
        'DELETE FROM contact_auth_overrides WHERE contact_id = ANY($1)',
        [createdContactIds],
      );
      await pool.query(
        'DELETE FROM contacts WHERE id = ANY($1)',
        [createdContactIds],
      );
    }
    if (createdKgNodeIds.length > 0) {
      await pool.query(
        'DELETE FROM kg_edges WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)',
        [createdKgNodeIds],
      );
      await pool.query(
        'DELETE FROM kg_nodes WHERE id = ANY($1)',
        [createdKgNodeIds],
      );
    }
    // NOTE: audit_log rows produced by this test are deliberately NOT cleaned up.
    // audit_log is append-only — a DB trigger rejects DELETE (only acknowledged
    // false→true is permitted) — so attempting to delete here would throw. Leftover
    // rows are harmless: the test matches its own run's row by the unique per-run
    // contact IDs, so accumulated rows from prior runs never affect the assertions.
    await pool.end();
  });

  it(
    'merges two contacts via the real service path, reattaching the loser\'s identities to the survivor, and writes an audit_log row',
    async () => {
      // Unique email suffix per test run so parallel runs don't collide
      const runId = Date.now().toString(36);
      // Each contact has its OWN email. Two contacts CANNOT share an identifier:
      // migration 005's UNIQUE(channel, channel_identifier) (and 044's LOWER() index)
      // enforce global uniqueness, so the realistic dedup case is two contacts with
      // distinct/complementary identities matched by name or kg_node_id, then merged.
      const primaryEmail = `dedup-merge-primary-${runId}@example.com`;
      const secondaryEmail = `dedup-merge-secondary-${runId}@example.com`;

      // --- 1. Create two contacts, each with a KG node (entityMemory is wired) ---

      const primary = await contactService.createContact({
        displayName: `Dedup Primary ${runId}`,
        source: 'ceo_stated',
        status: 'confirmed',
      });
      createdContactIds.push(primary.id);
      if (primary.kgNodeId) createdKgNodeIds.push(primary.kgNodeId);

      const secondary = await contactService.createContact({
        displayName: `Dedup Secondary ${runId}`,
        source: 'email_participant',
        status: 'provisional',
      });
      createdContactIds.push(secondary.id);
      if (secondary.kgNodeId) createdKgNodeIds.push(secondary.kgNodeId);

      // Each contact gets its own distinct verified email. The merge must re-point the
      // loser's identity onto the survivor via the real ContactService.mergeContacts()
      // path (reattachIdentities) — the old hand-rolled UPDATE skipped this entirely.
      await contactService.linkIdentity({
        contactId: primary.id,
        channel: 'email',
        channelIdentifier: primaryEmail,
        source: 'ceo_stated',
      });
      await contactService.linkIdentity({
        contactId: secondary.id,
        channel: 'email',
        channelIdentifier: secondaryEmail,
        source: 'email_participant',
      });

      // --- 2. Confirm both contacts exist before the merge ---

      const primaryBefore = await contactService.getContact(primary.id);
      const secondaryBefore = await contactService.getContact(secondary.id);
      expect(primaryBefore).toBeDefined();
      expect(secondaryBefore).toBeDefined();

      // --- 3. Run the REAL merge path used by the script ---
      //
      // This is the exact call the CLI entry point makes after the fix.
      // dryRun=false → performs the real write, fires the bus event, and records an audit row.
      const mergeResult = await contactService.mergeContacts(primary.id, secondary.id, false);

      // MergeResult (dryRun=false path) carries dryRun=false and primaryContactId
      expect(mergeResult.primaryContactId).toBe(primary.id);
      expect('dryRun' in mergeResult && mergeResult.dryRun).toBe(false);

      // --- 4. Assert: loser contact row is gone ---

      const secondaryAfter = await contactService.getContact(secondary.id);
      expect(secondaryAfter).toBeUndefined();

      // --- 5. Assert: loser's channel identity now belongs to the survivor ---
      //
      // The real ContactService.mergeContacts() calls reattachIdentities(), which
      // re-points the loser's rows onto the survivor (deleting any that would collide
      // with the survivor's existing identifiers first). The survivor should now carry
      // BOTH emails — proof the identity actually moved rather than being dropped.
      const withIdentities = await contactService.getContactWithIdentities(primary.id);
      expect(withIdentities).toBeDefined();
      const emails = withIdentities!.identities.map(i => i.channelIdentifier);

      expect(emails).toContain(primaryEmail);
      expect(emails).toContain(secondaryEmail);
      // Each identifier appears exactly once (no duplicate rows introduced by the merge)
      expect(emails.filter(e => e === secondaryEmail).length).toBe(1);

      // --- 6. Assert: an audit_log row exists for the contact.merged event ---
      //
      // The bus publish → write-ahead hook → auditLogger.log() flow runs synchronously
      // before event delivery, so the row exists immediately after mergeContacts() resolves.
      // We poll for up to ~500ms to allow any async publish Promise to settle.
      let auditRow: { event_type: string; payload: string } | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        const { rows } = await pool.query<{ event_type: string; payload: string }>(
          `SELECT event_type, payload::text AS payload
           FROM audit_log
           WHERE event_type = 'contact.merged'
             AND payload->>'primaryContactId' = $1
             AND payload->>'secondaryContactId' = $2
           LIMIT 1`,
          [primary.id, secondary.id],
        );
        if (rows.length > 0) {
          auditRow = rows[0]!;
          break;
        }
        // Brief pause — the onContactMerged callback's bus.publish() is async
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(auditRow).toBeDefined();
      expect(auditRow!.event_type).toBe('contact.merged');

      // Confirm the payload carries both contact IDs (no deep JSON parse needed — text search is fine)
      expect(auditRow!.payload).toContain(primary.id);
      expect(auditRow!.payload).toContain(secondary.id);
    },
  );
});
