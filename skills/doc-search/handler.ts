// handler.ts — doc-search skill (#1209).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { searchDocuments, requireWorkingDocs } from '../_shared/doc-workspace.js';

export class DocSearchHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { query, path_prefix } = ctx.input as { query?: string; path_prefix?: string };

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { success: false, error: 'Missing required input: query (string)' };
    }
    if (path_prefix !== undefined && typeof path_prefix !== 'string') {
      return { success: false, error: 'path_prefix must be a string when provided' };
    }

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;

    try {
      return await searchDocuments(ctx, query, path_prefix);
    } catch (err) {
      ctx.log.error({ err, query }, 'doc-search: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
