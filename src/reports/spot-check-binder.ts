// spot-check-binder.ts — record which delivered message carried a digest's spot-check set (#2159).
//
// The sampler stores each digest's number-to-action map before the digest is sent. Delivery
// is what ties that map to something the principal can reply to: the provider message id, and
// for email the thread id (a reply on that thread resolves against this digest). This binder
// listens for outbound.delivered, the same signal ReactionApprovalMapper uses to bind a
// delivered approval message, and hands the delivery to SpotCheckStore.bindDelivery.
//
// A bound set's rows are then marked sampled, so the next digest does not offer them again.
// That happens here, not when the block is drawn: only a delivered, bound block can be answered,
// and marking earlier burned samples whose digest never went out. A second delivery of the same
// digest marks the same rows again, which is harmless (markSampled overwrites one jsonb key).
//
// Failure policy: binding is best-effort bookkeeping. A failure is logged and never thrown,
// because it runs inside a bus handler and must not disturb delivery. The cost of a missed
// bind is bounded: a reply on a thread falls back to the "most recent delivered digest within
// 24 hours" match, or the tool asks the principal.

import type { EventBus } from '../bus/bus.js';
import type { OutboundDeliveredEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ChannelIdentity } from '../contacts/types.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import { isPrincipalIdentity } from '../contacts/principal-recipient.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { SpotCheckStore, type SpotCheckSet } from './spot-check-store.js';
import { ConfigStore } from '../memory/config-store.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { SPOT_CHECK_HEADER } from './spot-check-sampler.js';

export interface SpotCheckBinderDeps {
  bus: EventBus;
  store: Pick<SpotCheckStore, 'bindDelivery'>;
  gateway: Pick<OutboundGateway, 'getEmailMessage'>;
  /** Marks a bound set's rows sampled, taking them out of the pool. */
  actionLogRepo: Pick<ActionLogRepo, 'markSampled'>;
  principalIdentities: readonly ChannelIdentity[];
  logger: Logger;
}

export class SpotCheckBinder {
  private readonly bus: EventBus;
  private readonly store: Pick<SpotCheckStore, 'bindDelivery'>;
  private readonly gateway: Pick<OutboundGateway, 'getEmailMessage'>;
  private readonly actionLogRepo: Pick<ActionLogRepo, 'markSampled'>;
  private readonly principalIdentities: readonly ChannelIdentity[];
  private readonly log: Logger;

  constructor(deps: SpotCheckBinderDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.actionLogRepo = deps.actionLogRepo;
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

    // A digest that lost the block cannot be answered by number, so it must not be bound.
    // Checked first: it keeps everything below (logging included) off every other message.
    if (!content.includes(SPOT_CHECK_HEADER)) return;

    // The block went out but cannot be tied to its set (a queue-flushed send carries no
    // conversationId). The principal now holds numbers nothing can resolve: say so.
    if (!conversationId || !messageId) {
      this.log.warn(
        { channel, messageId, conversationId },
        'spot-check digest delivered without conversationId/messageId; its numbers cannot be answered',
      );
      return;
    }

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

      const result = await this.store.bindDelivery(conversationId, {
        channel,
        messageId,
        ...(threadId ? { threadId } : {}),
        at: new Date().toISOString(),
      }, content);
      if (result.kind !== 'bound') {
        // no_set: no stored set fits this message (none drawn in this conversation, or several
        // and the content matched none). rejected: the config store refused the write.
        this.log.warn(
          { conversationId, messageId, channel, kind: result.kind },
          'spot-check binder: a delivered digest shows a spot-check block but was not bound; its numbers cannot be answered',
        );
        return;
      }
      this.log.info(
        { setId: result.set.id, channel, messageId, threadId: threadId !== undefined },
        'spot-check binder: bound the delivered digest to its spot-check set',
      );
      await this.markSampled(result.set);
    } catch (err) {
      this.log.error(
        { err, conversationId, messageId },
        'spot-check binder: failed to bind the delivery to its spot-check set',
      );
    }
  }

  /** Take a bound set's rows out of the pool. A failure only means they may be offered again. */
  private async markSampled(set: SpotCheckSet): Promise<void> {
    const actionLogIds = set.items.map((i) => i.actionLogId);
    try {
      await this.actionLogRepo.markSampled(actionLogIds, new Date());
    } catch (err) {
      this.log.error(
        { err, setId: set.id, actionLogIds },
        'spot-check binder: could not mark the bound set\'s rows sampled; a later digest may offer them again',
      );
    }
  }
}

export interface RegisterSpotCheckBinderDeps {
  bus: EventBus;
  /** Backs the config store the spot-check sets live in. */
  entityMemory: EntityMemory | undefined;
  /** Reads a delivered email's thread id. */
  outboundGateway: OutboundGateway | undefined;
  /** Marks a bound set's rows sampled. */
  actionLogRepo: ActionLogRepo | undefined;
  /**
   * The shared, hot-reloaded principal identity array (#1514). Passed by reference and read on
   * every delivery, so it may be empty at boot: the principal can be set up later.
   */
  principalIdentities: readonly ChannelIdentity[];
  logger: Logger;
}

/**
 * Build and register the binder at boot, or warn naming what is missing. Registration does
 * not depend on the principal's identities being known yet (the array is filled in later by
 * the hot reload), the way ReactionApprovalMapper registers with the live array. Without the
 * binder no digest is ever bound, so every spot-check number is unanswerable: hence the warn.
 */
export function registerSpotCheckBinder(deps: RegisterSpotCheckBinderDeps): SpotCheckBinder | undefined {
  const { entityMemory, outboundGateway, actionLogRepo } = deps;
  if (!entityMemory || !outboundGateway || !actionLogRepo) {
    const missing = [
      ...(entityMemory ? [] : ['entityMemory']),
      ...(outboundGateway ? [] : ['outboundGateway']),
      ...(actionLogRepo ? [] : ['actionLogRepo']),
    ];
    deps.logger.warn(
      { missing },
      'spot-check binder not registered: delivered digests will not be bound, so spot-check replies cannot be resolved',
    );
    return undefined;
  }
  const binder = new SpotCheckBinder({
    bus: deps.bus,
    store: new SpotCheckStore(new ConfigStore(entityMemory, deps.logger), deps.logger),
    gateway: outboundGateway,
    actionLogRepo,
    principalIdentities: deps.principalIdentities,
    logger: deps.logger,
  });
  binder.register();
  return binder;
}
