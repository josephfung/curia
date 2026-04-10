import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftDetector } from '../../../src/scheduler/drift-detector.js';
import type { DriftConfig } from '../../../src/scheduler/drift-detector.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';

function mockProvider(): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn(),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

const defaultConfig: DriftConfig = {
  enabled: true,
  checkEveryNBursts: 1,
  minConfidenceToPause: 'high',
};

const params = {
  intentAnchor: 'Research articles about AI safety and summarise findings weekly.',
  taskPayload: { skill: 'web-search', query: 'AI safety research 2025' },
  lastRunSummary: null,
};

describe('DriftDetector', () => {
  let provider: ReturnType<typeof mockProvider>;
  let logger: ReturnType<typeof mockLogger>;

  beforeEach(() => {
    provider = mockProvider();
    logger = mockLogger();
  });

  describe('check()', () => {
    it('returns null when enabled is false', async () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, enabled: false }, logger);
      const result = await detector.check(params);
      expect(result).toBeNull();
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it('returns the verdict when LLM says no drift', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Task is aligned with original intent.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      const result = await detector.check(params);

      expect(result).toEqual({ drifted: false, reason: 'Task is aligned with original intent.', confidence: 'high' });
    });

    it('returns the verdict when LLM says drift detected', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":true,"reason":"Task shifted from research to writing marketing copy.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      const result = await detector.check(params);

      expect(result).toEqual({
        drifted: true,
        reason: 'Task shifted from research to writing marketing copy.',
        confidence: 'high',
      });
    });

    it('includes lastRunSummary in the prompt when provided', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Aligned.","confidence":"high"}',
        usage: { inputTokens: 150, outputTokens: 20 },
      });

      await detector.check({ ...params, lastRunSummary: 'Searched for AI safety papers, found 5 results.' });

      const call = vi.mocked(provider.chat).mock.calls[0]![0];
      const userMessage = call.messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).toContain('What the agent did on its last run');
      expect(userMessage.content).toContain('Searched for AI safety papers');
    });

    it('omits lastRunSummary section when null', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Aligned.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      await detector.check({ ...params, lastRunSummary: null });

      const call = vi.mocked(provider.chat).mock.calls[0]![0];
      const userMessage = call.messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).not.toContain('What the agent did on its last run');
    });

    it('returns null and logs warning when LLM returns malformed JSON', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: 'Sorry, I cannot evaluate this.',
        usage: { inputTokens: 100, outputTokens: 10 },
      });

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ rawPreview: 'Sorry, I cannot evaluate this.' }),
        expect.stringContaining('malformed'),
      );
    });

    it('returns null and logs warning when LLM call throws', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockRejectedValueOnce(new Error('API timeout'));

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('drift check failed'),
      );
    });

    it('returns null and logs warning when LLM returns an error response', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'error',
        error: { type: 'provider_error', message: 'rate limited', retryable: true, source: 'llm', context: {} },
      });

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('shouldPause()', () => {
    it('returns true when drifted=true and confidence matches minConfidenceToPause', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'high' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'high' })).toBe(true);
    });

    it('returns false when drifted=false regardless of confidence', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'low' }, logger);
      expect(detector.shouldPause({ drifted: false, reason: 'x', confidence: 'high' })).toBe(false);
    });

    it('returns false when confidence is below minConfidenceToPause (high threshold, medium confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'high' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'medium' })).toBe(false);
    });

    it('returns false when confidence is below minConfidenceToPause (medium threshold, low confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'low' })).toBe(false);
    });

    it('returns true when confidence meets minConfidenceToPause (medium threshold, medium confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'medium' })).toBe(true);
    });

    it('returns true when confidence exceeds minConfidenceToPause (medium threshold, high confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'high' })).toBe(true);
    });

    it('returns true for any drift when minConfidenceToPause is low', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'low' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'low' })).toBe(true);
    });
  });
});
