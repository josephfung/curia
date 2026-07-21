// handler.ts — tool-registry built-in skill.
//
// Thin wrapper around ToolRegistry.search() that lets discovery-enabled agents
// find capabilities not in their pinned skill list.
//
// The registry reference is injected by the execution layer as ctx.toolSearch —
// a closure scoped to this skill by name, following the same name-gated pattern
// used for autonomyService and browserService. Declare "toolSearch" in capabilities.

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
