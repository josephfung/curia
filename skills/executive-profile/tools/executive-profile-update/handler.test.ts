// handler.test.ts — executive-profile-update skill
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { ExecutiveProfileUpdateHandler, MAX_GUIDE_CHARS, MAX_NOTE_CHARS } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WritingVoice } from '../../../../src/executive/types.js';

const BASE_VOICE: WritingVoice = {
  tone: ['warm'],
  formality: 5,
  patterns: ['short sentences'],
  vocabulary: { prefer: ['thanks'], avoid: ['synergy'] },
  signOff: 'Best',
  guide: 'Existing guide.',
};

function makeService() {
  let voice: WritingVoice = { ...BASE_VOICE };
  return {
    get: vi.fn(() => ({ writingVoice: voice })),
    update: vi.fn(async (config: { writingVoice: WritingVoice }, _by: string, _note?: string) => {
      voice = config.writingVoice;
    }),
  };
}

function makeContext(service: ReturnType<typeof makeService>, input: Record<string, unknown>): ToolContext {
  return {
    input,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    caller: { role: 'principal', contactId: 'contact-123' },
    executiveProfileService: service,
  } as unknown as ToolContext;
}

describe('ExecutiveProfileUpdateHandler guide and note', () => {
  const handler = new ExecutiveProfileUpdateHandler();

  it('keeps the current guide when none is given', async () => {
    const service = makeService();
    const result = await handler.execute(makeContext(service, { writing_voice: { formality: 7 } }));
    expect(result.success).toBe(true);
    const saved = service.update.mock.calls[0]![0].writingVoice;
    expect(saved.guide).toBe('Existing guide.');
    expect(saved.formality).toBe(7);
  });

  it('replaces the guide when given, trimmed', async () => {
    const service = makeService();
    const result = await handler.execute(
      makeContext(service, { writing_voice: {}, guide: '  New guide.\n' }),
    );
    expect(result.success).toBe(true);
    expect(service.update.mock.calls[0]![0].writingVoice.guide).toBe('New guide.');
    expect(service.update.mock.calls[0]![1]).toBe('tool');
  });

  it('records the note in the version row', async () => {
    const service = makeService();
    await handler.execute(
      makeContext(service, {
        writing_voice: { formality: 8 },
        note: ' deep dive, confirmed by the principal ',
      }),
    );
    const note = service.update.mock.calls[0]![2]!;
    expect(note).toBe('deep dive, confirmed by the principal: formality: 5 → 8 (by contact-123)');
  });

  it('leaves the version note unprefixed when the note is blank', async () => {
    const service = makeService();
    await handler.execute(makeContext(service, { writing_voice: { formality: 8 }, note: '   ' }));
    expect(service.update.mock.calls[0]![2]).toBe('formality: 5 → 8 (by contact-123)');
  });

  it('rejects an over-long guide', async () => {
    const service = makeService();
    const result = await handler.execute(
      makeContext(service, { writing_voice: {}, guide: 'x'.repeat(MAX_GUIDE_CHARS + 1) }),
    );
    expect(result.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects an over-long note', async () => {
    const service = makeService();
    const result = await handler.execute(
      makeContext(service, { writing_voice: {}, note: 'n'.repeat(MAX_NOTE_CHARS + 1) }),
    );
    expect(result.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects a non-string guide or note', async () => {
    const service = makeService();
    const a = await handler.execute(makeContext(service, { writing_voice: {}, guide: 5 }));
    const b = await handler.execute(makeContext(service, { writing_voice: {}, note: ['x'] }));
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('declares writing_voice before the optional guide and note in tool.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('./tool.json', import.meta.url), 'utf8'),
    ) as { inputs: Record<string, string> };
    expect(Object.keys(manifest.inputs)).toEqual(['writing_voice', 'guide', 'note']);
  });
});
