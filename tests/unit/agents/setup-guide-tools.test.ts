// #2358: the setup guide answers the operator on the Setup page, so it must have no tool
// that records anything about the principal: preferences, memory, profile, contacts or
// schedules. Its tools are read from the YAML and the setup bundle's SKILL.md, the way the
// agent loader resolves them.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function readYaml(file: string): Record<string, unknown> {
  return yaml.load(readFileSync(path.join(REPO_ROOT, file), 'utf-8')) as Record<string, unknown>;
}

function bundleTools(bundle: string): string[] {
  const raw = readFileSync(path.join(REPO_ROOT, 'skills', bundle, 'SKILL.md'), 'utf-8');
  const front = raw.split('---')[1] ?? '';
  return ((yaml.load(front) as { tools?: string[] }).tools) ?? [];
}

const agent = readYaml('agents/setup-wizard.yaml');
const pins = agent['pinned_skills'] as string[];
const tools = pins.flatMap((pin) => (pin === 'setup' ? bundleTools('setup') : [pin]));

describe('setup guide tools (#2358)', () => {
  it.each([
    'behavioral-preferences-update',
    'memory-store',
    'executive-profile-update',
    'contact-update',
    'scheduler-create',
    'scheduler-cancel',
  ])('has no %s', (tool) => {
    expect(tools).not.toContain(tool);
  });

  it('has exactly the setup tools, the registry read and the mailbox sign-in link', () => {
    expect([...tools].sort()).toEqual([
      'mailbox-signin-link',
      'setup-defer',
      'setup-status',
      'system-secret-capture-request',
      'tool-registry',
    ]);
  });

  it('cannot discover more tools at run time', () => {
    expect(agent['allow_discovery']).toBe(false);
  });
});
