// The test-mode stack with recordSends (#2312), against a real database. It boots with the
// recording review layer the scenario suite's through_gateway cases use, and keeps the
// promises of tests/integration/test-mode-stack.test.ts for everything else:
//   1. The layer agents call keeps the no-send gateway.
//   2. A send on the review layer runs production's handler and gateway and reaches only the
//      recorder: no real client, no fetch, no outbound_queue row.
//   3. A gated send writes production's approval row (Gate A through the approval trigger).
// The content-filter judge is off (offline LLM); the relay test stubs the band review. Rows it writes are removed by their conversation and id.
// Skips without DATABASE_URL; refuses any database but curia_test.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as path from 'node:path';
import { loadYamlConfig } from '../../src/config.js';
import { createOutboundMessage } from '../../src/bus/events.js';
import { EscalationJudge } from '../../src/autonomy/escalation-judge.js';
import { SendEvidenceCollector } from '../../src/autonomy/send-evidence.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import { createTestModeStack, runWithAutonomyFixture, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import type { RecordedSend } from '../../src/startup/test-mode-sends.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const { Pool } = pg;

describeIf('test-mode stack with recordSends', () => {
  let stack: TestModeStack | undefined;
  let review: ExecutionLayer | undefined;
  const sends: RecordedSend[] = [];
  let agentContactWasPresent = true;
  let agentNodeWasPresent = true;
  let onTestDb = false;
  const conversation = `scenario-recording-${randomUUID()}`;
  const contactIds: string[] = [];
  let relaysOn = false;

  beforeAll(async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    try {
      await requireCuriaTestDatabase(probe);
      onTestDb = true;
      const { rows } = await probe.query<{ contact: boolean; node: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM contacts WHERE system_role = 'agent') AS contact,
                EXISTS (SELECT 1 FROM kg_nodes WHERE (properties->>'is_agent') = 'true') AS node`,
      );
      agentContactWasPresent = rows[0]?.contact === true;
      agentNodeWasPresent = rows[0]?.node === true;
    } finally {
      await probe.end();
    }
    // The content-filter judge is off: offline providers would fail every call. The band-review
    // judge stays built (its calls fail offline, as a disabled judge does) so the relay test
    // below can stub its answers.
    const yamlConfig = loadYamlConfig(path.resolve(import.meta.dirname, '../../config'));
    yamlConfig.filter = { ...yamlConfig.filter, llmJudge: { ...yamlConfig.filter?.llmJudge, enabled: false } };
    stack = await createTestModeStack({
      llm: 'offline',
      enablement: 'all',
      yamlConfig,
      // A fixed score and gating, not the database's: a fresh database seeds 75, where band
      // gating (the default since #2192) holds the principal's sends these tests expect to
      // go through. Tests that need a hold enter their own fixture per call.
      autonomy: { score: 80, gating: 'band' },
      recordSends: {
        record: (send) => { sends.push(send); },
        message: () => undefined,
        // Relays only while a test turns them on: every other outbound.message stays unsent.
        relays: () => relaysOn,
      },
      wrapOutboundContext: (service) => service,
      wrapExecutionLayer: (layer, reviewLayer) => {
        review = reviewLayer;
        return layer;
      },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      if (onTestDb && stack) {
        await stack.pool.query('DELETE FROM autonomy_action_log WHERE conversation_id = $1', [conversation]);
        await stack.pool.query('DELETE FROM task_outreach WHERE conversation_id = $1', [conversation]);
        for (const id of contactIds) await stack.pool.query('DELETE FROM contacts WHERE id = $1', [id]);
      }
      if (onTestDb && (!agentContactWasPresent || !agentNodeWasPresent)) {
        const pool = new Pool({ connectionString: DATABASE_URL });
        try {
          if (!agentContactWasPresent) await pool.query(`DELETE FROM contacts WHERE system_role = 'agent'`);
          if (!agentNodeWasPresent) {
            await pool.query(
              `DELETE FROM kg_nodes WHERE (properties->>'is_agent') = 'true'
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

  async function recipient(): Promise<string> {
    const contact = await stack!.contactService.createContact({ displayName: 'Recording recipient', source: 'ceo_stated' });
    contactIds.push(contact.id);
    await stack!.contactService.linkIdentity({
      contactId: contact.id, channel: 'email', channelIdentifier: `rec-${randomUUID()}@vendorco.test`, source: 'ceo_stated', verified: true,
    });
    return contact.id;
  }

  const queued = async (): Promise<number> =>
    Number((await stack!.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM outbound_queue')).rows[0]!.n);

  it('hands the wrapper a review layer, and keeps the no-send gateway on the layer agents call', () => {
    expect(review).toBeDefined();
    expect(review).not.toBe(stack!.executionLayer);
    expect(stack!.outboundGateway.listAccountIds()).toEqual([]);
  });

  it('runs email-send through the review and records it, with no network call and no queued row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
    try {
      const before = await queued();
      const to = await recipient();
      const principal = { contactId: stack!.principalContactId ?? randomUUID(), systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString(), tier: 'principal', authenticated: true };
      const result = await review!.invoke('email-send', { to, subject: 'Forms', body: 'Here are the forms.' }, undefined, {
        agentId: 'coordinator', channelId: 'signal', conversationId: conversation, taskEventId: randomUUID(), liveTurn: true,
        taskMetadata: { originator: principal },
      });
      expect(result).toMatchObject({ success: true });
      expect(sends).toEqual([expect.objectContaining({ channel: 'email', kind: 'send', subject: 'Forms' })]);
      expect(sends[0]!.to[0]).toMatch(/@vendorco\.test$/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await queued()).toBe(before);
      // The base layer still has no gateway to send with.
      const base = await stack!.executionLayer.invoke('email-send', { to, subject: 'Hi', body: 'Hello' }, undefined, {
        agentId: 'coordinator', channelId: 'cli', conversationId: conversation,
      });
      expect(base.success).toBe(false);
      expect(sends).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('relays a dispatcher reply through the real Signal adapter path only while the recorder accepts it', async () => {
    const before = sends.length;
    const relayConversation = `signal:+1555${String(Date.now()).slice(-7)}`;
    // Band review holds a send that isn't principal-directed when it can't be reviewed (#2473).
    // This test is about the relay path, not gating, so here and nowhere else the review answers:
    // the evidence read finds a drafting turn (the reply below has none in audit_log, which counts
    // as a failed review before the judge is asked), and the judge, offline here, says "routine".
    const evidenceStub = vi.spyOn(SendEvidenceCollector.prototype, 'collect').mockResolvedValue({
      unavailable: false, toolResults: [], principalBlock: null, authority: { originator: null, liveTurn: false },
    });
    const judgeStub = vi.spyOn(EscalationJudge.prototype, 'review').mockResolvedValue({
      ok: true, purpose: 'serving', speaksAsPrincipal: false, stakes: 'routine', stakesReason: 'Routine reply.',
      unsupportedClaims: [], unnecessaryItems: [], disclosures: [], reason: 'stub',
    });
    const publish = () => stack!.bus.publish('dispatch', createOutboundMessage({
      conversationId: relayConversation, channelId: 'signal', content: 'Relayed hello', taskEventId: randomUUID(), parentEventId: randomUUID(),
    }));
    try {
      await publish();
      expect(sends.length).toBe(before);
      relaysOn = true;
      await publish();
      expect(sends.slice(before)).toEqual([expect.objectContaining({ channel: 'signal', kind: 'send', body: 'Relayed hello' })]);
    } finally {
      relaysOn = false;
      judgeStub.mockRestore();
      evidenceStub.mockRestore();
      await stack!.pool.query('DELETE FROM autonomy_action_log WHERE conversation_id = $1', [relayConversation]);
    }
  });

  it('holds a send a known contact started below the score, writing production\'s approval row', async () => {
    const to = await recipient();
    const result = await runWithAutonomyFixture({ score: 50, gating: 'tier' }, () => review!.invoke('email-send', { to, subject: 'Quote', body: 'Our quote.' }, undefined, {
      agentId: 'coordinator', channelId: 'email', conversationId: conversation, taskEventId: randomUUID(),
      taskMetadata: { originator: { contactId: to, systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known' } },
    }));
    expect(result.success).toBe(false);
    const { rows } = await stack!.pool.query<{ outcome: string; tool_name: string; short_ref: string | null }>(
      'SELECT outcome, skill_name AS tool_name, short_ref FROM autonomy_action_log WHERE conversation_id = $1', [conversation],
    );
    expect(rows).toEqual([expect.objectContaining({ outcome: 'pending_approval', tool_name: 'email-send' })]);
    expect(rows[0]!.short_ref).not.toBeNull();
    expect(sends.filter(s => s.subject === 'Quote')).toEqual([]);
  });

  it('seeds a trusted contact, a standing task and outreach, reads the run\'s gateway outcome and removes it all', async (ctx) => {
    // The principal-originated task and send need a principal.
    if (!stack!.principalContactId) ctx.skip();
    // Its own conversation, so it depends on no other test's sends.
    const own = `scenario-recording-${randomUUID()}`;
    const { seedRun, readGatewayOutcome, cleanupRun, SeedScope } = await import('../scenarios/seed.js');
    const { loadScenarioCase } = await import('../scenarios/loader.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'recording-'));
    const tag = randomUUID().slice(0, 8);
    try {
      const file = path.join(dir, 'case.yaml');
      writeFileSync(file, `
name: recording seeds
through_gateway: true
seed:
  contacts:
    - { key: pat, display_name: Pat Seed ${tag}, tier: trusted, channel: email, identifier: pat-${tag}@vendorco.test }
  tasks:
    - { key: forms, title: Vendor forms ${tag}, originator: principal }
  outreach:
    - { key: sent, task: forms, via: email, domains: [vendorco.test], contacts: [pat], summary: Sent forms, confirmed: true }
inbound: { from: pat, content: hi }
expected_behaviors:
  - { id: a, description: x, check: { held: true } }
`);
      const scenario = loadScenarioCase(file);
      const scope = new SeedScope();
      scope.rootConversation = own;
      const seeded = await seedRun(scenario, { stack: stack!, outboundContext: {} as never, scope });
      let cleaned = false;
      try {
        const contact = await stack!.contactService.getContact(seeded.refs.get('contact:pat')!);
        expect(contact?.tier).toBe('trusted');
        // A principal's live send, which records confirmed outreach (the real TaskOutreachService),
        // and a known contact's send below the score, which is held: both in this conversation.
        const to = await recipient();
        const principal = { contactId: stack!.principalContactId!, systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString(), tier: 'principal', authenticated: true };
        const sent = await review!.invoke('email-send', { to, subject: 'Forms', body: 'Here are the forms.' }, undefined, {
          agentId: 'coordinator', channelId: 'signal', conversationId: own, taskEventId: randomUUID(), liveTurn: true,
          taskMetadata: { originator: principal },
        });
        expect(sent.success).toBe(true);
        const held = await runWithAutonomyFixture({ score: 50, gating: 'tier' }, () => review!.invoke('email-send', { to, subject: 'Quote', body: 'Our quote.' }, undefined, {
          agentId: 'coordinator', channelId: 'email', conversationId: own, taskEventId: randomUUID(),
          taskMetadata: { originator: { contactId: to, systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known' } },
        }));
        expect(held.success).toBe(false);
        const outcome = await readGatewayOutcome(stack!, scenario, seeded, scope);
        // The held send, and the outreach the principal's send recorded; the seeded row,
        // untouched, is not counted.
        expect(outcome.holds).toEqual([expect.objectContaining({ toolName: 'email-send', outcome: 'pending_approval' })]);
        expect(outcome.outreach).toEqual([expect.objectContaining({ domains: ['vendorco.test'], confirmed: true, seeded: false })]);
        await cleanupRun(stack!, seeded, scope, own);
        cleaned = true;
        const left = await stack!.pool.query<{ n: string }>(
          `SELECT ((SELECT count(*) FROM tasks WHERE id = ANY($1::uuid[])) + (SELECT count(*) FROM task_outreach WHERE id = ANY($2::uuid[]))
                  + (SELECT count(*) FROM autonomy_action_log WHERE conversation_id = $3))::text AS n`,
          [seeded.taskIds, seeded.outreachIds, own],
        );
        expect(left.rows[0]!.n).toBe('0');
      } finally {
        // A failed assertion above must not leave the seeded rows behind.
        if (!cleaned) await cleanupRun(stack!, seeded, scope, own);
        await stack!.pool.query('DELETE FROM autonomy_action_log WHERE conversation_id = $1', [own]);
        await stack!.pool.query('DELETE FROM task_outreach WHERE conversation_id = $1', [own]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
