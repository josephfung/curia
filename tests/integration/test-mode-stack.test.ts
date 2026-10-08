// The test-mode stack against a real database (#1966). Three promises to keep:
//   1. Its coordinator gets the production system prompt — every block AgentRuntime
//      adds, built from the real agents/ and skills/ directories.
//   2. Nothing it does can send a message.
//   3. It leaves nothing a real instance sharing the database would act on: no
//      registry rows, no autonomy or identity changes.
//
// Not destructive: booting writes only the idempotent bootstrap rows a real boot
// writes (office identity, agent contact). The agent contact and node are removed
// afterward when this file created them. No agent turn runs here (offline LLM).
// Skips without DATABASE_URL.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { OfficeIdentity } from '../../src/identity/types.js';
import { AutonomyService } from '../../src/autonomy/autonomy-service.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../src/agents/prompts/date-resolve-guardrail.js';
import { formatWhoYouServeBlock } from '../../src/agents/principal-contact-block.js';
import { compileSecurityContextBlock, resolveSecurityThresholds } from '../../src/security/security-context.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const { Pool } = pg;

describeIf('test-mode stack', () => {
  let stack: TestModeStack;
  let rendered: string;
  // Fail closed: delete only after the probe proves this file is what created the row.
  // A boot that throws before the probe must not wipe an agent another suite left behind.
  let agentContactWasPresent = true;
  let agentNodeWasPresent = true;
  // Set only after requireCuriaTestDatabase confirms curia_test. vitest still runs afterAll
  // when beforeAll throws, and DATABASE_URL being set is not proof of which database it reached.
  let onTestDb = false;

  beforeAll(async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    try {
      // Before the existence probe and before any later cleanup pool is opened.
      await requireCuriaTestDatabase(probe);
      onTestDb = true;
      const { rows } = await probe.query<{ contact: boolean; node: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM contacts WHERE system_role = 'agent') AS contact,
           EXISTS (SELECT 1 FROM kg_nodes WHERE (properties->>'is_agent') = 'true') AS node`,
      );
      agentContactWasPresent = rows[0]?.contact === true;
      agentNodeWasPresent = rows[0]?.node === true;
    } finally {
      await probe.end();
    }
    // Offline providers: rendering and invoking tools need no API key. 'all' so the
    // result does not depend on whatever another suite left in the registry tables.
    stack = await createTestModeStack({ llm: 'offline', enablement: 'all' });
    rendered = await stack.renderSystemPrompt('coordinator');
  }, 120_000);

  afterAll(async () => {
    // Boot upserts the agent contact and node. Remove only the side this file
    // created, and do it even when boot threw after the insert (stack is unset).
    try {
      if (onTestDb && (!agentContactWasPresent || !agentNodeWasPresent)) {
        const pool = new Pool({ connectionString: DATABASE_URL });
        try {
          if (!agentContactWasPresent) {
            await pool.query(`DELETE FROM contacts WHERE system_role = 'agent'`);
          }
          if (!agentNodeWasPresent) {
            await pool.query(
              `DELETE FROM kg_nodes
                WHERE (properties->>'is_agent') = 'true'
                  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.kg_node_id = kg_nodes.id)`,
            );
          }
        } finally {
          await pool.end();
        }
      }
    } finally {
      await stack?.shutdown();
    }
  });

  describe('coordinator system prompt', () => {
    it('opens with the identity block, then the security block, then the YAML body', () => {
      const identity = stack.officeIdentityService.compileSystemPromptBlock();
      const thresholds = resolveSecurityThresholds(stack.yamlConfig.security?.trust_thresholds);
      if (!thresholds.ok) throw new Error('config/default.yaml trust_thresholds should be valid');
      const security = compileSecurityContextBlock(thresholds.thresholds);

      expect(rendered.startsWith(identity + '\n\n' + security + '\n\n')).toBe(true);
    });

    it('carries every pinned SKILL.md body', () => {
      const blocks = stack.agent('coordinator').pinResolution.instructionBlocks;
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(rendered).toContain(block);
    });

    it('carries the roster, autonomy, date guardrail, own contact details and turn budget', async () => {
      expect(rendered).toContain('## Available Specialists\n' + stack.agentRegistry.specialistSummary());

      const autonomy = await stack.autonomyService.getConfig();
      expect(autonomy).not.toBeNull();
      expect(rendered).toContain(AutonomyService.formatPromptBlock(autonomy!));

      expect(rendered).toContain(DATE_RESOLVE_GUARDRAIL);
      expect(rendered).toContain('## Current Date & Time');
      expect(rendered).toContain(`- Contact ID: ${stack.agentContactId}`);
      expect(rendered).toContain('## Turn budget');
    });

    it('carries the principal contact details the runtime would render', () => {
      // Other suites create and delete the principal in this shared DB, and some
      // seed one with no verified identities — which production renders as no
      // block at all. So derive the expectation from what the stack loaded at boot,
      // through the same formatter, rather than from whether a principal exists.
      const rc = stack.agent('coordinator').runtimeConfig;
      const expected = formatWhoYouServeBlock(
        rc.principalIdentities ?? [],
        rc.principalPrimaryEmail?.current ?? null,
      );
      if (expected) {
        expect(rendered).toContain(expected);
      } else {
        expect(rendered).not.toContain('## Who you serve');
        expect(rendered).not.toContain('Principal Contact Details');
      }
    });
  });

  describe('no outbound message can leave the process', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
      // The production-.env case: provider credentials present in the environment.
      for (const key of ['NYLAS_API_KEY', 'CEO_NYLAS_GRANT_ID']) {
        savedEnv[key] = process.env[key];
        process.env[key] = `${key.toLowerCase()}-from-env`;
      }
    });
    afterEach(() => {
      fetchSpy.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('has a gateway with no account to send from', () => {
      expect(stack.outboundGateway.listAccountIds()).toEqual([]);
    });

    it('fails a principal-approved email send inside the gateway', async () => {
      const result = await stack.outboundGateway.send(
        { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
        { humanApproved: true },
      );
      expect(result.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // Refused at the capability check (no outboundContext service — see disabledTools);
    // the transport-less gateway above is the second line if that ever changes.
    it('fails email-send and signal-send invoked the way the coordinator would', async () => {
      const opts = { agentId: 'coordinator', channelId: 'cli', conversationId: 'test-mode-no-send' };
      // Send skills take a contact reference (#2041): the pre-gate check must pass so the
      // capability check is what refuses. Unique identifiers: the database is shared.
      const contact = await stack.contactService.createContact({ displayName: 'Test-mode no-send recipient', source: 'ceo_stated' });
      try {
        await stack.contactService.linkIdentity({ contactId: contact.id, channel: 'email',
          channelIdentifier: `no-send-${randomUUID()}@example.com`, source: 'ceo_stated' });
        await stack.contactService.linkIdentity({ contactId: contact.id, channel: 'signal',
          channelIdentifier: `+1555${String(Date.now()).slice(-7)}`, source: 'ceo_stated' });
        const email = await stack.executionLayer.invoke('email-send', { to: contact.id, subject: 'Hi', body: 'Hello' }, undefined, opts);
        const signal = await stack.executionLayer.invoke('signal-send', { recipient: contact.id, message: 'Hello' }, undefined, opts);
        expect(email).toMatchObject({ success: false, error: expect.stringMatching(/requires capabilities/) });
        expect(signal).toMatchObject({ success: false, error: expect.stringMatching(/requires capabilities/) });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await stack.pool.query('DELETE FROM contacts WHERE id = $1', [contact.id]);
        if (contact.kgNodeId) await stack.pool.query('DELETE FROM kg_nodes WHERE id = $1', [contact.kgNodeId]);
      }
    });

    it('reports the refused tools per agent', () => {
      const coordinator = stack.disabledTools['coordinator'] ?? [];
      expect(coordinator.find(d => d.tool === 'email-send')?.missing).toContain('outboundContext');
      expect(coordinator.find(d => d.tool === 'signal-send')?.missing).toContain('outboundContext');
    });

    it('withholds env credentials from a skill that calls Nylas directly', async () => {
      // ceo-inbox drafts go straight to the principal's mailbox with its own Nylas
      // credentials, never through the gateway.
      const result = await stack.executionLayer.invoke(
        'ceo-inbox-draft-compose',
        { to_address: 'someone@example.com', subject: 'Hi', body: 'Hello' },
        undefined,
        { agentId: 'ceo-inbox', channelId: 'cli', conversationId: 'test-mode-no-send' },
      );
      // The handler maps the withheld-secret error to "not configured".
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/not configured|withheld/) });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('leaves no state a real instance would act on', () => {
    it('gives agents a read-only autonomy score and office identity', async () => {
      const before = await stack.autonomyService.getConfig();
      const rc = stack.agent('coordinator').runtimeConfig;

      expect(rc.autonomyService).not.toBe(stack.autonomyService);
      expect(() => rc.autonomyService!.setScore(99, 'test')).toThrow(/read-only in test mode/);
      expect(() => rc.officeIdentityService!.update({} as OfficeIdentity, 'test')).toThrow(/read-only in test mode/);
      expect(await stack.autonomyService.getConfig()).toEqual(before);
    });

    it('boots in registry mode without writing a registry row', async () => {
      // Reconcile enrols as 'reconciliation'. Scope to rows written during this boot,
      // so another suite using the shared database cannot make this flake.
      const { rows: [{ now: startedAt }] } = await stack.pool.query<{ now: Date }>('SELECT now()');
      const registryStack = await createTestModeStack({ llm: 'offline', enablement: 'registry' });
      try {
        // Production's reconcile, dry-run: the coordinator is a core default, so it
        // loads even on a database Curia never booted against.
        expect(registryStack.agent('coordinator')).toBeDefined();
      } finally {
        await registryStack.shutdown();
      }
      const { rows } = await stack.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM tool_registry WHERE installed_by = 'reconciliation' AND installed_at >= $1)
              + (SELECT count(*) FROM skill_registry WHERE installed_by = 'reconciliation' AND installed_at >= $1)
              + (SELECT count(*) FROM agent_registry WHERE installed_by = 'reconciliation' AND installed_at >= $1) AS n`,
        [startedAt],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }, 120_000);
  });
});
