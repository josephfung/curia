// handler.ts — list-spot-checks (#2159 Phase 3).
//
// Draws up to three recent autonomous actions for the principal to grade, as the digest's
// ready-made "Spot check" block. The draw stores the number-to-action map against this
// conversation (the digest run), which is how a later "2 good" reply is resolved. Action ids
// are never returned: the principal sees numbers only.
//
// The outbound gateway is optional. When present, triage samples ("Archive an email") gain
// the email's subject and sender so the principal can tell which email it was. Without it,
// samples keep their stored summaries.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { SpotCheckSampler } from '../../../../src/reports/spot-check-sampler.js';
import { describeEmailVia } from '../../../../src/reports/describe-email.js';
import { SpotCheckStore } from '../../../../src/reports/spot-check-store.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

export class ListSpotChecksHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'list-spot-checks requires actionLogRepo capability' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'list-spot-checks requires entityMemory capability' };
    }
    // The map is keyed by conversation so the digest's delivery can be bound back to it.
    if (!ctx.conversationId) {
      return { success: false, error: 'list-spot-checks requires a conversation; it must run inside a digest task' };
    }

    const sampler = new SpotCheckSampler({
      actionLogRepo: ctx.actionLogRepo,
      store: new SpotCheckStore(new ConfigStore(ctx.entityMemory, ctx.log), ctx.log),
      logger: ctx.log,
      ...(ctx.outboundGateway ? { describeEmail: describeEmailVia(ctx.outboundGateway) } : {}),
    });

    // draw() never throws: on any failure it logs and returns `unavailable`, so the digest goes
    // out without a spot-check block rather than failing. `reason` tells the agent (and anyone
    // reading the tool result) whether there was nothing to check or the draw broke. The setId
    // stays internal: the agent has no use for it.
    const drawn = await sampler.draw(ctx.conversationId);
    if (drawn.kind === 'drawn') {
      return { success: true, data: { block: drawn.block, count: drawn.count } };
    }
    const reason = drawn.kind === 'empty' ? 'empty' : drawn.reason;
    return { success: true, data: { block: null, count: 0, reason } };
  }
}
