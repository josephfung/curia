// escalation-judge.test.ts — unit tests for the escalation-line policy (issue #948).
//
// Three test groups:
//   1. Deterministic policy tables (escalation-policy.ts) — no LLM involved.
//   2. Verdict parsers (escalation-judge-prompt.ts) — pure string parsing.
//   3. EscalationJudge integration (escalation-judge.ts) — mock LLM, fixture set.

import { describe, it, expect, vi } from 'vitest';
import { applyDisclosurePolicy, applyActionPolicy } from './escalation-policy.js';
import { parseDisclosureVerdict, parseActionVerdict } from './escalation-judge-prompt.js';
import { EscalationJudge } from './escalation-judge.js';
import type { EscalationJudgeConfig } from './escalation-judge.js';
import type { LLMProvider, LLMResponse } from '../agents/llm/provider.js';
import type { ContactTier } from '../contacts/types.js';
import { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const silentLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

function fakeBus(): EventBus & { published: unknown[] } {
  const published: unknown[] = [];
  return {
    published,
    publish: vi.fn(async (_topic: string, ev: unknown) => { published.push(ev); }),
  } as unknown as EventBus & { published: unknown[] };
}

function textResponse(content: string): LLMResponse {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5', providerRequestId: 'test' },
  };
}

function providerReturning(response: LLMResponse | Promise<LLMResponse>): LLMProvider {
  return { id: 'fake', chat: vi.fn(async () => response) } as unknown as LLMProvider;
}

const DEFAULT_CONFIG: EscalationJudgeConfig = {
  enabled: true,
  model: 'claude-haiku-4-5',
  timeoutMs: 5000,
};

function makeJudge(provider: LLMProvider, config: Partial<EscalationJudgeConfig> = {}) {
  const bus = fakeBus();
  const registry = new ModelRegistry(silentLogger);
  const judge = new EscalationJudge(provider, { ...DEFAULT_CONFIG, ...config }, bus, silentLogger, registry);
  return { judge, bus };
}

// ---------------------------------------------------------------------------
// 1. Policy table: applyDisclosurePolicy
// ---------------------------------------------------------------------------

describe('applyDisclosurePolicy', () => {
  it('unknown: allows public only', () => {
    expect(applyDisclosurePolicy('unknown', 'public')).toBe('allow');
    expect(applyDisclosurePolicy('unknown', 'principal-context')).toBe('escalate');
    expect(applyDisclosurePolicy('unknown', 'third-party')).toBe('escalate');
    expect(applyDisclosurePolicy('unknown', 'confidential')).toBe('escalate');
  });

  it('known: allows public and principal-context; escalates third-party and confidential', () => {
    expect(applyDisclosurePolicy('known', 'public')).toBe('allow');
    expect(applyDisclosurePolicy('known', 'principal-context')).toBe('allow');
    expect(applyDisclosurePolicy('known', 'third-party')).toBe('escalate');
    expect(applyDisclosurePolicy('known', 'confidential')).toBe('escalate');
  });

  it('trusted: allows all classes including third-party and confidential', () => {
    expect(applyDisclosurePolicy('trusted', 'public')).toBe('allow');
    expect(applyDisclosurePolicy('trusted', 'principal-context')).toBe('allow');
    expect(applyDisclosurePolicy('trusted', 'third-party')).toBe('allow');
    expect(applyDisclosurePolicy('trusted', 'confidential')).toBe('allow');
  });

  it('principal: allows all classes', () => {
    expect(applyDisclosurePolicy('principal', 'public')).toBe('allow');
    expect(applyDisclosurePolicy('principal', 'confidential')).toBe('allow');
    expect(applyDisclosurePolicy('principal', 'third-party')).toBe('allow');
  });

  it('blocked: escalates all classes', () => {
    expect(applyDisclosurePolicy('blocked', 'public')).toBe('escalate');
    expect(applyDisclosurePolicy('blocked', 'confidential')).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// 2. Policy table: applyActionPolicy
// ---------------------------------------------------------------------------

describe('applyActionPolicy', () => {
  it('none and reversible-internal always allow regardless of tier', () => {
    for (const tier of ['unknown', 'known', 'trusted', 'principal'] as const) {
      expect(applyActionPolicy(tier, 'none', false)).toBe('allow');
      expect(applyActionPolicy(tier, 'none', true)).toBe('allow');
      expect(applyActionPolicy(tier, 'reversible-internal', false)).toBe('allow');
      expect(applyActionPolicy(tier, 'reversible-internal', true)).toBe('allow');
    }
  });

  it('unknown: reversible-external escalates regardless of isThirdPartyFacing', () => {
    expect(applyActionPolicy('unknown', 'reversible-external', false)).toBe('escalate');
    expect(applyActionPolicy('unknown', 'reversible-external', true)).toBe('escalate');
  });

  it('known: reply-to-sender (not third-party-facing) is allowed', () => {
    expect(applyActionPolicy('known', 'reversible-external', false)).toBe('allow');
  });

  it('known: third-party-facing reversible-external escalates', () => {
    expect(applyActionPolicy('known', 'reversible-external', true)).toBe('escalate');
  });

  it('trusted: reversible-external always allowed', () => {
    expect(applyActionPolicy('trusted', 'reversible-external', false)).toBe('allow');
    expect(applyActionPolicy('trusted', 'reversible-external', true)).toBe('allow');
  });

  it('irreversible always escalates unless principal', () => {
    expect(applyActionPolicy('unknown', 'irreversible', false)).toBe('escalate');
    expect(applyActionPolicy('known', 'irreversible', false)).toBe('escalate');
    expect(applyActionPolicy('trusted', 'irreversible', false)).toBe('escalate');
  });

  it('principal allows everything including irreversible', () => {
    expect(applyActionPolicy('principal', 'reversible-external', true)).toBe('allow');
    expect(applyActionPolicy('principal', 'irreversible', true)).toBe('allow');
  });

  it('blocked escalates everything', () => {
    expect(applyActionPolicy('blocked', 'none', false)).toBe('escalate');
    expect(applyActionPolicy('blocked', 'reversible-internal', false)).toBe('escalate');
    expect(applyActionPolicy('blocked', 'reversible-external', false)).toBe('escalate');
    expect(applyActionPolicy('blocked', 'irreversible', false)).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// 3. Verdict parsers
// ---------------------------------------------------------------------------

describe('parseDisclosureVerdict', () => {
  it('parses a valid disclosure verdict', () => {
    expect(parseDisclosureVerdict('{"class": "public", "reason": "scheduling only"}')).toEqual({
      class: 'public',
      reason: 'scheduling only',
    });
  });

  it('parses all four disclosure classes', () => {
    for (const cls of ['public', 'principal-context', 'third-party', 'confidential'] as const) {
      const result = parseDisclosureVerdict(`{"class": "${cls}", "reason": "x"}`);
      expect(result?.class).toBe(cls);
    }
  });

  it('tolerates a markdown code fence', () => {
    const result = parseDisclosureVerdict('```json\n{"class": "confidential", "reason": "financials"}\n```');
    expect(result?.class).toBe('confidential');
  });

  it('returns null for an unknown class', () => {
    expect(parseDisclosureVerdict('{"class": "secret", "reason": "x"}')).toBeNull();
  });

  it('returns null for missing class', () => {
    expect(parseDisclosureVerdict('{"reason": "x"}')).toBeNull();
  });

  it('defaults reason to empty string when missing', () => {
    expect(parseDisclosureVerdict('{"class": "public"}')).toEqual({ class: 'public', reason: '' });
  });

  it('returns null for entirely invalid JSON', () => {
    expect(parseDisclosureVerdict('not json')).toBeNull();
  });
});

describe('parseActionVerdict', () => {
  it('parses a valid action verdict', () => {
    expect(parseActionVerdict('{"class": "reversible-external", "isThirdPartyFacing": true, "reason": "sends email to new contact"}')).toEqual({
      class: 'reversible-external',
      isThirdPartyFacing: true,
      reason: 'sends email to new contact',
    });
  });

  it('parses all four action classes', () => {
    for (const cls of ['none', 'reversible-internal', 'reversible-external', 'irreversible'] as const) {
      const result = parseActionVerdict(`{"class": "${cls}", "isThirdPartyFacing": false, "reason": "x"}`);
      expect(result?.class).toBe(cls);
    }
  });

  it('returns null when isThirdPartyFacing is not a boolean', () => {
    expect(parseActionVerdict('{"class": "none", "isThirdPartyFacing": "yes", "reason": "x"}')).toBeNull();
  });

  it('returns null when isThirdPartyFacing is null', () => {
    expect(parseActionVerdict('{"class": "none", "isThirdPartyFacing": null, "reason": "x"}')).toBeNull();
  });

  it('returns null for an unknown action class', () => {
    expect(parseActionVerdict('{"class": "dangerous", "isThirdPartyFacing": false, "reason": "x"}')).toBeNull();
  });

  it('tolerates a markdown code fence', () => {
    const result = parseActionVerdict('```json\n{"class": "irreversible", "isThirdPartyFacing": false, "reason": "payment"}\n```');
    expect(result?.class).toBe('irreversible');
  });

  it('does not end the object early on a brace inside the reason string', () => {
    const result = parseActionVerdict('{"class": "none", "isThirdPartyFacing": false, "reason": "action contains } brace"} trailing');
    expect(result).toEqual({ class: 'none', isThirdPartyFacing: false, reason: 'action contains } brace' });
  });
});

describe('parseDisclosureVerdict brace-in-string edge case', () => {
  it('does not end the object early on a brace inside the reason string', () => {
    const result = parseDisclosureVerdict('{"class": "public", "reason": "see {appendix} for context"} trailing');
    expect(result).toEqual({ class: 'public', reason: 'see {appendix} for context' });
  });
});

// ---------------------------------------------------------------------------
// 4. EscalationJudge.classifyDisclosure — fixture set + failure modes
// ---------------------------------------------------------------------------

describe('EscalationJudge.classifyDisclosure', () => {
  it('allows public content to an unknown-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "public", "reason": "scheduling only"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "Best to reach Joseph by email this week.",
      recipientTier: 'unknown',
      conversationId: 'conv-1',
    });
    expect(result.decision).toBe('allow');
    expect(result.disclosureClass).toBe('public');
  });

  it('escalates principal-context content to an unknown-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "principal-context", "reason": "reveals availability"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "Joseph is travelling to New York this week.",
      recipientTier: 'unknown',
      conversationId: 'conv-2',
    });
    expect(result.decision).toBe('escalate');
    expect(result.disclosureClass).toBe('principal-context');
  });

  it('allows principal-context to a known-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "principal-context", "reason": "light context"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "He prefers calls after 10am.",
      recipientTier: 'known',
      conversationId: 'conv-3',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates third-party info to a known-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "third-party", "reason": "reveals another contact"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "Sarah mentioned she is moving to Chicago.",
      recipientTier: 'known',
      conversationId: 'conv-4',
    });
    expect(result.decision).toBe('escalate');
    expect(result.disclosureClass).toBe('third-party');
  });

  it('allows third-party info to a trusted-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "third-party", "reason": "another contact detail"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "Hamilton’s budget is around $50k.",
      recipientTier: 'trusted',
      conversationId: 'conv-5',
    });
    expect(result.decision).toBe('allow');
  });

  it('allows confidential content to a trusted-tier recipient', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "confidential", "reason": "financial detail"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "The Q3 revenue target is $2M.",
      recipientTier: 'trusted',
      conversationId: 'conv-6',
    });
    expect(result.decision).toBe('allow');
  });

  it('always allows disclosure to the principal tier', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "confidential", "reason": "board info"}')),
    );
    const result = await judge.classifyDisclosure({
      content: "Board deck attached.",
      recipientTier: 'principal',
      conversationId: 'conv-7',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates when disabled', async () => {
    const provider = providerReturning(textResponse('{"class": "public", "reason": ""}'));
    const { judge } = makeJudge(provider, { enabled: false });
    const result = await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'principal',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('escalates on provider timeout', async () => {
    const slowProvider = {
      id: 'slow',
      chat: vi.fn(() => new Promise<LLMResponse>((resolve) =>
        setTimeout(() => resolve(textResponse('{"class":"public","reason":""}')), 50),
      )),
    } as unknown as LLMProvider;
    const { judge } = makeJudge(slowProvider, { timeoutMs: 5 });
    const result = await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'unknown',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
    expect(result.reason).toMatch(/timed out/);
  });

  it('escalates on provider error', async () => {
    const errorResponse: LLMResponse = { type: 'error', error: { message: 'boom' } as never };
    const { judge } = makeJudge(providerReturning(errorResponse));
    const result = await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'unknown',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });

  it('escalates on malformed verdict', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('not json at all')));
    const result = await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'unknown',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
    expect(result.reason).toMatch(/malformed/);
  });

  it('aborts the in-flight provider call on timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    const provider = {
      id: 'capture',
      chat: vi.fn((params: { options?: { signal?: AbortSignal } }) => {
        capturedSignal = params.options?.signal;
        return new Promise<LLMResponse>((resolve) =>
          setTimeout(() => resolve(textResponse('{"class":"public","reason":""}')), 50),
        );
      }),
    } as unknown as LLMProvider;
    const { judge } = makeJudge(provider, { timeoutMs: 5 });
    await judge.classifyDisclosure({ content: 'hello', recipientTier: 'unknown', conversationId: '' });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('publishes one llm.call telemetry event on a successful verdict', async () => {
    const { judge, bus } = makeJudge(
      providerReturning(textResponse('{"class": "public", "reason": "fine"}')),
    );
    await judge.classifyDisclosure({ content: 'hello', recipientTier: 'unknown', conversationId: 'c1' });
    const events = (bus as unknown as { published: Array<{ type: string }> }).published.filter((e) => e.type === 'llm.call');
    expect(events).toHaveLength(1);
  });

  it('does not publish telemetry on timeout (no model response)', async () => {
    const slowProvider = {
      id: 'slow',
      chat: vi.fn(() => new Promise<LLMResponse>(() => { /* never resolves */ })),
    } as unknown as LLMProvider;
    const { judge, bus } = makeJudge(slowProvider, { timeoutMs: 5 });
    await judge.classifyDisclosure({ content: 'hello', recipientTier: 'unknown', conversationId: '' });
    const events = (bus as unknown as { published: Array<{ type: string }> }).published.filter((e) => e.type === 'llm.call');
    expect(events).toHaveLength(0);
  });

  it('escalates without throwing when passed an unrecognized tier value', async () => {
    // Validates fail-closed behavior when an invalid tier reaches the policy functions
    // (e.g. a future DB-side tier value before a code deployment). The policy guard
    // returns 'escalate' rather than throwing; the judge's try/catch catches any throw
    // that does escape.
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "public", "reason": "fine"}')),
    );
    const result = await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'invalid-tier' as unknown as ContactTier,
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// 5. EscalationJudge.classifyAction — fixture set + failure modes
// ---------------------------------------------------------------------------

describe('EscalationJudge.classifyAction', () => {
  it('allows a read-only action from an unknown-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "none", "isThirdPartyFacing": false, "reason": "read only"}')),
    );
    const result = await judge.classifyAction({
      description: 'Look up Joseph’s calendar for next Tuesday.',
      initiatingTier: 'unknown',
      conversationId: 'a-1',
    });
    expect(result.decision).toBe('allow');
    expect(result.actionClass).toBe('none');
  });

  it('allows drafting from an unknown-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-internal", "isThirdPartyFacing": false, "reason": "draft only"}')),
    );
    const result = await judge.classifyAction({
      description: 'Draft a reply to this email but do not send it.',
      initiatingTier: 'unknown',
      conversationId: 'a-2',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates an external send from an unknown-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-external", "isThirdPartyFacing": false, "reason": "sending email"}')),
    );
    const result = await judge.classifyAction({
      description: 'Reply to this email confirming the meeting.',
      initiatingTier: 'unknown',
      conversationId: 'a-3',
    });
    expect(result.decision).toBe('escalate');
  });

  it('allows a reply-to-sender from a known-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-external", "isThirdPartyFacing": false, "reason": "reply to sender"}')),
    );
    const result = await judge.classifyAction({
      description: 'Reply to Armin confirming Thursday works.',
      initiatingTier: 'known',
      conversationId: 'a-4',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates a third-party-facing action from a known-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-external", "isThirdPartyFacing": true, "reason": "invites a third party"}')),
    );
    const result = await judge.classifyAction({
      description: 'Book a meeting room and invite the full team.',
      initiatingTier: 'known',
      conversationId: 'a-5',
    });
    expect(result.decision).toBe('escalate');
  });

  it('allows third-party-facing external action from a trusted-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-external", "isThirdPartyFacing": true, "reason": "external invite"}')),
    );
    const result = await judge.classifyAction({
      description: 'Send the board the updated agenda.',
      initiatingTier: 'trusted',
      conversationId: 'a-6',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates an irreversible action from a trusted-tier contact', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "irreversible", "isThirdPartyFacing": false, "reason": "payment"}')),
    );
    const result = await judge.classifyAction({
      description: 'Process the $500 invoice payment.',
      initiatingTier: 'trusted',
      conversationId: 'a-7',
    });
    expect(result.decision).toBe('escalate');
  });

  it('allows irreversible action from the principal tier', async () => {
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "irreversible", "isThirdPartyFacing": false, "reason": "payment initiated by CEO"}')),
    );
    const result = await judge.classifyAction({
      description: 'Transfer $10,000 to the vendor account.',
      initiatingTier: 'principal',
      conversationId: 'a-8',
    });
    expect(result.decision).toBe('allow');
  });

  it('escalates when disabled', async () => {
    const provider = providerReturning(textResponse('{"class": "none", "isThirdPartyFacing": false, "reason": ""}'));
    const { judge } = makeJudge(provider, { enabled: false });
    const result = await judge.classifyAction({
      description: 'lookup',
      initiatingTier: 'principal',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('escalates on provider timeout', async () => {
    const slowProvider = {
      id: 'slow',
      chat: vi.fn(() => new Promise<LLMResponse>((resolve) =>
        setTimeout(() => resolve(textResponse('{"class":"none","isThirdPartyFacing":false,"reason":""}')), 50),
      )),
    } as unknown as LLMProvider;
    const { judge } = makeJudge(slowProvider, { timeoutMs: 5 });
    const result = await judge.classifyAction({
      description: 'lookup',
      initiatingTier: 'unknown',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });

  it('escalates on malformed verdict', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('{"class": "unknown-class", "isThirdPartyFacing": true}')));
    const result = await judge.classifyAction({
      description: 'do something',
      initiatingTier: 'trusted',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });

  it('aborts the in-flight provider call on timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    const provider = {
      id: 'capture',
      chat: vi.fn((params: { options?: { signal?: AbortSignal } }) => {
        capturedSignal = params.options?.signal;
        return new Promise<LLMResponse>((resolve) =>
          setTimeout(() => resolve(textResponse('{"class":"none","isThirdPartyFacing":false,"reason":""}')), 50),
        );
      }),
    } as unknown as LLMProvider;
    const { judge } = makeJudge(provider, { timeoutMs: 5 });
    await judge.classifyAction({ description: 'lookup', initiatingTier: 'unknown', conversationId: '' });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('escalates on provider error', async () => {
    const errorResponse: LLMResponse = { type: 'error', error: { message: 'api down' } as never };
    const { judge } = makeJudge(providerReturning(errorResponse));
    const result = await judge.classifyAction({
      description: 'do something',
      initiatingTier: 'unknown',
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });

  it('escalates without throwing when policy throws on unrecognized tier value', async () => {
    // An unrecognized tier causes meetsMinimumTier() to throw inside applyActionPolicy.
    // The judge's try/catch must catch that and return escalate rather than propagating.
    const { judge } = makeJudge(
      providerReturning(textResponse('{"class": "reversible-external", "isThirdPartyFacing": false, "reason": "test"}')),
    );
    const result = await judge.classifyAction({
      description: 'do something',
      initiatingTier: 'invalid-tier' as unknown as ContactTier,
      conversationId: '',
    });
    expect(result.decision).toBe('escalate');
  });
});
