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
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import { SpotCheckSampler, type DescribeEmail } from '../../../../src/reports/spot-check-sampler.js';
import { SpotCheckStore } from '../../../../src/reports/spot-check-store.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

/** Subject and sender ("Name <email>", or the bare email) of a message, read through the gateway. */
function describeEmailVia(gateway: OutboundGateway): DescribeEmail {
  return async (messageId, account) => {
    const msg = await gateway.getEmailMessage(messageId, account);
    const sender = msg.from[0];
    const from = sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : undefined;
    return { subject: msg.subject || undefined, from: from || undefined };
  };
}

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

    // draw() never throws: on any failure it logs and returns null, so the digest goes out
    // without a spot-check block rather than failing.
    const drawn = await sampler.draw(ctx.conversationId);
    return { success: true, data: { block: drawn?.block ?? null, count: drawn?.count ?? 0 } };
  }
}
