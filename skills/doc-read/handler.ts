// handler.ts — doc-read skill (#1209).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { readDocument, requireWorkingDocs } from '../_shared/doc-workspace.js';

export class DocReadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { path, section } = ctx.input as { path?: string; section?: string };

    if (!path || typeof path !== 'string' || !path.trim()) {
      return { success: false, error: 'Missing required input: path (string)' };
    }
    if (section !== undefined && typeof section !== 'string') {
      return { success: false, error: 'section must be a string when provided' };
    }

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;

    try {
      return await readDocument(ctx, path, section);
    } catch (err) {
      ctx.log.error({ err, path }, 'doc-read: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
