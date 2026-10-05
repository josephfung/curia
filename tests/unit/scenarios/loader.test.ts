import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadScenarioCase,
  loadScenarioCases,
  placeholdersIn,
  resolvePlaceholders,
  resolveRunPlaceholders,
} from '../../scenarios/loader.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'scenarios-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

const VALID = `
name: transfer yes
tags: [routing]
runs: 3
seed:
  contacts:
    - key: sam
      display_name: Sam Rivera
      tier: known
      channel: email
      identifier: sam@example.test
  outbound_context:
    - key: offsite
      channel: email
      agent: ceo-inbox
      content: Does Thursday work?
      delegation_hint: ceo-inbox
inbound:
  from: principal
  content: "Yes"
tool_stubs:
  delegate:
    - match: { agent: ceo-inbox }
      return: { response: "Sent." }
    - match: {}
      error: wrong specialist
expected_behaviors:
  - id: routes
    weight: critical
    description: delegates to ceo-inbox with the entry id
    check:
      called: delegate
      with: { agent: ceo-inbox }
      contains: { task: "{{entry:offsite}}" }
      max: 1
  - id: silent
    description: does not answer directly
`;

describe('loadScenarioCase', () => {
  it('loads a valid case', () => {
    const c = loadScenarioCase(write('a.yaml', VALID));
    expect(c.name).toBe('transfer yes');
    expect(c.runs).toBe(3);
    expect(c.seed.contacts[0]).toMatchObject({ key: 'sam', tier: 'known', kind: 'person' });
    expect(c.seed.outboundContext[0]).toMatchObject({ key: 'offsite', delegationHint: 'ceo-inbox' });
    expect(c.toolStubs['delegate']).toEqual([
      { match: { agent: 'ceo-inbox' }, return: { response: 'Sent.' } },
      { match: {}, error: 'wrong specialist' },
    ]);
    expect(c.expectedBehaviors[0]!.check).toEqual({
      kind: 'called', tool: 'delegate', with: { agent: 'ceo-inbox' }, contains: { task: '{{entry:offsite}}' }, max: 1,
    });
    expect(c.expectedBehaviors[1]).toEqual({ id: 'silent', description: 'does not answer directly', weight: 'important' });
  });

  it.each([
    ['a placeholder for an unseeded entry', VALID.replace('{{entry:offsite}}', '{{entry:missing}}'), /names no seeded entry/],
    ['an unknown placeholder kind', VALID.replace('{{entry:offsite}}', '{{job:x}}'), /unknown placeholder/],
    ['a sender that is not seeded', VALID.replace('from: principal', 'from: nobody'), /not principal, bullpen or a seeded contact/],
    ['a stub with both return and error', VALID.replace("error: wrong specialist", "error: x\n      return: {}"), /exactly one of 'return' or 'error'/],
    ['a check with two kinds', VALID.replace('max: 1', 'max: 1\n      not_called: [email-send]'), /exactly one of/],
    ['an invalid weight', VALID.replace('weight: critical', 'weight: urgent'), /invalid weight/],
    ['a duplicate behavior id', VALID.replace('id: silent', 'id: routes'), /duplicate behavior id/],
    ['zero runs', VALID.replace('runs: 3', 'runs: 0'), /positive integer/],
    ['a bad regex', VALID.replace('description: does not answer directly', 'description: x\n    check: { reply_excludes: ["("] }'), /invalid pattern/],
  ])('rejects %s', (_label, body, error) => {
    expect(() => loadScenarioCase(write('bad.yaml', body))).toThrow(error);
  });

  it.each([
    ['a trusted tier (a grant, refused at create)', VALID.replace('tier: known', 'tier: trusted'), /tier must be one of known, unknown/],
    ['an email outside example.test', VALID.replace('sam@example.test', 'sam@gmail.com'), /under example.test/],
    ['a misspelled weight key', VALID.replace('weight: critical', 'weigth: critical'), /unknown key\(s\) weigth/],
    ['a misspelled check key', VALID.replace('    check:\n      called: delegate', '    checks:\n      called: delegate'), /unknown key\(s\) checks/],
    ['an unknown key inside a check', VALID.replace('with: { agent: ceo-inbox }\n      contains', 'wth: { agent: ceo-inbox }\n      contains'), /unknown key\(s\) wth/],
    ['an unknown top-level key', VALID + 'run: 3\n', /unknown key\(s\) run/],
    ['a known_failure without an issue reference', VALID.replace('runs: 3', 'runs: 3\nknown_failure: { issue: "later", reason: "x" }'), /known_failure.issue must look like/],
    ['a placeholder in failure_modes', VALID + 'failure_modes:\n  - "drops {{entry:offsite}}"\n', /failure_modes cannot contain/],
  ])('rejects %s', (_label, body, error) => {
    expect(() => loadScenarioCase(write('bad2.yaml', body))).toThrow(error);
  });

  it('parses an any_of check into its alternatives (#1972)', () => {
    const body = VALID.replace(
      '    check:\n      called: delegate\n      with: { agent: ceo-inbox }\n      contains: { task: "{{entry:offsite}}" }\n      max: 1',
      '    check:\n      any_of:\n        - called: delegate\n          with: { agent: ceo-inbox, outbound_entry_id: "{{entry:offsite}}" }\n        - called: delegate\n          with: { agent: ceo-inbox }\n          contains: { task: "{{entry:offsite}}" }',
    );
    const c = loadScenarioCase(write('any.yaml', body));
    expect(c.expectedBehaviors[0]!.check).toEqual({
      kind: 'any_of',
      checks: [
        { kind: 'called', tool: 'delegate', with: { agent: 'ceo-inbox', outbound_entry_id: '{{entry:offsite}}' } },
        { kind: 'called', tool: 'delegate', with: { agent: 'ceo-inbox' }, contains: { task: '{{entry:offsite}}' } },
      ],
    });
  });

  it.each([
    ['an empty any_of', '    check:\n      any_of: []'],
    ['an any_of of non-mappings', '    check:\n      any_of: [delegate]'],
  ])('rejects %s', (_label, check) => {
    const body = VALID.replace(
      '    check:\n      called: delegate\n      with: { agent: ceo-inbox }\n      contains: { task: "{{entry:offsite}}" }\n      max: 1',
      check,
    );
    expect(() => loadScenarioCase(write('bad3.yaml', body))).toThrow(/any_of/);
  });

  it('requires a bullpen inbound to name a seeded thread', () => {
    const body = VALID.replace('from: principal', 'from: bullpen');
    expect(() => loadScenarioCase(write('b.yaml', body))).toThrow(/needs 'thread'/);
  });
});

describe('stub sets', () => {
  it('appends a shared set after the case\'s own stubs', () => {
    const casesDir = path.join(dir, 'cases');
    const stubsDir = path.join(dir, 'stubs');
    mkdirSync(casesDir);
    mkdirSync(stubsDir);
    writeFileSync(path.join(stubsDir, 'defaults.yaml'), 'email-list:\n  - match: {}\n    return: { messages: [], count: 0 }\n');
    writeFileSync(path.join(stubsDir, 'sends.yaml'), 'delegate:\n  - match: {}\n    return: { from: set }\nsignal-send:\n  - match: {}\n    return: { delivered_to: x, channel: signal }\n');
    const file = path.join(casesDir, 'c.yaml');
    writeFileSync(file, VALID.replace('tags: [routing]', 'tags: [routing]\nstub_sets: [sends]'));
    const c = loadScenarioCase(file, { stubsDir });
    expect(c.toolStubs['delegate']!.map(s => s.return ?? s.error)).toEqual([{ response: 'Sent.' }, 'wrong specialist', { from: 'set' }]);
    expect(c.toolStubs['signal-send']).toHaveLength(1);
    // defaults always applies, without being named
    expect(c.toolStubs['email-list']).toHaveLength(1);
  });

  it('rejects an unknown set', () => {
    expect(() => loadScenarioCase(write('c.yaml', VALID.replace('tags: [routing]', 'tags: [routing]\nstub_sets: [nope]')))).toThrow(/stub set 'nope'/);
  });
});

describe('loadScenarioCases', () => {
  it('rejects duplicate names', () => {
    write('a.yaml', VALID);
    write('b.yaml', VALID.replace('name: transfer yes', 'name: Transfer Yes'));
    expect(() => loadScenarioCases(dir)).toThrow(/Duplicate scenario name/);
  });
});

describe('placeholders', () => {
  it('finds and resolves them deeply', () => {
    const value = { a: 'id {{entry:x}} and {{ principal_contact_id }}', b: ['{{contact:y}}'], c: 3 };
    expect(placeholdersIn(value)).toEqual(['entry:x', 'principal_contact_id', 'contact:y']);
    const refs = new Map([['entry:x', 'E1'], ['principal_contact_id', 'P1'], ['contact:y', 'C1']]);
    expect(resolvePlaceholders(value, refs)).toEqual({ a: 'id E1 and P1', b: ['C1'], c: 3 });
  });

  it('throws on an unresolved one', () => {
    expect(() => resolvePlaceholders('{{entry:nope}}', new Map())).toThrow(/Unresolved/);
  });
});

// #1958: a stub pinned to absolute dates goes stale. Case 10 asked for "next week" and
// stubbed Oct 6–8, which stopped being next week the day after it was written.
describe('date placeholders', () => {
  const DATED = VALID
    .replace('content: "Yes"', 'content: "Can we do {{day:next-monday+1}}?"')
    .replace('return: { response: "Sent." }', 'return: { response: "Free {{time:next-monday+1 10:00}} ({{timezone}})" }');

  it('loads a case that uses them, leaving them for the run to resolve', () => {
    const c = loadScenarioCase(write('d.yaml', DATED));
    expect(c.inbound.content).toBe('Can we do {{day:next-monday+1}}?');
    expect(c.toolStubs['delegate']![0]!.return).toEqual({ response: 'Free {{time:next-monday+1 10:00}} ({{timezone}})' });
  });

  it('accepts the keyless and colon-only forms the seeded-row check would otherwise reject', () => {
    const body = VALID.replace('content: "Yes"', 'content: "{{date:today}} {{weekday:today}} {{at:now}} {{timezone}}"');
    expect(() => loadScenarioCase(write('d2.yaml', body))).not.toThrow();
  });

  it.each([
    ['an unknown day', 'content: "{{day:nxt-monday}}"', /date placeholder.*unknown day/],
    ['a bad time', 'content: "{{time:today 25:00}}"', /date placeholder.*invalid time/],
    // Keyless date kinds match neither resolver: they must fail here, not at rating time.
    ['a keyless date kind', 'content: "{{date}}"', /unknown placeholder \{\{date\}\}/],
    ['a keyed timezone', 'content: "{{timezone:x}}"', /unknown placeholder \{\{timezone:x\}\}/],
  ])('rejects %s', (_label, content, error) => {
    expect(() => loadScenarioCase(write('d3.yaml', VALID.replace('content: "Yes"', content)))).toThrow(error);
  });

  it('rejects one in failure_modes, which reach the judge as written', () => {
    const body = VALID + 'failure_modes:\n  - "offers {{day:next-monday+1}}"\n';
    expect(() => loadScenarioCase(write('d4.yaml', body))).toThrow(/failure_modes cannot contain/);
  });

  it('rejects one in the description, which reaches the judge as written', () => {
    const body = VALID.replace('tags: [routing]', 'description: asks about {{day:today}}\ntags: [routing]');
    expect(() => loadScenarioCase(write('d5.yaml', body))).toThrow(/description cannot contain date placeholders/);
  });
});

describe('resolveRunPlaceholders', () => {
  // Monday 2026-10-05 09:00 in Toronto.
  const clock = { now: '2026-10-05T13:00:00.000Z', timezone: 'America/Toronto' };

  it('resolves dates against the run clock, then seeded ids', () => {
    const run = { refs: { 'entry:x': 'E1' }, clock };
    expect(resolveRunPlaceholders('{{entry:x}} on {{day:next-monday+1}} ({{date:next-monday+1}})', run))
      .toBe('E1 on Tuesday, October 13 (2026-10-13)');
  });

  it('leaves a value with no date placeholders alone when the run has no clock', () => {
    expect(resolveRunPlaceholders('{{entry:x}}', { refs: { 'entry:x': 'E1' } })).toBe('E1');
  });

  it('throws rather than hand the judge a raw date when the run has no clock', () => {
    expect(() => resolveRunPlaceholders('on {{day:today}}', { refs: {} })).toThrow(/no clock/);
  });
});
