// handler.ts — file-parse skill.
//
// General-purpose document parser. Dispatches by content type:
// - CSV: deterministic parser (no LLM)
// - Image: InfraLlm vision (passes base64 image blocks)
// - PDF: pdf-parse text extraction, then optional LLM structuring
// - HTML: tag stripping, then optional LLM structuring
//
// All LLM calls go through the constrained InfraLlm service (classify + extract
// only) so costs and latency are tracked by the telemetry infrastructure.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';

// pdf-parse is CJS-only and doesn't provide a default ESM export.
// Use createRequire to load it reliably under Node ESM + tsx.
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as typeof import('pdf-parse');
import { parseCsv } from './csv.js';
import { getExtractionPrompt, type ExtractAs } from './prompts.js';

// MIME types we support, mapped to our internal content categories.
const MIME_MAP: Record<string, 'csv' | 'pdf' | 'image' | 'html'> = {
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'text/html': 'html',
};

// extract_as is open-ended: 'receipt', 'bank_statement', 'invoice' have tailored prompts;
// 'raw' opts out of LLM extraction; any other non-empty string gets a generic prompt.
// See prompts.ts — agents can define new document types without modifying this file.

export class FileParseHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.infraLlm) {
      ctx.log.error('file-parse: infraLlm capability missing — execution layer misconfigured');
      return { success: false, error: 'file-parse requires infraLlm capability' };
    }
    const infraLlm = ctx.infraLlm;

    // --- Input validation ---
    let contentBase64 = typeof ctx.input.content_base64 === 'string'
      ? ctx.input.content_base64.trim() : '';
    const tempFileUrl = typeof ctx.input.temp_file_url === 'string'
      ? ctx.input.temp_file_url.trim() : '';
    const mimeType = typeof ctx.input.mime_type === 'string'
      ? ctx.input.mime_type.trim().toLowerCase() : '';
    const extractAs = typeof ctx.input.extract_as === 'string'
      ? ctx.input.extract_as.trim().toLowerCase() as ExtractAs : 'raw';

    // When temp_file_url is provided but content_base64 is not, read the file from
    // disk. This bridges the gap with ceo-inbox-download-attachment which omits
    // content_base64 when temp storage is available (to avoid output size limits).
    if (!contentBase64 && tempFileUrl) {
      const resolved = this.resolveTempFileUrl(tempFileUrl);
      if (!resolved) {
        return { success: false, error: 'Invalid temp_file_url: must be a file:// URL under the temp store directory' };
      }
      try {
        const fileBuffer = await fs.readFile(resolved);
        contentBase64 = fileBuffer.toString('base64');
        ctx.log.info(
          { tempFileUrl, bytes: fileBuffer.length },
          'file-parse: read content from temp_file_url (content_base64 was empty)',
        );
      } catch (err) {
        ctx.log.error({ err, tempFileUrl }, 'file-parse: failed to read temp file');
        return { success: false, error: 'Failed to read file from temp_file_url — file may have expired' };
      }
    }

    if (!contentBase64) {
      return { success: false, error: 'Missing required input: content_base64 (or provide temp_file_url)' };
    }
    if (!mimeType) {
      return { success: false, error: 'Missing required input: mime_type' };
    }

    const contentType = MIME_MAP[mimeType];
    if (!contentType) {
      return { success: false, error: `Unsupported mime_type: ${mimeType}. Supported: ${Object.keys(MIME_MAP).join(', ')}` };
    }
    // Only reject empty strings — any non-empty extract_as is valid.
    // Known schemas get tailored prompts; unknown strings get a generic prompt.
    if (!extractAs) {
      return { success: false, error: 'Invalid extract_as: value must be a non-empty string (e.g. receipt, bank_statement, invoice, raw, or a custom schema name)' };
    }

    try {
      const buffer = Buffer.from(contentBase64, 'base64');

      switch (contentType) {
        case 'csv':
          return this.handleCsv(buffer);
        case 'image':
          return await this.handleImage(ctx, infraLlm, contentBase64, mimeType, extractAs);
        case 'pdf':
          return await this.handlePdf(ctx, infraLlm, buffer, extractAs);
        case 'html':
          return await this.handleHtml(ctx, infraLlm, buffer, extractAs);
      }
    } catch (err) {
      ctx.log.error({ err, mimeType }, 'file-parse: unexpected error');
      return { success: false, error: 'file-parse failed unexpectedly' };
    }
  }

  // --- CSV: deterministic, no LLM ---

  private handleCsv(buffer: Buffer): SkillResult {
    const text = buffer.toString('utf-8');
    const rows = parseCsv(text);
    return {
      success: true,
      data: {
        type: 'csv',
        raw_text: text,
        structured: rows,
        confidence: 1.0,
      },
    };
  }

  // --- Image: InfraLlm vision ---

  private async handleImage(
    ctx: SkillContext,
    infraLlm: InfraLlm,
    contentBase64: string,
    mimeType: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);

    // For 'raw', ask for a plain text transcription of the image
    const textPrompt = prompt
      ?? 'Transcribe all visible text from this image. Return the text verbatim, preserving layout where possible.';

    // Normalize the non-standard image/jpg alias to the IANA-registered image/jpeg.
    // The Anthropic API only accepts the canonical MIME types.
    const normalizedMimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

    const result = await infraLlm.extract(textPrompt, {
      maxTokens: 4000,
      image: { base64: contentBase64, mediaType: normalizedMimeType },
    });

    if (!result.ok) {
      ctx.log.error({ error: result.error }, 'file-parse: Claude vision extraction failed');
      return { success: false, error: 'Failed to extract content from image' };
    }

    if (!result.text) {
      ctx.log.warn('file-parse: vision API returned no text content');
      return { success: true, data: { type: 'image', raw_text: '', structured: null, confidence: 0 } };
    }

    return this.buildResult(ctx, 'image', result.text, extractAs, prompt !== null);
  }

  // --- PDF: text extraction + optional LLM structuring ---

  private async handlePdf(
    ctx: SkillContext,
    infraLlm: InfraLlm,
    buffer: Buffer,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    let rawText: string;
    try {
      const parsed = await pdfParse(buffer);
      rawText = parsed.text;
    } catch (err) {
      ctx.log.error({ err }, 'file-parse: PDF text extraction failed');
      return { success: false, error: 'Failed to extract text from PDF — file may be corrupt or image-only' };
    }

    if (!rawText.trim()) {
      // Image-only PDF — no text layer. Return with guidance.
      return {
        success: true,
        data: {
          type: 'pdf',
          raw_text: '',
          structured: null,
          confidence: 0,
        },
      };
    }

    if (extractAs === 'raw') {
      return { success: true, data: { type: 'pdf', raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    // Run LLM extraction on the text
    return await this.extractStructured(ctx, infraLlm, 'pdf', rawText, extractAs);
  }

  // --- HTML: tag stripping + optional LLM structuring ---

  private async handleHtml(
    ctx: SkillContext,
    infraLlm: InfraLlm,
    buffer: Buffer,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const html = buffer.toString('utf-8');
    const rawText = stripHtmlTags(html);

    if (extractAs === 'raw') {
      return { success: true, data: { type: 'html', raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    return await this.extractStructured(ctx, infraLlm, 'html', rawText, extractAs);
  }

  // --- Shared: LLM-based structured extraction from text ---

  private async extractStructured(
    ctx: SkillContext,
    infraLlm: InfraLlm,
    type: 'pdf' | 'html',
    rawText: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);
    if (!prompt) {
      // Should not happen — 'raw' is handled before this call
      return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    const result = await infraLlm.extract(
      `${prompt}\n\nDocument text:\n${rawText}`,
      { maxTokens: 4000 },
    );

    if (!result.ok) {
      ctx.log.error({ error: result.error, extractAs }, 'file-parse: LLM structured extraction failed');
      return { success: false, error: `Failed to extract structured data as ${extractAs}` };
    }

    if (!result.text) {
      ctx.log.warn('file-parse: LLM extraction returned no text content');
      return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 0 } };
    }

    return this.buildResult(ctx, type, result.text, extractAs, true, rawText);
  }

  // --- Result builder: parse LLM output into structured data ---

  private buildResult(
    ctx: SkillContext,
    type: 'csv' | 'pdf' | 'image' | 'html',
    llmText: string,
    extractAs: ExtractAs,
    isStructured: boolean,
    rawTextOverride?: string,
  ): SkillResult {
    if (!isStructured) {
      // raw text extraction (e.g. image transcription)
      return { success: true, data: { type, raw_text: llmText, structured: null, confidence: 0.8 } };
    }

    // Try to parse the LLM response as JSON
    try {
      // Extract JSON from the LLM response. The LLM may wrap it in markdown fences
      // despite instructions; the capture-group approach handles prose before/after the block.
      const fenceMatch = llmText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      const cleaned = (fenceMatch ? fenceMatch[1] : llmText).trim();
      const structured = JSON.parse(cleaned);
      return {
        success: true,
        data: {
          type,
          raw_text: rawTextOverride ?? llmText,
          structured,
          confidence: 0.85,
        },
      };
    } catch (err) {
      // LLM returned non-JSON — return with low confidence so the caller can surface
      // this to the user for manual review.
      ctx.log.warn({ err, type, extractAs }, 'file-parse: LLM response was not valid JSON; returning low-confidence result');
      return {
        success: true,
        data: {
          type,
          raw_text: rawTextOverride ?? llmText,
          structured: null,
          confidence: 0.2,
        },
      };
    }
  }

  /**
   * Validate and resolve a file:// URL to an absolute filesystem path.
   * Only allows paths under known temp store directories to prevent path traversal.
   * Returns null if the URL is invalid or points outside the allowed directories.
   */
  private resolveTempFileUrl(url: string): string | null {
    if (!url.startsWith('file://')) return null;

    const filePath = path.resolve(url.slice('file://'.length));

    // Allow paths under the production tmpfs mount or the /tmp fallback (local dev).
    // Both are restricted directories where only TempFileStore writes.
    const allowedPrefixes = ['/run/curia-tempfiles/', '/tmp/curia-tempfiles/'];
    const allowed = allowedPrefixes.some((prefix) => filePath.startsWith(prefix));
    if (!allowed) return null;

    return filePath;
  }
}

/** Strip HTML tags and decode common entities. Lightweight, no dependency. */
function stripHtmlTags(html: string): string {
  let text = html;

  // Strip <script> and <style> blocks including their content. Loop until the
  // string stops changing to prevent nested-substitution bypass: a crafted
  // input like <scri<script>X</script>pt>…<scri<script>Y</script>pt> causes the
  // g-flag replace to strip both inner blocks simultaneously, leaving the outer
  // fragments to merge into <script>…</script>. A second pass catches that.
  // \s* before the closing > handles whitespace-padded tags like </script >.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  }

  // Strip all complete HTML tags (< ... >).
  text = text.replace(/<[^>]+>/g, ' ');

  // Strip incomplete tags — bare <tagname without a closing > cannot be caught
  // by <[^>]+> above (which requires >). Loop until stable: stripping a complete
  // inner tag can expose a bare <script fragment from a nested pattern.
  // {0,500} caps match length to prevent consuming large text bodies on inputs
  // with a lone < far from any >.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<[a-zA-Z][^>]{0,500}/g, ' ');
  }

  // Decode HTML entities.
  // Order matters: &amp; must be decoded LAST to prevent double-decoding.
  // Decoding &amp; first turns &amp;lt; into &lt;, which then decodes to <,
  // smuggling a literal < through (js/double-escaping).
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
