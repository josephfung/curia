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
import type { Node, HTMLElement as HtmlElement } from 'node-html-parser';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';

// CJS-only deps: load via createRequire so the CJS build is used reliably under
// Node ESM + tsx/vitest (Vite's ESM/CJS interop can lose named exports).
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
const { parse, NodeType } = require('node-html-parser') as typeof import('node-html-parser');
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
      const resolved = await this.resolveTempFileUrl(tempFileUrl);
      if (!resolved) {
        ctx.log.warn({ tempFileUrl }, 'file-parse: rejected temp_file_url — must be file:// under allowed prefix');
        return { success: false, error: 'Invalid temp_file_url: must be a file:// URL under the temp store directory' };
      }
      try {
        const fileBuffer = await fs.readFile(resolved);
        if (fileBuffer.length === 0) {
          ctx.log.error({ tempFileUrl }, 'file-parse: temp file exists but is empty (0 bytes)');
          return { success: false, error: 'Temp file at temp_file_url is empty (0 bytes) — file may have been corrupted or partially written' };
        }
        contentBase64 = fileBuffer.toString('base64');
        ctx.log.info(
          { tempFileUrl, bytes: fileBuffer.length },
          'file-parse: read content from temp_file_url (content_base64 was empty)',
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        ctx.log.error({ err, tempFileUrl, errCode: code }, 'file-parse: failed to read temp file');
        if (code === 'ENOENT') {
          return { success: false, error: 'Failed to read file from temp_file_url — temp file has expired or been cleaned up. Re-download the attachment to get a fresh temp_file_url.' };
        }
        return { success: false, error: `Failed to read file from temp_file_url — filesystem error (${code ?? 'unknown'})` };
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
      const parser = new PDFParse({ data: buffer });
      try {
        // pageJoiner: '' suppresses pdf-parse v2's default "-- N of M --" page
        // markers. Without this, a text-less PDF yields marker noise instead of
        // an empty string (defeating the image-only check below), and extracted
        // text is polluted with separators.
        const parsed = await parser.getText({ pageJoiner: '' });
        rawText = parsed.text ?? '';
      } finally {
        // Release the pdfjs worker/resources, but never let a cleanup failure
        // overwrite a real extraction error (or a good result) on the way out.
        await parser.destroy().catch((destroyErr) => {
          ctx.log.warn({ err: destroyErr }, 'file-parse: PDF parser cleanup failed');
        });
      }
    } catch (err) {
      ctx.log.error({ err }, 'file-parse: PDF text extraction failed');
      return { success: false, error: 'Failed to extract text from PDF — the file may be corrupt or unreadable' };
    }

    if (!rawText.trim()) {
      // No extractable text layer: a genuinely scanned/image-only PDF (or one
      // whose fonts carry no extractable text). Parsing succeeded but yielded
      // nothing — distinct from the extraction *error* above. `reason` gives the
      // caller a machine-readable fact so it reports the cause instead of
      // inferring one from an empty string.
      return {
        success: true,
        data: {
          type: 'pdf',
          raw_text: '',
          structured: null,
          confidence: 0,
          reason: 'no_text_layer',
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
   * Resolves symlinks to prevent symlink-based escape from the allowed directory.
   * Returns null if the URL is invalid or points outside the allowed directories.
   */
  private async resolveTempFileUrl(url: string): Promise<string | null> {
    if (!url.startsWith('file://')) return null;

    const filePath = path.resolve(url.slice('file://'.length));

    // Allow paths under the production tmpfs mount or the /tmp fallback (local dev).
    // Both are restricted directories where only TempFileStore writes.
    // Include CURIA_TEMPFILE_DIR if set, so this stays in sync with TempFileStore config.
    const allowedPrefixes = ['/run/curia-tempfiles/', '/tmp/curia-tempfiles/'];
    const customDir = process.env.CURIA_TEMPFILE_DIR;
    if (customDir) {
      const normalized = path.resolve(customDir);
      allowedPrefixes.push(normalized.endsWith('/') ? normalized : normalized + '/');
    }
    const logicallyAllowed = allowedPrefixes.some((prefix) => filePath.startsWith(prefix));
    if (!logicallyAllowed) return null;

    // Resolve symlinks to prevent a symlink inside the allowed directory from
    // pointing to files outside it (e.g. ln -s /etc/shadow /tmp/curia-tempfiles/x).
    let realPath: string;
    try {
      realPath = await fs.realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — return the logical path and let the
        // caller's fs.readFile produce the "expired" error message.
        return filePath;
      }
      // EACCES, EIO, etc. — can't verify the real path, reject the URL.
      // Don't fall back to the logical path since that would bypass the
      // symlink check on a path we couldn't resolve.
      return null;
    }

    // Resolve the prefix directories too — on macOS /tmp is a symlink to
    // /private/tmp, so both sides of the comparison must be resolved.
    const resolvedPrefixes = await Promise.all(
      allowedPrefixes.map(async (prefix) => {
        try {
          // realpath the directory (without trailing slash), then re-add it
          return await fs.realpath(prefix.slice(0, -1)) + '/';
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Unexpected error resolving a prefix dir — fall back to the
            // original string rather than failing the entire validation.
            // This is less security-critical since we control the prefix values.
          }
          return prefix;
        }
      }),
    );
    const allPrefixes = [...new Set([...allowedPrefixes, ...resolvedPrefixes])];
    const reallyAllowed = allPrefixes.some((prefix) => realPath.startsWith(prefix));
    if (!reallyAllowed) return null;

    return realPath;
  }
}

const BLOCK_ELEMENTS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'TD', 'TH', 'BLOCKQUOTE',
]);

/**
 * Collect raw text content from a parsed HTML node, skipping SCRIPT and STYLE
 * elements. Uses `rawText` (not decoded `.text`) so entity decoding can happen
 * in a controlled order after tag-like fragments are stripped.
 */
function buildPlainText(node: Node, buf: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    buf.push(node.rawText);
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;

  const el = node as HtmlElement;
  const tag = el.tagName as string | undefined;
  if (!tag) {
    for (const child of el.childNodes) buildPlainText(child, buf);
    return;
  }

  // Drop script and style blocks entirely (tag + content)
  if (tag === 'SCRIPT' || tag === 'STYLE') return;

  if (tag === 'BR') { buf.push('\n'); return; }

  for (const child of el.childNodes) buildPlainText(child, buf);

  if (BLOCK_ELEMENTS.has(tag)) buf.push('\n');
}

/**
 * Strip HTML tags from a string and decode common entities.
 *
 * Uses a proper HTML parser (node-html-parser) to remove <script> and <style>
 * blocks, eliminating the regex-based tag-filtering bypass described in CodeQL
 * rule js/bad-tag-filter. The parser correctly handles cases where the script
 * body contains string literals that look like closing tags.
 */
function stripHtmlTags(html: string): string {
  // Normalize end tags with trailing whitespace only (e.g. </script >).
  // The HTML spec allows whitespace padding; node-html-parser requires `>` to follow immediately.
  // Only \s+ (not [^>]+) so fake closing tags like </script type=text> inside string literals
  // are left intact and not converted into real closing tags by this pass.
  const normalized = html.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s+>/g, '</$1>');

  const root = parse(normalized, { comment: false });
  const buf: string[] = [];
  buildPlainText(root, buf);
  let text = buf.join('');

  // Strip any tag-like fragments remaining in the raw text (e.g. from malformed
  // input where the parser left literal angle-bracket characters in text nodes).
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^>]+>/g, ' ');            // complete tag-like patterns
    text = text.replace(/<[a-zA-Z][^>]{0,500}/g, ' '); // incomplete trailing fragments
  }

  // Decode HTML entities. &amp; must come LAST to prevent double-decoding.
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
