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

// Hostnames and IP patterns that must be blocked to prevent SSRF.
// The LLM controls the URL, so this is a security boundary.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  // AWS/GCP/Azure metadata endpoints
  '169.254.169.254',
  'metadata.google.internal',
]);

/**
 * Check if a hostname points to a private/reserved IP range or cloud metadata endpoint.
 * Used to prevent SSRF attacks where the LLM is tricked into probing internal services.
 */
function isPrivateHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;

  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;           // loopback
  if (/^10\./.test(hostname)) return true;            // Class A private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // Class B private
  if (/^192\.168\./.test(hostname)) return true;      // Class C private
  if (/^169\.254\./.test(hostname)) return true;      // link-local

  // IPv6 loopback and link-local
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) return true;

  return false;
}

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

    // SSRF protection: block requests to private/reserved IP ranges and cloud
    // metadata endpoints. The LLM controls the URL input, so an attacker could
    // use prompt injection to probe internal services or exfiltrate cloud credentials.
    const hostname = parsedUrl.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
      return { success: false, error: `Blocked: requests to internal/private addresses are not allowed (${hostname})` };
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
