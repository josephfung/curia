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

/** VALID's inbound, which the task-wake rows replace. */
const PRINCIPAL_INBOUND = 'from: principal\n  content: "Yes"';
const WAKE_TASK_ID = '5f1c2d3e-4a5b-4c6d-8e7f-22a0b1c2d3e4';
const WAKE_TASK = `{ id: ${WAKE_TASK_ID}, title: Deck comments, intent: Collect comments, notes: [{ at: "2026-10-08T10:00:00-04:00", note: Asked Sam. }] }`;

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

  it('loads a scheduler inbound (#2024)', () => {
    const c = loadScenarioCase(write('s.yaml', VALID.replace('from: principal', 'from: scheduler')));
    expect(c.inbound).toMatchObject({ from: 'scheduler', content: 'Yes' });
  });

  it('loads a task-wake inbound, whose body is built at run time (prompt trim PR 9)', () => {
    const c = loadScenarioCase(write('w.yaml', VALID.replace(PRINCIPAL_INBOUND, `from: task-wake\n  task: ${WAKE_TASK}`)));
    expect(c.inbound).toMatchObject({
      from: 'task-wake',
      content: '',
      task: {
        id: WAKE_TASK_ID,
        title: 'Deck comments',
        intent: 'Collect comments',
        notes: [{ at: '2026-10-08T10:00:00-04:00', note: 'Asked Sam.' }],
      },
    });
  });

  it.each([
    ['a placeholder for an unseeded entry', VALID.replace('{{entry:offsite}}', '{{entry:missing}}'), /names no seeded entry/],
    ['an unknown placeholder kind', VALID.replace('{{entry:offsite}}', '{{job:x}}'), /unknown placeholder/],
    ['a sender that is not seeded', VALID.replace('from: principal', 'from: nobody'), /not principal, bullpen, scheduler, task-wake, delegate or a seeded contact/],
    ['a scheduler inbound with a channel', VALID.replace('from: principal', 'from: scheduler\n  channel: signal'), /from scheduler takes no channel/],
    ['a task wake with content', VALID.replace('from: principal', `from: task-wake\n  task: ${WAKE_TASK}`), /takes 'task', not 'content'/],
    ['a task wake with no task', VALID.replace(PRINCIPAL_INBOUND, 'from: task-wake'), /inbound\.task must be a mapping/],
    ['a task wake whose id is not a UUID', VALID.replace(PRINCIPAL_INBOUND, `from: task-wake\n  task: ${WAKE_TASK.replace(WAKE_TASK_ID, 'task-1')}`), /'id' must be a UUID/],
    ['a task wake with no notes', VALID.replace(PRINCIPAL_INBOUND, `from: task-wake\n  task: ${WAKE_TASK.replace(/, notes: .*\}$/, ' }')}`), /'notes' must list/],
    ['a task on a principal inbound', VALID.replace(PRINCIPAL_INBOUND, `${PRINCIPAL_INBOUND}\n  task: ${WAKE_TASK}`), /only for 'from: task-wake'/],
    ['a stub with both return and error', VALID.replace("error: wrong specialist", "error: x\n      return: {}"), /exactly one of 'return' or 'error'/],
    ['a check with two kinds', VALID.replace('max: 1', 'max: 1\n      not_called: [email-send]'), /exactly one of/],
    ['an invalid weight', VALID.replace('weight: critical', 'weight: urgent'), /invalid weight/],
    ['a duplicate behavior id', VALID.replace('id: silent', 'id: routes'), /duplicate behavior id/],
    ['zero runs', VALID.replace('runs: 3', 'runs: 0'), /positive integer/],
    ['a bad regex', VALID.replace('description: does not answer directly', 'description: x\n    check: { reply_excludes: ["("] }'), /invalid pattern/],
    ['a non-boolean success', VALID.replace('max: 1', 'max: 1\n      success: yes'), /'success' must be a boolean/],
    ['success on not_called', VALID.replace('    check:\n      called: delegate\n      with: { agent: ceo-inbox }\n      contains: { task: "{{entry:offsite}}" }\n      max: 1', '    check:\n      not_called: [email-send]\n      success: true'), /unknown key\(s\) success/],
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

  it('parses called success: true', () => {
    const c = loadScenarioCase(write('ok.yaml', VALID.replace('max: 1', 'max: 1\n      success: true')));
    expect(c.expectedBehaviors[0]!.check).toMatchObject({ kind: 'called', success: true, max: 1 });
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

  it('loads seed.backlog, absent counts as zero (prompt trim PR 7)', () => {
    const body = VALID.replace('seed:\n', 'seed:\n  backlog: { pending_approvals: 2 }\n');
    const c = loadScenarioCase(write('backlog.yaml', body));
    expect(c.seed.backlog).toEqual({ decayWarnings: 0, pendingApprovals: 2, principalTasks: 0 });
    expect(loadScenarioCase(write('none.yaml', VALID)).seed).not.toHaveProperty('backlog');
  });

  it.each([
    ['all zero', '{ pending_approvals: 0 }', /at least one count must be positive/],
    ['a fractional count', '{ decay_warnings: 1.5 }', /must be a whole number/],
    ['a negative count', '{ principal_tasks: -1 }', /non-negative number/],
    ['an unknown kind', '{ held_messages: 1 }', /unknown key\(s\) held_messages/],
  ])('rejects a backlog with %s', (_label, backlog, error) => {
    const body = VALID.replace('seed:\n', `seed:\n  backlog: ${backlog}\n`);
    expect(() => loadScenarioCase(write('bad-backlog.yaml', body))).toThrow(error);
  });

  it('parses seed.verifications and resolves {{verification:key}} (#2017)', () => {
    const body = VALID
      .replace('seed:\n', [
        'seed:',
        '  verifications:',
        '    - key: otp',
        '      site: example-insurer.ca',
        '      page_domain: login.example-insurer.ca',
        '      delivery: sms',
        '      browser_session_id: s-1',
        `      task: ${WAKE_TASK_ID}`,
        '      requested_minutes_ago: 3',
        '    - key: old',
        '      site: aircanada.com',
        '      page_domain: aircanada.com',
        '      delivery: email',
        '      browser_session_id: s-9',
        '      status: expired',
        '',
      ].join('\n'))
      .replace('contains: { task: "{{entry:offsite}}" }', 'contains: { task: "{{entry:offsite}} {{verification:otp}}" }');
    const c = loadScenarioCase(write('verif.yaml', body));
    expect(c.seed.verifications).toEqual([
      {
        key: 'otp', site: 'example-insurer.ca', pageDomain: 'login.example-insurer.ca', delivery: 'sms',
        browserSessionId: 's-1', taskId: WAKE_TASK_ID, status: 'pending', requestedMinutesAgo: 3, sessionAlive: true,
      },
      {
        key: 'old', site: 'aircanada.com', pageDomain: 'aircanada.com', delivery: 'email',
        browserSessionId: 's-9', status: 'expired', requestedMinutesAgo: 15, sessionAlive: false,
      },
    ]);
    const resolved = resolvePlaceholders(c.expectedBehaviors[0]!.check, new Map([
      ['entry:offsite', 'e-1'], ['verification:otp', 'v-1'],
    ]));
    expect(resolved).toMatchObject({ contains: { task: 'e-1 v-1' } });
    // A case without the kind has none, and every other case keeps loading.
    expect(loadScenarioCase(write('none.yaml', VALID)).seed.verifications).toEqual([]);
  });

  it.each([
    ['an unknown delivery', 'delivery: voice', /delivery must be one of email, sms, app/],
    ['an unknown status', 'status: waiting', /status must be one of pending, expired, satisfied, abandoned/],
    ['a misspelled key', 'session: s-1', /unknown key\(s\) session/],
    ['a task that is not a UUID', 'task: t-1', /'task' must be a UUID/],
  ])('rejects a seeded verification with %s', (_label, extra, error) => {
    const body = VALID.replace('seed:\n', [
      'seed:',
      '  verifications:',
      '    - key: otp',
      '      site: example.ca',
      '      page_domain: example.ca',
      '      browser_session_id: s-1',
      ...(extra.startsWith('delivery') ? [] : ['      delivery: sms']),
      `      ${extra}`,
      '',
    ].join('\n'));
    expect(() => loadScenarioCase(write('bad-verif.yaml', body))).toThrow(error);
  });

  it('rejects two seeded verifications for one site', () => {
    const row = (key: string, status: string) => [
      `    - key: ${key}`, '      site: example.ca', '      page_domain: login.example.ca',
      '      delivery: sms', `      browser_session_id: s-${key}`, `      status: ${status}`,
    ];
    const body = VALID.replace('seed:\n', ['seed:', '  verifications:', ...row('a', 'pending'), ...row('b', 'expired'), ''].join('\n'));
    expect(() => loadScenarioCase(write('two.yaml', body))).toThrow(/at most one verification per site/);
  });

  it('parses seed.principal_identities (#2017)', () => {
    const body = VALID.replace('seed:\n', 'seed:\n  principal_identities:\n    - { channel: signal, identifier: "+15555550142" }\n');
    const c = loadScenarioCase(write('pid.yaml', body));
    expect(c.seed.principalIdentities).toEqual([{ channel: 'signal', identifier: '+15555550142' }]);
    expect(loadScenarioCase(write('none.yaml', VALID)).seed.principalIdentities).toEqual([]);
  });

  it.each([
    ['a local channel the principal needs no identity on', '{ channel: cli, identifier: x }', /needs no identity/],
    ['two on one channel', '{ channel: signal, identifier: "+1" }\n    - { channel: signal, identifier: "+2" }', /at most one per channel/],
    ['an unknown key', '{ channel: signal, identifier: "+1", verified: true }', /unknown key\(s\) verified/],
    ['an email outside example.test', '{ channel: email, identifier: a@gmail.com }', /under example.test/],
  ])('rejects a principal identity with %s', (_label, entry, error) => {
    const body = VALID.replace('seed:\n', `seed:\n  principal_identities:\n    - ${entry}\n`);
    expect(() => loadScenarioCase(write('bad-pid.yaml', body))).toThrow(error);
  });

  it('rejects a placeholder for an unseeded verification', () => {
    const body = VALID.replace('{{entry:offsite}}', '{{verification:missing}}');
    expect(() => loadScenarioCase(write('bad-ref.yaml', body))).toThrow(/names no seeded verification/);
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

  it('stubs web-search from defaults unless the case sets live_search (#2106)', () => {
    const stubsDir = path.join(dir, 'stubs');
    mkdirSync(stubsDir);
    const search = 'web-search:\n  - match: {}\n    return: { results: [], count: 0 }\n';
    writeFileSync(path.join(stubsDir, 'defaults.yaml'), `${search}email-list:\n  - match: {}\n    return: { messages: [], count: 0 }\n`);
    writeFileSync(path.join(stubsDir, 'research.yaml'), search);
    const withKey = (extra: string): string => VALID.replace('tags: [routing]', `tags: [routing]\n${extra}`);

    const stubbed = loadScenarioCase(write('a.yaml', VALID), { stubsDir });
    expect(stubbed.toolStubs['web-search']).toHaveLength(1);
    expect(stubbed.liveSearch).toBeUndefined();

    const live = loadScenarioCase(write('b.yaml', withKey('live_search: true')), { stubsDir });
    expect(live.toolStubs['web-search']).toBeUndefined();
    expect(live.toolStubs['email-list']).toHaveLength(1);
    expect(live.liveSearch).toBe(true);

    // A stub of the case's own, or a named set's, would answer every search instead.
    expect(() => loadScenarioCase(write('c.yaml', withKey(`live_search: true\nstub_sets: [research]`)), { stubsDir })).toThrow(/live_search/);
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

describe('real delegation (#2027)', () => {
  const REAL = `
name: real one
delegation: real
release_gate: false
seed:
  outbound_context:
    - key: ask
      channel: signal
      agent: research-analyst
      content: Which angle?
      delegation_hint: research-analyst
      resume: { agent: research-analyst, original_task: Research targets, context: Found three }
inbound:
  from: principal
  content: Technology
tool_stubs:
  web-search:
    - agent: research-analyst
      match: {}
      return: { results: [], count: 0 }
expected_behaviors:
  - id: resumes
    weight: critical
    description: resumes with the token
    check:
      called: delegate
      with: { resume_token: "{{resume_token:ask}}" }
  - id: briefed
    description: the specialist gets its progress back
    check:
      briefed: research-analyst
      brief_contains: ["Principal's Direction"]
  - id: specialist
    description: the specialist searches
    check:
      called: [web-search, web-fetch]
      agent: research-analyst
      returns: { count: 0 }
`;

  it('loads delegation, release_gate, agent-scoped stubs and checks, and resume tokens', () => {
    const c = loadScenarioCase(write('real.yaml', REAL));
    expect(c.delegation).toBe('real');
    expect(c.releaseGate).toBe(false);
    expect(c.toolStubs['web-search']![0]).toMatchObject({ agent: 'research-analyst' });
    expect(c.seed.outboundContext[0]!.resume).toEqual({ agent: 'research-analyst', originalTask: 'Research targets', context: 'Found three' });
    expect(c.expectedBehaviors.map(b => b.check?.kind)).toEqual(['called', 'briefed', 'called']);
    expect(c.expectedBehaviors[2]!.check).toMatchObject({ tool: ['web-search', 'web-fetch'], agent: 'research-analyst', returns: { count: 0 } });
  });

  it('defaults to stubbed delegation in the release gate', () => {
    const c = loadScenarioCase(write('c.yaml', VALID));
    expect(c.delegation).toBe('stubbed');
    expect(c.releaseGate).toBe(true);
  });

  it('rejects what a mode cannot honour', () => {
    const load = (body: string) => () => loadScenarioCase(write('x.yaml', body));
    // A delegate stub would replace the specialist the case runs.
    expect(load(REAL.replace('tool_stubs:', 'tool_stubs:\n  delegate:\n    - match: {}\n      return: {}'))).toThrow(/remove the 'delegate' stubs/);
    // A stubbed case runs no specialist: scoped stubs, agent checks and briefs see nothing.
    const stubbed = REAL.replace('delegation: real\n', '');
    expect(load(stubbed)).toThrow(/needs delegation: real/);
    expect(load(REAL.replace('delegation: real', 'delegation: sometimes'))).toThrow(/'delegation' must be one of stubbed, real/);
    expect(load(REAL.replace('briefed: research-analyst', 'briefed: any'))).toThrow(/names one agent/);
    // A token placeholder must name an entry that seeds one.
    expect(load(REAL.replace('{{resume_token:ask}}', '{{resume_token:other}}'))).toThrow(/names no seeded resume_token/);
  });
});

describe('a case aimed at a specialist (#2025)', () => {
  const SPECIALIST = `
name: inbox lists rules
agent: ceo-inbox
seed:
  contacts:
    - key: sam
      display_name: Sam Rivera
      channel: email
      identifier: sam@example.test
  bullpen:
    - key: consult
      topic: Scheduling consult
      creator: ceo-inbox
      participants: [ceo-inbox, calendar]
      content: CONSULT REQUEST
inbound:
  from: delegate
  content: List my inbox rules.
tool_stubs:
  config-store:
    - agent: ceo-inbox
      match: {}
      return: { found: false }
expected_behaviors:
  - id: reads_rules
    weight: critical
    description: reads the rules
    check:
      called: config-store
      with: { action: retrieve }
  - id: own_calls
    description: an explicit agent naming the case's agent is fine
    check:
      not_called: [ceo-inbox-archive]
      agent: ceo-inbox
`;
  const load = (body: string) => () => loadScenarioCase(write('s.yaml', body));

  it('loads the agent and a delegate inbound, the requester defaulting to the principal', () => {
    const c = loadScenarioCase(write('s.yaml', SPECIALIST));
    expect(c.agent).toBe('ceo-inbox');
    expect(c.inbound).toMatchObject({ from: 'delegate', requester: 'principal', content: 'List my inbox rules.' });
    expect(loadScenarioCase(write('c.yaml', VALID)).agent).toBe('coordinator');
  });

  it('takes a seeded contact as requester, and a consult reply posted by another participant', () => {
    expect(loadScenarioCase(write('r.yaml', SPECIALIST.replace('  from: delegate\n', '  from: delegate\n  requester: sam\n'))).inbound.requester).toBe('sam');
    const reply = loadScenarioCase(write('b.yaml', SPECIALIST.replace('  from: delegate\n', '  from: bullpen\n  thread: consult\n  author: calendar\n')));
    expect(reply.inbound).toMatchObject({ from: 'bullpen', thread: 'consult', author: 'calendar' });
  });

  it('rejects inbounds a specialist cannot receive and fields that belong to another inbound', () => {
    expect(load(SPECIALIST.replace('  from: delegate\n', '  from: principal\n'))).toThrow(/takes inbound from delegate, bullpen, scheduler or task-wake/);
    expect(load(SPECIALIST.replace('agent: ceo-inbox\n', ''))).toThrow(/set the case's 'agent'/);
    expect(load(SPECIALIST.replace('  from: delegate\n', '  from: delegate\n  requester: nobody\n'))).toThrow(/not principal or a seeded contact/);
    expect(load(SPECIALIST.replace('  from: delegate\n', '  from: delegate\n  author: calendar\n'))).toThrow(/only for 'from: bullpen'/);
    // The thread's creator is the case's agent, so the reply needs another author.
    expect(load(SPECIALIST.replace('  from: delegate\n', '  from: bullpen\n  thread: consult\n'))).toThrow(/must be another participant/);
    expect(load(SPECIALIST.replace('agent: ceo-inbox', 'agent: any'))).toThrow(/must name one agent/);
  });

  it('holds stubs and checks to the case agent, and leaves real delegation to the coordinator', () => {
    expect(load(SPECIALIST.replace('    - agent: ceo-inbox\n', '    - agent: calendar\n'))).toThrow(/needs delegation: real/);
    expect(load(SPECIALIST.replace('      agent: ceo-inbox\n', '      agent: calendar\n'))).toThrow(/needs delegation: real/);
    expect(load(SPECIALIST.replace('agent: ceo-inbox\n', 'agent: ceo-inbox\ndelegation: real\n'))).toThrow(/starts from the coordinator/);
  });

  it('finds an overlay\'s stub sets before core\'s', () => {
    const core = path.join(dir, 'core-stubs');
    const extra = path.join(dir, 'extra-stubs');
    mkdirSync(core);
    mkdirSync(extra);
    writeFileSync(path.join(core, 'defaults.yaml'), 'email-list:\n  - match: {}\n    return: { from: core }\n');
    writeFileSync(path.join(core, 'shared.yaml'), 'signal-send:\n  - match: {}\n    return: { from: core }\n');
    writeFileSync(path.join(extra, 'shared.yaml'), 'signal-send:\n  - match: {}\n    return: { from: overlay }\n');
    const c = loadScenarioCase(write('o.yaml', VALID.replace('tags: [routing]', 'tags: [routing]\nstub_sets: [shared]')), { stubsDir: core, extraStubsDirs: [extra] });
    expect(c.toolStubs['signal-send']!.map(s => s.return)).toEqual([{ from: 'overlay' }]);
    expect(c.toolStubs['email-list']!.map(s => s.return)).toEqual([{ from: 'core' }]);
  });
});

describe('loadScenarioCase: principal_note checks (prompt trim PR 5)', () => {
  const withCheck = (check: string) => VALID.replace(
    '  - id: silent\n    description: does not answer directly\n',
    `  - id: silent\n    description: does not answer directly\n    check:\n${check}`,
  );

  it('loads present with note_contains, and absent', () => {
    const present = loadScenarioCase(write('note.yaml', withCheck('      principal_note: present\n      note_contains: [Sam, offsite]\n')));
    expect(present.expectedBehaviors[1]!.check).toEqual({ kind: 'principal_note', is: 'present', contains: ['Sam', 'offsite'] });
    const absent = loadScenarioCase(write('note-absent.yaml', withCheck('      principal_note: absent\n')));
    expect(absent.expectedBehaviors[1]!.check).toEqual({ kind: 'principal_note', is: 'absent' });
  });

  it('rejects an unknown value and note_contains on absent', () => {
    expect(() => loadScenarioCase(write('bad1.yaml', withCheck('      principal_note: maybe\n')))).toThrow(/present or absent/);
    expect(() => loadScenarioCase(write('bad2.yaml', withCheck('      principal_note: absent\n      note_contains: [Sam]\n')))).toThrow(/needs principal_note: present/);
  });
});

describe('text checks and identity fixtures (#2143)', () => {
  const STYLE = `
name: style
release_gate: false
identity: brief
inbound:
  from: principal
  content: Did Dana confirm?
expected_behaviors:
  - id: short
    description: brief
    check:
      text: reply
      max_words: 40
      excludes: ['!']
  - id: short_send
    description: brief send
    check:
      text: { tool: signal-send, arg: message }
      max_words: 60
`;
  const FIXTURE = `
judge_brief: Dry and brief.
identity:
  tone: { style: Dry and brief., verbosity: 15 }
  behavioralPreferences: [Keep it short]
  constraints: [Never impersonate the principal]
`;
  function identities(body = FIXTURE): string {
    const ids = path.join(dir, 'identities');
    mkdirSync(ids, { recursive: true });
    writeFileSync(path.join(ids, 'brief.yaml'), body);
    return ids;
  }

  it('parses a text check on the reply or on a tool argument', () => {
    const c = loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: identities() });
    expect(c.expectedBehaviors[0]!.check).toEqual({ kind: 'text', of: 'reply', maxWords: 40, excludes: ['!'] });
    expect(c.expectedBehaviors[1]!.check).toEqual({ kind: 'text', of: { tool: 'signal-send', arg: 'message' }, maxWords: 60 });
  });

  it('attaches the identity fixture, judge brief included', () => {
    const c = loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: identities() });
    expect(c.identity?.name).toBe('brief');
    expect(c.identity?.judgeBrief).toBe('Dry and brief.');
    expect(c.identity?.config.tone.verbosity).toBe(15);
  });

  it('keeps a case with an identity fixture out of the release gate', () => {
    const ids = identities();
    expect(() => loadScenarioCase(write('a.yaml', STYLE.replace('release_gate: false\n', '')), { identitiesDir: ids }))
      .toThrow(/set release_gate: false/);
  });

  it('rejects a fixture that leaves part of the identity to the database', () => {
    const partial = FIXTURE.replace(/  constraints:.*\n/, '');
    expect(() => loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: identities(partial) })).toThrow(/missing constraints/);
    const scalar = FIXTURE.replace('constraints: [Never impersonate the principal]', 'constraints: Never impersonate the principal');
    expect(() => loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: identities(scalar) })).toThrow(/'constraints' must be a list of strings/);
    const withAssistant = FIXTURE + '  assistant: { name: X, title: Y, emailSignature: Z }\n';
    expect(() => loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: identities(withAssistant) })).toThrow(/unknown key\(s\) assistant/);
  });

  it('rejects a missing fixture and malformed text checks', () => {
    expect(() => loadScenarioCase(write('a.yaml', STYLE), { identitiesDir: path.join(dir, 'none') })).toThrow(/identity 'brief' could not be read/);
    const ids = identities();
    const bare = STYLE.replace("      max_words: 40\n      excludes: ['!']\n", '');
    expect(() => loadScenarioCase(write('b.yaml', bare), { identitiesDir: ids })).toThrow(/needs max_words, excludes or both/);
    const badPattern = STYLE.replace("excludes: ['!']", "excludes: ['(']");
    expect(() => loadScenarioCase(write('c.yaml', badPattern), { identitiesDir: ids })).toThrow(/invalid pattern/);
    const agentOnReply = STYLE.replace('      text: reply\n', '      text: reply\n      agent: calendar\n');
    expect(() => loadScenarioCase(write('d.yaml', agentOnReply), { identitiesDir: ids })).toThrow(/the reply is the case agent's/);
  });
});
