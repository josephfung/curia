// spot-check-binder.ts — record which delivered message carried a digest's spot-check set (#2159).
//
// The sampler stores each digest's number-to-action map before the digest is sent. Delivery
// is what ties that map to something the principal can reply to: the provider message id, and
// for email the thread id (a reply on that thread resolves against this digest). This binder
// listens for outbound.delivered, the same signal ReactionApprovalMapper uses to bind a
// delivered approval message, and hands the delivery to SpotCheckStore.bindDelivery.
//
// Failure policy: binding is best-effort bookkeeping. A failure is logged and never thrown,
// because it runs inside a bus handler and must not disturb delivery. The cost of a missed
// bind is bounded: a reply on a thread falls back to the "most recent delivered digest within
// 24 hours" match, or the tool asks the principal.

import type { EventBus } from '../bus/bus.js';
import type { OutboundDeliveredEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ChannelIdentity } from '../contacts/types.js';
import { isPrincipalIdentity } from '../contacts/principal-recipient.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { SpotCheckStore } from './spot-check-store.js';
import { SPOT_CHECK_HEADER } from './spot-check-sampler.js';

export interface SpotCheckBinderDeps {
  bus: EventBus;
  store: Pick<SpotCheckStore, 'bindDelivery'>;
  gateway: Pick<OutboundGateway, 'getEmailMessage'>;
  principalIdentities: readonly ChannelIdentity[];
  logger: Logger;
}

export class SpotCheckBinder {
  private readonly bus: EventBus;
  private readonly store: Pick<SpotCheckStore, 'bindDelivery'>;
  private readonly gateway: Pick<OutboundGateway, 'getEmailMessage'>;
  private readonly principalIdentities: readonly ChannelIdentity[];
  private readonly log: Logger;

  constructor(deps: SpotCheckBinderDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.principalIdentities = deps.principalIdentities;
    this.log = deps.logger.child({ component: 'spot-check-binder' });
  }

  register(): void {
    this.bus.subscribe('outbound.delivered', 'dispatch', async (event) => {
      await this.handleDelivered(event as OutboundDeliveredEvent);
    });
    this.log.info('SpotCheckBinder registered (outbound.delivered)');
  }

  /** @internal exported for tests */
  async handleDelivered(event: OutboundDeliveredEvent): Promise<void> {
    const { channel, recipientId, content, conversationId, messageId } = event.payload;
    if (!conversationId || !messageId) return;

    // A digest that lost the block cannot be answered by number, so it must not be bound.
    // The check also keeps the config-store read below off every other message.
    if (!content.includes(SPOT_CHECK_HEADER)) return;

    // Only a digest sent to the principal can be graded by them.
    if (!isPrincipalIdentity(channel, recipientId, this.principalIdentities)) return;

    try {
      // Email replies resolve by thread, so look the thread up. If that fails, bind anyway:
      // the reply then resolves through the 24 hour "most recent digest" match instead.
      let threadId: string | undefined;
      if (channel === 'email') {
        try {
          threadId = (await this.gateway.getEmailMessage(messageId)).threadId;
        } catch (err) {
          this.log.warn(
            { err, conversationId, messageId },
            'spot-check binder: could not read the delivered email thread; binding without it',
          );
        }
      }

      const bound = await this.store.bindDelivery(conversationId, {
        channel,
        messageId,
        ...(threadId ? { threadId } : {}),
        at: new Date().toISOString(),
      });
      this.log.debug({ conversationId, messageId, bound }, 'spot-check binder: delivery processed');
    } catch (err) {
      this.log.error(
        { err, conversationId, messageId },
        'spot-check binder: failed to bind the delivery to its spot-check set',
      );
    }
  }
}
