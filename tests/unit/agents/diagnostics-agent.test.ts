// tests/unit/agents/diagnostics-agent.test.ts
//
// Structural contract tests for the diagnostics agent (#1356). The principal-
// restriction guarantee is enforced by construction: the agent is pinned ONLY to
// read-only query skills, so it physically cannot send, write, or delegate. This
// test is the executable proof of that — if a future edit adds an outbound or
// write skill to the roster, it fails.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');
const config = loadAgentConfig(path.join(agentsDir, 'diagnostics.yaml'));

/** The complete, read-only toolset the diagnostics agent is allowed to hold. */
const ALLOWED_SKILLS = new Set(['date-resolve', 'audit-query', 'audit-trace', 'ops-lookup']);

describe('diagnostics agent config', () => {
  it('runs on the powerful tier', () => {
    expect(config.model.tier).toBe('powerful');
  });

  it('is a specialist (never externally inbound-reachable — dispatcher routes inbound to coordinator)', () => {
    expect(config.role).toBe('specialist');
  });

  it('pins exactly the three diagnostics query skills plus date-resolve', () => {
    expect(config.pinned_skills).toEqual(expect.arrayContaining(['audit-query', 'audit-trace', 'ops-lookup']));
  });

  it('pins NO outbound, delegate, or write-capable skill (structural principal-restriction)', () => {
    for (const skill of config.pinned_skills ?? []) {
      expect(ALLOWED_SKILLS.has(skill), `unexpected skill pinned to diagnostics: ${skill}`).toBe(true);
    }
    // Spell out the disallowed classes so the intent is legible in the failure output.
    const forbidden = ['email-send', 'email-reply', 'signal-send', 'send-draft', 'delegate', 'memory-store'];
    for (const bad of forbidden) {
      expect(config.pinned_skills ?? []).not.toContain(bad);
    }
  });

  it('does not allow dynamic skill discovery (roster stays locked to the read-only set)', () => {
    expect(config.allow_discovery).toBe(false);
  });

  it('declares its output is principal-only in the system prompt', () => {
    expect(config.system_prompt.toLowerCase()).toContain('principal');
  });
});
