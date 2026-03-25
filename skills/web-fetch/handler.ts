// handler.ts — web-fetch skill implementation.
//
// Fetches web pages via HTTP GET using Node's built-in fetch().
// Security constraints:
//   - Only HTTPS and HTTP protocols allowed (no file://, ftp://, etc.)
//   - Response body is truncated to prevent memory exhaustion
//   - Timeout is enforced by the execution layer (not duplicated here)
//
// This is a "normal" sensitivity skill — no human approval required.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Default max body length: 50KB. Enough for most web pages when truncated.
const DEFAULT_MAX_LENGTH = 50000;

export class WebFetchHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { url, max_length } = ctx.input as { url?: string; max_length?: number };

    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Missing required input: url (string)' };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { success: false, error: `Only HTTP and HTTPS protocols are allowed, got: ${parsedUrl.protocol}` };
    }

    const maxLength = typeof max_length === 'number' ? max_length : DEFAULT_MAX_LENGTH;

    ctx.log.info({ url, maxLength }, 'Fetching web page');

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Curia/1.0 (AI Executive Assistant)',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        };
      }

      let body = await response.text();
      const contentType = response.headers.get('content-type') ?? 'unknown';

      if (body.length > maxLength) {
        body = body.slice(0, maxLength) + '[truncated]';
      }

      return {
        success: true,
        data: {
          body,
          status: response.status,
          content_type: contentType,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, url }, 'Fetch failed');
      return { success: false, error: `Fetch failed: ${message}` };
    }
  }
}
