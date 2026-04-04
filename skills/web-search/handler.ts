// handler.ts — web-search skill implementation.
//
// Calls the Tavily search API and returns structured results for the LLM
// to synthesise. All synthesis happens in Nathan's LLM — this skill is a
// data bridge, not an answer generator.
//
// Two search depths:
//   basic    — fast, returns title + snippet only. Good for simple lookups.
//   advanced — slower, extracts full page content. Good for research tasks.
//
// Security: the API key is resolved via ctx.secret() (declared in manifest),
// never passed through the LLM context. Content is truncated per result to
// avoid blowing out the LLM context window.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Max characters per result's content field — keeps LLM context manageable.
const MAX_CONTENT_LENGTH = 5000;

const TAVILY_API_URL = 'https://api.tavily.com/search';

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

export class WebSearchHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { query, maxResults, searchDepth } = ctx.input as {
      query?: string;
      maxResults?: number;
      searchDepth?: string;
    };

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return { success: false, error: 'Missing required input: query (non-empty string)' };
    }

    // Resolve API key — declared in manifest so secret() will allow it.
    // If the env var is not set, secret() throws — we surface that as a
    // user-readable error rather than letting the exception propagate.
    let apiKey: string;
    try {
      apiKey = ctx.secret('tavily_api_key');
    } catch (err) {
      ctx.log.error({ err }, 'Failed to resolve Tavily API key');
      return { success: false, error: 'Tavily API key not configured — set TAVILY_API_KEY in the environment' };
    }

    if (searchDepth !== undefined && searchDepth !== 'basic' && searchDepth !== 'advanced') {
      ctx.log.warn({ searchDepth }, 'Unrecognised searchDepth value — defaulting to basic');
    }
    const depth = searchDepth === 'advanced' ? 'advanced' : 'basic';
    const limit = typeof maxResults === 'number' ? Math.min(maxResults, 20) : 5;

    ctx.log.info({ query, depth, limit }, 'Running web search via Tavily');

    let response: Response;
    try {
      response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Send the API key in the Authorization header rather than the body
          // so it isn't captured by proxy logs or debug-level body logging.
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
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
      return {
        success: false,
        error: `Tavily returned HTTP ${response.status}: ${response.statusText || 'request failed'}`,
      };
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
    const results: NormalisedResult[] = body.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: truncate(r.raw_content ?? r.content ?? ''),
      score: r.score,
    }));

    ctx.log.info({ query, resultCount: results.length }, 'Web search complete');

    return {
      success: true,
      data: { results, count: results.length },
    };
  }
}
