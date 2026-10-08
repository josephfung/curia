// The committed scenario cases load, and each has a stub-coverage record (#1956).
// Runs in CI with no database or model: the live suite is `pnpm scenarios`.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAUSED_NEXT_STEP } from '../../../src/agents/prompts/delegate-result-guidance.js';
import { loadScenarioCases } from '../../scenarios/loader.js';
import { matchToolStub } from '../../scenarios/stub-matcher.js';
import { coverageViolations, readCoverage } from '../../scenarios/stub-coverage.js';
import type { ScenarioCase } from '../../scenarios/types.js';

const SCENARIOS_DIR = path.resolve(import.meta.dirname, '../../scenarios');
const cases = loadScenarioCases(path.join(SCENARIOS_DIR, 'cases'));

describe('coordinator scenario cases', () => {
  it('load and validate', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
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

  it('have a well-formed stub-coverage record', () => {
    const coverage = readCoverage(path.join(SCENARIOS_DIR, 'stub-coverage.json'));
    expect(coverageViolations(cases.map(c => c.name), coverage, { strict: false })).toEqual([]);
  });
});
