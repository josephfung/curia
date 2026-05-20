// handler.ts — file-parse skill.
//
// General-purpose document parser. Dispatches by content type:
// - CSV: deterministic parser (no LLM)
// - Image: LLMProvider vision (passes base64 image blocks)
// - PDF: pdf-parse text extraction, then optional LLM structuring
// - HTML: tag stripping, then optional LLM structuring
//
// All LLM calls go through the shared LLMProvider + ModelRouter so costs and
// latency are tracked by the telemetry infrastructure.

import { createRequire } from 'node:module';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { Message } from '../../src/agents/llm/provider.js';

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

/**
 * Image content block for vision calls. The shared LLMProvider.Message interface
 * uses ContentBlock for multi-content messages; image blocks are a superset used
 * only in file-parse. We define it locally and cast as needed. The underlying
 * Anthropic implementation accepts these shapes even though the interface doesn't
 * formally declare them — tracked as a future provider.ts extension.
 *
 * @TODO Extend the ContentBlock union in src/agents/llm/provider.ts to include
 * ImageContent natively so callers don't need local casts.
 */
interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    data: string;
  };
}

export class FileParseHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.llmProvider || !ctx.modelRouter) {
      return { success: false, error: 'file-parse requires llmProvider and modelRouter capabilities' };
    }

    // --- Input validation ---
    const contentBase64 = typeof ctx.input.content_base64 === 'string'
      ? ctx.input.content_base64.trim() : '';
    const mimeType = typeof ctx.input.mime_type === 'string'
      ? ctx.input.mime_type.trim().toLowerCase() : '';
    const extractAs = typeof ctx.input.extract_as === 'string'
      ? ctx.input.extract_as.trim().toLowerCase() as ExtractAs : 'raw';

    if (!contentBase64) {
      return { success: false, error: 'Missing required input: content_base64' };
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

    // Resolve the standard-tier model once for any LLM calls below.
    const extractionModel = ctx.modelRouter.resolve('standard').model;

    try {
      const buffer = Buffer.from(contentBase64, 'base64');

      switch (contentType) {
        case 'csv':
          return this.handleCsv(buffer);
        case 'image':
          return await this.handleImage(ctx, extractionModel, contentBase64, mimeType, extractAs);
        case 'pdf':
          return await this.handlePdf(ctx, extractionModel, buffer, extractAs);
        case 'html':
          return await this.handleHtml(ctx, extractionModel, buffer, extractAs);
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

  // --- Image: LLMProvider vision ---

  private async handleImage(
    ctx: SkillContext,
    extractionModel: string,
    contentBase64: string,
    mimeType: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);

    // For 'raw', ask for a plain text transcription of the image
    const textPrompt = prompt
      ?? 'Transcribe all visible text from this image. Return the text verbatim, preserving layout where possible.';

    // Normalize the non-standard image/jpg alias to the IANA-registered image/jpeg.
    // The Anthropic API only accepts the canonical MIME types; passing image/jpg would
    // produce an API error at runtime despite the TypeScript cast.
    const normalizedMimeType = (mimeType === 'image/jpg' ? 'image/jpeg' : mimeType) as ImageContent['source']['media_type'];

    // Image blocks are not yet in the shared ContentBlock union — cast via unknown.
    // @TODO Remove this cast once ImageContent is added to provider.ts ContentBlock.
    const imageMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizedMimeType,
            data: contentBase64,
          },
        } as unknown as ReturnType<typeof Object>,
        { type: 'text', text: textPrompt },
      ] as Message['content'],
    };

    const response = await ctx.llmProvider!.chat({
      model: extractionModel,
      messages: [imageMessage],
      options: { max_tokens: 4000 },
    });

    if (response.type === 'error') {
      ctx.log.error({ error: response.error }, 'file-parse: Claude vision extraction failed');
      return { success: false, error: 'Failed to extract content from image' };
    }

    if (!response.content) {
      ctx.log.warn('file-parse: vision API returned no text content');
      return { success: true, data: { type: 'image', raw_text: '', structured: null, confidence: 0 } };
    }

    return this.buildResult(ctx, 'image', response.content, extractAs, prompt !== null);
  }

  // --- PDF: text extraction + optional LLM structuring ---

  private async handlePdf(
    ctx: SkillContext,
    extractionModel: string,
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
    return await this.extractStructured(ctx, extractionModel, 'pdf', rawText, extractAs);
  }

  // --- HTML: tag stripping + optional LLM structuring ---

  private async handleHtml(
    ctx: SkillContext,
    extractionModel: string,
    buffer: Buffer,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const html = buffer.toString('utf-8');
    const rawText = stripHtmlTags(html);

    if (extractAs === 'raw') {
      return { success: true, data: { type: 'html', raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    return await this.extractStructured(ctx, extractionModel, 'html', rawText, extractAs);
  }

  // --- Shared: LLM-based structured extraction from text ---

  private async extractStructured(
    ctx: SkillContext,
    extractionModel: string,
    type: 'pdf' | 'html',
    rawText: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);
    if (!prompt) {
      // Should not happen — 'raw' is handled before this call
      return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    const response = await ctx.llmProvider!.chat({
      model: extractionModel,
      messages: [{
        role: 'user',
        content: `${prompt}\n\nDocument text:\n${rawText}`,
      }],
      options: { max_tokens: 4000 },
    });

    if (response.type === 'error') {
      ctx.log.error({ error: response.error, extractAs }, 'file-parse: LLM structured extraction failed');
      return { success: false, error: `Failed to extract structured data as ${extractAs}` };
    }

    if (!response.content) {
      ctx.log.warn('file-parse: LLM extraction returned no text content');
      return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 0 } };
    }

    return this.buildResult(ctx, type, response.content, extractAs, true, rawText);
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
    } catch {
      // LLM returned non-JSON — return with low confidence so the caller can surface
      // this to the user for manual review. Log at debug so repeated occurrences are visible.
      ctx.log.debug({ type, extractAs }, 'file-parse: LLM response was not valid JSON; returning low-confidence result');
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
}

/** Strip HTML tags and decode common entities. Lightweight, no dependency. */
function stripHtmlTags(html: string): string {
  // nosemgrep: js/incomplete-multi-character-sanitization — incomplete tags caught by /<[a-zA-Z][^>]{0,500}/g below
  return html
    // Strip <script> and <style> blocks including their content.
    // \s* before the closing > handles whitespace-padded closing tags like </script >
    // which the original pattern (</script>) did not match (js/bad-tag-filter).
    // nosemgrep: js/bad-tag-filter — \s* handles whitespace before >; attribute-bearing closing tags like </script bar> are invalid HTML
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    // Strip all complete HTML tags (< ... >).
    .replace(/<[^>]+>/g, ' ')
    // Strip incomplete tags — bare <tagname without a closing > cannot be caught by
    // <[^>]+> above (which requires >). This prevents <script fragments from leaking
    // into the extracted text. {0,500} caps match length to prevent stripping large
    // text bodies on inputs with a lone < far from any > (js/incomplete-multi-character-sanitization).
    .replace(/<[a-zA-Z][^>]{0,500}/g, ' ')
    // Decode HTML entities.
    // Order matters: &amp; must be decoded LAST to prevent double-decoding.
    // Decoding &amp; first turns &amp;lt; into &lt;, which then decodes to <,
    // smuggling a literal < through (js/double-escaping).
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
