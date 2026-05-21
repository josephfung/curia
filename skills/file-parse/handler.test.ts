import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseCsv } from './csv.js';
import { FileParseHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { InfraLlm, InfraLlmResult } from '../../src/skills/infra-llm.js';

function makeCtx(
  input: Record<string, unknown>,
  infraLlm?: InfraLlm,
): SkillContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    infraLlm,
  } as unknown as SkillContext;
}

/**
 * Build a mock InfraLlm that returns a successful extract result.
 */
function makeInfraLlm(responseText: string): InfraLlm {
  return {
    classify: vi.fn().mockResolvedValue({ ok: true, text: responseText } as InfraLlmResult),
    extract: vi.fn().mockResolvedValue({ ok: true, text: responseText } as InfraLlmResult),
  };
}

/**
 * Build a mock InfraLlm that returns an error from extract.
 */
function makeInfraLlmError(message: string): InfraLlm {
  return {
    classify: vi.fn().mockResolvedValue({ ok: false, error: message } as InfraLlmResult),
    extract: vi.fn().mockResolvedValue({ ok: false, error: message } as InfraLlmResult),
  };
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
    it('returns error when infraLlm is missing', async () => {
      const handler = new FileParseHandler();
      const ctx = {
        input: { content_base64: Buffer.from('a,b\n1,2').toString('base64'), mime_type: 'text/csv' },
        secret: () => 'test-api-key',
        log: pino({ level: 'silent' }),
        // infraLlm intentionally omitted
      } as unknown as SkillContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/infraLlm/);
    });
  });

  describe('input validation', () => {
    const handler = new FileParseHandler();

    it('rejects missing content_base64', async () => {
      const result = await handler.execute(makeCtx({ mime_type: 'text/csv' }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/content_base64/);
    });

    it('rejects missing mime_type', async () => {
      const result = await handler.execute(makeCtx({ content_base64: 'abc' }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/mime_type/);
    });

    it('rejects unsupported mime_type', async () => {
      const content = Buffer.from('hello').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/octet-stream',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/unsupported/i);
    });

    it('rejects empty extract_as value', async () => {
      const content = Buffer.from('a,b\n1,2').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
        extract_as: '',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract_as/);
    });

    it('accepts an unknown extract_as schema (e.g. purchase_order)', async () => {
      const csv = 'vendor,amount\nAcme,500';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
        extract_as: 'purchase_order',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
    });
  });

  describe('CSV handling', () => {
    const handler = new FileParseHandler();

    it('parses CSV content without LLM call', async () => {
      const infraLlm = makeInfraLlm('{}');
      const csv = 'date,vendor,amount\n2026-01-15,OpenAI,20.00';
      const content = Buffer.from(csv).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/csv',
      }, infraLlm));
      expect(result.success).toBe(true);
      // CSV is deterministic — infraLlm should not be called
      expect(infraLlm.extract).not.toHaveBeenCalled();
      expect(infraLlm.classify).not.toHaveBeenCalled();
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
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).toBe(csv);
      }
    });
  });

  describe('image handling (vision)', () => {
    it('calls infraLlm.extract for image/jpeg with vision content', async () => {
      const jsonText = '{"vendor":"Starbucks","amount":5.75,"currency":"CAD","date":"2026-03-10","tax":0.75,"line_items":[]}';
      const infraLlm = makeInfraLlm(jsonText);

      const handler = new FileParseHandler();
      const content = Buffer.from('fake-image-bytes').toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpeg',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(true);
      expect(infraLlm.extract).toHaveBeenCalledOnce();

      // Verify the extract call includes image data
      const callArgs = (infraLlm.extract as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toEqual(expect.objectContaining({
        image: expect.objectContaining({ base64: content, mediaType: 'image/jpeg' }),
      }));

      if (result.success) {
        const data = result.data as { structured: { vendor: string } };
        expect(data.structured.vendor).toBe('Starbucks');
      }
    });

    it('normalizes image/jpg to image/jpeg in the vision call', async () => {
      const jsonText = '{"vendor":"Test","amount":1,"currency":"CAD","date":"2026-01-01","tax":null,"line_items":[]}';
      const infraLlm = makeInfraLlm(jsonText);
      const handler = new FileParseHandler();

      const content = Buffer.from('fake-image-bytes').toString('base64');
      await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'image/jpg',
        extract_as: 'receipt',
      }, infraLlm));

      expect(infraLlm.extract).toHaveBeenCalledOnce();
      const callArgs = (infraLlm.extract as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].image.mediaType).toBe('image/jpeg');
    });
  });

  describe('HTML handling — security', () => {
    it('strips <script> blocks whose closing tag has trailing whitespace (</script >)', async () => {
      const html = '<p>Safe</p><script>evil()</script > trailing';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).not.toContain('evil');
        expect(data.raw_text).toContain('Safe');
      }
    });

    it('strips <script> tags reconstructed by nested-substitution bypass', async () => {
      const payload =
        '<scri<script>X</script>pt>alert("xss")</scri<script>Y</script>pt>';
      const content = Buffer.from(payload).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).not.toContain('<script');
        expect(data.raw_text).not.toContain('alert("xss")');
      }
    });

    it('strips <style> tags reconstructed by nested-substitution bypass', async () => {
      const payload =
        '<sty<style>X</style>le>body{color:red}</sty<style>Y</style>le>';
      const content = Buffer.from(payload).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { raw_text: string };
        expect(data.raw_text).not.toContain('<style');
        expect(data.raw_text).not.toContain('body{color:red}');
      }
    });

    it('does not double-decode &amp;lt; into a literal < in HTML text', async () => {
      const html = '<p>Entity: &amp;lt;</p>';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, makeInfraLlm('{}')));
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
      const infraLlm = makeInfraLlm('{}');
      const html = '<html><body><h1>Invoice</h1><p>Amount: $50.00</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'raw',
      }, infraLlm));
      expect(result.success).toBe(true);
      // extract_as: raw → no LLM call
      expect(infraLlm.extract).not.toHaveBeenCalled();
      if (result.success) {
        const data = result.data as { type: string; raw_text: string };
        expect(data.type).toBe('html');
        expect(data.raw_text).toContain('Invoice');
        expect(data.raw_text).toContain('$50.00');
      }
    });

    it('uses infraLlm.extract for structured extraction from HTML', async () => {
      const jsonText = '{"vendor":"Acme","amount":50,"currency":"USD","date":"2026-01-01","tax":null,"line_items":[]}';
      const infraLlm = makeInfraLlm(jsonText);
      const handler = new FileParseHandler();

      const html = '<html><body><p>Receipt from Acme: $50 USD</p></body></html>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(true);
      expect(infraLlm.extract).toHaveBeenCalledOnce();
    });
  });

  describe('PDF handling', () => {
    it('returns error for corrupt PDF content', async () => {
      const content = Buffer.from('not a pdf').toString('base64');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/pdf',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/pdf/i);
    });
  });

  describe('LLM error handling', () => {
    it('returns success: false when LLM call returns an error response', async () => {
      const infraLlm = makeInfraLlmError('API rate limited');
      const handler = new FileParseHandler();

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/extract/i);
    });

    it('returns low confidence when LLM returns unparseable JSON', async () => {
      const infraLlm = makeInfraLlm('I cannot parse this document.');
      const handler = new FileParseHandler();

      const html = '<p>receipt</p>';
      const content = Buffer.from(html).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'text/html',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { confidence: number; structured: unknown };
        expect(data.confidence).toBeLessThan(0.5);
        expect(data.structured).toBeNull();
      }
    });
  });
});
