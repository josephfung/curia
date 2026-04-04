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
  results: TavilyResult[];
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
    } catch {
      return { success: false, error: 'Tavily API key not configured — set TAVILY_API_KEY in the environment' };
    }

    const depth = searchDepth === 'advanced' ? 'advanced' : 'basic';
    const limit = typeof maxResults === 'number' ? Math.min(maxResults, 20) : 5;

    ctx.log.info({ query, depth, limit }, 'Running web search via Tavily');

    let response: Response;
    try {
      response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
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
      return {
        success: false,
        error: `Tavily returned HTTP ${response.status}: ${response.statusText || 'request failed'}`,
      };
    }

    let body: TavilyResponse;
    try {
      body = await response.json() as TavilyResponse;
    } catch (err) {
      return { success: false, error: 'Failed to parse Tavily response as JSON' };
    }

    // Normalise and truncate — use raw_content when available (advanced depth),
    // fall back to the snippet content field.
    const results: NormalisedResult[] = (body.results ?? []).map((r) => ({
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
