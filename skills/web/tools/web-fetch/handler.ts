// handler.ts — web-fetch skill implementation.
//
// Fetches web pages via HTTP GET using Node's built-in fetch().
// Security constraints:
//   - Only HTTPS and HTTP protocols allowed (no file://, ftp://, etc.)
//   - Every hop, redirects included, must resolve to public addresses only (#2521)
//   - Google Docs, Sheets and Drive files are refused: they open through google-workspace
//   - Response body is truncated to prevent memory exhaustion
//   - Timeout is enforced by the execution layer (not duplicated here)
//
// This is a "normal" sensitivity skill — no human approval required.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { googleWorkspaceUrlError, isGoogleWorkspaceFileUrl, isGoogleWorkspaceLanding } from '../../../../src/skills/_shared/google-workspace-url.js';
import { WEB_FETCH_NOT_FOUND_LINES } from '../../../../src/agents/prompts/dead-end-guidance.js';
import { vetHost } from '../../../../src/browser/egress-proxy.js';
import sanitizeHtml from 'sanitize-html';
import net from 'node:net';
import undici from 'undici';

const WEB_FETCH_NOT_FOUND = WEB_FETCH_NOT_FOUND_LINES.join(' ');
const NO_READABLE_TEXT_NOTE = 'This fetch returned no readable text, which usually means the page is rendered by JavaScript or max_length cut it off. It says nothing about what the site offers. A real browser is needed: use web-browser if you have it, otherwise report that the page could not be read.';

// Elements whose text is not page content. sanitize-html's nonTextTags drops them with their text.
// Includes the instruction-like tags the execution layer's output sanitizer (src/skills/sanitize.ts)
// also drops with their text, so a page holding only such text is still flagged as empty.
const NON_CONTENT_TAGS = ['script', 'style', 'textarea', 'option', 'xmp', 'iframe', 'object', 'embed', 'applet', 'head', 'title', 'noscript', 'system', 'instruction', 'prompt', 'role'];

/** The text a reader would see in the page body: markup, head, title and noscript removed. */
function readableText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: NON_CONTENT_TAGS })
    .replace(/&nbsp;|\s/g, '');
}

// Default max body length: 50KB. Enough for most web pages when truncated.
const DEFAULT_MAX_LENGTH = 50000;

// Redirects are followed by hand, so each hop's host is checked before it is requested.
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * A `connect.lookup` for one hop that answers only from the addresses vetHost approved (#2521).
 * The connection then cannot reach an address the check did not see, whatever the name resolves
 * to by the time it connects. The URL keeps its hostname, so Host and TLS SNI are unchanged.
 */
export function pinnedLookup(addresses: readonly string[]) {
  const pinned = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return (_hostname: string, options: { all?: boolean; family?: number | string } | undefined, callback: LookupCallback): void => {
    // A caller that asks for one family gets that family or an error, never an unvetted fallback.
    const wanted = options?.family === 4 || options?.family === 'IPv4' ? 4 : options?.family === 6 || options?.family === 'IPv6' ? 6 : 0;
    const usable = wanted === 0 ? pinned : pinned.filter((p) => p.family === wanted);
    const first = usable[0];
    if (!first) {
      callback(Object.assign(new Error('no vetted address for this family'), { code: 'ENOTFOUND' }), []);
      return;
    }
    if (options?.all) callback(null, usable);
    else callback(null, first.address, first.family);
  };
}

/** A `--use-env-proxy` flag (or `--use-env-proxy=...`) among Node CLI arguments. */
function hasUseEnvProxyFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--use-env-proxy' || arg.startsWith('--use-env-proxy='));
}

/**
 * Whether Node routes fetch through the environment proxy. Node turns it on three ways: the
 * NODE_USE_ENV_PROXY variable, the `--use-env-proxy` flag on the command line (process.execArgv),
 * or the same flag in NODE_OPTIONS. Any of them counts.
 */
function envProxyEnabled(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
  const variable = env.NODE_USE_ENV_PROXY;
  if (variable && variable !== '0' && variable.toLowerCase() !== 'false') return true;
  if (hasUseEnvProxyFlag(execArgv)) return true;
  return hasUseEnvProxyFlag((env.NODE_OPTIONS ?? '').split(/\s+/));
}

/**
 * The proxy Node's fetch would send `url` through when environment-proxy routing is on, or null.
 * Each hop here connects directly to its vetted addresses (#2521), which would bypass such a proxy,
 * so a configured one makes the fetch refuse instead. NO_PROXY is not consulted: refusing a host it
 * excludes is the safe side, and Curia configures no proxy today.
 */
export function envProxyFor(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): string | null {
  if (!envProxyEnabled(env, execArgv)) return null;
  const proxy = url.protocol === 'https:'
    ? env.HTTPS_PROXY || env.https_proxy
    : env.HTTP_PROXY || env.http_proxy;
  return proxy ? proxy : null;
}

export class WebFetchHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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

    // A Google file gets only a sign-in page here; its tools are google-workspace's.
    if (isGoogleWorkspaceFileUrl(parsedUrl)) {
      ctx.log.info({ hostname }, 'web-fetch: refused a Google Workspace file URL');
      return { success: false, error: googleWorkspaceUrlError('web-fetch') };
    }

    const maxLength = typeof max_length === 'number' ? max_length : DEFAULT_MAX_LENGTH;

    ctx.log.info({ url, maxLength }, 'Fetching web page');

    const agents: InstanceType<typeof undici.Agent>[] = [];
    try {
      const signal = AbortSignal.timeout(10000);
      let current = parsedUrl;
      let response: Response;
      for (let hop = 0; ; hop++) {
        // Checked per hop: a redirect can change the scheme, and so which proxy variable applies.
        if (envProxyFor(current) !== null) {
          ctx.log.warn({ hostname: current.hostname, hop }, 'web-fetch: refused — an environment proxy is configured and pinned connections would bypass it');
          return { success: false, error: 'web-fetch cannot go through the configured HTTP proxy (NODE_USE_ENV_PROXY or --use-env-proxy); the request was not sent' };
        }
        // By resolved address, not just the name (#2521): a public name can point at an
        // internal address, and a redirect can send us anywhere. The hop then connects only
        // to the addresses just vetted, so the name cannot be rebound in between.
        const vetted = await vetHost(current.hostname);
        if (!vetted.ok) {
          ctx.log.warn({ hostname: current.hostname, hop }, 'web-fetch: refused a host that resolves privately or not at all');
          return { success: false, error: `Blocked: requests to internal/private addresses are not allowed, or the host did not resolve (${current.hostname})` };
        }
        const agent = new undici.Agent({ connect: { lookup: pinnedLookup(vetted.addresses) } });
        agents.push(agent);
        // `dispatcher` is undici's extension to fetch's init, absent from the DOM RequestInit type.
        response = await fetch(current, {
          headers: {
            'User-Agent': 'Curia/1.0 (AI Executive Assistant)',
          },
          signal,
          redirect: 'manual',
          dispatcher: agent,
        } as RequestInit);
        const location = response.headers.get('location');
        if (!REDIRECT_STATUSES.has(response.status) || !location) break;
        if (hop >= MAX_REDIRECTS) return { success: false, error: `Too many redirects (more than ${MAX_REDIRECTS})` };
        const next = new URL(location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return { success: false, error: `Blocked: a redirect to ${next.protocol} is not followed` };
        }
        await response.body?.cancel();
        current = next;
      }

      // Redirects are followed, so a short link can land on a Google file or its sign-in page.
      if (isGoogleWorkspaceLanding(response.url || current.href)) {
        ctx.log.info({ hostname }, 'web-fetch: a redirect landed on a Google Workspace file — refused');
        return { success: false, error: googleWorkspaceUrlError('web-fetch') };
      }

      // Pages reach the model without their links, so a 404 tends to start a run of
      // guessed paths on the same site (#2149). Say so with the failure.
      if (response.status === 404) {
        return { success: false, error: WEB_FETCH_NOT_FOUND };
      }

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        };
      }

      let body = await response.text();
      const contentType = response.headers.get('content-type') ?? 'unknown';

      const truncated = body.length > maxLength;
      if (truncated) body = body.slice(0, maxLength);

      // The execution layer strips markup after this returns, so raw HTML with no text in it
      // (a JS-rendered shell, or a max_length that ended inside <head>) reaches the model as
      // bare whitespace. A shell's <title> and <noscript> message are not page content either,
      // so judge the text without head, title and noscript (#2546).
      const hasReadableText = readableText(body).length > 0;
      if (truncated) body += '[truncated]';

      return {
        success: true,
        data: {
          body,
          status: response.status,
          content_type: contentType,
          ...(hasReadableText ? {} : { note: NO_READABLE_TEXT_NOTE }),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, url }, 'Fetch failed');
      return { success: false, error: `Fetch failed: ${message}` };
    } finally {
      // One agent per hop; the body has been read (or abandoned) by now.
      await Promise.allSettled(agents.map((a) => a.destroy()));
    }
  }
}
