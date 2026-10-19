import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EventBus } from '../../../src/bus/bus.js';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';
import { HONESTY_LINE, OfficeIdentityService, REGISTER_LINE } from '../../../src/identity/service.js';
import type { OfficeIdentity } from '../../../src/identity/types.js';
import type { Logger } from '../../../src/logger.js';
import { CONTENT_LINE, LENGTH_EXCEPTION } from '../../../src/identity/length.js';

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** A service whose stored row is `config`, as the database returns it (not re-validated). */
async function serviceWith(config: unknown, log: Logger = logger()): Promise<OfficeIdentityService> {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [{ config }] }) } as unknown as Pool;
  const service = new OfficeIdentityService(pool, log, { publish: vi.fn() } as unknown as EventBus);
  await service.initialize();
  return service;
}

/** update() as far as validation: the pool has no connect(), so a valid config fails later. */
async function validationError(config: unknown): Promise<string | undefined> {
  const service = await serviceWith(DEFAULT_OFFICE_IDENTITY);
  try {
    await service.update(config as OfficeIdentity, 'api');
  } catch (err) {
    const message = (err as Error).message;
    return message.includes('connect') ? undefined : message;
  }
  return undefined;
}

const STYLE = 'Dry and understated.\nSounds like: "Done. Thursday\'s call is now at 3."';
const IDENTITY: OfficeIdentity = {
  ...DEFAULT_OFFICE_IDENTITY,
  tone: { style: STYLE, verbosity: 15 },
  behavioralPreferences: ['Call me Joe'],
};

describe('OfficeIdentityService.compileSystemPromptBlock (#2143)', () => {
  it('renders constraints, who, style, length, honesty and preferences, in that order', async () => {
    const block = (await serviceWith(IDENTITY)).compileSystemPromptBlock();
    const order = [
      '**Hard constraints (non-negotiable):**',
      '- Never impersonate the principal',
      '**Who you are:**',
      '**How you sound:**',
      STYLE,
      REGISTER_LINE,
      '**Length (Detail: Brief):**',
      '- Signal, SMS and Slack: 1–2 sentences. The answer or outcome only.',
      '- Email: Under ~80 words. No warm-up line, no closing summary.',
      LENGTH_EXCEPTION,
      CONTENT_LINE,
      HONESTY_LINE,
      '**Standing preferences:**',
      '- Call me Joe',
    ].map(text => block.indexOf(text));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('has no decision posture and no tone-word sentence', async () => {
    const block = (await serviceWith(IDENTITY)).compileSystemPromptBlock();
    expect(block).not.toMatch(/Decision posture|For external actions|Your tone is/);
  });

  it('renders a legacy row through normalization', async () => {
    const legacy = {
      ...DEFAULT_OFFICE_IDENTITY,
      tone: { baseline: ['dry', 'candid'], verbosity: 15, directness: 90 },
      decisionStyle: { externalActions: 'proactive', internalAnalysis: 'proactive' },
    };
    const block = (await serviceWith(legacy)).compileSystemPromptBlock();
    expect(block).toContain('Dry and candid. State positions plainly; avoid softening language.');
    expect(block).not.toContain('surface insights without being asked');
  });

  // A stored row is not re-validated on read: bad tone must never become "undefined".
  for (const [label, tone] of [
    ['a missing style', { style: undefined, verbosity: 50 }],
    ['an out-of-range verbosity', { style: STYLE, verbosity: 150 }],
  ] as const) {
    it(`with ${label}, logs at error and drops only the tone and length sections`, async () => {
      const log = logger();
      // A style-less row with no legacy words normalizes to the default style, so the
      // first case is set up after load, as a corrupt in-memory value would be.
      const service = await serviceWith(IDENTITY, log);
      vi.spyOn(service, 'get').mockReturnValue({ ...IDENTITY, tone: tone as unknown as OfficeIdentity['tone'] });
      const block = service.compileSystemPromptBlock();
      expect(block).not.toContain('undefined');
      expect(block).not.toContain('**How you sound:**');
      expect(block).not.toContain('**Length');
      expect(block).toContain('- Never impersonate the principal');
      expect(block).toContain('- Call me Joe');
      expect(block).toContain(HONESTY_LINE);
      expect(log.error).toHaveBeenCalledOnce();
    });
  }
});

describe('OfficeIdentityService validation (#2143)', () => {
  it('accepts a current identity', async () => {
    expect(await validationError(IDENTITY)).toBeUndefined();
  });

  it('rejects the legacy fields by name, so a stale client fails loudly', async () => {
    const stale = {
      ...IDENTITY,
      tone: { ...IDENTITY.tone, baseline: ['warm'], directness: 50 },
      decisionStyle: { externalActions: 'balanced', internalAnalysis: 'balanced' },
    };
    const message = await validationError(stale);
    expect(message).toMatch(/no longer accepts tone\.baseline, tone\.directness, decisionStyle/);
  });

  it('requires a non-empty style of at most 800 characters', async () => {
    expect(await validationError({ ...IDENTITY, tone: { verbosity: 50 } })).toMatch(/requires tone\.style/);
    expect(await validationError({ ...IDENTITY, tone: { style: '  ', verbosity: 50 } })).toMatch(/requires tone\.style/);
    expect(await validationError({ ...IDENTITY, tone: { style: 'x'.repeat(801), verbosity: 50 } })).toMatch(/at most 800 characters; got 801/);
    expect(await validationError({ ...IDENTITY, tone: { style: 'x'.repeat(800), verbosity: 50 } })).toBeUndefined();
  });

  it('requires preferences and constraints to be lists of strings', async () => {
    expect(await validationError({ ...IDENTITY, constraints: 'Never impersonate the principal' })).toMatch(/constraints to be a list of strings/);
    expect(await validationError({ ...IDENTITY, behavioralPreferences: [1] })).toMatch(/behavioralPreferences to be a list of strings/);
  });
});

describe('OfficeIdentityService.history (#2143)', () => {
  it('returns legacy versions in the current shape', async () => {
    const legacy = { ...DEFAULT_OFFICE_IDENTITY, tone: { baseline: ['calm'], verbosity: 50 }, decisionStyle: {} };
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, version: 1, config: legacy, changed_by: 'wizard', note: null, created_at: new Date(0) }],
      }),
    } as unknown as Pool;
    const service = new OfficeIdentityService(pool, logger(), { publish: vi.fn() } as unknown as EventBus);
    const [version] = await service.history();
    expect(version!.config.tone).toEqual({ style: 'Calm.', verbosity: 50 });
    expect(version!.config).not.toHaveProperty('decisionStyle');
  });
});
