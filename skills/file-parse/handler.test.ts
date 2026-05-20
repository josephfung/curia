import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseCsv } from './csv.js';
import { FileParseHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// Minimal modelRouter stub that always resolves to 'claude-sonnet-4-6'.
// Returns the full ResolvedModel shape { model, tier } to match the runtime contract.
const mockModelRouter = {
  resolve: (_tier: string) => ({ model: 'claude-sonnet-4-6', tier: 'standard' as const }),
};

function makeCtx(
  input: Record<string, unknown>,
  llmProvider?: SkillContext['llmProvider'],
): SkillContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    llmProvider,
    modelRouter: mockModelRouter,
  } as unknown as SkillContext;
}

/**
 * Build a mock LLMProvider that returns a successful text response.
 */
function makeLlmProvider(responseText: string) {
  const chat = vi.fn().mockResolvedValue({ type: 'text', content: responseText, usage: {}, provenance: {} });
  return { id: 'mock', chat };
}

/**
 * Build a mock LLMProvider that rejects (simulates an API error returned as
 * a discriminated-union error value, not a thrown exception).
 */
function makeLlmProviderError(message: string) {
  const chat = vi.fn().mockResolvedValue({
    type: 'error',
    error: { message, code: 'LLM_ERROR' },
  });
  return { id: 'mock', chat };
}

describe('parseCsv', () => {
  it('parses a simple CSV into typed rows', () => {
    const csv = 'date,description,amount\n2026-01-15,OpenAI,20.00\n2026-01-16,Figma,15.00';
    const result = parseCsv(csv);
    expect(result).toEqual([
      { date: '2026-01-15', description: 'OpenAI', amount: '20.00' },
      { date: '2026-01-16', description: 'Figma', amount: '15.00' },
    ]);
  });

  it('handles quoted fields with commas', () => {
    const csv = 'vendor,description,amount\n"Acme, Inc.","Widget, large",99.99';
    const result = parseCsv(csv);
    expect(result).toEqual([
      { vendor: 'Acme, Inc.', description: 'Widget, large', amount: '99.99' },
    ]);
  });

  it('handles empty fields', () => {
    const csv = 'a,b,c\n1,,3';
    const result = parseCsv(csv);
    expect(result).toEqual([{ a: '1', b: '', c: '3' }]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('returns empty array for header-only CSV', () => {
    expect(parseCsv('a,b,c')).toEqual([]);
  });

  it('trims whitespace from headers and values', () => {
    const csv = ' name , value \n Alice , 42 ';
    const result = parseCsv(csv);
    expect(result).toEqual([{ name: 'Alice', value: '42' }]);
  });
});

describe('FileParseHandler', () => {
  describe('capability guard', () => {
    it('returns error when llmProvider is missing', async () => {
      const handler = new FileParseHandler();
      // Pass no llmProvider so the guard fires
      const ctx = {
        input: { content_base64: Buffer.from('a,b\n1,2').toString('base64'), mime_type: 'text/csv' },
        secret: () => 'test-api-key',
        log: pino({ level: 'silent' }),
        llmProvider: undefined,
        modelRouter: mockModelRouter,
      } as unknown as SkillContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/llmProvider/);
    });

    it('returns error when modelRouter is missing', async () => {
      const handler = new FileParseHandler();
      const ctx = {
        input: { content_base64: Buffer.from('a,b\n1,2').toString('base64'), mime_type: 'text/csv' },
        secret: () => 'test-api-key',
        log: pino({ level: 'silent' }),
        llmProvider: makeLlmProvider('{}'),
        modelRouter: undefined,
      } as unknown as SkillContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/modelRouter/);
    });
  });

  describe('input validation', () => {
    const handler = new FileParseHandler();

    it('rejects missing content_base64', async () => {
      const result = await handler.execute(makeCtx({ mime_type: 'text/csv' }, makeLlmProvider('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/content_base64/);
    });

    it('rejects missing mime_type', async () => {
      const result = await handler.execute(makeCtx({ content_base64: 'abc' }, makeLlmProvider('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/mime_type/);
    });

    it('rejects unsupported mime_type', async () => {
      const content = Buffer.from('hello').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/octet-stream',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/unsupported/i);
    });

    it('rejects empty extract_as value', async () => {
      // Empty string is the only invalid value — any non-empty string is accepted
      // (unknown schemas get a generic extraction prompt). Use '' to test the guard.
      const content = Buffer.from('a,b\n1,2').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
        extract_as: '',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract_as/);
    });

    it('accepts an unknown extract_as schema (e.g. purchase_order)', async () => {
      // Non-standard schemas should succeed with CSV — CSV is deterministic and
      // doesn't use the extract_as hint for structured extraction.
      const csv = 'vendor,amount\nAcme,500';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
        extract_as: 'purchase_order',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(true);
    });
  });

  describe('CSV handling', () => {
    const handler = new FileParseHandler();

    it('parses CSV content without LLM call', async () => {
      const llmProvider = makeLlmProvider('{}');
      const csv = 'date,vendor,amount\n2026-01-15,OpenAI,20.00';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
      }, llmProvider));
      expect(result.success).toBe(true);
      // CSV is deterministic — LLM should not be called
      expect(llmProvider.chat).not.toHaveBeenCalled();
      if (result.success) {
        const data = result.data as { type: string; raw_text: string; structured: unknown; confidence: number };
        expect(data.type).toBe('csv');
        expect(data.confidence).toBe(1.0);
        expect(data.structured).toEqual([
          { date: '2026-01-15', vendor: 'OpenAI', amount: '20.00' },
        ]);
      }
    });

    it('returns raw_text as the original CSV content', async () => {
      const csv = 'a,b\n1,2';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).toBe(csv);
      }
    });
  });

  describe('image handling (vision)', () => {
    it('calls LLMProvider.chat for image/jpeg with vision content', async () => {
      const jsonText = '{"vendor":"Starbucks","amount":5.75,"currency":"CAD","date":"2026-03-10","tax":0.75,"line_items":[]}';
      const llmProvider = makeLlmProvider(jsonText);

      const handler = new FileParseHandler();
      const content = Buffer.from('fake-image-bytes').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpeg',
        extract_as: 'receipt',
      }, llmProvider));

      expect(result.success).toBe(true);
      expect(llmProvider.chat).toHaveBeenCalledOnce();

      // Verify the message structure includes an image block
      const callArgs = llmProvider.chat.mock.calls[0][0];
      const userMessage = callArgs.messages[0];
      expect(userMessage.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'image', source: expect.objectContaining({ type: 'base64' }) }),
        ]),
      );

      if (result.success) {
        const data = result.data as { structured: { vendor: string } };
        expect(data.structured.vendor).toBe('Starbucks');
      }
    });

    it('normalizes image/jpg to image/jpeg in the vision call', async () => {
      // The Anthropic API only accepts image/jpeg, not the non-standard image/jpg alias.
      // Verify the normalization happens before the LLMProvider call.
      const jsonText = '{"vendor":"Test","amount":1,"currency":"CAD","date":"2026-01-01","tax":null,"line_items":[]}';
      const llmProvider = makeLlmProvider(jsonText);
      const handler = new FileParseHandler();

      const content = Buffer.from('fake-image-bytes').toString('base64');
      await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpg',
        extract_as: 'receipt',
      }, llmProvider));

      expect(llmProvider.chat).toHaveBeenCalledOnce();
      const callArgs = llmProvider.chat.mock.calls[0][0];
      const imageBlock = callArgs.messages[0].content.find(
        (c: { type: string }) => c.type === 'image',
      );
      expect(imageBlock.source.media_type).toBe('image/jpeg');
    });
  });

  describe('HTML handling — security', () => {
    // ── Security: js/bad-tag-filter ───────────────────────────────────────────

    it('strips <script> blocks whose closing tag has trailing whitespace (</script >)', async () => {
      const html = '<p>Safe</p><script>evil()</script > trailing';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).not.toContain('evil');
        expect(data.raw_text).toContain('Safe');
      }
    });

    // ── Security: js/double-escaping ──────────────────────────────────────────

    it('does not double-decode &amp;lt; into a literal < in HTML text', async () => {
      // Original entity order decoded &amp; first, then &lt;, so &amp;lt; → &lt; → <
      const html = '<p>Entity: &amp;lt;</p>';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).toContain('&lt;');
        expect(data.raw_text).not.toContain('Entity: <');
      }
    });
  });

  describe('HTML handling', () => {
    it('extracts text from HTML and returns raw_text (no LLM call for raw)', async () => {
      const llmProvider = makeLlmProvider('{}');
      const html = '<html><body><h1>Invoice</h1><p>Amount: $50.00</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, llmProvider));
      expect(result.success).toBe(true);
      // extract_as: raw → no LLM call
      expect(llmProvider.chat).not.toHaveBeenCalled();
      if (result.success) {
        const data = result.data as { type: string; raw_text: string };
        expect(data.type).toBe('html');
        expect(data.raw_text).toContain('Invoice');
        expect(data.raw_text).toContain('$50.00');
      }
    });

    it('uses LLMProvider.chat for structured extraction from HTML', async () => {
      const jsonText = '{"vendor":"Acme","amount":50,"currency":"USD","date":"2026-01-01","tax":null,"line_items":[]}';
      const llmProvider = makeLlmProvider(jsonText);
      const handler = new FileParseHandler();

      const html = '<html><body><p>Receipt from Acme: $50 USD</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, llmProvider));

      expect(result.success).toBe(true);
      expect(llmProvider.chat).toHaveBeenCalledOnce();
    });
  });

  describe('PDF handling', () => {
    it('returns error for corrupt PDF content', async () => {
      const content = Buffer.from('not a pdf').toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/pdf',
      }, makeLlmProvider('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/pdf/i);
    });
  });

  describe('LLM error handling', () => {
    it('returns success: false when LLM call returns an error response', async () => {
      const llmProvider = makeLlmProviderError('API rate limited');
      const handler = new FileParseHandler();

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, llmProvider));

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract/i);
    });

    it('returns low confidence when LLM returns unparseable JSON', async () => {
      const llmProvider = makeLlmProvider('I cannot parse this document.');
      const handler = new FileParseHandler();

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, llmProvider));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { confidence: number; structured: unknown };
        expect(data.confidence).toBeLessThan(0.5);
        expect(data.structured).toBeNull();
      }
    });
  });
});
