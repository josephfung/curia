import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

    it('strips inner <script> elements from nested-substitution bypass payload', async () => {
      // A proper HTML parser removes the real <script>X</script> and
      // <script>Y</script> elements. The outer malformed fragments are literal
      // text. After generic tag stripping, assembled <script> tag characters
      // are gone. Content between them may remain as literal text in the
      // plain-text output — not an XSS risk for LLM consumption.
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
        expect(data.raw_text).not.toContain('<script'); // tag characters stripped
        expect(data.raw_text).not.toContain('X');       // inner content removed
        expect(data.raw_text).not.toContain('Y');       // inner content removed
      }
    });

    it('strips inner <style> elements from nested-substitution bypass payload', async () => {
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
        expect(data.raw_text).not.toContain('<style'); // tag characters stripped
        expect(data.raw_text).not.toContain('X');      // inner content removed
        expect(data.raw_text).not.toContain('Y');      // inner content removed
      }
    });

    it('strips <script> block whose body contains a fake closing tag with attributes', async () => {
      // See CodeQL alert js/bad-tag-filter (#40). The regex non-greedy match
      // terminates at the first </script[^>]*> it encounters, which may be a
      // fake one embedded in a string literal, leaking the subsequent content.
      const payload = '<p>Safe</p><script>var x = "</script type=text>"; alert(1);</script>';
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
        expect(data.raw_text).not.toContain('alert(1)');
        expect(data.raw_text).toContain('Safe');
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
    // A minimal, valid text-layer PDF with known content. Guards against the
    // pdf-parse v1→v2 API regression where the library was called as a function
    // (v1) on a class export (v2), making every PDF throw and be misreported as
    // "image-only". See issue #770.
    async function readSampleReceiptPdfBase64(): Promise<string> {
      const fixturePath = path.join(import.meta.dirname, '__fixtures__', 'sample-receipt.pdf');
      const buffer = await fs.readFile(fixturePath);
      return buffer.toString('base64');
    }

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

    it('extracts the text layer from a real text-based PDF (extract_as: raw)', async () => {
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: await readSampleReceiptPdfBase64(),
        mime_type: 'application/pdf',
        extract_as: 'raw',
      }, makeInfraLlm('{}')));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('pdf');
        expect(result.data.raw_text).toContain('Acme Corp');
        expect(result.data.raw_text).toContain('123.45');
        expect(result.data.confidence).toBeGreaterThan(0);
      }
    });

    it('flags a no-text-layer PDF with a machine-readable reason, not an LLM call', async () => {
      const infraLlm = makeInfraLlm('{}');
      const handler = new FileParseHandler();
      const fixturePath = path.join(import.meta.dirname, '__fixtures__', 'no-text-layer.pdf');
      const content = (await fs.readFile(fixturePath)).toString('base64');
      const result = await handler.execute(makeCtx({
        content_base64: content,
        mime_type: 'application/pdf',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.raw_text).toBe('');
        expect(data.confidence).toBe(0);
        expect(data.reason).toBe('no_text_layer');
      }
      // A PDF with no text layer must not be shipped to the LLM as junk.
      expect(infraLlm.extract).not.toHaveBeenCalled();
    });

    it('passes extracted PDF text to the LLM for structured extraction', async () => {
      const infraLlm = makeInfraLlm('{"vendor":"Acme Corp","amount":"123.45"}');
      const handler = new FileParseHandler();
      const result = await handler.execute(makeCtx({
        content_base64: await readSampleReceiptPdfBase64(),
        mime_type: 'application/pdf',
        extract_as: 'receipt',
      }, infraLlm));

      expect(result.success).toBe(true);
      expect(infraLlm.extract).toHaveBeenCalledOnce();
      // The text layer (not an empty string) must reach the LLM prompt.
      const promptArg = (infraLlm.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(promptArg).toContain('123.45');
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

  describe('temp_file_url support', () => {
    const handler = new FileParseHandler();
    // Use /tmp/curia-tempfiles/ which is in the handler's allowed prefix list.
    // mkdtemp creates a uniquely-named subdirectory so the path is not
    // predictable — avoids the js/insecure-temporary-file CodeQL pattern.
    // The unique subdir still starts with /tmp/curia-tempfiles/ so it passes
    // the handler's allow-list check.
    const TEMPFILES_BASE = '/tmp/curia-tempfiles';
    let tempDir: string;
    let testFilePath: string;

    beforeAll(async () => {
      await fs.mkdir(TEMPFILES_BASE, { recursive: true });
      tempDir = await fs.mkdtemp(path.join(TEMPFILES_BASE, 'test-'));
      testFilePath = path.join(tempDir, 'test-file.csv');
      await fs.writeFile(testFilePath, 'vendor,amount\nAcme,50.00');
    });

    afterAll(async () => {
      if (tempDir) {
        try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
      }
    });

    it('reads file from temp_file_url when content_base64 is empty', async () => {
      const result = await handler.execute(makeCtx({
        content_base64: '',
        temp_file_url: `file://${testFilePath}`,
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { type: string; structured: Array<Record<string, string>> };
        expect(data.type).toBe('csv');
        expect(data.structured).toEqual([{ vendor: 'Acme', amount: '50.00' }]);
      }
    });

    it('reads file from temp_file_url when content_base64 is absent', async () => {
      const result = await handler.execute(makeCtx({
        temp_file_url: `file://${testFilePath}`,
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { type: string; structured: Array<Record<string, string>> };
        expect(data.type).toBe('csv');
        expect(data.structured).toEqual([{ vendor: 'Acme', amount: '50.00' }]);
      }
    });

    it('prefers content_base64 over temp_file_url when both are provided', async () => {
      const directCsv = 'name,value\nDirect,100';
      const result = await handler.execute(makeCtx({
        content_base64: Buffer.from(directCsv).toString('base64'),
        temp_file_url: `file://${testFilePath}`,
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { structured: Array<Record<string, string>> };
        // Should use content_base64, not the temp file
        expect(data.structured).toEqual([{ name: 'Direct', value: '100' }]);
      }
    });

    it('rejects temp_file_url outside allowed directories', async () => {
      const result = await handler.execute(makeCtx({
        temp_file_url: 'file:///etc/passwd',
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/invalid temp_file_url/i);
    });

    it('rejects temp_file_url with path traversal', async () => {
      const result = await handler.execute(makeCtx({
        temp_file_url: 'file:///tmp/curia-tempfiles/../../etc/passwd',
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/invalid temp_file_url/i);
    });

    it('rejects non-file:// URLs', async () => {
      const result = await handler.execute(makeCtx({
        temp_file_url: 'https://example.com/file.csv',
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/invalid temp_file_url/i);
    });

    it('returns error when temp file has been cleaned up', async () => {
      const result = await handler.execute(makeCtx({
        temp_file_url: 'file:///tmp/curia-tempfiles/nonexistent-file.csv',
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/expired|cleaned up/i);
        // Error should include remediation guidance for the calling agent
        expect(result.error).toMatch(/re-download/i);
      }
    });

    it('returns specific error for empty (0-byte) temp files', async () => {
      const emptyFilePath = path.join(tempDir, 'empty-file.csv');
      await fs.writeFile(emptyFilePath, '');
      try {
        const result = await handler.execute(makeCtx({
          temp_file_url: `file://${emptyFilePath}`,
          mime_type: 'text/csv',
        }, makeInfraLlm('{}')));
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toMatch(/empty.*0 bytes/i);
      } finally {
        await fs.unlink(emptyFilePath).catch(() => {});
      }
    });

    it('error message mentions temp_file_url as alternative when both inputs are missing', async () => {
      const result = await handler.execute(makeCtx({
        mime_type: 'text/csv',
      }, makeInfraLlm('{}')));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/temp_file_url/);
    });
  });
});
