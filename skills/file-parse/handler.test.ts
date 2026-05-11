import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseCsv } from './csv.js';
import { FileParseHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
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
  describe('input validation', () => {
    const handler = new FileParseHandler();

    it('rejects missing content_base64', async () => {
      const result = await handler.execute(makeCtx({ mime_type: 'text/csv' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/content_base64/);
    });

    it('rejects missing mime_type', async () => {
      const result = await handler.execute(makeCtx({ content_base64: 'abc' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/mime_type/);
    });

    it('rejects unsupported mime_type', async () => {
      const content = Buffer.from('hello').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/octet-stream',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/unsupported/i);
    });

    it('rejects invalid extract_as value', async () => {
      const content = Buffer.from('a,b\n1,2').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
        extract_as: 'spreadsheet',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract_as/);
    });
  });

  describe('CSV handling', () => {
    const handler = new FileParseHandler();

    it('parses CSV content without LLM call', async () => {
      const csv = 'date,vendor,amount\n2026-01-15,OpenAI,20.00';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
      }));
      expect(result.success).toBe(true);
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
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).toBe(csv);
      }
    });
  });

  describe('image handling (vision)', () => {
    it('calls Claude vision API for image/jpeg', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"vendor":"Starbucks","amount":5.75,"currency":"CAD","date":"2026-03-10","tax":0.75,"line_items":[]}' }],
      });
      const mockClient = { messages: { create: mockCreate } };
      const handler = new FileParseHandler(mockClient as any);

      const content = Buffer.from('fake-image-bytes').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpeg',
        extract_as: 'receipt',
      }));

      expect(result.success).toBe(true);
      expect(mockCreate).toHaveBeenCalledOnce();
      const callArgs = mockCreate.mock.calls[0][0];
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

    it('normalizes image/jpg to image/jpeg for the Anthropic API', async () => {
      // The Anthropic API only accepts image/jpeg, not the non-standard image/jpg alias.
      // Verify the normalization happens before the API call.
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"vendor":"Test","amount":1,"currency":"CAD","date":"2026-01-01","tax":null,"line_items":[]}' }],
      });
      const mockClient = { messages: { create: mockCreate } };
      const handler = new FileParseHandler(mockClient as any);

      const content = Buffer.from('fake-image-bytes').toString('base64');
      await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpg',
        extract_as: 'receipt',
      }));

      expect(mockCreate).toHaveBeenCalledOnce();
      const callArgs = mockCreate.mock.calls[0][0];
      const imageBlock = callArgs.messages[0].content.find(
        (c: { type: string }) => c.type === 'image',
      );
      expect(imageBlock.source.media_type).toBe('image/jpeg');
    });
  });

  describe('HTML handling', () => {
    it('extracts text from HTML and returns raw_text', async () => {
      const html = '<html><body><h1>Invoice</h1><p>Amount: $50.00</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { type: string; raw_text: string };
        expect(data.type).toBe('html');
        expect(data.raw_text).toContain('Invoice');
        expect(data.raw_text).toContain('$50.00');
      }
    });

    it('uses LLM for structured extraction from HTML', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"vendor":"Acme","amount":50,"currency":"USD","date":"2026-01-01","tax":null,"line_items":[]}' }],
      });
      const mockClient = { messages: { create: mockCreate } };
      const handler = new FileParseHandler(mockClient as any);

      const html = '<html><body><p>Receipt from Acme: $50 USD</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }));

      expect(result.success).toBe(true);
      expect(mockCreate).toHaveBeenCalledOnce();
    });
  });

  describe('PDF handling', () => {
    it('returns error for corrupt PDF content', async () => {
      const content = Buffer.from('not a pdf').toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/pdf',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/pdf/i);
    });
  });

  describe('LLM error handling', () => {
    it('returns success: false when LLM call throws', async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error('API rate limited'));
      const mockClient = { messages: { create: mockCreate } };
      const handler = new FileParseHandler(mockClient as any);

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }));

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract/i);
    });

    it('returns low confidence when LLM returns unparseable JSON', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'I cannot parse this document.' }],
      });
      const mockClient = { messages: { create: mockCreate } };
      const handler = new FileParseHandler(mockClient as any);

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { confidence: number; structured: unknown };
        expect(data.confidence).toBeLessThan(0.5);
        expect(data.structured).toBeNull();
      }
    });
  });
});
