// Integration test for the outbound LLM audience-leak judge (spec 17 / task 7).
//
// Gated on ANTHROPIC_API_KEY — the suite is skipped entirely in keyless CI.
// When the key is present, the tests fire real Haiku calls and assert that:
//   1. The verbatim 2026-06-01 leak body is flagged when a third party is present.
//   2. A clean professional reply passes without a finding.
//   3. Principal-sole messages are short-circuited (no model call, always []).
//
// Model: claude-haiku-4-5 — cheapest Anthropic model, fast enough for CI parity.

import { describe, it, expect } from 'vitest';
import { OutboundLlmJudge } from '../../src/dispatch/outbound-judge.js';
import { AnthropicProvider } from '../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../src/agents/llm/model-registry.js';
import type { EventBus } from '../../src/bus/bus.js';
import { createSilentLogger } from '../../src/logger.js';

const RUN = !!process.env.ANTHROPIC_API_KEY;

const logger = createSilentLogger();
// Minimal bus stub — the judge only calls bus.publish() for telemetry, which is
// fire-and-forget and non-critical for these integration assertions.
const bus = { publish: async () => {} } as unknown as EventBus;

const armin = { email: 'armin@external.com', isPrincipal: false };
const principal = { email: 'ceo@example.com', isPrincipal: true };

// The verbatim 2026-06-01 4:38 PM leak body — an agent message that addresses both
// an external third party (Armin) and the CEO in the same body, leaking side-channel
// status ("backend issues", "I'll keep an eye on it") to a non-principal audience.
const LEAK_BODY = [
  "Backend issues are preventing me from creating the calendar invite right now. Let me confirm with Armin and I'll circle back with the CEO about the invite.",
  '',
  "Armin — Friday June 5 at 2 PM works. Consider it locked in. I'll get a calendar invite over to you shortly.",
  '',
  "To the CEO: Both contacts and calendar specialists are returning errors — looks like a backend issue. I've confirmed Friday June 5 at 2 PM with Armin for coffee, but I'll need to get that invite out once things are back up. I'll keep an eye on it.",
].join('\n');

const CLEAN_BODY = "Friday June 5 at 2 PM works. I'll send a calendar invite shortly.";

function judge() {
  const registry = new ModelRegistry(logger);
  const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, logger, registry);
  return new OutboundLlmJudge(
    provider,
    { enabled: true, model: 'claude-haiku-4-5', timeoutMs: 15000, failMode: 'split' },
    bus,
    logger,
    registry,
  );
}

describe.skipIf(!RUN)('OutboundLlmJudge integration (real model)', () => {
  it('flags the leak body to a third party (no principal)', async () => {
    const findings = await judge().review({
      content: LEAK_BODY,
      recipients: [armin],
      principalIncluded: false,
      principalIsSoleRecipient: false,
      conversationId: '',
      channelId: 'email',
    });
    expect(findings.some((x) => x.rule === 'llm-judge-audience-leak')).toBe(true);
  }, 20000);

  it("flags the leak body even when the principal is CC'd (third party still reads it)", async () => {
    const findings = await judge().review({
      content: LEAK_BODY,
      recipients: [armin, principal],
      principalIncluded: true,
      principalIsSoleRecipient: false,
      conversationId: '',
      channelId: 'email',
    });
    expect(findings.some((x) => x.rule === 'llm-judge-audience-leak')).toBe(true);
  }, 20000);

  it('skips entirely when the principal is the sole recipient', async () => {
    const findings = await judge().review({
      content: LEAK_BODY,
      recipients: [principal],
      principalIncluded: true,
      principalIsSoleRecipient: true,
      conversationId: '',
      channelId: 'email',
    });
    // No model call is made — the judge short-circuits and returns [] immediately.
    expect(findings).toEqual([]);
  }, 20000);

  it('passes a clean professional reply to a third party', async () => {
    const findings = await judge().review({
      content: CLEAN_BODY,
      recipients: [armin],
      principalIncluded: false,
      principalIsSoleRecipient: false,
      conversationId: '',
      channelId: 'email',
    });
    expect(findings).toEqual([]);
  }, 20000);
});
