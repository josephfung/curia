// handler.ts — onboarding-start (#2360).
//
// The principal asked to do the onboarding. Same start path as the console's button, as the
// principal: they are already talking to Curia, so no invitation, no greeting and no new thread.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

const REFUSALS: Record<string, string> = {
  already_started: 'Onboarding is already under way.',
  setup_incomplete: "Setup isn't finished yet. Onboarding can start once the operator completes Setup.",
  route_unreachable: 'Setup has no messaging route for the principal, so onboarding cannot start. The operator can set one in Setup.',
};

export class OnboardingStartHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.onboardingService;
    if (!svc) return { success: false, error: 'onboarding-start requires the onboardingService capability' };
    try {
      // The principal asking is their confirmation that they already use this install.
      const result = await svc.start({ actor: 'principal', confirmWorkingPrincipal: true });
      if (!result.ok) {
        return { success: false, error: REFUSALS[result.code] ?? `Onboarding could not start (${result.code}).` };
      }
      return { success: true, data: { taskId: result.taskId, restartScheduled: result.restartScheduled } };
    } catch (err) {
      ctx.log.error({ err }, 'onboarding-start failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
