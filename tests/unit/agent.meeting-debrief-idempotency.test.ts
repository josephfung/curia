// tests/unit/agent.meeting-debrief-idempotency.test.ts
//
// Guards against regression of #724 (5 duplicate Bullpen prompts for the same
// meeting on 2026-05-26). Verifies that the meeting-debrief system prompt reads
// the prompted:<eventId> guard before Step 6 posts (the wake's phase derivation,
// #839, which replaced Step 6's own re-check in #2025), writes the key after a
// successful post, and handles write failures gracefully. The behavior is covered
// by scenario cases 32b and 32h.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

let step6: string;
let wakeDerivation: string;

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
  const wakeStart = prompt.indexOf('# TASK WAKE-UP MODE');
  if (wakeStart === -1 || wakeStart > start) {
    throw new Error('TASK WAKE-UP MODE heading not found before Step 6 — was a heading renamed?');
  }
  wakeDerivation = prompt.slice(wakeStart, start);
  if (step6.length < 50) {
    throw new Error(`Step 6 section is suspiciously short (${step6.length} chars) — may have been truncated`);
  }
});

describe('meeting-debrief idempotency guard (issue #724)', () => {
  it('derives the phase from prompted:<eventId> before Step 6 opens a Bullpen thread', () => {
    // A wake reaches Step 6 (the post) only when prompted:<eventId> is absent; when it
    // is present the wake goes to Step 7 instead. If this fails, a resent wake can post
    // a duplicate prompt for the same calendar event.
    expect(wakeDerivation).toMatch(/`prompted:<eventId>` absent → \*\*Step 6\*\*/);
    expect(wakeDerivation).toMatch(/`prompted:` present[^\n]*→ \*\*Step 7\*\*/);
  });

  it('instructs the agent to write the idempotency key to config-store after the post, not before', () => {
    // The store must come AFTER the bullpen post — writing before would create a phantom
    // key that blocks all future posts if the bullpen call then fails.
    expect(step6).toMatch(/action.*['"']store['"']|store.*prompted:|prompted:.*store/i);
    const idxPost = step6.indexOf('`bullpen-post` with');
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
