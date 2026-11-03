// handler.ts — web-search skill implementation.
//
// Calls the Tavily search API and returns structured results for the LLM
// to synthesise. All synthesis happens in the agent's LLM — this skill is a
// data bridge, not an answer generator.
//
// Two search depths:
//   basic    — fast, returns title + snippet only. Good for simple lookups.
//   advanced — slower, extracts full page content. Good for research tasks.
//
// Keyless by default (#2445): with no tavily_api_key the request uses Tavily's
// free, rate-limited keyless mode. A key is an optional upgrade for higher limits.
//
// Security: the API key is resolved via ctx.secret() (declared in manifest),
// never passed through the LLM context. Content is truncated per result to
// avoid blowing out the LLM context window.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

// Max characters per result's content field — keeps LLM context manageable.
const MAX_CONTENT_LENGTH = 5000;

const TAVILY_API_URL = 'https://api.tavily.com/search';

// The execution layer's message for a declared secret with no value (src/skills/execution.ts).
// Only this case means "no key, search keyless"; any other throw is a real error.
const SECRET_ABSENT_MSG = 'is declared but not set in the environment';

// Selects Tavily's free, rate-limited keyless access (https://docs.tavily.com/documentation/keyless).
const KEYLESS_HEADER = 'X-Tavily-Access-Mode';

// Where an operator adds or replaces the key. Both paths take effect on the next search:
// the execution layer reads the vault on every invocation.
const UPGRADE_PATHS =
  'add one in the console (Settings → Tools → web), or ask Curia in chat to "add my Tavily key" for a secure link';

/**
 * Map a non-OK Tavily response to an error the agent can relay to the principal.
 *
 * Measured 2026-11-03 (#2445): the keyless cap is hourly (29 searches from one IP
 * succeeded, the 30th got HTTP 429 with a Retry-After header and a body whose code is
 * "hourly_cap_reached"). That body steers agents to x402 agentic payment, so we never
 * relay it — only our own text, which points at the free key. Keyed failures keep
 * Tavily's documented codes: 401/403 bad key, 432/433 plan or pay-as-you-go limit.
 */
function httpErrorMessage(response: Response, keyless: boolean): string {
  const status = response.status;
  if (keyless && status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const minutes = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter / 60) : null;
    const wait = minutes === null
      ? ' Searching works again within the hour.'
      : ` Searching works again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    return 'Web search is temporarily limited: Curia is searching without a Tavily API key, and the free hourly ' +
      `allowance is used up.${wait} A free Tavily key (tavily.com, 1,000 searches a month, no card) raises the ` +
      `limit — ${UPGRADE_PATHS}. Tell the principal this rather than reporting that nothing was found.`;
  }
  if (!keyless && (status === 401 || status === 403)) {
    return `Web search failed: Tavily rejected the API key (HTTP ${status}), so it is invalid or revoked. ` +
      `Replace it with a valid key from tavily.com — ${UPGRADE_PATHS}. Tell the principal this rather than ` +
      'reporting that nothing was found.';
  }
  if (!keyless && (status === 432 || status === 433)) {
    return `Web search failed: the Tavily account's usage limit is used up (HTTP ${status}). It resets with the ` +
      "plan's monthly credits, or the principal can raise the limit at app.tavily.com. Tell the principal this " +
      'rather than reporting that nothing was found.';
  }
  if (status === 429) {
    return 'Web search is temporarily rate-limited by Tavily (HTTP 429). Try again in a minute.';
  }
  return `Tavily returned HTTP ${status}: ${response.statusText || 'request failed'}`;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score: number;
}

interface TavilyResponse {
  // results may be absent if the API returns a malformed body
  results?: TavilyResult[];
}

interface NormalisedResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + '[truncated]';
}

export class WebSearchHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { query, maxResults, searchDepth } = ctx.input as {
      query?: string;
      maxResults?: number;
      searchDepth?: string;
    };

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return { success: false, error: 'Missing required input: query (non-empty string)' };
    }

    // Resolve the optional API key (#2445). ctx.secret() reads the vault first and
    // falls back to the TAVILY_API_KEY env var; it throws when neither has it. A
    // missing key is not an error: Tavily serves /search keyless (free, rate-limited),
    // so we search keyless and the key becomes an upgrade for higher limits.
    let apiKey: string | null;
    try {
      apiKey = ctx.secret('tavily_api_key');
    } catch (err) {
      // ctx.secret() throws for two very different reasons. A genuinely-missing secret
      // is a plain Error; a vault READ failure (DB down, decrypt error) is wrapped with
      // a `cause` by the execution layer (src/skills/execution.ts). An outage must not
      // silently downgrade a keyed install to keyless limits — it stays an error.
      if (err instanceof Error && err.cause !== undefined) {
        ctx.log.error({ err }, 'Failed to read Tavily API key from the vault');
        return {
          success: false,
          error: 'Web search unavailable: failed to read the Tavily API key from the secrets vault (operational error, not a missing key). Check vault/database connectivity.',
        };
      }
      // Anything other than "declared but not set" (e.g. the key dropped from the
      // manifest's `secrets`) is a programming error. Going keyless would hide it
      // behind lower limits on every keyed install.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(SECRET_ABSENT_MSG)) {
        ctx.log.error({ err }, 'Unexpected error resolving the Tavily API key');
        return { success: false, error: `Web search unavailable: could not resolve the Tavily API key (${message}).` };
      }
      apiKey = null;
    }
    const keyless = apiKey === null;

    if (searchDepth !== undefined && searchDepth !== 'basic' && searchDepth !== 'advanced') {
      ctx.log.warn({ searchDepth }, 'Unrecognised searchDepth value — defaulting to basic');
    }
    const depth = searchDepth === 'advanced' ? 'advanced' : 'basic';
    const limit = typeof maxResults === 'number' ? Math.min(maxResults, 20) : 5;

    ctx.log.info({ query, depth, limit, keyless }, 'Running web search via Tavily');

    let response: Response;
    try {
      response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        // Keyless mode is selected by header alone. It is never sent alongside a key:
        // a key would take precedence anyway, and leaving it off keeps keyed requests
        // exactly as they were before #2445.
        headers: keyless
          ? { 'Content-Type': 'application/json', [KEYLESS_HEADER]: 'keyless' }
          : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Tavily v1 API authenticates via api_key in the request body.
          ...(keyless ? {} : { api_key: apiKey }),
          query: query.trim(),
          max_results: limit,
          search_depth: depth,
          // Request raw_content for advanced depth — full extracted page text
          include_raw_content: depth === 'advanced',
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, query }, 'Tavily request failed');
      return { success: false, error: `Search failed: ${message}` };
    }

    if (!response.ok) {
      ctx.log.error({ query, status: response.status, statusText: response.statusText }, 'Tavily returned non-OK response');
      return { success: false, error: httpErrorMessage(response, keyless) };
    }

    let body: TavilyResponse;
    try {
      body = await response.json() as TavilyResponse;
    } catch (err) {
      ctx.log.error({ err, query }, 'Failed to parse Tavily JSON response');
      return { success: false, error: 'Failed to parse Tavily response as JSON' };
    }

    // Guard against malformed responses where results is missing or not an array.
    // A silent ?? [] fallback would return success with zero results, masking API bugs.
    if (!Array.isArray(body.results)) {
      ctx.log.error({ query, body }, 'Unexpected Tavily response shape — results field is not an array');
      return { success: false, error: 'Unexpected response from Tavily (results field missing or malformed)' };
    }

    // Normalise and truncate — use raw_content when available (advanced depth),
    // fall back to the snippet content field.
    // Use flatMap to skip null/malformed entries rather than throwing — a single
    // bad result from Tavily should not discard all the valid ones.
    const results: NormalisedResult[] = body.results.flatMap((r) => {
      if (!r || typeof r.title !== 'string' || typeof r.url !== 'string' || typeof r.score !== 'number') {
        ctx.log.warn({ r }, 'Skipping malformed Tavily result entry');
        return [];
      }
      const content = typeof r.raw_content === 'string' ? r.raw_content
        : (typeof r.content === 'string' ? r.content : '');
      return [{ title: r.title, url: r.url, content: truncate(content), score: r.score }];
    });

    ctx.log.info({ query, resultCount: results.length }, 'Web search complete');

    return {
      success: true,
      data: { results, count: results.length },
    };
  }
}
