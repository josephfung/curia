// handler.ts — deep-dive-run (#2362).
//
// The principal asked for the deep dive again. Forces a fresh run of the pipeline, which works
// with onboarding closed too: its drafts then go on a standalone review task. A run in progress
// is never doubled.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

const REFUSALS: Record<string, string> = {
  running: 'A deep dive is already running. Its drafts come back for review when it finishes.',
  no_mailbox: "The principal's mailbox isn't connected, so there is nothing to read. Connect it first.",
};

export class DeepDiveRunHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.deepDiveService;
    if (!svc) return { success: false, error: 'deep-dive-run requires the deepDiveService capability' };
    try {
      const result = await svc.startOnce({ force: true });
      if (!result.started) {
        return { success: false, error: REFUSALS[result.reason] ?? `The deep dive could not start (${result.reason}).` };
      }
      return { success: true, data: { started: true } };
    } catch (err) {
      ctx.log.error({ err }, 'deep-dive-run failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
