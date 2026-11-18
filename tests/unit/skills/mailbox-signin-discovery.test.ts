// mailbox-signin-discovery.test.ts — the mailbox-signin-link tool is reachable the way the issue
// needs (#2361): a coordinator that searches for "connect gmail" finds it, while only the setup
// wizard pins it, so the coordinator's always-on prompt does not grow.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import semver from 'semver';
import { loadRegistryDefaults } from '../../../src/registry/reconcile.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { unifiedToolSearch } from '../../../src/skills/skill-activation.js';
import type { ToolManifest } from '../../../src/skills/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function loadManifest(): ToolManifest {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'skills/mailbox-signin-link/tool.json'), 'utf8')) as ToolManifest;
}

function readPins(agent: string): string[] {
  const doc = yaml.load(readFileSync(path.join(REPO_ROOT, `agents/${agent}.yaml`), 'utf8')) as { pinned_skills?: string[] };
  return doc.pinned_skills ?? [];
}

describe('mailbox-signin-link registration', () => {
  it('is returned by a tool-registry search for "connect gmail", for the coordinator', () => {
    const tools = new ToolRegistry();
    tools.register(loadManifest(), noopHandler);
    const hits = unifiedToolSearch({ query: 'connect gmail', toolRegistry: tools, skillRegistry: new SkillRegistry(), agentId: 'coordinator' });
    expect(hits.map((h) => h.name)).toContain('mailbox-signin-link');
  });

  it('declares the shape the plan asks for', () => {
    const m = loadManifest();
    // A floor, not an exact pin: the release PR bumps versions.
    expect(semver.valid(m.version)).not.toBeNull();
    expect(semver.gte(m.version, '0.1.0')).toBe(true);
    expect(m.action_risk).toBe('none');
    expect(m.sensitivity).toBe('elevated');
    expect(m.capabilities).toEqual(['mailboxSignIn']);
    // No caller restriction: a discovering coordinator must be able to call it.
    expect(m.allowed_callers).toBeUndefined();
    expect(m.description.startsWith("Connect, reconnect or sign in to the principal's Gmail and Google Calendar")).toBe(true);
  });

  it('is enabled by default as a standalone tool', () => {
    const defaults = loadRegistryDefaults(path.join(REPO_ROOT, 'config/registry-defaults.yaml'));
    expect(defaults.tools).toContain('mailbox-signin-link');
  });

  it('is pinned to the setup wizard and not to the coordinator', () => {
    expect(readPins('setup-wizard')).toContain('mailbox-signin-link');
    expect(readPins('coordinator')).not.toContain('mailbox-signin-link');
  });
});
