// tests/unit/agent.meeting-debrief-idempotency.test.ts
//
// Guards against regression of #724 (5 duplicate Bullpen prompts for the same
// meeting on 2026-05-26). Verifies that the meeting-debrief system prompt
// contains the config-store idempotency check in Step 6: check before posting,
// skip if already sent, write the key after a successful post.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

function loadSystemPrompt(): string {
  const agentPath = path.resolve(import.meta.dirname, '../../agents/meeting-debrief.yaml');
  const raw = fs.readFileSync(agentPath, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  if (typeof parsed.system_prompt !== 'string') {
    throw new Error('meeting-debrief.yaml missing system_prompt string');
  }
  return parsed.system_prompt;
}

function extractStep6Section(prompt: string): string {
  const start = prompt.indexOf('## Step 6');
  const end = prompt.indexOf('## Step 7');
  if (start === -1 || end === -1) {
    throw new Error('Step 6 or Step 7 section not found in system prompt');
  }
  return prompt.slice(start, end);
}

describe('meeting-debrief idempotency guard (issue #724)', () => {
  let step6: string;

  beforeEach(() => {
    step6 = extractStep6Section(loadSystemPrompt());
  });

  it('checks config-store for prompted:<eventId> key before opening a Bullpen thread', () => {
    // The idempotency key must be referenced before the bullpen "post" action in Step 6.
    // If this fails, the agent can post duplicate threads on the same calendar event.
    expect(step6).toMatch(/prompted:/);
    const idxKey = step6.indexOf('prompted:');
    const idxPost = step6.search(/"post"/);
    expect(idxPost).toBeGreaterThan(-1);
    expect(idxKey).toBeLessThan(idxPost);
  });

  it('instructs the agent to skip posting when the idempotency key is already present', () => {
    // Prevents re-posting to Bullpen when config-store already has the prompted: key.
    expect(step6).toMatch(/found.*true|if.*found|already.*prompted|skip|do not post/i);
  });

  it('instructs the agent to write the idempotency key to config-store after a successful post', () => {
    // Without this, the guard is useless on the very next tick after the first post.
    expect(step6).toMatch(/action.*['"']store['"']|store.*prompted:|prompted:.*store/i);
  });

  it('includes thread_id in the stored idempotency value', () => {
    // The stored value must include the thread_id so a future debug session can
    // trace which Bullpen thread was the canonical one.
    expect(step6).toMatch(/thread_id/);
  });
});
