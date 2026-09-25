import type { BusEvent, EventType, Layer } from './events.js';
import { canPublish, canSubscribe } from './permissions.js';
import type { Logger } from '../logger.js';

/**
 * An `agent.task` whose target id is not owned by any loaded runtime.
 * The audit row is written and left unacknowledged so the startup scan
 * reports it; subscribers are not invoked. (#1898)
 */
export class UnownedAgentTaskError extends Error {
  readonly agentId: string;
  readonly layer: Layer;
  readonly eventId: string;
  readonly originatingEventId: string | undefined;

  constructor(
    agentId: string,
    layer: Layer,
    eventId: string,
    originatingEventId: string | undefined,
  ) {
    super(`agent.task targets '${agentId}' which no loaded runtime owns`);
    this.name = 'UnownedAgentTaskError';
    this.agentId = agentId;
    this.layer = layer;
    this.eventId = eventId;
    this.originatingEventId = originatingEventId;
  }
}

type EventHandler = (event: BusEvent) => void | Promise<void>;

// The onEvent hook runs before subscriber delivery — this is intentional.
// The audit logger uses it as a write-ahead record so that even if a subscriber
// throws or the process crashes mid-delivery, the event is already persisted.
type OnEventHook = (event: BusEvent) => void | Promise<void>;

// The onDelivered hook runs after all subscribers have been attempted (regardless
// of per-subscriber errors). The audit logger uses it to flip acknowledged = true,
// signalling that delivery was attempted for all registered handlers.
type OnDeliveredHook = (eventId: string) => void | Promise<void>;

export class EventBus {
  // Keyed by EventType so dispatch is O(1) lookup rather than scanning all subscribers.
  private subscribers = new Map<EventType, EventHandler[]>();
  private logger: Logger;
  private onEvent?: OnEventHook;
  private onDelivered?: OnDeliveredHook;
  /** When set, an agent.task for an id this returns false for is an error, not a delivery. */
  private ownsAgent?: (agentId: string) => boolean;

  constructor(logger: Logger, onEvent?: OnEventHook, onDelivered?: OnDeliveredHook) {
    this.logger = logger;
    this.onEvent = onEvent;
    this.onDelivered = onDelivered;
  }

  subscribe(eventType: EventType, layer: Layer, handler: EventHandler): void {
    // Enforce the layer permission boundary at subscribe time, not just at publish time.
    // Failing fast here makes misconfiguration errors surface immediately on startup.
    if (!canSubscribe(layer, eventType)) {
      throw new Error(
        `Layer '${layer}' is not authorized to subscribe to '${eventType}'`,
      );
    }

    const handlers = this.subscribers.get(eventType) ?? [];
    handlers.push(handler);
    this.subscribers.set(eventType, handlers);

    this.logger.debug({ layer, eventType }, 'Subscriber registered');
  }

  /**
   * Wire the live agent-ownership check once the registry is populated.
   * Until this is called, agent.task delivery is unchanged — unit tests that
   * publish tasks without a registry keep working. Production sets it. (#1898)
   */
  setAgentOwner(ownsAgent: (agentId: string) => boolean): void {
    this.ownsAgent = ownsAgent;
  }

  async publish(layer: Layer, event: BusEvent): Promise<void> {
    // Enforce publish permissions — the layer claiming ownership of an event type
    // must match the allowlist so rogue components can't inject arbitrary events.
    if (!canPublish(layer, event.type)) {
      throw new Error(
        `Layer '${layer}' is not authorized to publish '${event.type}'`,
      );
    }

    const unowned = this.unownedAgentTask(layer, event);
    if (unowned) {
      // Write the audit row, then leave it unacknowledged. Delivery was not
      // handled — acknowledging it is what made this class invisible to the
      // startup scan. Subscribers are not invoked; they would all no-op.
      this.logger.error(
        {
          agentId: unowned.agentId,
          layer: unowned.layer,
          eventId: unowned.eventId,
          originatingEventId: unowned.originatingEventId,
        },
        'agent.task published for an agent no loaded runtime owns',
      );
      if (this.onEvent) {
        await this.onEvent(event);
      }
      throw unowned;
    }

    this.logger.debug(
      { layer, eventType: event.type, eventId: event.id },
      'Event published',
    );

    // Write-ahead hook (for audit logger) — runs BEFORE subscriber delivery.
    // If the hook throws we let it propagate; we do NOT proceed with delivery
    // because an audit gap is worse than a delayed message.
    if (this.onEvent) {
      await this.onEvent(event);
    }

    // Deliver to subscribers sequentially — awaited so the full chain completes
    // before publish() resolves, which makes test assertions straightforward.
    // Subscriber errors are caught and logged individually so one bad subscriber
    // cannot block delivery to subsequent subscribers.
    const handlers = this.subscribers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        // Swallowing subscriber errors deliberately: the publisher must not be
        // punished for a subscriber's internal failure. The error is logged at
        // 'error' level so it's visible in production observability tools.
        this.logger.error(
          { err, eventType: event.type, eventId: event.id },
          'Subscriber error',
        );
      }
    }

    // Delivery confirmation hook — runs after all handlers have been attempted.
    // "Delivery attempted" (not "all succeeded") is the guarantee: per-subscriber
    // errors are swallowed above, but the event was dispatched to every registered
    // handler. The audit logger uses this to flip acknowledged = true.
    // Errors here are logged but not re-thrown — a failed acknowledgement write
    // should not roll back a completed delivery.
    if (this.onDelivered) {
      try {
        await this.onDelivered(event.id);
      } catch (err) {
        this.logger.error(
          { err, eventType: event.type, eventId: event.id },
          'Delivery acknowledgement failed',
        );
      }
    }
  }

  private unownedAgentTask(layer: Layer, event: BusEvent): UnownedAgentTaskError | undefined {
    if (event.type !== 'agent.task' || !this.ownsAgent) return undefined;
    if (this.ownsAgent(event.payload.agentId)) return undefined;
    return new UnownedAgentTaskError(
      event.payload.agentId,
      layer,
      event.id,
      event.parentEventId,
    );
  }
}
