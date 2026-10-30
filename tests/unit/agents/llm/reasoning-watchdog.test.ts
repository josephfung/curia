import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  watchdogLimits,
  forcedAttemptMessage,
  estimateReasoningTokens,
  FORCED_REASONING_TAIL_CHARS,
  WATCHDOG_REQUEST_TIMEOUT_MS,
} from '../../../../src/agents/llm/reasoning-watchdog.js';
import { OPENROUTER_REQUEST_TIMEOUT_MS } from '../../../../src/agents/llm/openrouter.js';

describe('watchdog module dependencies', () => {
  const llmDir = path.join(import.meta.dirname, '../../../../src/agents/llm');
  it.each(['reasoning-watchdog.ts', 'reasoning-watchdog-provider.ts'])(
    '%s imports no concrete provider module',
    (file) => {
      const source = fs.readFileSync(path.join(llmDir, file), 'utf8');
      expect(source).not.toMatch(/from '\.\/(openrouter|anthropic|bedrock)\.js'/);
    },
  );
  it('measures against the same request timeout OpenRouter uses', () => {
    expect(WATCHDOG_REQUEST_TIMEOUT_MS).toBe(OPENROUTER_REQUEST_TIMEOUT_MS);
    expect(WATCHDOG_REQUEST_TIMEOUT_MS).toBe(600_000);
  });
});

describe('estimateReasoningTokens', () => {
  it('returns the delta count when it is the higher figure', () => {
    expect(estimateReasoningTokens(12, 30)).toBe(12);
  });
  it('returns ceil(chars / 3) when that is higher', () => {
    expect(estimateReasoningTokens(5, 30)).toBe(10);
    expect(estimateReasoningTokens(1, 31)).toBe(11);
  });
  it('is zero when no reasoning arrived', () => {
    expect(estimateReasoningTokens(0, 0)).toBe(0);
  });
});

describe('watchdogLimits', () => {
  it('fires tokens at half the call cap', () => {
    expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0 }).tokenThreshold).toBe(16_384);
    expect(watchdogLimits({ maxTokens: 4_000, callStartMs: 0 }).tokenThreshold).toBe(2_000);
  });
  it('fires time at half the window before the deadline, after the reserve', () => {
    // window = min(563s, 600s) - 60s = 503s → fire at 251.5s
    expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 1_000, deadlineAt: 564_000 }).fireAtMs).toBe(252_500);
  });
  it('caps the window at the request timeout when the deadline is further out', () => {
    expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 4_500_000 }).fireAtMs).toBe(270_000);
  });
  it('falls back to the request timeout when the deadline is past or inside the reserve', () => {
    expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 100_000, deadlineAt: 90_000 }).fireAtMs).toBe(370_000);
    expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 59_000 }).fireAtMs).toBe(270_000);
  });
});

describe('forcedAttemptMessage', () => {
  it('puts the marker first, the tail of the reasoning, then the act-now instruction', () => {
    const msg = forcedAttemptMessage('x'.repeat(20_000) + 'END');
    expect(msg.startsWith('[Runtime note from Curia, not from the principal]\n')).toBe(true);
    expect(msg).toContain('END');
    expect(msg).not.toContain('x'.repeat(FORCED_REASONING_TAIL_CHARS + 1));
    expect(msg).toContain('Take your next step now: call the tool you need, or write your reply.');
  });
  it('still asks to act when there is no reasoning text', () => {
    const msg = forcedAttemptMessage('');
    expect(msg).toContain('Take your next step now');
    expect(msg).not.toContain('<previous_reasoning>');
  });
  it('forced message with no reasoning omits the "below" sentence', () => {
    expect(forcedAttemptMessage('')).toBe(
      [
        '[Runtime note from Curia, not from the principal]',
        'Your previous attempt at this step was stopped after a long stretch of reasoning with no action.',
        'You have already thought this through. Do not start over or re-derive it.',
        'Take your next step now: call the tool you need, or write your reply.',
      ].join('\n'),
    );
  });
});
