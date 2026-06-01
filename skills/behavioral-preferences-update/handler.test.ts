// handler.test.ts — behavioral-preferences-update skill
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BehavioralPreferencesUpdateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OfficeIdentity } from '../../src/identity/types.js';

function makeContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: {},
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    caller: { role: 'principal', contactId: 'contact-123' },
    ...overrides,
  } as unknown as SkillContext;
}

const BASE_IDENTITY: OfficeIdentity = {
  assistant: { name: 'Curia', title: 'Chief of Staff', emailSignature: '' },
  tone: { baseline: ['professional'], verbosity: 50, directness: 50 },
  behavioralPreferences: ['Be concise', 'Prioritize signal over noise'],
  decisionStyle: { externalActions: 'balanced', internalAnalysis: 'balanced' },
  constraints: [],
};

function makeOfficeIdentityService(identity: OfficeIdentity = BASE_IDENTITY) {
  // Clone so tests don't share mutable state.
  const state: OfficeIdentity = {
    ...identity,
    behavioralPreferences: [...identity.behavioralPreferences],
  };
  return {
    get: vi.fn((): OfficeIdentity => ({ ...state, behavioralPreferences: [...state.behavioralPreferences] })),
    update: vi.fn(async (config: OfficeIdentity, _changedBy: string, _note?: string) => {
      state.behavioralPreferences = [...config.behavioralPreferences];
    }),
  };
}

describe('BehavioralPreferencesUpdateHandler', () => {
  let handler: BehavioralPreferencesUpdateHandler;

  beforeEach(() => {
    handler = new BehavioralPreferencesUpdateHandler();
  });

  it('append adds new entries to existing preferences', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'append', entries: ['Reply within 24h'] },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { preferences: string[]; summary: string; changes: string };
    expect(data.preferences).toEqual([
      'Be concise',
      'Prioritize signal over noise',
      'Reply within 24h',
    ]);
    expect(service.update).toHaveBeenCalledOnce();
  });

  it('append is idempotent — entries already present are not duplicated', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'append', entries: ['Be concise'] },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { preferences: string[] };
    // 'Be concise' was already present — list length must not grow.
    expect(data.preferences).toEqual(['Be concise', 'Prioritize signal over noise']);
    // No DB write when nothing changed.
    expect(service.update).not.toHaveBeenCalled();
  });

  it('replace overwrites the entire list', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'replace', entries: ['New preference only'] },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { preferences: string[] };
    expect(data.preferences).toEqual(['New preference only']);
    expect(service.update).toHaveBeenCalledOnce();
  });

  it('returns failure when officeIdentityService is absent', async () => {
    const ctx = makeContext({ input: { operation: 'append', entries: ['x'] } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns failure for an unrecognised operation', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'upsert', entries: ['x'] },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns failure for an empty entries array', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'append', entries: [] },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns failure for a non-array entries value', async () => {
    const service = makeOfficeIdentityService();
    const ctx = makeContext({
      officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
      input: { operation: 'append', entries: 'not-an-array' },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
