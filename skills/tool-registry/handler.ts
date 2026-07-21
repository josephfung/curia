// handler.ts — tool-registry built-in skill.
//
// Thin wrapper around unified tool/skill search (ctx.toolSearch) that lets
// discovery-enabled agents find capabilities not in their pinned skill list.
// Results may be kind:'tool' (callable immediately) or kind:'skill' (activate
// via skill-activate to load member tools + SKILL.md instructions).
//
// The search closure is injected by the execution layer as ctx.toolSearch —
// declare "toolSearch" in capabilities.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

export class ToolRegistryHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.toolSearch) {
      // Guard against misconfiguration — should never happen in normal operation
      // since the execution layer always injects toolSearch for this skill name.
      return { success: false, error: 'tool-registry: toolSearch not available in context' };
    }

    const query = (ctx.input.query as string) ?? '';

    try {
      const tools = ctx.toolSearch(query);
      return { success: true, data: { tools } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'tool-registry: search failed');
      return { success: false, error: `tool-registry search failed: ${message}` };
    }
  }
}

export default new ToolRegistryHandler();
