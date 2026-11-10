// The committed scenario cases load, and each has a stub-coverage record (#1956).
// Runs in CI with no database or model: the live suite is `pnpm scenarios`.
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { BullpenReplyHandler } from '../../../skills/bullpen/tools/bullpen-reply/handler.js';
import { PAUSED_NEXT_STEP, delegateFailureNextStep } from '../../../src/agents/prompts/delegate-result-guidance.js';
import { WEB_FETCH_NOT_FOUND_LINES } from '../../../src/agents/prompts/dead-end-guidance.js';
import { googleWorkspaceUrlError } from '../../../src/skills/_shared/google-workspace-url.js';
import { shapeSpecialistAnswer } from '../../../src/agents/specialist-answer.js';
import { createLogger } from '../../../src/logger.js';
import { BullpenService } from '../../../src/memory/bullpen.js';
import type { ToolContext } from '../../../src/skills/types.js';
import { PRINCIPAL_SEND_DIGEST_REASONS } from '../../../src/skills/outbound-gateway.js';
import { leafChecks } from '../../scenarios/assertions.js';
import { loadScenarioCase, loadScenarioCases } from '../../scenarios/loader.js';
import { matchToolStub } from '../../scenarios/stub-matcher.js';
import { coverageViolations, readCoverage } from '../../scenarios/stub-coverage.js';
import type { ScenarioCase } from '../../scenarios/types.js';

const SCENARIOS_DIR = path.resolve(import.meta.dirname, '../../scenarios');
const cases = loadScenarioCases(path.join(SCENARIOS_DIR, 'cases'));

describe('coordinator scenario cases', () => {
  it('load and validate', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it('case 26 scores a text-button click as a miss and leaves other session actions on the choice page (#2018)', () => {
    const scenario = cases.find(c => c.sourceFile.endsWith('26-mid-turn-correction.yaml'));
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const page = (args: Record<string, unknown>): string => {
      const stub = matchToolStub('web-browser', args, scenario.toolStubs);
      const content = (stub?.return as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : '';
    };
    const session = { session_id: 's-26' };
    expect(page({ ...session, action: 'click', selector: '[g1f0e2]' })).toContain('Check your email');
    expect(page({ ...session, action: 'click', selector: 'g1f0e2' })).toContain('Check your email');
    expect(page({ ...session, action: 'click', selector: '[g1f0e1]' })).toContain('Check your phone');
    expect(page({ ...session, action: 'click', selector: 'g1f0e1' })).toContain('Check your phone');
    const signedInBatches = [
      [
        { action: 'type', selector: '[g2f0e1]', text: '518204' },
        { action: 'click', selector: '[g2f0e2]' },
      ],
      [
        { action: 'type', selector: 'g2f0e1', text: '518204' },
        { action: 'click', selector: 'g2f0e2' },
      ],
      [
        { action: 'click', selector: '[g2f0e1]' },
        { action: 'type', selector: '[g2f0e1]', text: '518204' },
        { action: 'click', selector: '[g2f0e2]' },
      ],
      [
        { action: 'click', selector: 'g2f0e1' },
        { action: 'type', selector: 'g2f0e1', text: '518204' },
        { action: 'click', selector: 'g2f0e2' },
      ],
    ];
    for (const actions of signedInBatches) {
      expect(page({ ...session, actions })).toContain("You're signed in");
    }
    for (const selector of ['[g2f0e1]', 'g2f0e1']) {
      expect(page({ ...session, action: 'type', selector, text: '518204' })).toContain('518204');
    }
    for (const selector of ['[g2f0e2]', 'g2f0e2']) {
      expect(page({ ...session, action: 'click', selector })).toContain("You're signed in");
    }
    expect(page({ ...session, action: 'click', selector: 'Email me the code' })).toContain('Check your email');
    for (const selector of ['[g1f0e2]', 'g1f0e2', 'Email me the code']) {
      expect(page({ ...session, actions: [{ action: 'click', selector }] })).toContain('Check your email');
    }
    const taskId = '4b7e1c90-2d3f-4a5b-8c6d-7e8f9012ab34';
    expect(matchToolStub('task-update', { task_id: taskId, progress_note: 'switched to email' }, scenario.toolStubs)?.error).toBeUndefined();
    expect(matchToolStub('task-complete', { task_id: taskId, completion_note: 'signed in' }, scenario.toolStubs)?.return).toMatchObject({ status: 'done' });
    const other = page({ ...session, action: 'click', selector: 'button:has-text("Text me the code")' });
    expect(other).toContain('How should we send');
    expect(other).not.toContain('Check your email');
    const critical = scenario.expectedBehaviors.filter(b => b.weight === 'critical').map(b => b.check);
    expect(critical).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'any_of',
        checks: [
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { action: 'click', selector: '[g1f0e2]' } }),
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { action: 'click', selector: 'g1f0e2' } }),
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { action: 'click', selector: 'Email me the code' } }),
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { actions: [{ action: 'click', selector: '[g1f0e2]' }] } }),
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { actions: [{ action: 'click', selector: 'g1f0e2' }] } }),
          expect.objectContaining({ kind: 'called', tool: 'web-browser', with: { actions: [{ action: 'click', selector: 'Email me the code' }] } }),
        ],
      }),
      expect.objectContaining({ kind: 'not_called', tools: ['web-browser'], with: { action: 'click', selector: '[g1f0e1]' } }),
      expect.objectContaining({ kind: 'not_called', tools: ['web-browser'], with: { action: 'click', selector: 'g1f0e1' } }),
    ]));
  });

  it('cover the ten behaviors #1956 names', () => {
    // Case files are numbered by the issue's list; every number must be present.
    const numbers = new Set(cases.map(c => Number(path.basename(c.sourceFile).slice(0, 2))));
    for (let n = 1; n <= 10; n++) expect(numbers, `case ${n}`).toContain(n);
  });

  it('assert tool calls in code wherever a behavior is a tool call', () => {
    // At least one deterministic check per case — a case scored only by the judge
    // cannot fail for the reason it exists.
    for (const c of cases) {
      expect(c.expectedBehaviors.some(b => b.check), c.name).toBe(true);
    }
  });

  it('stub a paused delegate result with the next_step the real handler adds (#1959)', () => {
    // A stub replaces the delegate handler. Without next_step the case would test a
    // result production never sends; with a stale copy it would test old guidance.
    const paused = cases.flatMap(c => (c.toolStubs['delegate'] ?? []).map(stub => stub.return))
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && (r as Record<string, unknown>)['paused'] === true);
    expect(paused.length).toBeGreaterThan(0);
    for (const r of paused) expect(r['next_step']).toBe(PAUSED_NEXT_STEP);
  });

  it('gives a failed delegate stub the next_step the handler would add (prompt trim PR 6)', () => {
    const failed = cases.flatMap(c => (c.toolStubs['delegate'] ?? []).map(stub => stub.return))
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && (r as Record<string, unknown>)['failed'] === true);
    expect(failed.length).toBeGreaterThan(0);
    for (const r of failed) expect(r['next_step'], String(r['agent'])).toBe(delegateFailureNextStep(String(r['agent'])));
  });

  it('answers a Google file URL in a web tool with the handler\'s refusal (prompt trim PR 6)', () => {
    let seen = 0;
    for (const c of cases) {
      for (const tool of ['web-fetch', 'web-browser']) {
        for (const stub of c.toolStubs[tool] ?? []) {
          // Other web stubs (the browser unavailable, say) are not this refusal.
          if (!stub.error?.includes('Google Workspace tools')) continue;
          seen++;
          expect(stub.error, `${c.name}: ${tool}`).toBe(googleWorkspaceUrlError(tool));
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('answers a 404 in web-fetch with the handler\'s message (#2149)', () => {
    const notFound = cases.flatMap(c => (c.toolStubs['web-fetch'] ?? []).map(stub => stub.error))
      .filter((e): e is string => typeof e === 'string' && e.startsWith('HTTP 404'));
    expect(notFound.length).toBeGreaterThan(0);
    for (const e of notFound) expect(e).toBe(WEB_FETCH_NOT_FOUND_LINES.join(' '));
  });

  it('gives a delegate stub with `sent` the next_step the handler would add (#2055)', () => {
    const withSent = cases.flatMap(c => (c.toolStubs['delegate'] ?? []).map(stub => stub.return))
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && Array.isArray((r as Record<string, unknown>)['sent']));
    expect(withSent.length).toBeGreaterThan(0);
    for (const r of withSent) {
      // The stub has no brief, so this mirrors the handler on the response alone. A stub whose
      // note would come only from the brief's wording is not caught here.
      // Drafts go back into the text as the <scheduling_email> blocks they were lifted from.
      const drafts = (r['draft_emails'] ?? []) as Array<{ subject?: string; body: string }>;
      const content = [String(r['response']), ...drafts.map(d =>
        `<scheduling_email${d.subject !== undefined ? ` subject="${d.subject}"` : ''}>\n${d.body}\n</scheduling_email>`)].join('\n');
      const shaped = shapeSpecialistAnswer(content, r['sent'] as string[], '');
      expect(r['draft_emails'], String(r['response']).slice(0, 60)).toEqual(shaped.draft_emails);
      expect(r['next_step'], String(r['response']).slice(0, 60)).toBe(shaped.next_step);
    }
  });

  it('answers the side calls that failed stub coverage (#2058)', () => {
    // These calls are intermittent. Unstubbed, each one is a refused hole and the
    // case fails the gate even when every behavior passes.
    const byName = new Map(cases.map(c => [c.name, c]));
    const answered = (caseName: string, tool: string, input: Record<string, unknown> = {}): Record<string, unknown> => {
      const scenario: ScenarioCase | undefined = byName.get(caseName);
      expect(scenario, caseName).toBeDefined();
      const stub = matchToolStub(tool, input, scenario!.toolStubs);
      expect(stub?.error, `${caseName} ${tool}`).toBeUndefined();
      expect(stub?.return, `${caseName} ${tool}`).toEqual(expect.any(Object));
      return stub!.return as Record<string, unknown>;
    };

    const memory = answered('send to principal by alias', 'memory-store', { entity: 'Harbourfront Centre', field: 'venue', value: 'Room 4B' });
    expect(memory).toMatchObject({ stored: true, action: 'created' });
    const config = answered('send to principal by alias', 'config-store', { action: 'store', namespace: 'offsite', key: 'venue', value: 'Room 4B' });
    expect(config).toMatchObject({ stored: true, action: 'created', namespace: 'offsite', key: 'venue' });

    const ambiguous = byName.get('scheduler ambiguous asks');
    const reportWithoutJob = matchToolStub('scheduler-report', { summary: 'Asked which pipeline review.' }, ambiguous!.toolStubs);
    expect(reportWithoutJob?.error).toContain('Missing job_id');
    expect(answered('scheduler ambiguous asks', 'scheduler-report', {
      summary: 'Asked which pipeline review.',
      job_id: '7d1c2e44-0b6a-4f0e-9d7e-3a1f5c2b8e10',
    })).toEqual({ success: true });

    const profile = answered('external reply first person', 'executive-profile-get');
    expect(profile['summary']).toEqual(expect.any(String));
    expect(profile['profile']).toMatchObject({ writingVoice: { formality: 50 } });

    const placement = answered('bullpen mention stays on thread', 'doc-place', { title: 'Q3 competitor brief' });
    expect(placement).toMatchObject({
      action: 'extend',
      slug: 'q3-competitor-brief',
      path: '/projects/q3-competitor-brief/brief.md',
      allocated: false,
    });
    expect(placement['catalog']).toEqual([
      expect.objectContaining({ slug: 'q3-competitor-brief', document_count: 1 }),
    ]);
    const brief = {
      path: '/projects/q3-competitor-brief/brief.md',
      type: 'brief',
      displayTimezone: 'America/Toronto',
    };
    const bullpen = byName.get('bullpen mention stays on thread');
    const alreadyExists = matchToolStub('doc-write', { path: brief.path, mode: 'create', type: 'brief' }, bullpen!.toolStubs);
    expect(alreadyExists?.return).toBeUndefined();
    expect(alreadyExists?.error).toBe(
      "Document already exists at /projects/q3-competitor-brief/brief.md — use append, replace, or section-edit",
    );
    expect(answered('bullpen mention stays on thread', 'doc-write', { path: '/projects/q3-competitor-brief/notes.md', mode: 'create' })).toEqual({
      action: 'created',
      document: { ...brief, version: 1 },
    });
    expect(answered('bullpen mention stays on thread', 'doc-write', { path: brief.path, mode: 'append', content: 'noted', expected_version: 1 })).toMatchObject({
      action: 'appended',
      document: { path: brief.path, version: 2 },
    });
    const unknownMode = matchToolStub('doc-write', { path: brief.path, mode: 'rename' }, bullpen!.toolStubs);
    expect(unknownMode?.error).toBe("Missing or invalid mode — must be 'create', 'append', 'replace', or 'section-edit'");

    const updated = answered('direct email reply as text', 'contact-update', { contact_id: '{{contact:tomas}}', fields: { organization: 'Northwind' } });
    expect(updated['contact_id']).toBe('{{contact:tomas}}');
    expect(updated['updated_fields']).toEqual(['organization']);

    // These calls are the wrong move for the case, so they are scored, not only stubbed.
    for (const [caseName, id, tool] of [
      ['bullpen mention stays on thread', 'leaves_saved_brief', 'doc-write'],
      ['scheduler ambiguous asks', 'reports_no_run', 'scheduler-report'],
      ['direct email reply as text', 'leaves_contact_unchanged', 'contact-update'],
    ] as const) {
      const behavior = byName.get(caseName)?.expectedBehaviors.find(b => b.id === id);
      expect(behavior?.weight, id).toBe('important');
      expect(behavior?.check).toMatchObject({ kind: 'not_called', tools: [tool] });
    }
  });

  it("answers a malformed bullpen reply with the handler's own error (#2098)", async () => {
    // Case 06's catch-all answers posted: true. Without these rules a reply with no content
    // is told it posted, never gets the error production returns, and retries until the
    // turn budget runs out. The expected errors come from the real handler, so a reworded
    // handler message fails here instead of leaving the stub quietly out of date.
    const bullpen = cases.find(c => c.name === 'bullpen mention stays on thread');
    expect(bullpen).toBeDefined();
    const handler = new BullpenReplyHandler();
    const handlerError = async (input: Record<string, unknown>): Promise<string | undefined> => {
      // The handler refuses before validating unless its service, bus, agent and task are set.
      // Both field checks then run before it reads a thread or publishes, so an empty
      // in-memory service and an inert bus are enough.
      const result = await handler.execute({
        input,
        agentId: 'coordinator',
        taskEventId: 'task-2098',
        log: createLogger('error'),
        bullpenService: BullpenService.createInMemory(),
        bus: { publish: async () => undefined, subscribe: () => undefined },
      } as unknown as ToolContext);
      return result.success ? undefined : result.error;
    };

    const threadId = '9b2f4c1e-6a3d-4e8f-b0c7-2d5e9a1f3b64';
    for (const input of [
      // The 2026-10-10 gate's looping runs sent exactly this shape.
      { thread_id: threadId, source_message_id: threadId, close_after: true },
      { thread_id: threadId, content: '' },
      { thread_id: '', content: 'Got it, thanks.' },
      { content: 'Got it, thanks.' },
      {},
    ]) {
      const stub = matchToolStub('bullpen-reply', input, bullpen!.toolStubs);
      const expected = await handlerError(input);
      expect(expected, JSON.stringify(input)).toEqual(expect.any(String));
      expect(stub?.return, JSON.stringify(input)).toBeUndefined();
      expect(stub?.error, JSON.stringify(input)).toBe(expected);
    }

    // A refused reply did not post, so the critical behavior counts only a reply that succeeded.
    expect(bullpen!.expectedBehaviors.find(b => b.id === 'replies_on_thread')?.check)
      .toMatchObject({ kind: 'called', success: true });

    // A well-formed reply still posts.
    expect(matchToolStub('bullpen-reply', { thread_id: threadId, content: 'Got it, thanks.' }, bullpen!.toolStubs)?.return)
      .toMatchObject({ posted: true });
  });

  it('gate releases on the real-delegation cases the README names (#2027)', () => {
    // Real delegation multiplies cost, so most of these run on demand. A change here
    // changes the release gate: update the table in tests/scenarios/README.md with it.
    // The principal-scheduling series (25*) runs on demand for its cost (README, "Principal-
    // involved scheduling"), each case under an autonomy fixture (see the test below).
    const real = cases.filter(c => c.delegation === 'real' && !c.autonomy);
    expect(real.map(c => path.basename(c.sourceFile).slice(0, 3)).sort())
      .toEqual(['16a', '16b', '16c', '16d', '16e', '16f', '16g', '17a']);
    expect(real.filter(c => c.releaseGate).map(c => path.basename(c.sourceFile).slice(0, 3)).sort())
      .toEqual(['16a', '16d', '16f']);
    // Every other case is in the gate, except 21c (opt-in diagnostics; README, "Cases
    // that need an opt-in agent") and the specialist cases that reply on a bullpen
    // thread, which run on demand until #2126 ends the content-less reply loop
    // (README, "Cases for a specialist"). The style cases run under an identity
    // fixture, which the loader keeps out of the gate.
    expect(cases.filter(c => c.delegation === 'stubbed' && !c.releaseGate && !c.identity).map(c => path.basename(c.sourceFile).slice(0, 3)))
      .toEqual(['21c', '30d', '30e', '30f', '31a', '31b', '31c', '31d', '31h', '32b']);
  });

  it('principal-scheduling cases split into batches that each share one stack', () => {
    // docs/wip/2026-10-21-principal-scheduling-scenarios-design.md. A run has one stack, so
    // one identity (ps-prefs); autonomy is per case since #2312, but each batch still agrees.
    const ps = cases.filter(c => c.tags.includes('principal-scheduling'));
    expect(ps.map(c => path.basename(c.sourceFile).slice(0, 3)).sort())
      .toEqual(['25a', '25b', '25c', '25d', '25e', '25f', '25g', '25h', '25i', '25j', '25k', '25l', '25m', '25n', '25o']);
    for (const c of ps) {
      expect(c.releaseGate).toBe(false);
      expect(c.delegation).toBe('real');
      expect(c.autonomy).toBeDefined();
    }
    for (const batch of ['ps-core', 'ps-ask', 'ps-prefs']) {
      const picked = ps.filter(c => c.tags.includes(batch));
      expect(picked.length, batch).toBeGreaterThan(0);
      expect(new Set(picked.map(c => `${c.identity?.name}|${c.autonomy?.score}|${c.autonomy?.gating}`)).size, batch).toBe(1);
    }
    expect(ps.every(c => ['ps-core', 'ps-ask', 'ps-prefs'].filter(t => c.tags.includes(t)).length === 1)).toBe(true);
  });

  it('style cases share one identity fixture and score in code what code can score (#2143)', () => {
    const style = cases.filter(c => c.tags.includes('style'));
    expect(style.map(c => path.basename(c.sourceFile).slice(0, 3)))
      .toEqual(['40a', '40b', '40c', '40d', '40e', '40f', '40g']);
    // `--tags style` is one run, and a run has one identity.
    expect(new Set(style.map(c => c.identity?.name))).toEqual(new Set(['style-brief-dry']));
    for (const c of style) expect(c.releaseGate).toBe(false);
    // Every case that writes to someone keeps its facts, as a critical behavior: brevity
    // must never be bought by dropping content.
    for (const c of style) {
      expect(c.expectedBehaviors.find(b => b.id === 'content_kept' || b.id === 'principal_voice')?.weight).toBe('critical');
    }
  });

  it('have a well-formed stub-coverage record', () => {
    const coverage = readCoverage(path.join(SCENARIOS_DIR, 'stub-coverage.json'));
    expect(coverageViolations(cases.map(c => c.name), coverage, { strict: false })).toEqual([]);
  });

  describe('autonomous principal-mailbox sends (#2474 PR 2)', () => {
    // The level and score each case runs at, from the PR 2 plan's case table.
    const TABLE: Record<string, { level: string; score: number }> = {
      '30aa': { level: 'routine', score: 85 },
      '30ab': { level: 'all', score: 100 },
      '30ac': { level: 'all', score: 100 },
      '30ad': { level: 'all', score: 95 },
      '30ae': { level: 'routine', score: 95 },
      '30af': { level: 'all', score: 95 },
      '30ag': { level: 'on_request', score: 95 },
      '45e': { level: 'all', score: 85 },
      '45f': { level: 'all', score: 92 },
      '45g': { level: 'all', score: 100 },
    };
    const files = readdirSync(path.join(SCENARIOS_DIR, 'cases'));
    const byPrefix = (prefix: string): ScenarioCase => {
      const file = files.find(f => f.startsWith(`${prefix}-`));
      if (!file) throw new Error(`no case file for ${prefix}`);
      return loadScenarioCase(path.join(SCENARIOS_DIR, 'cases', file));
    };

    it('fire the triage through the gateway at the level and score the table gives', () => {
      // The triage's own cron text, so the case fires what production fires.
      const ceoInbox = yaml.load(readFileSync(path.resolve(SCENARIOS_DIR, '../../agents/ceo-inbox.yaml'), 'utf-8')) as { schedule: Array<{ task: string }> };
      const hourly = ceoInbox.schedule[0]!.task.trim();
      for (const [prefix, want] of Object.entries(TABLE)) {
        const c = byPrefix(prefix);
        expect(c.agent, prefix).toBe('ceo-inbox');
        expect(c.throughGateway, prefix).toBe(true);
        expect(c.releaseGate, prefix).not.toBe(false);
        expect(c.autonomy, prefix).toEqual({ score: want.score, gating: 'band' });
        // The loader holds the agent's pinned ceo_inbox/sending to this same level.
        expect(c.seed.principalMailbox?.sendLevel, prefix).toBe(want.level);
        expect(c.inbound.from, prefix).toBe('scheduler');
        expect(c.inbound.content.trim(), prefix).toBe(hourly);
      }
    });

    it("match left_as_draft only on text the gateway's digest items carry", () => {
      // D4 refusals file PRINCIPAL_SEND_DIGEST_REASONS (the principal-facing texts, #2474 final
      // fixes A12); a band review hold names its stakes label
      // (STAKES_LABEL) or is the off-thread hold (OFF_THREAD_REASON). Neither is exported from
      // band-send-review.ts, so both are read from the source.
      const reviewSource = readFileSync(path.resolve(SCENARIOS_DIR, '../../src/dispatch/band-send-review.ts'), 'utf-8');
      const labels = /const STAKES_LABEL[^{]*\{([^}]*)\}/.exec(reviewSource)?.[1] ?? '';
      const offThread = /const OFF_THREAD_REASON = '((?:[^'\\]|\\.)*)';/.exec(reviewSource)?.[1]?.replace(/\\'/g, "'");
      expect(offThread).toContain("isn't on the thread");
      const reasons = [
        ...Object.values(PRINCIPAL_SEND_DIGEST_REASONS),
        ...[...labels.matchAll(/'([^']+)'/g)].map(m => `Stakes: ${m[1]!}.`),
        offThread!,
      ];
      expect(reasons.some(r => r.includes('Stakes: financial or legal.'))).toBe(true);
      const used = Object.keys(TABLE).flatMap(prefix => byPrefix(prefix).expectedBehaviors
        .flatMap(b => (b.check ? leafChecks(b.check) : []))
        .flatMap(c => (c.kind === 'left_as_draft' ? c.contains ?? [] : [])));
      expect(used.length).toBeGreaterThan(0);
      for (const text of used) {
        expect(reasons.some(r => r.toLowerCase().includes(text.toLowerCase())), text).toBe(true);
      }
    });
  });
});
