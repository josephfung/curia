import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestCases, loadTestCase, targetProblems } from '../../smoke/loader.js';

// Track temp dirs created in this suite for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Minimal valid YAML test case content
function minimalYaml(name: string): string {
  return [
    `name: ${name}`,
    'turns:',
    '  - content: hello',
    'expected_behaviors:',
    '  - id: respond',
    '    description: Responds to user',
    '    weight: important',
  ].join('\n');
}

describe('Smoke test loader', () => {
  it('loads a single YAML test case', () => {
    const tc = loadTestCase('tests/smoke/cases/forwarded-receipt.yaml');
    expect(tc.name).toBe('Forwarded Receipt (No Context)');
    expect(tc.turns).toHaveLength(1);
    expect(tc.turns[0]!.role).toBe('user');
    expect(tc.expectedBehaviors.length).toBeGreaterThan(0);
    expect(tc.tags).toContain('inference');
  });

  it('loads all test cases from directory', () => {
    const cases = loadTestCases('tests/smoke/cases');
    expect(cases.length).toBeGreaterThan(0);
    for (const tc of cases) {
      expect(tc.name).toBeDefined();
      expect(tc.turns.length).toBeGreaterThan(0);
      expect(tc.expectedBehaviors.length).toBeGreaterThan(0);
    }
  });

  it('validates required fields', () => {
    expect(() => loadTestCase('tests/smoke/cases/nonexistent.yaml')).toThrow();
  });

  it('filters by tag', () => {
    const all = loadTestCases('tests/smoke/cases');
    const filtered = loadTestCases('tests/smoke/cases', { tags: ['inference'] });
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    for (const tc of filtered) {
      expect(tc.tags).toContain('inference');
    }
  });

  it('throws on duplicate test case names across files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Duplicate Name'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('Duplicate Name'));

    expect(() => loadTestCases(dir)).toThrow(/Duplicate test case name 'Duplicate Name'/);
  });

  it('throws on case-insensitive duplicate names to match CLI --case filter semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    // 'Invoice' and 'invoice' are distinct to a case-sensitive Set but both match
    // `--case invoice` in the CLI, so we treat them as duplicates.
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Invoice'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('invoice'));

    expect(() => loadTestCases(dir)).toThrow(/Duplicate test case name/);
  });

  it('does not throw when all test case names are unique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Case A'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('Case B'));

    expect(() => loadTestCases(dir)).not.toThrow();
  });

  describe('sender and judge_tool_calls (#1956)', () => {
    function load(extra: string): ReturnType<typeof loadTestCase> {
      const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
      tempDirs.push(dir);
      const file = join(dir, 'case.yaml');
      writeFileSync(file, `${minimalYaml('Case')}\n${extra}`);
      return loadTestCase(file);
    }

    it('defaults to the principal, with the judge reading replies only', () => {
      const tc = load('');
      expect(tc.sender).toBe('principal');
      expect(tc.judgeToolCalls).toBe(false);
    });

    it('reads an unknown sender and opting the judge into tool calls', () => {
      const tc = load('sender: unknown\njudge_tool_calls: true');
      expect(tc.sender).toBe('unknown');
      expect(tc.judgeToolCalls).toBe(true);
    });

    it('rejects an invalid sender', () => {
      expect(() => load('sender: ceo')).toThrow(/Invalid sender 'ceo'/);
    });

    it('rejects a non-boolean judge_tool_calls', () => {
      expect(() => load('judge_tool_calls: "yes"')).toThrow(/judge_tool_calls/);
    });

    it('rejects an unknown top-level key, so a typo cannot silently fall back to a default', () => {
      expect(() => load('judge_tool_call: true')).toThrow(/Unknown key\(s\) 'judge_tool_call'/);
    });
  });

  describe('target (#1977)', () => {
    function load(extra: string): ReturnType<typeof loadTestCase> {
      const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
      tempDirs.push(dir);
      const file = join(dir, 'case.yaml');
      writeFileSync(file, `${minimalYaml('Case')}\n${extra}`);
      return loadTestCase(file);
    }
    const target = (fields: Record<string, string>): string =>
      ['target:', ...Object.entries(fields).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)].join('\n');
    const valid = { agent: 'ceo-inbox', via: 'bullpen', from: 'calendar', topic: 'Consult', opening: 'CONSULT REQUEST' };

    it('has no target by default: the case addresses the coordinator', () => {
      expect(load('').target).toBeUndefined();
    });

    it('reads a bullpen target', () => {
      expect(load(target(valid)).target).toEqual(valid);
    });

    it('rejects a sender alongside a target, since the turns come from target.from', () => {
      expect(() => load(`sender: unknown\n${target(valid)}`)).toThrow(/'sender' and 'target' cannot both be set/);
    });

    it('rejects an unknown delivery path', () => {
      expect(() => load(target({ ...valid, via: 'email' }))).toThrow(/Invalid target.via 'email'/);
    });

    it('rejects a missing field and a misspelt one', () => {
      const { opening: _omitted, ...withoutOpening } = valid;
      expect(() => load(target(withoutOpening))).toThrow(/'target.opening' must be non-empty text/);
      expect(() => load(target({ ...valid, openning: 'x' }))).toThrow(/Unknown key\(s\) 'openning' in target/);
    });

    it('rejects an agent posting to itself', () => {
      expect(() => load(target({ ...valid, from: 'ceo-inbox' }))).toThrow(/must be another agent/);
    });

    it('checks placeholders in the opening at load time', () => {
      expect(() => load(target({ ...valid, opening: 'By {{dat:today}}' }))).toThrow(/unrecognised placeholder/);
    });

    it('reports targets naming an agent the stack does not run', () => {
      const tc = load(target({ ...valid, from: 'calender' }));
      const registered = new Set(['ceo-inbox', 'calendar']);
      expect(targetProblems([tc], (name) => registered.has(name)))
        .toEqual([`Case: target.from 'calender' is not a registered agent`]);
      expect(targetProblems([load('')], () => false)).toEqual([]);
    });
  });

  describe('tool_stubs and known_failure', () => {
    function loadYaml(yamlText: string): ReturnType<typeof loadTestCase> {
      const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
      tempDirs.push(dir);
      const file = join(dir, 'case.yaml');
      writeFileSync(file, yamlText);
      return loadTestCase(file);
    }
    const behaviors = ['expected_behaviors:', '  - id: respond', '    description: Responds'].join('\n');

    it('reads case-level and turn-level stubs', () => {
      const tc = loadYaml([
        'name: Stubbed',
        'tool_stubs:',
        '  calendar-list-events:',
        '    - match: {}',
        '      return: { events: [] }',
        'turns:',
        '  - content: first',
        '  - content: second',
        '    tool_stubs:',
        '      scheduler-list:',
        '        - match: { status: active }',
        '          error: scheduler down',
        behaviors,
      ].join('\n'));
      expect(tc.toolStubs).toEqual({ 'calendar-list-events': [{ match: {}, return: { events: [] } }] });
      expect(tc.turns[0]!.toolStubs).toBeUndefined();
      expect(tc.turns[1]!.toolStubs).toEqual({ 'scheduler-list': [{ match: { status: 'active' }, error: 'scheduler down' }] });
    });

    it('defaults to no stubs', () => {
      expect(loadYaml(minimalYaml('Plain')).toolStubs).toEqual({});
    });

    it('rejects a stub with both return and error', () => {
      expect(() => loadYaml(`${minimalYaml('Bad')}\ntool_stubs:\n  x:\n    - match: {}\n      return: 1\n      error: no`))
        .toThrow(/exactly one of 'return' or 'error'/);
    });

    it('rejects an unknown turn key', () => {
      expect(() => loadYaml(['name: Bad', 'turns:', '  - content: hi', '    tool_stub: {}', behaviors].join('\n')))
        .toThrow(/Unknown key\(s\) 'tool_stub' in turn 0/);
    });

    it('reads known_failure and requires an issue reference', () => {
      expect(loadYaml(`${minimalYaml('Known')}\nknown_failure: { issue: "#1980" }`).knownFailure).toEqual({ issue: '#1980' });
      expect(() => loadYaml(`${minimalYaml('Known')}\nknown_failure: { issue: "soon" }`)).toThrow(/known_failure/);
      expect(() => loadYaml(`${minimalYaml('Known')}\nknown_failure: true`)).toThrow(/known_failure/);
    });
  });
});

describe('placeholders and behavior ids at load time', () => {
  function loadText(body: string): ReturnType<typeof loadTestCase> {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    const file = join(dir, 'case.yaml');
    writeFileSync(file, body);
    return loadTestCase(file);
  }
  const behavior = ['expected_behaviors:', '  - id: respond', '    description: Responds'].join('\n');

  it('rejects a misspelt placeholder kind in a message', () => {
    expect(() => loadText(['name: A', 'turns:', '  - content: "due {{dat:today}}"', behavior].join('\n')))
      .toThrow(/unrecognised placeholder \{\{dat:today\}\}/);
  });

  it('rejects a principal field with the wrong case', () => {
    expect(() => loadText(['name: A', 'turns:', '  - content: "Hi {{principal:Name}}"', behavior].join('\n')))
      .toThrow(/placeholder/);
  });

  it('leaves {{input:…}} for call time', () => {
    expect(() => loadText([
      'name: A', 'tool_stubs:', '  task-create:', '    - match: {}', '      return: { title: "{{input:title}}" }',
      'turns:', '  - content: hi', behavior,
    ].join('\n'))).not.toThrow();
  });

  it('rejects duplicate behavior ids', () => {
    expect(() => loadText([
      'name: A', 'turns:', '  - content: hi', 'expected_behaviors:',
      '  - { id: x, description: one, weight: critical }', '  - { id: x, description: two, weight: nice-to-have }',
    ].join('\n'))).toThrow(/Duplicate behavior id 'x'/);
  });
});
