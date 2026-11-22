// tests/integration/setup-routes.test.ts
//
// Integration tests for /api/setup/* endpoints (issue #771).
// Verifies authentication, validation, idempotency, and the status-flag wiring
// to setupRequiredAtBoot.
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.
//
// IMPORTANT: requires a DB with NO pre-existing principal contact. The partial
// unique index on system_role='principal' means the "creates a principal" cases
// will 23505 if any other principal already exists in the database. CI runs
// against a fresh container; for local dev runs, point DATABASE_URL at an empty
// test database, not your working dev database.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { setupRoutes } from '../../src/channels/http/routes/setup.js';
import { createLogger, createSilentLogger } from '../../src/logger.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import {
  markSetupComplete,
  readSetupState,
  SetupSettingsError,
  updateSetupState,
  type SetupWriteOptions,
} from '../../src/setup/setup-settings.js';
import type { SetupChecklist } from '../../src/setup/checklist.js';
import { requireCuriaTestDatabase } from './require-test-db.js';
import { completeSetup } from '../../src/setup/complete-setup.js';
import { lockSetupSingletons } from './setup-singletons-lock.js';
import { isIdentityConfigured } from '../../src/channels/http/routes/identity.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const TEST_SECRET = 'setup-route-test-secret';
/** Confirmation notices sent while saving the operator (#2710). */
const operatorNotices = vi.fn(async (_request: { notificationType: string; subject: string; body: string }) => true);
const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };
const TEST_LABEL_PREFIX = 'Setup-Route Test';
// The settings migration 132 created for Setup (#2709). These suites own them.
const SETUP_SETTING_KEYS = ['operator', 'operator_confirmation', 'messaging_route', 'voice_route', 'setup.completed_at'];
// Person labels this file writes that do not use the prefix above.
const OWNED_KG_LABELS = [
  'Original Name',
  'Corrected Name',
  'Same Name',
  'Profile Owner',
  'TZ Tester',
  'Full Profile',
  'Partial',
];

describeIf('/api/setup/* routes', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');

  // Two apps: one booted as setupRequiredAtBoot=true (the wizard-mode case),
  // one as false (post-restart). Both share the DB and session store so we can
  // assert the status flag responds to the boot-time value, not live state.
  let appSetupMode: FastifyInstance;
  let appNormalMode: FastifyInstance;
  let bootStartedAtSetupMode: string;
  let bootStartedAtNormalMode: string;
  // Sessions intentionally empty — tests use the bootstrap-secret header.
  const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();
  // Captured calls into the injected scheduleProcessExit hook; assert on this
  // instead of actually exiting the test runner.
  const processExitCalls: number[] = [];
  // Node ids present when this file started. Cleanup never deletes them: a
  // pre-existing row can share a label with a principal this file creates.
  let preExistingNodeIds: string[] = [];
  let graphSnapshotReady = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Every hook below deletes rows (principal contacts, setup settings): refuse anything but
    // the isolated test database before the first of them runs.
    await requireCuriaTestDatabase(pool);
    await pool.query('SELECT 1 FROM contacts LIMIT 0');

    // Other test files (notably ceo-bootstrap.test.ts) may leave a principal contact
    // behind. Clear it so the partial unique index doesn't trip the "creates" cases.
    // Destructive — see the file header comment for required DB posture.
    await pool.query(
      `DELETE FROM contact_channel_identities WHERE contact_id IN
         (SELECT id FROM contacts WHERE system_role = 'principal')`,
    );
    await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);

    // Build the services needed by setup routes (#392). Mirrors the pattern in
    // tests/integration/contacts.test.ts — EmbeddingService.createForTesting()
    // produces a no-op embedder (no OpenAI key required), which is fine here
    // since the existing tests don't exercise KG-backed endpoints yet.
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, createSilentLogger());
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);

    // Each test app gets its own bootStartedAt — when we exercise the polling
    // loop's "different boot" detection in the frontend later, the same logic
    // applies here: a new process produces a strictly-later timestamp.
    bootStartedAtSetupMode = '2026-05-31T18:00:00.000Z';
    bootStartedAtNormalMode = '2026-05-31T18:30:00.000Z';

    const buildApp = async (
      setupRequiredAtBoot: boolean,
      bootStartedAt: string,
      scheduleProcessExit: (delayMs: number) => void,
    ) => {
      const app = Fastify();
      // rate-limit plugin is required because setup routes attach { config: { rateLimit: ... } }
      // per route — without it Fastify errors on registration.
      // allowList bypasses rate-limit enforcement in tests so that the route-level
      // max:10 cap doesn't throttle requests as the test count grows.
      await app.register(rateLimit, { max: 1000, timeWindow: '1 minute', allowList: () => true });
      await app.register(setupRoutes, {
        webAppBootstrapSecret: TEST_SECRET,
        sessions,
        pool,
        logger,
        setupRequiredAtBoot,
        bootStartedAt,
        scheduleProcessExit,
        contactService,
        entityMemory,
        // The operator's confirmation notice (#2710): recorded, not sent anywhere.
        outboundGateway: { sendNotification: operatorNotices },
        appOrigin: 'https://curia.example.com',
      });
      await app.ready();
      return app;
    };

    appSetupMode = await buildApp(true, bootStartedAtSetupMode, (delayMs) => {
      processExitCalls.push(delayMs);
    });
    appNormalMode = await buildApp(false, bootStartedAtNormalMode, (delayMs) => {
      processExitCalls.push(delayMs);
    });

    const existing = await pool.query<{ id: string }>(`SELECT id FROM kg_nodes`);
    preExistingNodeIds = existing.rows.map((row) => row.id);
    graphSnapshotReady = true;
  });

  // Person nodes this file mints (source bootstrap, not already in the database,
  // and not linked to a contact) and the setup-wizard facts hanging off those
  // people. Facts are reached only through that set, so a matching label on
  // someone else's person cannot pull their facts into the delete. Edges
  // cascade with the node. The contact guard is the second line: deleting a
  // linked node fails contacts_kg_node_id_fkey.
  async function deleteOwnedKnowledgeGraph(): Promise<void> {
    if (!graphSnapshotReady) return;
    await pool.query(
      `WITH owned_people AS (
         SELECT n.id
           FROM kg_nodes n
          WHERE n.type = 'person'
            AND n.source = 'bootstrap'
            AND (n.label LIKE $1 OR n.label = ANY($2::text[]))
            AND NOT (n.id = ANY($3::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.kg_node_id = n.id)
       ),
       owned_facts AS (
         SELECT f.id
           FROM kg_edges e
           JOIN owned_people person ON person.id = e.source_node_id
           JOIN kg_nodes f ON f.id = e.target_node_id
          WHERE f.type = 'fact'
            AND f.source = 'system:setup-wizard'
            AND NOT (f.id = ANY($3::uuid[]))
       )
       DELETE FROM kg_nodes
        WHERE id IN (SELECT id FROM owned_people UNION SELECT id FROM owned_facts)
          AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.kg_node_id = kg_nodes.id)`,
      [`${TEST_LABEL_PREFIX}%`, OWNED_KG_LABELS, preExistingNodeIds],
    );
  }

  afterAll(async () => {
    await appSetupMode.close();
    await appNormalMode.close();
    // Identities → contacts, then only the graph rows this file created.
    try {
      await pool.query(
        `DELETE FROM contact_channel_identities WHERE contact_id IN
           (SELECT id FROM contacts WHERE system_role = 'principal')`,
      );
      await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);
      await deleteOwnedKnowledgeGraph();
    } finally {
      await pool.end();
    }
  });

  // Clean up rows this file created. Prefixed contacts go here; the graph helper
  // drops this file's person nodes and wizard facts once nothing links them.
  // We never blind-delete by system_role='principal' in this hook because that
  // would destroy a real operator's principal contact when these tests are run
  // against a working dev database. The partial unique index on
  // system_role='principal' means tests that try to create a new principal MUST run
  // against a database where no prior principal exists — typically a fresh CI DB.
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM contact_channel_identities WHERE contact_id IN
         (SELECT id FROM contacts WHERE display_name LIKE $1)`,
      [`${TEST_LABEL_PREFIX}%`],
    );
    await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${TEST_LABEL_PREFIX}%`]);
    await deleteOwnedKnowledgeGraph();
    // Reset the captured restart-trigger calls between tests so each restart
    // test sees a fresh array.
    processExitCalls.length = 0;
  });

  describe('knowledge-graph cleanup', () => {
    it('keeps pre-existing rows, foreign people, and facts whose person is still linked', async () => {
      const insertPair = async (personSource: string) => {
        const inserted = await pool.query<{ person_id: string; fact_id: string }>(
          `WITH person AS (
             INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, identity_source)
             VALUES ('person', 'Partial', '{}', 1, 'permanent', $1, 'contact')
             RETURNING id
           ),
           fact AS (
             INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, identity_source)
             VALUES ('fact', 'Working hours', '{"attribute":"working_hours"}', 1, 'permanent', 'system:setup-wizard', 'label')
             RETURNING id
           ),
           edge AS (
             INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
             SELECT person.id, fact.id, 'relates_to', 'system:setup-wizard' FROM person, fact
             RETURNING source_node_id, target_node_id
           )
           SELECT source_node_id AS person_id, target_node_id AS fact_id FROM edge`,
          [personSource],
        );
        return inserted.rows[0]!;
      };

      const prior = await insertPair('bootstrap');
      preExistingNodeIds.push(prior.person_id, prior.fact_id);
      const foreign = await insertPair('other-suite');
      const linked = await insertPair('bootstrap');
      const contact = await pool.query<{ id: string }>(
        `INSERT INTO contacts (kg_node_id, display_name, role, tier, kind)
         VALUES ($1, 'Linked Partial', 'friend', 'known', 'person')
         RETURNING id`,
        [linked.person_id],
      );
      const contactId = contact.rows[0]!.id;
      const protectedIds = [prior.person_id, prior.fact_id, foreign.person_id, foreign.fact_id, linked.person_id, linked.fact_id];

      try {
        await deleteOwnedKnowledgeGraph();
        const kept = await pool.query<{ id: string }>(
          `SELECT id FROM kg_nodes WHERE id = ANY($1::uuid[])`,
          [protectedIds],
        );
        expect(kept.rows).toHaveLength(protectedIds.length);
        const priorEdge = await pool.query(
          `SELECT id FROM kg_edges WHERE source_node_id = $1 AND target_node_id = $2`,
          [prior.person_id, prior.fact_id],
        );
        expect(priorEdge.rows).toHaveLength(1);

        await pool.query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
        await deleteOwnedKnowledgeGraph();
        const afterUnlink = await pool.query<{ id: string }>(
          `SELECT id FROM kg_nodes WHERE id = ANY($1::uuid[])`,
          [protectedIds],
        );
        const remaining = new Set(afterUnlink.rows.map((row) => row.id));
        expect(remaining.has(prior.person_id)).toBe(true);
        expect(remaining.has(prior.fact_id)).toBe(true);
        expect(remaining.has(foreign.person_id)).toBe(true);
        expect(remaining.has(foreign.fact_id)).toBe(true);
        expect(remaining.has(linked.person_id)).toBe(false);
        expect(remaining.has(linked.fact_id)).toBe(false);
      } finally {
        await pool.query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
        await pool.query(`DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])`, [protectedIds]);
      }
    });
  });

  describe('POST /api/setup/principal', () => {
    // Each test in this block creates a principal, but the partial unique index on
    // system_role='principal' allows at most one row. Clear it before each test so
    // tests that create a principal don't collide with one another.
    beforeEach(async () => {
      await pool.query(
        `DELETE FROM contact_channel_identities WHERE contact_id IN
           (SELECT id FROM contacts WHERE system_role = 'principal')`,
      );
      await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);
    });

    async function stampVector(kgNodeId: string): Promise<void> {
      await pool.query(
        `UPDATE kg_nodes SET embedding = $1::vector, embedding_model = 'test-model' WHERE id = $2`,
        [`[${Array.from({ length: 1536 }, () => 0.1).join(',')}]`, kgNodeId],
      );
    }

    async function readVector(kgNodeId: string): Promise<{ label: string; hasEmbedding: boolean; model: string | null }> {
      const { rows } = await pool.query<{ label: string; has_embedding: boolean; embedding_model: string | null }>(
        `SELECT label, embedding IS NOT NULL AS has_embedding, embedding_model FROM kg_nodes WHERE id = $1`,
        [kgNodeId],
      );
      return { label: rows[0]!.label, hasEmbedding: rows[0]!.has_embedding, model: rows[0]!.embedding_model };
    }

    it('creates a principal contact and returns its IDs', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Alice` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        contactId: string;
        kgNodeId: string;
        alreadyExisted: boolean;
      };
      expect(body.contactId).toBeTruthy();
      expect(body.kgNodeId).toBeTruthy();
      expect(body.alreadyExisted).toBe(false);

      // Verify the contact landed with the expected fields
      const row = await pool.query<{ system_role: string; display_name: string }>(
        `SELECT system_role, display_name FROM contacts WHERE id = $1`,
        [body.contactId],
      );
      expect(row.rows[0]!.system_role).toBe('principal');
      expect(row.rows[0]!.display_name).toBe(`${TEST_LABEL_PREFIX} Alice`);
    });

    it('is idempotent — second call returns the existing principal with alreadyExisted=true', async () => {
      const first = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Beth` },
      });
      const second = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Beth` },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      const secondBody = JSON.parse(second.body);
      expect(secondBody.alreadyExisted).toBe(true);
      expect(secondBody.contactId).toBe(firstBody.contactId);
    });

    it('renames the principal when called again with a different name', async () => {
      const first = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Original Name' },
      });
      expect(first.statusCode).toBe(200);
      const { contactId } = first.json() as { contactId: string };

      const second = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Corrected Name' },
      });
      expect(second.statusCode).toBe(200);
      const body = second.json() as { alreadyExisted: boolean; renamed: boolean; contactId: string };
      expect(body.alreadyExisted).toBe(true);
      expect(body.renamed).toBe(true);
      expect(body.contactId).toBe(contactId);

      const row = await pool.query<{ display_name: string }>(
        `SELECT display_name FROM contacts WHERE id = $1`, [contactId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.display_name).toBe('Corrected Name');
    });

    it('clears the KG vector and its model when the rename changes the label', async () => {
      const first = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Original Name' },
      });
      const { kgNodeId } = first.json() as { kgNodeId: string };
      await stampVector(kgNodeId);

      const second = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Corrected Name' },
      });
      expect((second.json() as { renamed: boolean }).renamed).toBe(true);

      expect(await readVector(kgNodeId)).toEqual({ label: 'Corrected Name', hasEmbedding: false, model: null });
    });

    it('keeps the KG vector and its model when the rename leaves the label unchanged', async () => {
      const first = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Same Name' },
      });
      const { contactId, kgNodeId } = first.json() as { contactId: string; kgNodeId: string };
      await stampVector(kgNodeId);
      // Only the contact differs, so the route renames while the node label stays the same.
      await pool.query(`UPDATE contacts SET display_name = 'Partial' WHERE id = $1`, [contactId]);

      const second = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Same Name' },
      });
      expect((second.json() as { renamed: boolean }).renamed).toBe(true);

      expect(await readVector(kgNodeId)).toEqual({ label: 'Same Name', hasEmbedding: true, model: 'test-model' });
    });

    it('does not rename when the same name is submitted', async () => {
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Same Name' },
      });
      const again = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Same Name' },
      });
      expect((again.json() as { renamed: boolean }).renamed).toBe(false);
    });

    it('returns 400 when the name is missing', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when the name is empty or whitespace', async () => {
      const empty = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: '' },
      });
      expect(empty.statusCode).toBe(400);

      const whitespace = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: '   ' },
      });
      expect(whitespace.statusCode).toBe(400);
    });

    it('returns 400 when the name exceeds the length limit', async () => {
      const tooLong = 'X'.repeat(201);
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: tooLong },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} NoAuth` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/setup/status', () => {
    it('reports principalExists=false on a fresh DB (no principal, no identity)', async () => {
      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.principalExists).toBe(false);
      // identityConfigured depends on whether anything else in this DB ever wrote
      // a wizard/api identity version — we only assert the field exists and is boolean.
      expect(typeof body.identityConfigured).toBe('boolean');
      // externalAdaptersPending requires both principal AND identityConfigured AND setupRequiredAtBoot.
      // Without a principal, it must be false regardless of the boot flag.
      expect(body.externalAdaptersPending).toBe(false);
    });

    it('returns the bootStartedAt timestamp configured at app construction', async () => {
      // The wizard's post-restart polling loop compares this value across
      // responses to detect that the supervisor has brought the new process
      // up; if the status response stopped including it, that detection
      // would silently break. Each app instance gets a distinct boot stamp.
      const setupRes = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      const normalRes = await appNormalMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      expect(JSON.parse(setupRes.body).bootStartedAt).toBe(bootStartedAtSetupMode);
      expect(JSON.parse(normalRes.body).bootStartedAt).toBe(bootStartedAtNormalMode);
    });

    it('reports principalExists=true after creating one', async () => {
      await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Carol` },
      });

      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.principalExists).toBe(true);
    });

    it('externalAdaptersPending stays false in normal-mode boot even after setup completes', async () => {
      // Seed a principal so principalExists=true.
      await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Dani` },
      });

      const res = await appNormalMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      const body = JSON.parse(res.body);
      // setupRequiredAtBoot=false → externalAdaptersPending is always false,
      // since the adapters were already started at boot.
      expect(body.externalAdaptersPending).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // Curia's name is ticked by isIdentityConfigured. The Working style extra saves only a tone,
  // so its save must not tick it (#2358). In a transaction that is rolled back, so the shared
  // test database keeps its identity rows.
  describe('isIdentityConfigured', () => {
    it('counts a wizard or api save, not a Working style tone save', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // As if no wizard or api save existed yet (rolled back below; no row is deleted).
        await client.query(`UPDATE office_identity_versions SET changed_by = 'system_default' WHERE changed_by IN ('wizard', 'api')`);
        const insert = (changedBy: string) => client.query(
          `INSERT INTO office_identity_versions (version, config, changed_by)
           VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM office_identity_versions), '{}'::jsonb, $1)`,
          [changedBy],
        );
        await insert('working_style');
        expect(await isIdentityConfigured(client)).toBe(false);
        await insert('wizard');
        expect(await isIdentityConfigured(client)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('POST /api/setup/restart', () => {
    // The restart endpoint refuses (409) unless setup prerequisites are
    // actually complete. Seed the prerequisites for the happy-path test.
    //
    // Robust against parallel test files (vitest workers share the DB): the
    // prerequisite checks only need ANY principal to exist and ANY wizard/api
    // identity version to exist, so we write our own and tolerate whatever
    // else is in the database. INSERT...ON CONFLICT keeps this idempotent
    // even when a parallel test file's principal still exists.
    // Returns the id of the identity version row it inserted so the caller can
    // remove it. That row is never made current (office_identity_current is left
    // alone), which is a state production cannot reach: update() writes both in one
    // transaction. Left behind, it makes the next OfficeIdentityService.initialize()
    // on this DB try to seed version 1 and fail on UNIQUE(version) (#1966 CI).
    async function seedSetupPrerequisites(): Promise<number> {
      // Principal contact. The partial unique index on system_role='principal'
      // means at most one row can have that role; ON CONFLICT DO NOTHING is
      // the cheapest way to express "make sure one exists, don't care whose".
      await pool.query(
        `INSERT INTO contacts (id, display_name, role, tier, kind, system_role, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'ceo', 'principal', 'principal', 'principal', now(), now())
         ON CONFLICT DO NOTHING`,
        [`${TEST_LABEL_PREFIX} RestartHappy`],
      );

      // Identity version. UNIQUE(version) is the only constraint; the
      // max+1 expression races with concurrent inserters but pg raises 23505
      // rather than silently producing dup keys — retry once is enough for
      // a two-worker collision in practice.
      for (let attempt = 0; ; attempt++) {
        try {
          const inserted = await pool.query<{ id: number }>(
            `INSERT INTO office_identity_versions (version, config, changed_by, note)
             VALUES (
               (SELECT COALESCE(MAX(version), 0) + 1 FROM office_identity_versions),
               '{}'::jsonb,
               'wizard',
               'setup-routes test'
             )
             RETURNING id`,
          );
          return inserted.rows[0]!.id;
        } catch (err) {
          if ((err as { code?: string }).code !== '23505' || attempt === 2) throw err;
        }
      }
    }

    // Delete only the row this test inserted, and only while nothing points at it.
    async function removeSeededIdentityVersion(id: number): Promise<void> {
      await pool.query(
        `DELETE FROM office_identity_versions
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM office_identity_current WHERE version_id = $1)`,
        [id],
      );
    }

    it('schedules a process exit when setup is complete in setup-required mode', async () => {
      const seededIdentityVersionId = await seedSetupPrerequisites();
      try {
        // Sanity-check that the seed actually landed before exercising the
        // endpoint under test. Integration tests share a single DB across
        // worker processes, so a precondition that "should be" true can be
        // raced out from under us (e.g. another file's beforeAll wiping
        // principals). Asserting here means a 409 from the restart POST is
        // unambiguous — it'd be a real bug in the endpoint, not seed flake.
        const statusRes = await appSetupMode.inject({
          method: 'GET',
          url: '/api/setup/status',
          headers: AUTH_HEADER,
        });
        const status = JSON.parse(statusRes.body);
        expect(status.principalExists, 'principal must exist for happy-path seed').toBe(true);
        expect(status.identityConfigured, 'identity must be configured for happy-path seed').toBe(true);

        const res = await appSetupMode.inject({
          method: 'POST',
          url: '/api/setup/restart',
          headers: AUTH_HEADER,
        });
        // If this assertion ever fails again on CI, surface the response body
        // so the failure tells us which branch the endpoint took.
        expect(res.statusCode, `restart POST body: ${res.body}`).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.restarting).toBe(true);
        expect(typeof body.exitDelayMs).toBe('number');
        // Asserting on the captured spy rather than the wall clock so the test
        // doesn't have to actually wait for the (mocked) exit to fire.
        expect(processExitCalls).toHaveLength(1);
        expect(processExitCalls[0]).toBe(body.exitDelayMs);
      } finally {
        await removeSeededIdentityVersion(seededIdentityVersionId);
      }
    });

    it('returns 409 in setup-required mode when prerequisites are not met', async () => {
      // Wipe any principal a parallel test file (notably ceo-bootstrap.test.ts)
      // may have created so the prerequisite check resolves to false. The
      // wider cleanup in the outer beforeEach only filters by display_name
      // prefix, which doesn't catch other files' principals. We can't
      // realistically wipe identity versions (other workers may be racing
      // inserts into office_identity_versions), so we don't assert on it.
      await pool.query(
        `DELETE FROM contact_channel_identities WHERE contact_id IN
           (SELECT id FROM contacts WHERE system_role = 'principal')`,
      );
      await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);

      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/restart',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode, `restart POST body: ${res.body}`).toBe(409);
      expect(processExitCalls).toHaveLength(0);
      const body = JSON.parse(res.body);
      expect(body.principalExists).toBe(false);
      // identityConfigured may be true (left over from a parallel test) or
      // false (clean run). Either way, !principalExists is enough to trip
      // the 409 branch — that's what we assert.
      expect(typeof body.identityConfigured).toBe('boolean');
    });

    it('returns 409 in normal mode (nothing to restart for)', async () => {
      const res = await appNormalMode.inject({
        method: 'POST',
        url: '/api/setup/restart',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(409);
      // Critical safety check: a 409 must not have side-effected the exit hook.
      // If this ever flips, the endpoint became destructive in normal mode.
      expect(processExitCalls).toHaveLength(0);
    });

    it('returns 401 without auth and does not schedule an exit', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/restart',
      });
      expect(res.statusCode).toBe(401);
      expect(processExitCalls).toHaveLength(0);
    });
  });

  describe('GET /api/setup/principal', () => {
    // Each test creates/deletes a principal — clear before each so the partial
    // unique index doesn't collide across tests.
    beforeEach(async () => {
      await pool.query(
        `DELETE FROM contact_channel_identities WHERE contact_id IN
           (SELECT id FROM contacts WHERE system_role = 'principal')`,
      );
      await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);
      await deleteOwnedKnowledgeGraph();
    });

    it('GET /api/setup/principal returns { exists:false } when no principal', async () => {
      // beforeEach has cleared the principal
      const res = await appSetupMode.inject({
        method: 'GET', url: '/api/setup/principal', headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ exists: false, contactId: null, pronouns: null, displayName: null });
    });

    it('GET /api/setup/principal returns the persisted profile', async () => {
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
        payload: { name: 'Profile Owner' },
      });
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: {
          timezone: 'America/Vancouver',
          email: 'owner@example.com',
          preferredName: 'Owner',
          title: 'CEO',
          pronouns: 'they/them',
          workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
        },
      });

      const res = await appSetupMode.inject({
        method: 'GET', url: '/api/setup/principal', headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const contact = await pool.query<{ id: string }>(`SELECT id FROM contacts WHERE system_role = 'principal'`);
      expect(res.json()).toMatchObject({
        exists: true,
        // The Setup page (#2358) links channel ids to this contact, and edits the pronouns.
        contactId: contact.rows[0]!.id,
        pronouns: 'they/them',
        displayName: 'Profile Owner',
        timezone: 'America/Vancouver',
        preferredName: 'Owner',
        title: 'CEO',
        email: 'owner@example.com',
        workingHours: 'Mon–Fri, 9:00 AM–5:00 PM',
      });
    });
  });

  describe('POST /api/setup/principal/profile', () => {
    // Each test creates a principal — clear before each so the partial unique
    // index doesn't collide.
    beforeEach(async () => {
      await pool.query(
        `DELETE FROM contact_channel_identities WHERE contact_id IN
           (SELECT id FROM contacts WHERE system_role = 'principal')`,
      );
      await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);
      await deleteOwnedKnowledgeGraph();
    });

    it('POST profile rejects an invalid timezone with 422', async () => {
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'TZ Tester' },
      });
      const res = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'Mars/Olympus_Mons' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('POST profile 409s when no principal exists', async () => {
      const res = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'America/Toronto' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('POST profile writes canonical fields, links a verified email, and stores a working-hours fact', async () => {
      const created = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Full Profile' },
      });
      const { contactId, kgNodeId } = created.json() as { contactId: string; kgNodeId: string };

      const res = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: {
          timezone: 'America/Vancouver', email: 'FULL@Example.com',
          preferredName: 'Full', title: 'Founder',
          workingHours: { start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5] },
        },
      });
      expect(res.statusCode).toBe(200);

      const contact = await pool.query<{ timezone: string; preferred_name: string; title: string; primary_email: string }>(
        `SELECT timezone, preferred_name, title, primary_email FROM contacts WHERE id = $1`, [contactId],
      );
      expect(contact.rows).toHaveLength(1);
      expect(contact.rows[0]).toMatchObject({
        timezone: 'America/Vancouver', preferred_name: 'Full', title: 'Founder',
        primary_email: 'full@example.com', // lower-cased
      });

      const ident = await pool.query<{ verified: boolean; status: string; source: string }>(
        `SELECT verified, status, source FROM contact_channel_identities
           WHERE contact_id = $1 AND channel = 'email'`, [contactId],
      );
      expect(ident.rows).toHaveLength(1);
      expect(ident.rows[0]).toMatchObject({ verified: true, status: 'active', source: 'ceo_stated' });

      const fact = await pool.query<{ value: string }>(
        `SELECT n.properties->>'value' AS value FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_node_id
           WHERE e.source_node_id = $1 AND n.type = 'fact'
             AND lower(n.properties->>'attribute') = 'working_hours' LIMIT 1`, [kgNodeId],
      );
      expect(fact.rows).toHaveLength(1);
      expect(fact.rows[0]!.value).toBe('Mon–Fri, 8:00 AM–4:00 PM');
    });

    it('POST profile clears title and pronouns sent as null or blank (#2358)', async () => {
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Profile Owner' } });
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'America/Toronto', title: 'CEO', pronouns: 'she/her' },
      });
      const cleared = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'America/Toronto', title: null, pronouns: '  ' },
      });
      expect(cleared.statusCode).toBe(200);
      const row = await pool.query<{ title: string | null; pronouns: string | null }>(
        `SELECT title, pronouns FROM contacts WHERE system_role = 'principal'`,
      );
      expect(row.rows[0]).toEqual({ title: null, pronouns: null });
    });

    it.each([false, 7, { v: 'x' }])('POST profile refuses a %j title and keeps the stored one', async (bad) => {
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Profile Owner' } });
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER, payload: { timezone: 'America/Toronto', title: 'CEO' } });
      const res = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'America/Toronto', title: bad },
      });
      expect(res.statusCode).toBe(400);
      const row = await pool.query<{ title: string | null }>(`SELECT title FROM contacts WHERE system_role = 'principal'`);
      expect(row.rows[0]?.title).toBe('CEO');
    });

    it('GET principal returns the primary email after a correction, not the first one linked (#2358)', async () => {
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Profile Owner' } });
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER, payload: { timezone: 'America/Toronto', email: 'old-address@example.com' } });
      await appSetupMode.inject({ method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER, payload: { timezone: 'America/Toronto', email: 'new-address@example.com' } });
      const res = await appSetupMode.inject({ method: 'GET', url: '/api/setup/principal', headers: AUTH_HEADER });
      expect(res.json().email).toBe('new-address@example.com');
    });

    it('POST profile leaves omitted optional fields untouched', async () => {
      const created = await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Partial' },
      });
      const { contactId } = created.json() as { contactId: string };
      await appSetupMode.inject({
        method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
        payload: { timezone: 'America/Toronto', title: 'CTO' },
      });
      const row = await pool.query<{ preferred_name: string | null; primary_email: string | null }>(
        `SELECT preferred_name, primary_email FROM contacts WHERE id = $1`, [contactId],
      );
      expect(row.rows[0]).toMatchObject({ preferred_name: null, primary_email: null });
    });
  });

  // #2358/#2709: the Setup page's own settings, its checklist and Start onboarding.
  describe('Setup page state', () => {
    let app: FastifyInstance;
    let checklist: SetupChecklist = { setupFor: 'self', tasks: [], setupComplete: false, missing: ['email'] };
    const TEST_WRITE: SetupWriteOptions = { updatedBy: 'integration-test', logger };
    let savedSettings: Array<Record<string, unknown>> = [];
    let savedThread: string | undefined;
    // web-thread.test.ts reads the same rows (#2358, #2709): one suite at a time.
    let unlock: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      unlock = await lockSetupSingletons(DATABASE_URL!);
      // Keep whatever settings a working database has, and put them back afterwards.
      savedSettings = (await pool.query(
        'SELECT key, value, updated_at, updated_by FROM settings WHERE key = ANY($1::text[])',
        [SETUP_SETTING_KEYS],
      )).rows;
      // A test writes the shared web thread; put a working database's back after.
      savedThread = (await pool.query<{ conversation_id: string }>('SELECT conversation_id FROM web_thread WHERE id = 1')).rows[0]?.conversation_id;
      app = Fastify();
      await app.register(rateLimit, { max: 1000, timeWindow: '1 minute', allowList: () => true });
      await app.register(setupRoutes, {
        webAppBootstrapSecret: TEST_SECRET,
        sessions,
        pool,
        logger,
        setupRequiredAtBoot: false,
        bootStartedAt: bootStartedAtNormalMode,
        scheduleProcessExit: () => {},
        contactService: ContactService.createWithPostgres(pool, undefined, logger),
        entityMemory: undefined,
        setupChecklist: async () => checklist,
        // The operator's confirmation notice (#2710). Recorded through a spy, never sent.
        outboundGateway: { sendNotification: operatorNotices },
        appOrigin: 'https://curia.example.com',
      });
      await app.ready();
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM settings WHERE key = ANY($1::text[])', [SETUP_SETTING_KEYS]);
      checklist = { setupFor: 'self', tasks: [], setupComplete: false, missing: ['email'] };
      operatorNotices.mockClear();
    });

    afterAll(async () => {
      try {
        await app.close();
        await pool.query('DELETE FROM settings WHERE key = ANY($1::text[])', [SETUP_SETTING_KEYS]);
        await pool.query('DELETE FROM web_thread WHERE id = 1');
        if (savedThread) await pool.query('INSERT INTO web_thread (id, conversation_id) VALUES (1, $1)', [savedThread]);
        for (const row of savedSettings) {
          await pool.query(
            `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, $4)`,
            [row['key'], JSON.stringify(row['value']), row['updated_at'], row['updated_by']],
          );
        }
      } finally {
        await unlock?.();
      }
    });

    it('the first save creates both keys, and a later save never moves the phase', async () => {
      let state = await updateSetupState(
        pool,
        { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
        TEST_WRITE,
      );
      expect(state).toMatchObject({ phase: 'in_progress', setupFor: 'other', operatorName: 'Sam' });
      state = await updateSetupState(pool, { messagingRoute: 'signal' }, TEST_WRITE);
      expect(state).toMatchObject({ phase: 'in_progress', setupFor: 'other', messagingRoute: 'signal' });
      await markSetupComplete(pool, TEST_WRITE);
      state = await updateSetupState(pool, { voiceRoute: 'app' }, TEST_WRITE);
      expect(state.phase).toBe('complete');
      expect(state.completedAt).toBeInstanceOf(Date);
    });

    it('a save on an install that predates the Setup page leaves it complete', async () => {
      await pool.query(
        `INSERT INTO settings (key, value, updated_by)
         VALUES ('setup.completed_at', to_jsonb($1::text), 'migration:132:pre-setup-page')`,
        ['2026-01-01T00:00:00.000Z'],
      );
      const state = await updateSetupState(pool, { messagingRoute: 'app' }, TEST_WRITE);
      expect(state.phase).toBe('complete');
    });

    it('choosing Myself clears the operator, and a missing field is left alone', async () => {
      await updateSetupState(
        pool,
        { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
        TEST_WRITE,
      );
      const state = await updateSetupState(pool, { setupFor: 'self' }, TEST_WRITE);
      expect(state).toMatchObject({ setupFor: 'self', operatorName: null, operatorEmail: null });
    });

    it('refuses Someone else without an operator, and a half-written operator', async () => {
      await expect(updateSetupState(pool, { setupFor: 'other' }, TEST_WRITE)).rejects.toBeInstanceOf(SetupSettingsError);
      await expect(updateSetupState(pool, { operatorName: 'Sam' }, TEST_WRITE)).rejects.toBeInstanceOf(SetupSettingsError);
      expect(await readSetupState(pool, logger)).toMatchObject({ setupFor: 'self', operatorName: null, operatorEmail: null });
    });

    it('PUT /api/setup/state saves and returns the state', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'Sam@Example.com', messagingRoute: 'slack', voiceRoute: 'app' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().setup).toMatchObject({
        setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com', messagingRoute: 'slack', voiceRoute: 'app',
      });
      expect((await readSetupState(pool, logger)).messagingRoute).toBe('slack');
    });

    it('PUT /api/setup/state sends one confirmation notice when the operator is recorded (#2710)', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().operatorConfirmation).toMatchObject({ state: 'sent', email: 'sam@example.com' });
      expect(operatorNotices).toHaveBeenCalledOnce();
      const notice = operatorNotices.mock.calls[0]![0];
      expect(notice.notificationType).toBe('operator_configured');
      // The gateway resolves the address from the setting that was just saved.
      expect(notice.body).toContain('Sam');

      // Re-saving the same address is not a new operator: no second notice.
      await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
      });
      expect(operatorNotices).toHaveBeenCalledOnce();
    });

    it('PUT /api/setup/state records a failed confirmation, and keeps the setting', async () => {
      operatorNotices.mockResolvedValueOnce(false);
      const res = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
      });
      expect(res.json().operatorConfirmation).toMatchObject({ state: 'failed' });
      expect(await readSetupState(pool, logger)).toMatchObject({ operatorEmail: 'sam@example.com' });

      // A failed notice is owed, not abandoned: the next attempt sends it.
      const retried = await app.inject({ method: 'POST', url: '/api/setup/start', headers: AUTH_HEADER });
      expect(retried.statusCode).toBe(200);
      expect(operatorNotices).toHaveBeenCalledTimes(2);
    });

    it('PUT /api/setup/state sends no notice when the operator is cleared', async () => {
      await updateSetupState(pool, { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' }, TEST_WRITE);
      operatorNotices.mockClear();
      const res = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { setupFor: 'self' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().operatorConfirmation).toEqual({ state: 'none' });
      expect(operatorNotices).not.toHaveBeenCalled();
    });

    it('POST /api/setup/start keeps what is saved, and never reopens a finished Setup', async () => {
      await updateSetupState(pool, { messagingRoute: 'app' }, TEST_WRITE);
      const res = await app.inject({ method: 'POST', url: '/api/setup/start', headers: AUTH_HEADER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inSetup: true, setupGuide: true });
      expect(await readSetupState(pool, logger)).toMatchObject({ phase: 'in_progress', messagingRoute: 'app' });
      await markSetupComplete(pool, TEST_WRITE);
      const after = await app.inject({ method: 'POST', url: '/api/setup/start', headers: AUTH_HEADER });
      expect(after.json()).toEqual({ inSetup: false, setupGuide: false });
      expect((await readSetupState(pool, logger)).phase).toBe('complete');
    });

    it('POST /api/setup/start needs auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/setup/start' });
      expect(res.statusCode).toBe(401);
      expect((await readSetupState(pool, logger)).phase).toBe('in_progress');
    });

    it('PUT /api/setup/state refuses a bad body and saves nothing', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER, payload: { messagingRoute: 'fax' } });
      expect(res.statusCode).toBe(400);
      expect((await readSetupState(pool, logger)).messagingRoute).toBeNull();
    });

    it('PUT /api/setup/state answers 400 for a combination the registry refuses', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER, payload: { setupFor: 'other' },
      });
      expect(res.statusCode).toBe(400);
      // A half-blank operator pair is refused rather than silently clearing the operator.
      const halfBlank = await app.inject({
        method: 'PUT', url: '/api/setup/state', headers: AUTH_HEADER,
        payload: { operatorName: 'Sam', operatorEmail: '' },
      });
      expect(halfBlank.statusCode).toBe(400);
      expect(await readSetupState(pool, logger)).toMatchObject({ setupFor: 'self' });
    });

    it('refuses a half-blank operator pair instead of switching to Myself', async () => {
      await updateSetupState(
        pool,
        { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
        TEST_WRITE,
      );
      await expect(
        updateSetupState(pool, { operatorName: 'Sam', operatorEmail: null }, TEST_WRITE),
      ).rejects.toBeInstanceOf(SetupSettingsError);
      expect(await readSetupState(pool, logger)).toMatchObject({
        setupFor: 'other', operatorEmail: 'sam@example.com',
      });
    });

    it('GET /api/setup/status reports inSetup and the saved fields', async () => {
      await pool.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ('messaging_route', to_jsonb($1::text), 'test')`,
        ['signal'],
      );
      const res = await app.inject({ method: 'GET', url: '/api/setup/status', headers: AUTH_HEADER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ inSetup: true, setup: { setupFor: 'self', messagingRoute: 'signal' } });
    });

    it('GET /api/setup/checklist returns the checklist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/setup/checklist', headers: AUTH_HEADER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ setupFor: 'self', tasks: [], setupComplete: false, missing: ['email'] });
    });

    it('POST /api/setup/complete is refused with the missing steps until setup is complete', async () => {
      const refused = await app.inject({ method: 'POST', url: '/api/setup/complete', headers: AUTH_HEADER });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().missing).toEqual(['email']);
      expect((await readSetupState(pool, logger)).phase).toBe('in_progress');

      await pool.query(
        `INSERT INTO web_thread (id, conversation_id) VALUES (1, 'setup-chat')
         ON CONFLICT (id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
      );
      checklist = { setupFor: 'self', tasks: [], setupComplete: true, missing: [] };
      const ok = await app.inject({ method: 'POST', url: '/api/setup/complete', headers: AUTH_HEADER });
      expect(ok.statusCode).toBe(200);
      expect((await readSetupState(pool, logger)).phase).toBe('complete');
      // Finishing Setup leaves the thread alone (#2360): starting onboarding rotates it.
      const after = await pool.query<{ conversation_id: string }>('SELECT conversation_id FROM web_thread WHERE id = 1');
      expect(after.rows[0]?.conversation_id).toBe('setup-chat');
    });

    it('finishing Setup twice is idempotent and keeps the first completion time', async () => {
      const before = await pool.query<{ id: string }>(
        `SELECT COALESCE(max(id), 0)::text AS id FROM settings_history`,
      );
      await Promise.all([completeSetup(pool, TEST_WRITE), completeSetup(pool, TEST_WRITE)]);

      const first = (await pool.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'setup.completed_at'`,
      )).rows[0]?.value;
      expect(first).toBeDefined();

      await completeSetup(pool, TEST_WRITE);
      const later = (await pool.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'setup.completed_at'`,
      )).rows[0]?.value;
      expect(later).toBe(first);

      // Two concurrent calls, one write: the loser saw the winner's row under the lock.
      const history = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM settings_history
          WHERE key = 'setup.completed_at' AND id > $1::bigint`,
        [before.rows[0]?.id ?? '0'],
      );
      expect(history.rows[0]).toMatchObject({ n: 1 });
    });

    it.each([
      ['GET', '/api/setup/checklist'],
      ['PUT', '/api/setup/state'],
      ['POST', '/api/setup/complete'],
    ] as const)('%s %s needs auth', async (method, url) => {
      const res = await app.inject({ method, url, payload: method === 'PUT' ? { setupFor: 'self' } : undefined });
      expect(res.statusCode).toBe(401);
    });
  });

  // #2358: the Setup page re-reads after every save, so its reads take the console-wide read
  // limit and its saves 30/min. Restart keeps 10. The real limiter, no bypass.
  describe('rate limits', () => {
    let limited: FastifyInstance;
    let unlock: (() => Promise<void>) | undefined;
    let savedSettings: Array<Record<string, unknown>> = [];

    beforeAll(async () => {
      unlock = await lockSetupSingletons(DATABASE_URL!);
      savedSettings = (await pool.query(
        'SELECT key, value, updated_at, updated_by FROM settings WHERE key = ANY($1::text[])',
        [SETUP_SETTING_KEYS],
      )).rows;
      limited = Fastify();
      await limited.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
      await limited.register(setupRoutes, {
        webAppBootstrapSecret: TEST_SECRET, sessions, pool, logger,
        setupRequiredAtBoot: false, bootStartedAt: bootStartedAtNormalMode,
        scheduleProcessExit: () => {},
        contactService: ContactService.createWithPostgres(pool, undefined, logger),
        entityMemory: undefined,
      });
      await limited.ready();
    });

    afterAll(async () => {
      try {
        await limited.close();
        await pool.query('DELETE FROM settings WHERE key = ANY($1::text[])', [SETUP_SETTING_KEYS]);
        for (const row of savedSettings) {
          await pool.query(
            `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, $4)`,
            [row['key'], JSON.stringify(row['value']), row['updated_at'], row['updated_by']],
          );
        }
      } finally {
        await unlock?.();
      }
    });

    const hit = async (method: 'GET' | 'PUT' | 'POST', url: string, n: number, payload?: object) => {
      const codes: number[] = [];
      for (let i = 0; i < n; i++) codes.push((await limited.inject({ method, url, headers: AUTH_HEADER, payload })).statusCode);
      return codes;
    };

    it.each(['/api/setup/status', '/api/setup/principal'])('serves 30 reads of %s in a minute', async (url) => {
      expect((await hit('GET', url, 30)).filter((c) => c === 429)).toEqual([]);
    });

    it('takes 30 saves of the Setup state in a minute, and refuses the 31st', async () => {
      const codes = await hit('PUT', '/api/setup/state', 31, { setupFor: 'self' });
      expect(codes.slice(0, 30).filter((c) => c === 429)).toEqual([]);
      expect(codes[30]).toBe(429);
    });

    it('keeps restart at 10 a minute', async () => {
      expect((await hit('POST', '/api/setup/restart', 11)).at(-1)).toBe(429);
    });
  });
});
