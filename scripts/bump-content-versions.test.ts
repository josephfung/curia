import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpPatch,
  discoverUnits,
  planBumps,
  readVersion,
  setVersion,
  stripVersion,
  type GitReader,
  type Unit,
} from './bump-content-versions.js';

const AGENT_YAML = 'name: x\nversion: "0.4.2"\nrole: specialist\nsystem_prompt: |\n  version: not this one\n';
const TOOL_JSON = '{\n  "name": "t",\n  "version": "1.2.5",\n  "description": "d"\n}\n';

describe('version line handling', () => {
  it('reads the top-level version, not one inside a prompt body', () => {
    expect(readVersion('agent', AGENT_YAML)).toBe('0.4.2');
    expect(readVersion('tool', TOOL_JSON)).toBe('1.2.5');
    expect(readVersion('bundle', '---\nname: b\nversion: "0.1.1"\n---\n')).toBe('0.1.1');
    expect(readVersion('agent', 'name: x\n')).toBeNull();
  });

  it('rewrites only the version, keeping quoting and the rest of the file', () => {
    expect(setVersion('agent', AGENT_YAML, '0.4.3')).toBe(AGENT_YAML.replace('"0.4.2"', '"0.4.3"'));
    expect(setVersion('tool', TOOL_JSON, '1.2.6')).toBe(TOOL_JSON.replace('1.2.5', '1.2.6'));
  });

  it('strips the version line so a version-only edit compares equal', () => {
    expect(stripVersion('agent', AGENT_YAML)).toBe(stripVersion('agent', setVersion('agent', AGENT_YAML, '9.9.9')));
  });

  it('bumps the patch and rejects non-semver', () => {
    expect(bumpPatch('0.11.0')).toBe('0.11.1');
    expect(() => bumpPatch('banana')).toThrow(/not a valid semver/);
  });
});

function fakeGit(opts: {
  atRef: Record<string, string>;
  current: Record<string, string>;
  changed: string[];
}): GitReader {
  return {
    showAtRef: (_ref, file) => opts.atRef[file] ?? null,
    readCurrent: (file) => {
      const text = opts.current[file];
      if (text === undefined) throw new Error(`no current ${file}`);
      return text;
    },
    changedFiles: (_ref, scope) => opts.changed.filter((f) => scope.some((s) => f === s || f.startsWith(`${s}/`))),
  };
}

const agent: Unit = { kind: 'agent', versionFile: 'agents/x.yaml', scope: ['agents/x.yaml'] };
const tool: Unit = { kind: 'tool', versionFile: 'skills/b/tools/t/tool.json', scope: ['skills/b/tools/t'] };

describe('planBumps', () => {
  it('bumps an agent whose content changed', () => {
    const edited = AGENT_YAML.replace('role: specialist', 'role: coordinator');
    const { bumps } = planBumps(
      [agent],
      'v1',
      fakeGit({ atRef: { 'agents/x.yaml': AGENT_YAML }, current: { 'agents/x.yaml': edited }, changed: ['agents/x.yaml'] }),
    );
    expect(bumps).toEqual([{ unit: agent, from: '0.4.2', to: '0.4.3' }]);
  });

  it('leaves a version-only edit alone (idempotent after a bump)', () => {
    const bumped = setVersion('agent', AGENT_YAML, '0.4.3');
    const { bumps, skipped } = planBumps(
      [agent],
      'v1',
      fakeGit({ atRef: { 'agents/x.yaml': AGENT_YAML }, current: { 'agents/x.yaml': bumped }, changed: ['agents/x.yaml'] }),
    );
    expect(bumps).toEqual([]);
    expect(skipped[0]?.reason).toBe('already-bumped');
  });

  it('respects a hand bump even when other content also changed', () => {
    const edited = setVersion('agent', AGENT_YAML, '0.5.0').replace('role: specialist', 'role: coordinator');
    const { bumps, skipped } = planBumps(
      [agent],
      'v1',
      fakeGit({ atRef: { 'agents/x.yaml': AGENT_YAML }, current: { 'agents/x.yaml': edited }, changed: ['agents/x.yaml'] }),
    );
    expect(bumps).toEqual([]);
    expect(skipped[0]?.reason).toBe('already-bumped');
  });

  it('skips an unchanged unit and a unit that is new since the tag', () => {
    const { bumps, skipped } = planBumps(
      [agent, tool],
      'v1',
      fakeGit({
        atRef: { 'agents/x.yaml': AGENT_YAML },
        current: { 'agents/x.yaml': AGENT_YAML, [tool.versionFile]: TOOL_JSON },
        changed: [],
      }),
    );
    expect(bumps).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['unchanged', 'new-since-tag']);
  });

  it('bumps a tool when its handler changes but not when only its test does', () => {
    const git = (changed: string[]): GitReader =>
      fakeGit({ atRef: { [tool.versionFile]: TOOL_JSON }, current: { [tool.versionFile]: TOOL_JSON }, changed });
    expect(planBumps([tool], 'v1', git(['skills/b/tools/t/handler.ts'])).bumps).toHaveLength(1);
    expect(planBumps([tool], 'v1', git(['skills/b/tools/t/handler.test.ts'])).bumps).toHaveLength(0);
  });

  it('skips a file with no version field instead of guessing', () => {
    const { skipped } = planBumps(
      [agent],
      'v1',
      fakeGit({ atRef: {}, current: { 'agents/x.yaml': 'name: x\n' }, changed: [] }),
    );
    expect(skipped[0]?.reason).toBe('no-version');
  });
});

describe('against a real git repository', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('discovers units and plans from a tag', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bump-versions-'));
    const root = dir;
    const sh = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };

    put('agents/x.yaml', AGENT_YAML);
    put('agents/y.yaml', AGENT_YAML);
    put('skills/b/SKILL.md', '---\nname: b\nversion: "0.1.1"\n---\n');
    put('skills/b/tools/t/tool.json', TOOL_JSON);
    put('skills/b/tools/t/handler.ts', 'export {};\n');
    sh('init', '-q');
    sh('add', '.');
    sh('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    sh('tag', 'v1.0.0');

    put('agents/x.yaml', AGENT_YAML.replace('specialist', 'coordinator'));
    put('skills/b/tools/t/handler.ts', 'export const changed = 1;\n');
    sh('add', '.');
    sh('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'edit');

    const units = discoverUnits(root);
    expect(units.map((u) => `${u.kind}:${u.versionFile}`)).toEqual([
      'agent:agents/x.yaml',
      'agent:agents/y.yaml',
      'bundle:skills/b/SKILL.md',
      'tool:skills/b/tools/t/tool.json',
    ]);

    const git: GitReader = {
      changedFiles: (ref, scope) =>
        execFileSync('git', ['-C', root, 'diff', '--name-only', ref, '--', ...scope], { encoding: 'utf-8' })
          .split('\n')
          .filter(Boolean),
      showAtRef: (ref, file) => {
        try {
          return execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], { encoding: 'utf-8' });
        } catch {
          return null;
        }
      },
      readCurrent: (file) => readFileSync(path.join(root, file), 'utf-8'),
    };
    const { bumps } = planBumps(units, 'v1.0.0', git);
    expect(bumps.map((b) => `${b.unit.versionFile} ${b.from}->${b.to}`)).toEqual([
      'agents/x.yaml 0.4.2->0.4.3',
      'skills/b/tools/t/tool.json 1.2.5->1.2.6',
    ]);
  });
});
