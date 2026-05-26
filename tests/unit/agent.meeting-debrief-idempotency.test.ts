// tests/unit/agent.meeting-debrief-idempotency.test.ts
//
// Guards against regression of #724 (5 duplicate Bullpen prompts for the same
// meeting on 2026-05-26). Verifies that the meeting-debrief system prompt
// contains the config-store idempotency check in Step 6: check before posting,
// skip if already sent, write the key after a successful post, and handle write
// failures gracefully.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

let step6: string;

beforeAll(() => {
  const agentPath = path.resolve(import.meta.dirname, '../../agents/meeting-debrief.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(agentPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot load meeting-debrief.yaml from ${agentPath}: ${(err as Error).message}. ` +
      `Is the test running from the repo root?`,
    );
  }
  const parsed = yaml.load(raw) as Record<string, unknown>;
  if (typeof parsed.system_prompt !== 'string') {
    throw new Error('meeting-debrief.yaml is missing a system_prompt string field');
  }
  const prompt = parsed.system_prompt;

  const start = prompt.indexOf('## Step 6');
  const end = prompt.indexOf('## Step 7');
  if (start === -1 || end === -1) {
    throw new Error('Step 6 or Step 7 heading not found in system_prompt — was a heading renamed?');
  }
  step6 = prompt.slice(start, end);
  if (step6.length < 50) {
    throw new Error(`Step 6 section is suspiciously short (${step6.length} chars) — may have been truncated`);
  }
});

describe('meeting-debrief idempotency guard (issue #724)', () => {
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
    // Skipping must be explicitly tied to the found: true condition, not just any
    // use of the word "skip". Matches "If `found: true`" / "if found" constructs only.
    expect(step6).toMatch(/found.*true|if.*found|already.*prompted/i);
  });

  it('instructs the agent to write the idempotency key to config-store after the post, not before', () => {
    // The store must come AFTER the bullpen post — writing before would create a phantom
    // key that blocks all future posts if the bullpen call then fails.
    expect(step6).toMatch(/action.*['"']store['"']|store.*prompted:|prompted:.*store/i);
    const idxPost = step6.search(/"post"/);
    const idxStore = step6.search(/action.*['"']store['"']/);
    expect(idxPost).toBeGreaterThan(-1);
    expect(idxStore).toBeGreaterThan(idxPost);
  });

  it('includes thread_id in the stored idempotency value', () => {
    // The stored value must include the thread_id so a future debug session can
    // trace which Bullpen thread was the canonical one.
    expect(step6).toMatch(/thread_id/);
  });

  it('instructs the agent to handle a failed config-store write without retrying the Bullpen post', () => {
    // If the idempotency key write fails, the agent must NOT retry the bullpen post.
    // Without this guard, a write failure defeats the entire duplicate-prevention mechanism.
    expect(step6).toMatch(/stored.*false|store.*fail|success.*false|not.*persist|key.*not.*persisted|may not.*persist/i);
    // Separately verify the no-retry instruction exists. A prompt that acknowledges write
    // failure but still retries defeats the guard; this catches that regression.
    expect(step6).toMatch(/do not retry|not retry|no.*retry/i);
  });
});
