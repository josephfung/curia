// tests/shared/live-search.ts — counting the live web searches a suite run makes (#2106).
//
// `web-search` is a read-only tool, so neither suite would stub it on its own, and every
// call costs a Tavily credit. Both suites now stub it by default (smoke: stubs/office.yaml,
// scenarios: stubs/defaults.yaml); a case opts back in with `live_search: true`. The stub
// layers count what still reached Tavily, and each summary prints it beside the model
// spend, so a case that starts searching shows up without anyone checking the bill.
import type { ToolResult } from '../../src/skills/types.js';

export const LIVE_SEARCH_TOOL = 'web-search';

/**
 * Tavily's usage-limit responses: 432 (plan limit) and 433 (pay-as-you-go limit). The
 * handler reports them as "Tavily returned HTTP 433: …". Once the credits are gone every
 * search fails, the agents page through sites with web-fetch instead, and cases time out:
 * a run like that cannot be read as a behavior result.
 */
const QUOTA_ERROR = /\bHTTP 43[23]\b/;

export interface LiveSearchTally {
  /** web-search calls that ran the real tool, from any agent, in or out of a case. */
  calls: number;
  /** Of those, the ones Tavily refused for an exhausted quota. */
  quotaErrors: number;
}

export function newLiveSearchTally(): LiveSearchTally {
  return { calls: 0, quotaErrors: 0 };
}

/** Count one real (unstubbed) call. Calls to other tools are ignored. */
export function recordLiveCall(tally: LiveSearchTally, toolName: string, result: ToolResult): void {
  if (toolName !== LIVE_SEARCH_TOOL) return;
  tally.calls++;
  if (!result.success && QUOTA_ERROR.test(result.error)) tally.quotaErrors++;
}

/** Summary lines: the count, and a warning when Tavily ran out mid-run. */
export function liveSearchLines(tally: LiveSearchTally): string[] {
  const lines = [`Live web searches (Tavily): ${tally.calls}`];
  if (tally.quotaErrors > 0) {
    lines.push(
      `[WARN] Tavily refused ${tally.quotaErrors} search(es) with HTTP 432/433: the credits ran out. ` +
      'Cases that searched may have timed out for that reason, not for their behavior.',
    );
  }
  return lines;
}
