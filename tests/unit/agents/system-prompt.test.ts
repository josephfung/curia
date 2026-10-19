// buildBaseSystemPrompt: the per-turn verification block (#2017). It is injected for the
// coordinator and ceo-inbox only, rebuilt each turn, and never allowed to fail the turn.

import { describe, expect, it, vi } from 'vitest';
import { buildBaseSystemPrompt, type SystemPromptSources } from '../../../src/agents/system-prompt.js';
import { createLogger } from '../../../src/logger.js';
import type { Verification } from '../../../src/verification/types.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';

const NOW = new Date('2026-10-19T14:05:00Z');
const logger = createLogger('silent');

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: 'ver-1',
    purpose: 'sign_in',
    kind: 'code',
    delivery: 'sms',
    site: 'aircanada.com',
    pageDomain: 'b2clogin.com',
    browserSessionId: 'sess-aaa',
    taskId: 'task-42',
    conversationId: 'conv-1',
    status: 'pending',
    requestedAt: new Date('2026-10-19T14:00:00Z'),
    expiresAt: new Date('2026-10-19T14:10:00Z'),
    resolvedAt: null,
    metadata: {},
    ...overrides,
  };
}

function runtime(rows: Verification[], askChannel: string | null = 'signal'): VerificationRuntime {
  return {
    listActive: vi.fn(async () => rows),
    askChannel: () => askChannel,
    service: { config: { emailWaitSeconds: 180 } },
  } as unknown as VerificationRuntime;
}

function sources(agentId: string, rows: Verification[], extra: Partial<SystemPromptSources> = {}): SystemPromptSources {
  return {
    agentId,
    systemPrompt: 'Body.',
    timezone: 'America/Toronto',
    verification: runtime(rows),
    browserSessionAlive: (id: string) => id === 'sess-aaa',
    ...extra,
  };
}

describe('buildBaseSystemPrompt verification block', () => {
  it('coordinator prompt includes the block when a verification is pending', async () => {
    const prompt = await buildBaseSystemPrompt(sources('coordinator', [verification()]), { now: NOW, logger });
    expect(prompt).toContain('aircanada.com: sms, pending, session sess-aaa alive');
    expect(prompt).toContain('on signal');
  });

  it('marks the session gone when the liveness lookup says so', async () => {
    const prompt = await buildBaseSystemPrompt(
      sources('coordinator', [verification()], { browserSessionAlive: () => false }),
      { now: NOW, logger },
    );
    expect(prompt).toContain('session sess-aaa gone');
  });

  it('treats every session as gone when no liveness lookup is wired', async () => {
    const prompt = await buildBaseSystemPrompt(
      sources('coordinator', [verification()], { browserSessionAlive: undefined }),
      { now: NOW, logger },
    );
    expect(prompt).toContain('session sess-aaa gone');
  });

  it('injects nothing when no verification is active', async () => {
    const prompt = await buildBaseSystemPrompt(sources('coordinator', []), { now: NOW, logger });
    expect(prompt).not.toContain('sign-in');
  });

  it('ceo-inbox gets the email-delivery block only', async () => {
    const rows = [
      verification({ delivery: 'email' }),
      verification({ id: 'ver-2', delivery: 'sms', site: 'rbc.com' }),
    ];
    const prompt = await buildBaseSystemPrompt(sources('ceo-inbox', rows), { now: NOW, logger });
    expect(prompt).toContain('Pending sign-in code from aircanada.com');
    expect(prompt).not.toContain('rbc.com');
    // The coordinator's rules are not ceo-inbox's.
    expect(prompt).not.toContain('Enter a code only in the session and site listed.');
  });

  it('contacts agent prompt never includes it, even if handed a runtime', async () => {
    const lookup = runtime([verification({ delivery: 'email' })]);
    const prompt = await buildBaseSystemPrompt(
      sources('contacts', [], { verification: lookup }),
      { now: NOW, logger },
    );
    expect(prompt).not.toContain('aircanada.com');
    expect(lookup.listActive).not.toHaveBeenCalled();
  });

  it('places the block after the autonomy block and before the date guardrail', async () => {
    const autonomyService = {
      getConfig: async () => ({ score: 80 }),
    } as unknown as SystemPromptSources['autonomyService'];
    const prompt = await buildBaseSystemPrompt(
      sources('coordinator', [verification()], { autonomyService }),
      { now: NOW, logger },
    );
    expect(prompt.indexOf('## Sign-in verifications')).toBeLessThan(prompt.indexOf('### Date & time'));
  });

  it('omits the block, without failing the turn, when listActive throws', async () => {
    const failing = {
      listActive: async () => { throw new Error('verifications table unreadable'); },
      askChannel: () => null,
      service: { config: { emailWaitSeconds: 180 } },
    } as unknown as VerificationRuntime;
    const prompt = await buildBaseSystemPrompt(
      sources('coordinator', [], { verification: failing }),
      { now: NOW, logger },
    );
    expect(prompt.startsWith('Body.')).toBe(true);
    expect(prompt).not.toContain('Sign-in verifications');
  });

  it('throws for a render when listActive throws, so a partial prompt is never printed', async () => {
    const failing = {
      listActive: async () => { throw new Error('verifications table unreadable'); },
      askChannel: () => null,
      service: { config: { emailWaitSeconds: 180 } },
    } as unknown as VerificationRuntime;
    await expect(
      buildBaseSystemPrompt(sources('coordinator', [], { verification: failing }), {
        now: NOW,
        logger,
        onBlockError: 'throw',
      }),
    ).rejects.toThrow(/block 'verification' failed for agent 'coordinator'/);
  });
});
