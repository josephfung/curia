// buildBaseSystemPrompt: the per-turn verification block (#2017). It is injected for the
// coordinator and ceo-inbox only, rebuilt each turn, and never allowed to fail the turn.

import { describe, expect, it, vi } from 'vitest';
import {
  buildBaseSystemPrompt,
  buildPerTurnSystemPromptSuffix,
  buildStableSystemPromptPrefix,
  type SystemPromptSources,
} from '../../../src/agents/system-prompt.js';
import { createLogger } from '../../../src/logger.js';
import type { Verification } from '../../../src/verification/types.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../../src/agents/prompts/date-resolve-guardrail.js';

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

describe('stable vs per-turn system prompt split (#2764)', () => {
  it('keeps the date guardrail in the stable prefix and autonomy/time in the suffix', async () => {
    const autonomyService = {
      getConfig: async () => ({
        score: 75,
        band: 'spot-check',
        updatedAt: NOW,
        updatedBy: 'test',
      }),
    } as unknown as SystemPromptSources['autonomyService'];
    const src = sources('coordinator', [verification()], {
      autonomyService,
      skillList: [{ name: 'notes', description: 'notes' }],
    });
    const opts = { now: NOW, logger };
    const stable = await buildStableSystemPromptPrefix(src, opts);
    const perTurn = await buildPerTurnSystemPromptSuffix(src, opts);

    expect(stable).toContain(DATE_RESOLVE_GUARDRAIL.split('\n')[0]!);
    expect(stable).toContain('## Skills');
    expect(stable).not.toContain('## Autonomy Level');
    expect(stable).not.toContain('## Current Date & Time');
    expect(stable).not.toContain('## Sign-in verifications');
    expect(stable).not.toContain('## Turn budget');

    expect(perTurn).toContain('## Autonomy Level');
    expect(perTurn).toContain('## Sign-in verifications');
    expect(perTurn).toContain('## Current Date & Time');
    expect(perTurn).toContain('## Turn budget');
    expect(perTurn).not.toContain(DATE_RESOLVE_GUARDRAIL.split('\n')[0]!);

    const combined = await buildBaseSystemPrompt(src, opts);
    expect(combined).toBe(stable + perTurn);
  });
});

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

  it('places the block after the date guardrail and after the autonomy block (#2764)', async () => {
    const autonomyService = {
      getConfig: async () => ({
        score: 80,
        band: 'spot-check',
        updatedAt: NOW,
        updatedBy: 'test',
      }),
    } as unknown as SystemPromptSources['autonomyService'];
    const prompt = await buildBaseSystemPrompt(
      sources('coordinator', [verification()], { autonomyService }),
      { now: NOW, logger },
    );
    // Date guardrail is in the stable prefix; autonomy + verifications are per-turn.
    expect(prompt.indexOf('### Date & time')).toBeLessThan(prompt.indexOf('## Autonomy Level'));
    expect(prompt.indexOf('## Autonomy Level')).toBeLessThan(prompt.indexOf('## Sign-in verifications'));
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

// ## Your Contact Details labels each number by channel: Signal and SMS/voice are
// separate accounts, and a single "Phone" line claimed the Signal number took texts.
describe('buildBaseSystemPrompt own contact numbers', () => {
  async function contactBlock(channelAccounts: SystemPromptSources['channelAccounts']): Promise<string | null> {
    const prompt = await buildBaseSystemPrompt(
      { agentId: 'calendar', systemPrompt: 'Body.', channelAccounts },
      { now: NOW, logger },
    );
    const start = prompt.indexOf('## Your Contact Details');
    if (start === -1) return null;
    return prompt.slice(start, prompt.indexOf('\n\n', prompt.indexOf('- ', start)));
  }

  it('renders one combined line when Signal and SMS share a number, compared by digits', async () => {
    const block = await contactBlock({ signal: '+1 (555) 000-1111', sms: '+15550001111' });
    expect(block).toContain('- Phone (Signal and SMS): +15550001111');
    expect(block).not.toContain('- Signal:');
    expect(block).not.toContain('- SMS:');
  });

  it('renders separate Signal and SMS lines when the numbers differ', async () => {
    const block = await contactBlock({ email: 'curia@example.com', signal: '+15550001111', sms: '+15550002222' });
    expect(block).toContain('- Email: curia@example.com\n- Signal: +15550001111\n- SMS: +15550002222');
    expect(block).not.toContain('Signal and SMS');
  });

  it('renders only the Signal line when there is no SMS number', async () => {
    const block = await contactBlock({ signal: '+15550001111' });
    expect(block).toContain('- Signal: +15550001111');
    expect(block).not.toContain('Phone');
  });

  it('renders only the SMS line when there is no Signal number', async () => {
    const block = await contactBlock({ sms: '+15550002222' });
    expect(block).toContain('- SMS: +15550002222');
    expect(block).not.toContain('- Signal:');
  });

  it('renders no phone line, and no block, when neither number is set', async () => {
    expect(await contactBlock({ email: 'curia@example.com' })).not.toMatch(/Phone|Signal/);
    expect(await contactBlock({})).toBeNull();
  });
});

describe('buildBaseSystemPrompt pinned context (#2338)', () => {
  const pinnedContext = [{ kind: 'doc' as const, path: '/shared/inbox/rules.md' }];
  const pinnedContextReader = {
    warnChars: 16_000,
    readDoc: vi.fn(async () => ({ status: 'live' as const, version: 3, content: '## Board mail' })),
    readConfig: vi.fn(async () => null),
  };

  it('renders the block after the body and specialist roster, before autonomy', async () => {
    const autonomyService = {
      getConfig: vi.fn(async () => ({ score: 75, band: 'approval-required', updatedAt: NOW, updatedBy: 'x' })),
    } as unknown as SystemPromptSources['autonomyService'];
    const prompt = await buildBaseSystemPrompt(
      sources('ceo-inbox', [], { pinnedContext, pinnedContextReader, availableSpecialists: '- @x', autonomyService }),
      { now: NOW, logger },
    );
    const body = prompt.indexOf('Body.');
    const roster = prompt.indexOf('## Available Specialists');
    const pinned = prompt.indexOf('## Pinned context');
    const autonomy = prompt.indexOf('## Autonomy Level');
    expect(body).toBeGreaterThanOrEqual(0);
    expect(roster).toBeGreaterThan(body);
    expect(pinned).toBeGreaterThan(roster);
    expect(autonomy).toBeGreaterThan(pinned);
    expect(prompt).toContain('### Document /shared/inbox/rules.md (version 3)');
  });

  it('renders nothing for an agent that declares nothing', async () => {
    const prompt = await buildBaseSystemPrompt(sources('contacts', [], { pinnedContextReader }), { now: NOW, logger });
    expect(prompt).not.toContain('## Pinned context');
  });

  it('renders declared entries as unavailable when no reader is wired', async () => {
    const prompt = await buildBaseSystemPrompt(sources('ceo-inbox', [], { pinnedContext }), { now: NOW, logger });
    expect(prompt).toContain('### Document /shared/inbox/rules.md\n_Unavailable this turn');
  });

  it('builds the whole prompt when every declared entry is missing or every read fails', async () => {
    const many = [
      { kind: 'doc' as const, path: '/shared/a.md', description: 'A.' },
      { kind: 'doc' as const, path: '/shared/b.md' },
      { kind: 'config' as const, namespace: 'n', key: 'k', description: 'If missing, default to null.' },
    ];
    const missing = { warnChars: 16_000, readDoc: vi.fn(async () => null), readConfig: vi.fn(async () => null) };
    const failing = {
      warnChars: 16_000,
      readDoc: vi.fn(async () => { throw new Error('db down'); }),
      readConfig: vi.fn(async () => { throw new Error('kg down'); }),
    };
    // 'throw' mode fails the render on any block error, so this also proves nothing escapes.
    for (const opts of [{ now: NOW, logger }, { now: NOW, logger, onBlockError: 'throw' as const }]) {
      const absent = await buildBaseSystemPrompt(sources('ceo-inbox', [], { pinnedContext: many, pinnedContextReader: missing }), opts);
      expect(absent.match(/_Not yet created\._/g)).toHaveLength(2);
      expect(absent).toContain('### Config n/k\nPurpose: If missing, default to null.\n_Not set yet._');
      expect(absent).toContain('## Turn budget');

      const down = await buildBaseSystemPrompt(sources('ceo-inbox', [], { pinnedContext: many, pinnedContextReader: failing }), opts);
      expect(down.match(/_Unavailable this turn/g)).toHaveLength(3);
      expect(down).toContain('## Turn budget');
    }
  });
});
