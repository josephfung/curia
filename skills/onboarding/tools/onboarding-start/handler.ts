// handler.ts — onboarding-start (#2360).
//
// The principal asked to do the onboarding. Same start path as the console's button, as the
// principal: they are already talking to Curia, so no invitation and no greeting. The web thread
// is rotated only when they asked from another channel (their turn's channel is passed in).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

const REFUSALS: Record<string, string> = {
  already_started: 'Onboarding is already under way.',
  setup_incomplete: "Setup isn't finished yet. Onboarding can start once the operator completes Setup.",
  start_in_progress: 'Another onboarding start is still running. Check again in a moment.',
  no_persistent_store: "Curia's knowledge graph is off, so onboarding can't keep its progress. It can start once the knowledge graph is back.",
};

export class OnboardingStartHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.onboardingService;
    if (!svc) return { success: false, error: 'onboarding-start requires the onboardingService capability' };
    try {
      // The principal asking is their confirmation that they already use this install.
      const result = await svc.start({
        actor: 'principal',
        confirmWorkingPrincipal: true,
        ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
      });
      if (!result.ok) {
        return { success: false, error: REFUSALS[result.code] ?? `Onboarding could not start (${result.code}).` };
      }
      return {
        success: true,
        data: {
          taskId: result.taskId,
          restartScheduled: result.restartScheduled,
          ...(result.restartScheduled
            ? {
                instruction:
                  "Curia restarts in about 15 seconds to switch on email triage (held). Tell the principal now, " +
                  "in one short line, that you'll be back in a minute. The conversation resumes on its own after the restart.",
              }
            : {}),
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'onboarding-start failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
