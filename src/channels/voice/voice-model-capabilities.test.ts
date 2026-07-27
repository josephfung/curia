import { describe, it, expect } from 'vitest';
import { evaluateVoiceModelCapabilities } from './voice-model-capabilities.js';

describe('evaluateVoiceModelCapabilities (#1553)', () => {
  it('passes for a streaming+tools model', () => {
    expect(
      evaluateVoiceModelCapabilities('claude-haiku-4-5', ['vision', 'coding', 'streaming', 'tools']),
    ).toEqual({ ok: true });
  });

  it('refuses a non-streaming model', () => {
    const result = evaluateVoiceModelCapabilities('hypothetical/batch-only', [
      'coding',
      'tools',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('streaming');
      expect(result.unknownModel).toBe(false);
    }
  });

  it('refuses a non-tool model', () => {
    const result = evaluateVoiceModelCapabilities('hypothetical/stream-only', [
      'coding',
      'streaming',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['tools']);
    }
  });

  it('refuses an unknown model (fail closed)', () => {
    const result = evaluateVoiceModelCapabilities('totally-unknown-model', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknownModel).toBe(true);
      expect(result.missing).toEqual(['streaming', 'tools']);
    }
  });
});
