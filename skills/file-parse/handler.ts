// handler.ts — file-parse skill.
//
// General-purpose document parser. Dispatches by content type:
// - CSV: deterministic parser (no LLM)
// - Image: Claude vision API
// - PDF: pdf-parse text extraction, then optional LLM structuring
// - HTML: tag stripping, then optional LLM structuring

import Anthropic from '@anthropic-ai/sdk';
import pdfParse from 'pdf-parse';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { parseCsv } from './csv.js';
import { getExtractionPrompt, type ExtractAs } from './prompts.js';

const EXTRACTION_MODEL = 'claude-sonnet-4-6';

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
  constructor(private readonly anthropicClient?: Anthropic) {}

  async execute(ctx: SkillContext): Promise<SkillResult> {
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

    try {
      const buffer = Buffer.from(contentBase64, 'base64');

      switch (contentType) {
        case 'csv':
          return this.handleCsv(buffer);
        case 'image':
          return await this.handleImage(ctx, contentBase64, mimeType, extractAs);
        case 'pdf':
          return await this.handlePdf(ctx, buffer, extractAs);
        case 'html':
          return await this.handleHtml(ctx, buffer, extractAs);
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

  // --- Image: Claude vision ---

  private async handleImage(
    ctx: SkillContext,
    contentBase64: string,
    mimeType: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);
    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    // For 'raw', ask for a plain text transcription of the image
    const textPrompt = prompt
      ?? 'Transcribe all visible text from this image. Return the text verbatim, preserving layout where possible.';

    // Normalize the non-standard image/jpg alias to the IANA-registered image/jpeg.
    // The Anthropic API only accepts the canonical MIME types; passing image/jpg would
    // produce an API error at runtime despite the TypeScript cast.
    const normalizedMimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

    try {
      const response = await client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: normalizedMimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: contentBase64,
              },
            },
            { type: 'text', text: textPrompt },
          ],
        }],
      });

      const textBlock = response.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!textBlock) {
        ctx.log.warn('file-parse: vision API returned no text block');
        return { success: true, data: { type: 'image', raw_text: '', structured: null, confidence: 0 } };
      }

      return this.buildResult(ctx, 'image', textBlock.text, extractAs, prompt !== null);
    } catch (err) {
      ctx.log.error({ err }, 'file-parse: Claude vision extraction failed');
      return { success: false, error: 'Failed to extract content from image' };
    }
  }

  // --- PDF: text extraction + optional LLM structuring ---

  private async handlePdf(
    ctx: SkillContext,
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
    return await this.extractStructured(ctx, 'pdf', rawText, extractAs);
  }

  // --- HTML: tag stripping + optional LLM structuring ---

  private async handleHtml(
    ctx: SkillContext,
    buffer: Buffer,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const html = buffer.toString('utf-8');
    const rawText = stripHtmlTags(html);

    if (extractAs === 'raw') {
      return { success: true, data: { type: 'html', raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    return await this.extractStructured(ctx, 'html', rawText, extractAs);
  }

  // --- Shared: LLM-based structured extraction from text ---

  private async extractStructured(
    ctx: SkillContext,
    type: 'pdf' | 'html',
    rawText: string,
    extractAs: ExtractAs,
  ): Promise<SkillResult> {
    const prompt = getExtractionPrompt(extractAs);
    if (!prompt) {
      // Should not happen — 'raw' is handled before this call
      return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 1.0 } };
    }

    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    try {
      const response = await client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `${prompt}\n\nDocument text:\n${rawText}`,
        }],
      });

      const textBlock = response.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!textBlock) {
        ctx.log.warn('file-parse: LLM extraction returned no text block');
        return { success: true, data: { type, raw_text: rawText, structured: null, confidence: 0 } };
      }

      return this.buildResult(ctx, type, textBlock.text, extractAs, true, rawText);
    } catch (err) {
      ctx.log.error({ err, extractAs }, 'file-parse: LLM structured extraction failed');
      return { success: false, error: `Failed to extract structured data as ${extractAs}` };
    }
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
