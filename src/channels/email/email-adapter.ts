// src/channels/email/email-adapter.ts
//
// Email channel adapter — polls Nylas for new inbound emails, publishes them
// to the bus as inbound.message events, auto-creates contacts from participants,
// and sends outbound replies when the coordinator responds to an email thread.
//
// Multi-account: one EmailAdapter instance is constructed per configured email account.
// Each instance owns a single Nylas grant.

import type { EventBus } from '../../bus/bus.js';
import type { TurnLanes } from '../../dispatch/turn-lanes.js';
import type { Logger } from '../../logger.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { EmailSendRequest } from './outbound-request.js';
import { replyDisplayName, replyRecipientSource } from './reply-recipient-provenance.js';
import { deriveEmailReplyRecipientSet } from './reply-recipients.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { PrincipalEmailRef } from '../../contacts/types.js';
import { resolvePrincipalEmail } from '../../contacts/types.js';
import type { ConfigStore } from '../../memory/config-store.js';
import { convertNylasMessage, normalizeForComparison } from './message-converter.js';
import {
  createInboundMessage,
  createChannelPoll,
  createChannelStalled,
  createChannelDisconnected,
  createChannelReconnect,
  type InboundMessageEvent,
  type OutboundMessageEvent,
  type OutboundNotificationEvent,
} from '../../bus/events.js';
import { isDbUnavailableError } from '../../db/resilience.js';
import { INBOUND_REPLAY_LIMIT, INBOUND_REPLAY_MAX_AGE_HOURS } from '../../audit/inbound-replay.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import { buildReplyQuote } from '../../skills/_shared/reply-quote.js';
import {
  EMAIL_INBOUND_TURN_STALL_MS,
  EMAIL_POLL_PAGE_SIZE,
  MAX_STAGED_INBOUND_IDS,
  WRITE_AHEAD_POLL_FAIL_LIMIT,
  WRITE_AHEAD_RETRY_LIMIT,
} from './inbound-stall.js';
import type { Channel } from '../channel.js';

// Mirrors MAX_BODY_LENGTH in skills/email/tools/email-send/handler.ts and skills/email/tools/email-reply/handler.ts.
// When the agent's response plus the quoted original would exceed this, the quote
// is silently dropped so the reply still sends.
const MAX_REPLY_BODY_LENGTH = 50_000;

/** How long stop() waits for turns already running before shutdown continues. */
const STOP_DRAIN_MS = 5_000;

/**
 * One inbound message whose write-ahead succeeded. Delivery starts only when
 * the thread is idle and a concurrency slot is free.
 */
interface QueuedInboundEmail {
  event: InboundMessageEvent;
  /** Starts subscriber delivery. Write-ahead already finished in the poll. */
  deliver: () => Promise<void>;
  messageId: string;
  threadId: string;
  /** From address as on the message; absent when the sender was missing. */
  senderEmail: string | undefined;
  /** Converter sender id (`unknown` when From was missing). */
  senderId: string;
  subject: string;
  senderVerified: boolean;
  /** Epoch ms when the poll queued this message. */
  queuedAt: number;
  /** True when this item was loaded from an unacknowledged audit row. */
  replayed?: boolean;
}

function nylasMessageIdOf(event: InboundMessageEvent): string {
  const id = event.payload.metadata?.nylasMessageId;
  return typeof id === 'string' && id.length > 0 ? id : event.id;
}

function queuedFromReplay(
  event: InboundMessageEvent,
  messageId: string,
  deliver: () => Promise<void>,
): QueuedInboundEmail {
  const metadata = event.payload.metadata;
  const threadFromMeta = metadata?.nylasThreadId;
  const threadId = typeof threadFromMeta === 'string' && threadFromMeta.length > 0
    ? threadFromMeta
    : event.payload.conversationId.startsWith('email:')
      ? event.payload.conversationId.slice('email:'.length)
      : event.payload.conversationId;
  const subject = typeof metadata?.subject === 'string' ? metadata.subject : '';
  const senderId = event.payload.senderId;
  return {
    event,
    deliver,
    messageId,
    threadId,
    senderEmail: senderId.includes('@') ? senderId : undefined,
    senderId,
    subject,
    senderVerified: metadata?.senderVerified === true,
    queuedAt: Date.now(),
    replayed: true,
  };
}

// KG namespace and key pattern for persisting the poll high-water mark.
const POLL_STATE_NAMESPACE = 'system:email-poll-state';
function lastSeenKey(accountId: string): string {
  return `${accountId}.last_seen_at`;
}

export interface EmailAdapterConfig {
  /**
   * Logical name for this email account (e.g. "curia", "joseph").
   * Stamped onto every inbound.message event as accountId so the dispatcher
   * can route replies back through the same account.
   */
  accountId: string;
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  /** This account's own email address — used to filter out self-sent messages */
  selfEmail: string;
  /**
   * Addresses to suppress on inbound, in addition to this account's own selfEmail.
   * Auto-derived (#1101) from the union of every configured account's self_email, so the
   * agent never replies to a mailbox it owns. Case-insensitive.
   */
  suppressedSenderEmails: string[];
  /**
   * principal's email address — used as the recipient for rate-limit notification emails.
   * When absent/empty, rate-limit notifications are logged but not emailed.
   * Accepts a mutable PrincipalEmailRef so post-boot binds hot-reload (#1514).
   */
  ceoEmail?: string | PrincipalEmailRef;
  /**
   * Maximum new contacts to auto-create from a single email's participant list.
   * Existing contacts (already in DB) don't count. Default: 10.
   */
  contactCreationMaxPerMessage: number;
  /**
   * Maximum new contacts to auto-create per hour across all emails for this account.
   * Sliding window resets after 1 hour. Default: 100.
   */
  contactCreationMaxPerHour: number;
  /**
   * Max inbound turns in flight at once for this account (#2254).
   * Required. Bootstrap applies `channels.email.max_concurrent_turns` (default 4).
   * Messages on one thread stay strictly ordered and never run together.
   * Further threads wait for a free slot. The cap does not bound the queue.
   */
  maxConcurrentTurns: number;
  /**
   * IANA timezone (e.g. "America/Toronto") used when rendering the Date line in
   * appended reply quotes. Sourced from the global `TIMEZONE` env var to match
   * the timezone the skills receive via ToolContext.
   */
  timezone: string;
  /**
   * KG-backed config store for persisting the poll high-water mark across restarts.
   * When absent the adapter operates without persistence (in-memory only — reverts
   * to Date.now() on each restart, which is the legacy behaviour).
   */
  configStore?: ConfigStore;
  /**
   * Unacknowledged `inbound.message` rows for this account. On start, each
   * one is delivered again through `deliverPersisted` before the first poll,
   * so a restart cannot leave write-ahead mail behind the watermark (#2254).
   * Absent in tests that do not exercise replay.
   */
  unacknowledgedInbound?: {
    listUnacknowledgedInbound(accountId: string): Promise<InboundMessageEvent[]>;
  };
  /**
   * When the flag is on, the next same-thread message is released once the
   * dispatcher has decided the inbound, so it can join the turn still running.
   * Absent, or with the flag off, the thread stays locked until delivery ends.
   */
  turnLanes?: TurnLanes;
}

export class EmailAdapter implements Channel {
  readonly name = 'email';
  readonly isToggleable = true;
  /**
   * Email is HTTP (Nylas). Queueable like SMS (#1380): readiness tracks adapter
   * start/stop; the gateway also enqueues on transient Nylas/network failures.
   * Auth/grant failures stay non-queueable.
   */
  readonly supportsOutboundQueue = true;
  private config: EmailAdapterConfig;
  // Existing setInterval handle — cleared in stop() to halt the poll loop. The
  // overlap guard (`processing`) plus clearing this interval are sufficient to
  // stop polling; no separate `stopped` flag is needed because polls are driven
  // by a single repeating interval rather than per-poll re-scheduling.
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastSeenTimestamp: number = 0;
  /**
   * Overlap guard for the Nylas fetch and pre-publish work only. Inbound turns
   * run on the detached runner below (#2254), so a long coordinator turn must
   * not skip the next poll.
   */
  private processing = false;
  private readonly maxConcurrentTurns: number;
  /** Deliveries that have started and have not settled. */
  private inFlightTurns = 0;
  /** Settling handles so stop() and tests can wait out a detached delivery. */
  private inFlightRuns = new Set<Promise<void>>();
  /** messageId → when that delivery started. Two messages on one thread can overlap once injection is on. */
  private readonly inFlightStartedAt = new Map<string, { conversationId: string; startedAt: number }>();
  /** messageIds already warned for the delivery currently in flight. */
  private readonly stallWarned = new Set<string>();
  /** conversationId → messages waiting to deliver, in message-date order. */
  private readonly pendingByThread = new Map<string, QueuedInboundEmail[]>();
  /** conversationIds whose delivery is in flight. At most one each until intake settles (#2018). */
  private readonly runningThreads = new Set<string>();
  /** conversationId → messageId that currently owns the thread lock. */
  private readonly threadOwner = new Map<string, string>();
  /**
   * Threads that have a queued head and no free slot, oldest first.
   * A Set keeps insertion order: membership is O(1), and moving a thread to
   * the back is delete + add. A thread that just finished goes to the back,
   * so one busy thread cannot hold the only slot while other threads wait.
   */
  private readonly slotWaiters = new Set<string>();
  /** True between start() and stop() — outbound-queue readiness (#1380). */
  private running = false;

  // ── Watchdog state ─────────────────────────────────────────────────────────
  // Tracks the last successful poll completion time for stall detection.
  // "Successful" means listEmailMessages resolved without throwing; zero messages
  // returned is still a success (a quiet inbox is healthy).

  /** Epoch ms when the adapter was started — used to compute initial stall window. */
  private startedAt: number | null = null;
  /**
   * Epoch ms of the most recent poll whose Nylas fetch succeeded.
   * Stamped when the fetch and handoff finish, not when agent turns finish (#2254).
   */
  private _lastSuccessfulPollAt: number | null = null;
  /** True once channel.stalled has been successfully published this lifecycle. */
  private stalledEmitted = false;
  /** Number of channel.stalled publish attempts this lifecycle (bounds retries on bus failure). */
  private stalledEmitAttempts = 0;
  private static readonly MAX_STALL_EMIT_ATTEMPTS = 3;

  // ── Recently-sent message ID tracking (self-loop guard) ───────────────────
  // After a successful send, the Nylas message ID is added here so that the
  // next inbound poll can skip it even if the mail provider returns it as unread
  // or uses a send-as alias address that doesn't match selfEmail.
  // The set is bounded to MAX_SENT_IDS entries; oldest entries are evicted when
  // the cap is reached. 200 covers thousands of hours at normal send rates.

  private readonly recentlySentIds = new Set<string>();
  private static readonly MAX_SENT_IDS = 200;

  /**
   * Nylas ids whose `inbound.message` row already exists in this process
   * (this poll, or replay on start). A watermark rollback re-fetches them;
   * they must not be written ahead again. Bounded like {@link recentlySentIds}.
   */
  private readonly stagedInboundIds = new Set<string>();
  /** Consecutive write-ahead failures per Nylas message id. */
  private readonly writeAheadFailures = new Map<string, number>();
  /** Polls in a row that stopped on a retryable write-ahead failure. */
  private writeAheadPollFailures = 0;

  private trackSentId(id: string): void {
    this.recentlySentIds.add(id);
    // Set preserves insertion order, so values().next() is the oldest entry.
    if (this.recentlySentIds.size > EmailAdapter.MAX_SENT_IDS) {
      const oldest = this.recentlySentIds.values().next().value;
      if (oldest !== undefined) this.recentlySentIds.delete(oldest);
    }
  }

  private rememberStagedId(id: string): void {
    this.stagedInboundIds.add(id);
    if (this.stagedInboundIds.size > MAX_STAGED_INBOUND_IDS) {
      const oldest = this.stagedInboundIds.values().next().value;
      if (oldest !== undefined) this.stagedInboundIds.delete(oldest);
    }
  }

  // ── Contact auto-creation rate limiting (#36) ──────────────────────────────
  // In-memory counters — reset on process restart, which is fine for anti-flood.

  /** Sliding-window counter for the per-hour rate limit. */
  private hourlyContactCount = 0;
  /** Start of the current hourly window (epoch ms). Zero means the window hasn't started yet. */
  private hourlyWindowStart = 0;

  /** Epoch-ms timestamp of the last rate-limit notification per limit type, for dedup. */
  private lastNotifiedPerMessage = 0;
  private lastNotifiedPerHour = 0;

  constructor(config: EmailAdapterConfig) {
    this.config = config;
    if (!Number.isInteger(config.maxConcurrentTurns) || config.maxConcurrentTurns < 1) {
      throw new Error(
        `email maxConcurrentTurns must be a positive integer, got: ${String(config.maxConcurrentTurns)}`,
      );
    }
    this.maxConcurrentTurns = config.maxConcurrentTurns;
  }

  // ── Public health-probe getters ──────────────────────────────────────────
  // The watchdog state fields are private to prevent external mutation, but the
  // health module needs to read them without resorting to `any` casts. These
  // getters expose just enough surface for the liveness probe.

  /**
   * Epoch ms of the most recent successful poll, converted to Date for the
   * health probe. Null means no successful poll since start() was last called.
   */
  get lastSuccessfulPollAt(): Date | null {
    return this._lastSuccessfulPollAt !== null ? new Date(this._lastSuccessfulPollAt) : null;
  }

  /** Polling interval in ms — used by the health probe to compute the stall threshold. */
  get pollingIntervalMs(): number {
    return this.config.pollingIntervalMs;
  }

  /** Deliveries started and not yet settled. */
  get inboundInFlight(): number {
    return this.inFlightTurns;
  }

  /** Messages written ahead and still waiting for a slot or their thread. */
  get inboundPending(): number {
    let pending = 0;
    for (const queue of this.pendingByThread.values()) pending += queue.length;
    return pending;
  }

  /** Cap applied to {@link inboundInFlight}. */
  get inboundMaxConcurrentTurns(): number {
    return this.maxConcurrentTurns;
  }

  /** Age of the oldest in-flight turn, or null when nothing is running. */
  get oldestInboundInFlightAgeMs(): number | null {
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const entry of this.inFlightStartedAt.values()) {
      if (entry.startedAt < oldestStart) oldestStart = entry.startedAt;
    }
    return oldestStart === Number.POSITIVE_INFINITY ? null : Date.now() - oldestStart;
  }

  /** Age of the oldest queued message, or null when the queues are empty. */
  get oldestInboundPendingAgeMs(): number | null {
    let oldestQueuedAt = Number.POSITIVE_INFINITY;
    for (const queue of this.pendingByThread.values()) {
      for (const item of queue) {
        if (item.queuedAt < oldestQueuedAt) oldestQueuedAt = item.queuedAt;
      }
    }
    return oldestQueuedAt === Number.POSITIVE_INFINITY ? null : Date.now() - oldestQueuedAt;
  }

  /** In-flight turns older than the stall bound. */
  get inboundStalledTurns(): number {
    const now = Date.now();
    let stalled = 0;
    for (const entry of this.inFlightStartedAt.values()) {
      if (now - entry.startedAt >= EMAIL_INBOUND_TURN_STALL_MS) stalled++;
    }
    return stalled;
  }

  /** True once repeated polls have been unable to write inbound mail ahead. */
  get inboundWriteAheadDegraded(): boolean {
    return this.writeAheadPollFailures >= WRITE_AHEAD_POLL_FAIL_LIMIT;
  }

  /**
   * Resolves when every detached inbound delivery has settled.
   * `stop()` waits on this for {@link STOP_DRAIN_MS}, then continues so a hung
   * turn cannot block process exit (#2254).
   */
  async drainInFlight(): Promise<void> {
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns]);
    }
  }

  isOutboundReady(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    const { bus, logger, pollingIntervalMs, configStore, accountId } = this.config;

    // Subscribe to outbound messages for this specific email account.
    // When the coordinator responds to an email-triggered conversation, the dispatcher
    // creates an outbound.message with channelId 'email' and the accountId that received
    // the original message. Each adapter instance filters to its own accountId so replies
    // are always sent from the same account that received the inbound message.
    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'email') return;
      // Only handle events addressed to this account.
      // When accountId is absent (legacy events from before multi-account support),
      // default to 'curia' so the primary account claims the event — consistent with
      // the backward-compat fallback in resolveChannelAccounts().
      const targetAccountId = outbound.payload.accountId ?? 'curia';
      if (targetAccountId !== this.config.accountId) return;

      try {
        await this.sendOutboundReply(outbound);
      } catch (err) {
        logger.error({ err, conversationId: outbound.payload.conversationId },
          'Failed to send email response');
      }
    });

    // Subscribe to system notification events (blocked-content alerts, group-held alerts).
    // outbound.notification events are published by OutboundGateway.sendNotification()
    // and route through the filter pipeline like any other outbound message.
    //
    // Only the primary account ('curia') handles notifications to avoid duplicate sends
    // when multiple email accounts are configured. This matches the accountId fallback
    // convention used in the outbound.message subscription above.
    // TODO: replace hardcoded 'curia' with an isPrimaryAccount config flag once
    // multi-account primary detection is formalized.
    bus.subscribe('outbound.notification', 'channel', async (event) => {
      if (this.config.accountId !== 'curia') return;

      const notification = event as OutboundNotificationEvent;
      try {
        // isSystemNotification bypasses the autonomy gate so the principal still receives
        // alerts (e.g. approval_requested) even when the score is below the send
        // threshold — the notification must not be silenced by the gate it's reporting.
        // skipNotificationOnBlock prevents infinite recursion if the content filter
        // crashes and blocks this notification delivery itself.
        logger.info(
          { notificationType: notification.payload.notificationType, channel: 'email' },
          'EmailAdapter: delivering system notification with autonomy gate bypass',
        );
        const result = await this.config.outboundGateway.send(
          {
            channel: 'email',
            to: notification.payload.ceoEmail,
            subject: notification.payload.subject,
            body: notification.payload.body,
          },
          { skipNotificationOnBlock: true, isSystemNotification: true },
        );
        if (!result.success) {
          logger.error(
            {
              notificationType: notification.payload.notificationType,
              reason: result.blockedReason,
              blockId: notification.payload.blockId,
              originalChannel: notification.payload.originalChannel,
              ceoEmail: notification.payload.ceoEmail,
            },
            'EmailAdapter: failed to deliver outbound.notification — principal will NOT receive this alert',
          );
        }
      } catch (err) {
        logger.error(
          {
            err,
            notificationType: notification.payload.notificationType,
            blockId: notification.payload.blockId,
          },
          'EmailAdapter: unexpected error delivering outbound.notification',
        );
      }
    });

    // Restore the persisted high-water mark so restarts resume from where we left off
    // rather than silently dropping messages that arrived during downtime.
    // Falls back to Date.now() on first boot (no stored row) or when no configStore is wired.
    // Falls back to Date.now() and logs at error level if the KG read fails — this is a
    // degraded state (messages since the last persist may be re-fetched) but must not block startup.
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
    if (configStore) {
      try {
        const persisted = await configStore.get(POLL_STATE_NAMESPACE, lastSeenKey(accountId));
        if (persisted !== null) {
          const parsed = parseInt(persisted, 10);
          if (!isNaN(parsed)) {
            this.lastSeenTimestamp = parsed;
            logger.info(
              { accountId, lastSeenTimestamp: this.lastSeenTimestamp },
              'Email adapter: restored poll watermark from persisted state',
            );
          } else {
            logger.warn(
              { accountId, persisted },
              'Email adapter: persisted watermark is not a valid integer — falling back to Date.now()',
            );
          }
        } else {
          logger.info(
            { accountId },
            'Email adapter: no persisted watermark found — first boot, initialising to now',
          );
        }
      } catch (err) {
        logger.error(
          { err, accountId },
          'Email adapter: failed to read persisted watermark from KG — falling back to Date.now(). Messages that arrived since the last persist may be dropped.',
        );
      }
    }

    this.startedAt = Date.now();
    this._lastSuccessfulPollAt = null;
    this.stalledEmitted = false;
    this.stalledEmitAttempts = 0;
    this.running = true;
    // Replay before the interval and the first poll, so a re-fetch of mail
    // already written ahead is skipped instead of delivered twice.
    await this.replayUnacknowledgedInbound();

    // Poll on interval; also run the watchdog check each tick.
    this.pollTimer = setInterval(() => {
      void this.poll();
      void this.checkWatchdog();
      this.warnLongRunningTurns();
    }, pollingIntervalMs);
    logger.info({ pollingIntervalMs }, 'Email adapter started — polling Nylas');

    // Flush any messages queued while adapters were stopped (#1380). Multiple
    // account adapters may each publish reconnect — flush is idempotent.
    void bus.publish('channel', createChannelReconnect({ channel: 'email' })).catch((err) => {
      logger.error({ err, accountId }, 'Failed to publish channel.reconnect');
    });

    // Do an initial poll immediately and await it so callers that await start()
    // can be confident the first poll has completed before they assert results.
    // Subsequent polls run on setInterval (fire-and-forget).
    await this.poll();
  }

  async stop(): Promise<void> {
    // Gate the runner before dropping queues. A turn that settles while stop()
    // is in progress must not start the next one.
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.dropPendingInbound();
    await this.drainInFlightBounded();
    this.startedAt = null;
    // Await the disconnect publication before returning so a graceful stop() does
    // not resolve (or lose the event during immediate shutdown) while the readiness
    // transition is still in flight — the publish is a shutdown side effect, not
    // fire-and-forget (#1380 review).
    try {
      await this.config.bus.publish(
        'channel',
        createChannelDisconnected({
          channel: 'email',
          reason: `Email adapter stopped (account=${this.config.accountId})`,
        }),
      );
    } catch (err) {
      this.config.logger.error({ err }, 'Failed to publish channel.disconnected');
    }
    this.config.logger.info('Email adapter stopped');
  }

  /**
   * Deliver this account's recent unacknowledged inbound rows before the first poll.
   *
   * Only the last {@link INBOUND_REPLAY_MAX_AGE_HOURS} hours are loaded, and a
   * row is omitted when a later `inbound.message` in that window has the same
   * Nylas message id. A turn that was mid-flight when the process died may
   * already have sent its reply. Replay is at-least-once for that case, the
   * same as the re-fetch it replaces. A load failure is logged and startup
   * continues; the rows stay unacknowledged for the next start.
   */
  private async replayUnacknowledgedInbound(): Promise<void> {
    const source = this.config.unacknowledgedInbound;
    if (!source) return;
    let events: InboundMessageEvent[];
    try {
      events = await source.listUnacknowledgedInbound(this.config.accountId);
    } catch (err) {
      this.config.logger.error(
        { err, accountId: this.config.accountId },
        'Email adapter: failed to load unacknowledged inbound mail — replay skipped',
      );
      return;
    }
    if (events.length === 0) return;
    this.config.logger.info(
      {
        accountId: this.config.accountId,
        count: events.length,
        maxAgeHours: INBOUND_REPLAY_MAX_AGE_HOURS,
      },
      'Email adapter: replaying unacknowledged inbound mail',
    );
    if (events.length === INBOUND_REPLAY_LIMIT) {
      this.config.logger.warn(
        { accountId: this.config.accountId, count: events.length, limit: INBOUND_REPLAY_LIMIT },
        'Email adapter: inbound replay hit its limit — further rows in the window wait for the next start',
      );
    }
    for (const event of events) {
      if (!this.running) break;
      const messageId = nylasMessageIdOf(event);
      this.rememberStagedId(messageId);
      const queued = queuedFromReplay(
        event,
        messageId,
        () => this.config.bus.deliverPersisted(event),
      );
      if (this.enqueueInbound(queued)) this.logInboundQueued(queued);
    }
  }

  private async poll(): Promise<void> {
    // Guard against overlapping fetches. A previous poll still inside Nylas or
    // pre-publish work skips this cycle. An in-flight agent turn does not —
    // those run on the detached runner and must not stall the inbox (#2254).
    if (this.processing) return;
    this.processing = true;

    const pollStart = Date.now();
    // Capture watermark before the loop so we can detect whether it advanced.
    const prevWatermark = this.lastSeenTimestamp;

    // Per-filter skip counters for the channel.poll audit event.
    const skipped = {
      sent_folder: 0,
      recently_sent: 0,
      self: 0,
      excluded: 0,
      failed: 0,
      deferred: 0,
      already_staged: 0,
    };
    let fetched = 0;
    let processed = 0;

    // Separate try/catch for the Nylas API call so a transient network error
    // doesn't silently drop already-fetched messages.
    let messages;
    try {
      messages = await this.config.outboundGateway.listEmailMessages({
        receivedAfter: this.lastSeenTimestamp,
        unread: true,
        limit: EMAIL_POLL_PAGE_SIZE,
        // Request raw headers so the converter can extract Authentication-Results
        // and compute senderVerified (SPF/DKIM/DMARC). Without this flag, Nylas
        // omits headers from the response entirely and senderVerified will be false.
        fields: 'include_headers',
      }, this.config.accountId);
    } catch (err) {
      this.config.logger.error({ err }, 'Email polling failed — will retry');
      this.processing = false;
      return;
    }

    // Defensive: a misbehaving gateway mock/client must not throw an unhandled
    // rejection mid-poll (Vitest treats those as suite failures).
    if (!Array.isArray(messages)) {
      this.config.logger.error(
        { messagesType: typeof messages },
        'Email polling returned a non-array — will retry',
      );
      this.processing = false;
      return;
    }

    // Nylas returns newest-first. Same-thread mail must run oldest-first, so
    // sort by date before the loop. The watermark does not depend on order.
    const ordered = messages
      .map((msg, index) => ({ msg, index }))
      .sort((a, b) => a.msg.date - b.msg.date || a.index - b.index)
      .map((entry) => entry.msg);

    // Last watermark that is safe to persist: intentional skips and successful
    // write-aheads. A retryable write-ahead failure rolls the in-memory mark
    // back to include that message and stops the batch (#2254).
    let durableWatermark = prevWatermark;
    let endedOnWriteAheadRetry = false;

    try {
      for (let index = 0; index < ordered.length; index++) {
        const msg = ordered[index]!;
        if (!this.running) {
          this.lastSeenTimestamp = durableWatermark;
          skipped.deferred += ordered.length - index;
          break;
        }
        // Advance the in-memory mark before processing so a permanently broken
        // message (malformed payload, or write-ahead past its retry budget) is
        // not retried. A retryable write-ahead failure rolls the mark back.
        // +1 excludes this exact Unix second: receivedAfter is inclusive.
        if (msg.date >= this.lastSeenTimestamp) {
          this.lastSeenTimestamp = msg.date + 1;
        }

        // Already persisted in this process (replay, or a previous poll that
        // rolled the watermark back over a same-second neighbour).
        if (this.stagedInboundIds.has(msg.id)) {
          this.config.logger.debug(
            { messageId: msg.id, accountId: this.config.accountId },
            'Email skipped — inbound message was already written ahead',
          );
          skipped.already_staged++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        // ── Layer 1: folder-based detection ──────────────────────────────────
        // Skip messages in sent or draft folders — they are never genuine inbound
        // messages, regardless of the From address. This catches send-as aliases
        // (e.g. security@meetcuria.com) where the From won't match selfEmail.
        // Folder IDs/names vary by provider but always contain "sent" or "draft"
        // as a substring (Gmail: "SENT"/"DRAFT"; IMAP: "Sent Mail"/"Drafts").
        // Using a plain substring match so provider-specific prefixes/suffixes
        // like "recently-sent" still match without an asymmetric word boundary.
        const inSentOrDrafts = msg.folders.some((f) => /(sent|draft)/i.test(f));
        if (inSentOrDrafts) {
          this.config.logger.debug(
            { messageId: msg.id, folders: msg.folders, accountId: this.config.accountId },
            'Email skipped — message is in sent/drafts folder',
          );
          skipped.sent_folder++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        // ── Layer 2: recently-sent message ID ────────────────────────────────
        // Skip any message whose Nylas ID was recorded when we sent it.
        // This is the most reliable alias-proof check — the ID is unique and
        // does not depend on the From address matching selfEmail.
        // Note: this only covers direct sends through sendWithGatedDraftFallback.
        // Draft-to-send flows approved via the send-draft skill are not tracked
        // here; those rely on Layers 1 and 3 for loop prevention.
        if (this.recentlySentIds.has(msg.id)) {
          this.config.logger.info(
            { messageId: msg.id, accountId: this.config.accountId },
            'Email skipped — matches recently-sent message ID (loop guard)',
          );
          skipped.recently_sent++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        // ── Layer 3: address-based self-check (with plus-address normalization) ─
        // Skip emails sent by this account (self) — we only want inbound messages
        // from external senders, not our own outgoing replies.
        // normalizeForComparison strips plus-addressing and lowercases so that
        // variations like curia+reply@example.com still match curia@example.com.
        const fromEmail = msg.from[0]?.email;
        if (!fromEmail) {
          // Log a warning so misconfigured or malformed messages are observable.
          // We still forward for processing — the downstream dispatcher applies its
          // own sender policy and will surface the empty senderId appropriately.
          this.config.logger.warn(
            { messageId: msg.id, threadId: msg.threadId, accountId: this.config.accountId },
            'Email received with missing From address — self-check skipped, processing with unknown sender',
          );
        }
        if (
          fromEmail &&
          normalizeForComparison(fromEmail) === normalizeForComparison(this.config.selfEmail)
        ) {
          skipped.self++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        // Skip emails from any suppressed sender addresses (auto-derived union of all
        // owned mailbox addresses per #1101, to prevent cross-account reply loops).
        if (
          fromEmail &&
          this.config.suppressedSenderEmails.some(
            (suppressed) => normalizeForComparison(suppressed) === normalizeForComparison(fromEmail),
          )
        ) {
          this.config.logger.debug(
            { fromEmail, accountId: this.config.accountId },
            'Email skipped — sender is in suppressedSenderEmails',
          );
          skipped.excluded++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        let converted;
        try {
          converted = convertNylasMessage(msg, this.config.selfEmail);

          // Auto-create contacts from participants before publishing the inbound
          // event, so the contact resolver in the dispatch layer can find them.
          await this.extractParticipants(
            converted.metadata.participants,
            converted.metadata.subject,
            converted.senderId,
          );
        } catch (err) {
          // Conversion and contact extraction are not retried. The watermark
          // advanced above on purpose so a permanently broken payload cannot
          // wedge the inbox.
          this.config.logger.error(
            { err, messageId: msg.id, threadId: msg.threadId, senderEmail: fromEmail },
            'Failed to process inbound email — skipping message',
          );
          skipped.failed++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        // A sanitize throw is a pre-handoff skip. It must not abort the poll.
        let sanitizedContent: string;
        try {
          // Strips known injection patterns before the content reaches the LLM.
          // The converter already capped the body; this ceiling only prevents a
          // second truncation.
          sanitizedContent = sanitizeOutput(converted.content, { maxLength: 60_000 });
        } catch (err) {
          this.config.logger.error(
            { err, messageId: msg.id, threadId: msg.threadId, senderEmail: fromEmail },
            'Failed to process inbound email — skipping message',
          );
          skipped.failed++;
          durableWatermark = this.lastSeenTimestamp;
          continue;
        }

        const event = createInboundMessage({
          conversationId: converted.conversationId,
          channelId: converted.channelId,
          accountId: this.config.accountId,
          senderId: converted.senderId,
          content: sanitizedContent,
          metadata: {
            ...(converted.metadata as unknown as Record<string, unknown>),
          },
        });

        // Write-ahead before the watermark may move past this message. Delivery
        // of the agent turn stays on the runner (#2254).
        let deliver: () => Promise<void>;
        try {
          const staged = await this.config.bus.stagePublish('channel', event);
          deliver = staged.deliver;
        } catch (err) {
          // A database outage fails every write-ahead. Counting it toward the
          // per-message budget would skip real mail after about 90s, and
          // replay cannot recover a row that was never written. Outages still
          // end the poll on a write-ahead failure, so health goes red.
          const outage = isDbUnavailableError(err);
          const attempts = outage
            ? (this.writeAheadFailures.get(msg.id) ?? 0)
            : (this.writeAheadFailures.get(msg.id) ?? 0) + 1;
          if (!outage) this.writeAheadFailures.set(msg.id, attempts);
          if (!outage && attempts >= WRITE_AHEAD_RETRY_LIMIT) {
            this.writeAheadFailures.delete(msg.id);
            this.config.logger.error(
              {
                err,
                messageId: msg.id,
                threadId: msg.threadId,
                senderEmail: fromEmail,
                attempts,
              },
              'Inbound email write-ahead failed — skipping message after repeated failures',
            );
            skipped.failed++;
            durableWatermark = this.lastSeenTimestamp;
            continue;
          }
          this.config.logger.error(
            {
              err,
              messageId: msg.id,
              threadId: msg.threadId,
              senderEmail: fromEmail,
              attempts,
              outage,
              remainingInBatch: ordered.length - index - 1,
            },
            'Inbound email write-ahead failed — will retry next poll',
          );
          // Same-second neighbours share `date`. Rolling back only to the
          // previous success's date+1 would leave this message below the next
          // receivedAfter. Include its own second; already-staged ids skip
          // the neighbours this process has written ahead.
          this.lastSeenTimestamp = Math.min(durableWatermark, msg.date);
          skipped.deferred += ordered.length - index;
          endedOnWriteAheadRetry = true;
          break;
        }

        this.writeAheadFailures.delete(msg.id);
        this.rememberStagedId(msg.id);

        const queued: QueuedInboundEmail = {
          event,
          deliver,
          messageId: msg.id,
          threadId: msg.threadId,
          senderEmail: fromEmail,
          senderId: converted.senderId,
          subject: msg.subject,
          senderVerified: converted.metadata.senderVerified,
          queuedAt: Date.now(),
        };
        // stop() during stagePublish drops the message. Leave the watermark
        // behind it so the row is replayed on the next start, and do not
        // count it as processed.
        if (!this.enqueueInbound(queued)) {
          this.lastSeenTimestamp = durableWatermark;
          skipped.deferred += ordered.length - index;
          break;
        }
        this.logInboundQueued(queued);
        processed++;
        durableWatermark = this.lastSeenTimestamp;
      }
    } finally {
      this.processing = false;
    }

    fetched = messages.length;

    // stop() landed during this poll. Queued mail was dropped, and a message
    // this cycle already wrote ahead must stay behind the persisted watermark.
    // Skip the health stamp and channel.poll too: disconnected already fired.
    if (!this.running) return;

    if (endedOnWriteAheadRetry) {
      this.writeAheadPollFailures += 1;
    } else {
      this.writeAheadPollFailures = 0;
    }

    // ── Post-poll accounting (only reached when listEmailMessages succeeded) ──
    // Stamped when the fetch and write-ahead finish. A coordinator turn still
    // running on the detached runner must not age this out (#2254).

    this._lastSuccessfulPollAt = Date.now();
    this.warnLongRunningTurns();

    // Emit one channel.poll audit event per cycle so operators can verify the
    // adapter is alive and measure throughput over time.
    try {
      await this.config.bus.publish('channel', createChannelPoll({
        accountId: this.config.accountId,
        channel: 'email',
        fetched,
        processed,
        skipped,
        lastSeenAt: this.lastSeenTimestamp,
        durationMs: Date.now() - pollStart,
      }));
    } catch (err) {
      // Non-fatal — the messages were processed. Lose the audit event, not the mail.
      this.config.logger.error({ err }, 'Failed to emit channel.poll audit event');
    }

    // Persist the watermark only when it actually advanced to avoid KG write churn
    // on idle polls. Wrapped in try/catch so a KG write failure never aborts the
    // poll loop — the in-memory watermark remains correct for the current run.
    if (this.lastSeenTimestamp !== prevWatermark && this.config.configStore) {
      try {
        const { stored } = await this.config.configStore.set(
          POLL_STATE_NAMESPACE,
          lastSeenKey(this.config.accountId),
          String(this.lastSeenTimestamp),
        );
        if (!stored) {
          // Soft-reject (storeFact dedup 'conflict'/'auto_rejected' — no throw, so the catch below
          // never fires). The durable watermark stayed at its prior value: a restart would re-fetch
          // from there and reprocess already-seen mail. That's harmless (message processing dedups by
          // id) but wasteful, and otherwise entirely silent. Warn so operators can spot a stuck
          // watermark; the in-memory value remains correct for this run and the next advance retries.
          this.config.logger.warn(
            { accountId: this.config.accountId, lastSeenTimestamp: this.lastSeenTimestamp },
            'Email adapter: poll watermark write soft-rejected — durable watermark not advanced (in-memory value still current)',
          );
        }
      } catch (err) {
        this.config.logger.error(
          { err, accountId: this.config.accountId, lastSeenTimestamp: this.lastSeenTimestamp },
          'Email adapter: failed to persist poll watermark — in-memory value still current',
        );
      }
    }
  }

  /**
   * Accept one inbound message whose write-ahead already succeeded. Starts
   * delivery when the thread is idle and a slot is free; otherwise queues it.
   * Same-thread messages stay in queue order and never run concurrently
   * (#2018, #2254). Returns false when the adapter is stopped and the message
   * was dropped.
   */
  private enqueueInbound(item: QueuedInboundEmail): boolean {
    if (!this.running) {
      this.logDroppedInbound(item);
      return false;
    }
    const conversationId = item.event.payload.conversationId;
    const queue = this.pendingByThread.get(conversationId);
    if (queue) {
      queue.push(item);
      if (this.runningThreads.has(conversationId)) {
        this.config.logger.debug(
          { accountId: this.config.accountId, messageId: item.messageId, threadId: item.threadId },
          'Email adapter: inbound message queued behind the in-flight turn on this thread',
        );
      }
    } else {
      this.pendingByThread.set(conversationId, [item]);
    }
    this.scheduleThread(conversationId);
    return true;
  }

  private scheduleThread(conversationId: string): void {
    if (!this.running) return;
    if (this.runningThreads.has(conversationId)) return;
    const queue = this.pendingByThread.get(conversationId);
    if (!queue || queue.length === 0) return;
    if (this.inFlightTurns >= this.maxConcurrentTurns) {
      if (!this.slotWaiters.has(conversationId)) {
        this.slotWaiters.add(conversationId);
        const head = queue[0];
        this.config.logger.info(
          {
            accountId: this.config.accountId,
            messageId: head?.messageId,
            threadId: head?.threadId,
            inFlight: this.inFlightTurns,
            pending: this.inboundPending,
            maxConcurrentTurns: this.maxConcurrentTurns,
          },
          'Email adapter: in-flight cap reached; inbound message queued',
        );
      }
      return;
    }
    this.startThread(conversationId);
  }

  private startThread(conversationId: string): void {
    if (!this.running) return;
    this.slotWaiters.delete(conversationId);
    const queue = this.pendingByThread.get(conversationId);
    const item = queue?.shift();
    if (!queue || !item) {
      this.pendingByThread.delete(conversationId);
      return;
    }
    if (queue.length === 0) this.pendingByThread.delete(conversationId);

    this.runningThreads.add(conversationId);
    this.threadOwner.set(conversationId, item.messageId);
    this.inFlightTurns += 1;
    const startedAt = Date.now();
    this.inFlightStartedAt.set(item.messageId, { conversationId, startedAt });

    // Flag on only. intakeSettled resolves immediately when the lane is off,
    // and releasing the thread then would let the next message pass the one
    // still running. The in-flight count stays tied to `run` either way.
    const lanes = this.config.turnLanes;
    if (lanes?.enabled) {
      void lanes.intakeSettled(item.event.id).then(() => {
        this.releaseRunningThread(conversationId, item.messageId);
      });
    }

    // One chain for a sync throw and a rejection. Bookkeeping lives in finally
    // so the two paths cannot drift.
    const run = Promise.resolve()
      .then(() => item.deliver())
      .then(
        () => {
          this.logInboundCompleted(item, Date.now() - startedAt);
        },
        (err: unknown) => {
          this.logInboundTurnFailure(err, item);
        },
      )
      .finally(() => {
        // The dispatcher settles intake after it accepts the inbound. A
        // write-ahead failure never gets there, and this call is idempotent.
        if (lanes?.enabled) lanes.markIntakeSettled(item.event.id);
        this.releaseRunningThread(conversationId, item.messageId);
        this.inFlightTurns -= 1;
        this.inFlightStartedAt.delete(item.messageId);
        this.stallWarned.delete(item.messageId);
        this.inFlightRuns.delete(run);
        if (!this.running) return;
        // Behind threads that were already waiting on the cap, so a burst on
        // one thread does not keep every other thread queued.
        if (this.pendingByThread.has(conversationId)) {
          this.slotWaiters.delete(conversationId);
          this.slotWaiters.add(conversationId);
        }
        this.drainSlotWaiters();
      });
    this.inFlightRuns.add(run);
  }

  /**
   * Drop the thread lock if this delivery still owns it. A later message may
   * already own it once intake settled early; that owner's lock stays.
   */
  private releaseRunningThread(conversationId: string, messageId: string): void {
    if (this.threadOwner.get(conversationId) !== messageId) return;
    this.threadOwner.delete(conversationId);
    this.runningThreads.delete(conversationId);
    if (!this.running) return;
    if (this.pendingByThread.has(conversationId)) {
      this.slotWaiters.delete(conversationId);
      this.slotWaiters.add(conversationId);
    }
    this.drainSlotWaiters();
  }

  private drainSlotWaiters(): void {
    if (!this.running) return;
    while (this.inFlightTurns < this.maxConcurrentTurns && this.slotWaiters.size > 0) {
      const conversationId = this.slotWaiters.values().next().value;
      if (conversationId === undefined) break;
      this.slotWaiters.delete(conversationId);
      if (this.runningThreads.has(conversationId)) continue;
      if (!this.pendingByThread.has(conversationId)) continue;
      this.startThread(conversationId);
    }
  }

  /** Wait for in-flight turns, but only up to STOP_DRAIN_MS. */
  private async drainInFlightBounded(): Promise<void> {
    if (this.inFlightRuns.size === 0) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        this.config.logger.warn(
          { accountId: this.config.accountId, inFlight: this.inFlightTurns },
          'Email adapter stop: in-flight turns still running after drain timeout',
        );
        resolve();
      }, STOP_DRAIN_MS);
    });
    await Promise.race([this.drainInFlight(), timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  private dropPendingInbound(): void {
    for (const queue of this.pendingByThread.values()) {
      for (const item of queue) this.logDroppedInbound(item);
    }
    this.pendingByThread.clear();
    this.slotWaiters.clear();
  }

  private logDroppedInbound(item: QueuedInboundEmail): void {
    this.config.logger.error(
      {
        accountId: this.config.accountId,
        messageId: item.messageId,
        threadId: item.threadId,
        conversationId: item.event.payload.conversationId,
      },
      'Email adapter stopped with inbound mail still queued — message dropped',
    );
  }

  private warnLongRunningTurns(): void {
    const now = Date.now();
    for (const [messageId, entry] of this.inFlightStartedAt) {
      const ageMs = now - entry.startedAt;
      if (ageMs < EMAIL_INBOUND_TURN_STALL_MS) continue;
      if (this.stallWarned.has(messageId)) continue;
      this.stallWarned.add(messageId);
      this.config.logger.warn(
        {
          accountId: this.config.accountId,
          conversationId: entry.conversationId,
          messageId,
          ageMs,
          thresholdMs: EMAIL_INBOUND_TURN_STALL_MS,
          inFlight: this.inFlightTurns,
          pending: this.inboundPending,
        },
        'Email adapter: inbound turn still running past the stall bound',
      );
    }
  }

  /** Receipt signal. Fires at handoff, including when delivery later rejects. */
  private logInboundQueued(item: QueuedInboundEmail): void {
    if (item.replayed) {
      this.config.logger.info(
        {
          senderEmail: item.senderId,
          subject: item.subject,
          threadId: item.threadId,
          messageId: item.messageId,
          senderVerified: item.senderVerified,
          replayed: true,
          inFlight: this.inFlightTurns,
          pending: this.inboundPending,
        },
        'Unacknowledged inbound mail queued for replay',
      );
      return;
    }
    if (!item.senderVerified) {
      this.config.logger.warn(
        { senderEmail: item.senderId, messageId: item.messageId },
        'Email received with senderVerified: false — SPF/DKIM/DMARC did not all pass or headers were absent',
      );
    }
    this.config.logger.info(
      {
        senderEmail: item.senderId,
        subject: item.subject,
        threadId: item.threadId,
        messageId: item.messageId,
        senderVerified: item.senderVerified,
        inFlight: this.inFlightTurns,
        pending: this.inboundPending,
      },
      'Email received and queued',
    );
  }

  private logInboundCompleted(item: QueuedInboundEmail, durationMs: number): void {
    this.config.logger.info(
      {
        senderEmail: item.senderId,
        subject: item.subject,
        threadId: item.threadId,
        messageId: item.messageId,
        conversationId: item.event.payload.conversationId,
        durationMs,
      },
      'Inbound email turn completed',
    );
  }

  private logInboundTurnFailure(err: unknown, item: QueuedInboundEmail): void {
    this.config.logger.error(
      {
        err,
        messageId: item.messageId,
        threadId: item.threadId,
        conversationId: item.event.payload.conversationId,
        senderEmail: item.senderEmail,
      },
      'Inbound email turn failed after handoff — not retried',
    );
  }

  /**
   * Check whether the poll loop has stalled and emit channel.stalled if so.
   * Called on each interval tick alongside poll(). Emits at most once per adapter
   * lifecycle (until stop()/start()) — repeated alerts add noise without value.
   * If the bus publish fails, retries on the next tick up to MAX_STALL_EMIT_ATTEMPTS.
   */
  private async checkWatchdog(): Promise<void> {
    if (this.stalledEmitted) return;
    if (this.startedAt === null) return;
    if (this.stalledEmitAttempts >= EmailAdapter.MAX_STALL_EMIT_ATTEMPTS) return;

    const now = Date.now();
    const threshold = 5 * this.config.pollingIntervalMs;

    // Use the last successful poll time when available; fall back to startedAt
    // so a never-successful adapter (first poll already failing) is also detected.
    const reference = this._lastSuccessfulPollAt ?? this.startedAt;
    if (now - reference <= threshold) return;

    this.stalledEmitAttempts++;
    this.config.logger.error(
      {
        accountId: this.config.accountId,
        lastSuccessfulPollAt: this._lastSuccessfulPollAt,
        stallThresholdMs: threshold,
      },
      'Email adapter stall detected — no successful poll within threshold',
    );

    try {
      await this.config.bus.publish('channel', createChannelStalled({
        accountId: this.config.accountId,
        channel: 'email',
        lastSuccessfulPollAt: this._lastSuccessfulPollAt,
        stallThresholdMs: threshold,
      }));
      // Set stalledEmitted only after confirmed publish — if publish fails we retry
      // on the next tick (bounded by MAX_STALL_EMIT_ATTEMPTS) rather than permanently
      // silencing the alert.
      this.stalledEmitted = true;
    } catch (err) {
      this.config.logger.error(
        { err, attempt: this.stalledEmitAttempts, maxAttempts: EmailAdapter.MAX_STALL_EMIT_ATTEMPTS },
        'Failed to emit channel.stalled — will retry on next watchdog tick',
      );
    }
  }

  /**
   * Send the coordinator's response as an email reply in the original thread.
   * The conversationId encodes the thread (email:{threadId}), so we look up the
   * most recent inbound message in that thread and reply to it.
   * Sends via OutboundGateway (autonomy gate applied at gateway level).
   */
  private async sendOutboundReply(outbound: OutboundMessageEvent): Promise<void> {
    const { outboundGateway, logger } = this.config;
    const conversationId = outbound.payload.conversationId;

    if (!conversationId.startsWith('email:')) {
      logger.warn({ conversationId }, 'Cannot send email reply — conversation ID not in email format');
      return;
    }
    const threadId = conversationId.slice('email:'.length);

    try {
      // Fetch the most recent message in this thread. We use it for two things:
      //   1. The message ID — passed as replyToMessageId so Nylas threads the reply
      //   2. The human's email address to send the reply to
      //
      // Nylas returns messages in most-recent-first order, so messages[0] is the
      // latest. If Curia was the last sender (a prior turn in the conversation),
      // messages[0].from is Curia's own address — we must NOT reply to ourselves.
      // In that case, look at messages[0].to to find the human recipient.
      // include_headers so Authentication-Results is present for reply provenance (#2071).
      const messages = await outboundGateway.listEmailMessages(
        { limit: 1, threadId, fields: 'include_headers' },
        this.config.accountId,
      );
      const threadMessage = messages[0];
      if (!threadMessage) {
        logger.warn({ threadId }, 'Cannot find message to reply to in thread');
        return;
      }

      // Reply-all, the same derivation the email-reply skill uses (#2273): a received
      // message goes to its sender plus its other To, CC to its CC; when the latest
      // message is ours, the reply goes to the people it was addressed to. Our own
      // address is dropped everywhere, so a self-addressed thread resolves to null
      // rather than looping a reply into our own inbox.
      // Every owned mailbox, not just this account's: a latest message sent
      // from another of our accounts is still ours.
      const ownedMailboxes = [this.config.selfEmail, ...this.config.suppressedSenderEmails];
      const recipientSet = deriveEmailReplyRecipientSet({
        originalFrom: threadMessage.from[0]?.email,
        originalTo: threadMessage.to,
        originalCc: threadMessage.cc,
        ccInput: undefined,
        selfEmails: ownedMailboxes,
      });
      if (!recipientSet) {
        logger.warn(
          { threadId, messageId: threadMessage.id },
          'Cannot reply — no recipient outside our own mailbox in the latest thread message',
        );
        return;
      }
      const latestIsOurs = !recipientSet.toIsOriginalSender;
      const recipientEmail = recipientSet.to;
      const additionalTo = recipientSet.additionalTo;
      const ccAddresses = recipientSet.cc;

      if (additionalTo.length > 0 || ccAddresses.length > 0) {
        logger.debug(
          { additionalTo, ccAddresses, latestIsOurs },
          'sendOutboundReply: reply-all including further To and CC recipients',
        );
      }

      // Strip any existing "Re:" prefix before prepending our own to avoid
      // "Re: Re: Re: ..." chains when replying to already-replied threads.
      const baseSubject = threadMessage.subject.replace(/^Re:\s*/i, '');

      // Append a quoted copy of the original message below the reply body so
      // the recipient sees the context they replied to. Matches the format
      // used by email-send / email-reply / email-draft-save skills. The quote
      // is best-effort — if formatting fails or the total body would exceed
      // MAX_REPLY_BODY_LENGTH, the reply still goes out without the quote.
      // htmlQuote is passed separately so it is appended after markdownToHtml(body)
      // in the gateway, preventing the HTML from being re-escaped.
      const body = outbound.payload.content;
      let htmlQuote: string | undefined;
      try {
        const candidate = buildReplyQuote(threadMessage, this.config.timezone, { format: 'html' });
        if (body.length + candidate.length <= MAX_REPLY_BODY_LENGTH) {
          htmlQuote = candidate;
        }
      } catch (err) {
        logger.warn(
          { err, threadId, messageId: threadMessage.id },
          'sendOutboundReply: failed to build reply quote — proceeding without quote',
        );
      }

      const sendRequest = {
        channel: 'email' as const,
        accountId: this.config.accountId,
        to: recipientEmail,
        ...(additionalTo.length > 0 ? { additionalTo } : {}),
        // These people never wrote to us: no known-tier contact for them (#2273, ADR-047).
        ...(latestIsOurs ? { toFromOwnMessage: true } : {}),
        subject: `Re: ${baseSubject}`,
        body,
        replyToMessageId: threadMessage.id,
        htmlQuote,
        ...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
      };

      if (outbound.payload.contentBlockSalvage) {
        await this.saveContentBlockSalvageDraft(sendRequest, {
          conversationId: outbound.payload.conversationId,
          taskEventId: outbound.payload.taskEventId,
        });
        return;
      }

      // Provenance is a send option, not a field on sendRequest. A gated send
      // falls back to a draft, and send-draft must stay outbound_recipient.
      // addressFromHeader is false when To came from the thread's To list
      // (the latest message is ours), so that reply does not opt in.
      const provenance = replyRecipientSource({
        addressFromHeader: !latestIsOurs,
        recipient: recipientEmail,
        selfEmails: ownedMailboxes,
        headers: threadMessage.headers,
      });
      const fromName = provenance
        ? replyDisplayName(latestIsOurs ? undefined : threadMessage.from[0]?.name, recipientEmail)
        : undefined;

      await this.sendWithGatedDraftFallback(sendRequest, {
        taskEventId: outbound.payload.taskEventId,
        conversationId: outbound.payload.conversationId,
        parentEventId: outbound.id,   // link the outbound.delivered row back to the outbound.message event
        ...(provenance ? { recipientSource: provenance } : {}),
        ...(fromName ? { recipientDisplayName: fromName } : {}),
        // The principal approved this text (dispatcher-relay): do not hold it for review again (#2159).
        ...(outbound.payload.principalApproved === true ? { humanApproved: true } : {}),
      });
    } catch (err) {
      logger.error({ err, threadId }, 'Failed to send email reply');
    }
  }

  /**
   * Send the reply through the gateway (autonomy gate + blocked-contact +
   * content filter all run inside gateway.send). If the gateway returns
   * gated (autonomy blocked), fall back to creating a draft and linking
   * the action_log row so the principal can approve-and-send from the digest.
   */
  private async sendWithGatedDraftFallback(
    sendRequest: EmailSendRequest,
    context: {
      taskEventId?: string;
      conversationId?: string;
      parentEventId?: string;
      recipientSource?: 'email_participant';
      recipientDisplayName?: string;
      /** The principal approved this exact text (#2159). */
      humanApproved?: boolean;
    },
  ): Promise<void> {
    const { outboundGateway, logger, accountId } = this.config;

    // Send through gateway, handle gated fallback.
    // Pass reExecRecipe so the gateway knows how to re-execute this send on principal approval:
    //   toolName: 'send-draft' — the registered skill approve-action will invoke
    //   partialPayload: { account } — the draft's account; draft_id is filled in by
    //                                 linkGatedAction() after the draft is created below
    //   description: human-readable label for the pending_approval row + notification
    const recipientLabel = [sendRequest.to, ...(sendRequest.additionalTo ?? [])].join(', ');
    const subjectLabel = sendRequest.subject;
    const result = await outboundGateway.send(sendRequest, {
      taskEventId: context.taskEventId,
      conversationId: context.conversationId,
      parentEventId: context.parentEventId,
      // A relayed reply: the agent's turn is over, so a held approval wakes the coordinator (#2159).
      postTurn: true,
      ...(context.humanApproved ? { humanApproved: true } : {}),
      ...(context.recipientSource ? { recipientSource: context.recipientSource } : {}),
      ...(context.recipientDisplayName ? { recipientDisplayName: context.recipientDisplayName } : {}),
      reExecRecipe: {
        toolName: 'send-draft',
        partialPayload: { account: accountId },
        description: `Draft reply to ${recipientLabel}${subjectLabel ? ` — "${subjectLabel}"` : ''}. Use send-draft to approve.`,
      },
    });

    if (result.success) {
      // Track the sent message ID so the next inbound poll skips it.
      // Guards against the case where the provider returns our own sent message
      // as an unread inbox item (e.g. when using a send-as alias address).
      if (result.messageId) {
        this.trackSentId(result.messageId);
      } else {
        // Gateway returned success without a message ID — Layer 2 loop guard
        // is inactive for this specific message. Layers 1 (folder) and 3
        // (address normalization) still apply.
        this.config.logger.warn(
          { accountId: this.config.accountId, conversationId: context.conversationId },
          'email-adapter: send succeeded but gateway returned no messageId — Layer 2 loop guard inactive for this message',
        );
      }
      return;
    }

    if (result.gated) {
      // Gateway blocked the send — create draft as fallback.
      // Guard createEmailDraft explicitly: if it throws, we must not propagate to the
      // outer sendOutboundReply catch, which would log "Failed to send email reply" even
      // though the gateway gate is working correctly and no send was attempted.
      let draftResult: Awaited<ReturnType<typeof outboundGateway.createEmailDraft>> | undefined;
      try {
        draftResult = await outboundGateway.createEmailDraft(sendRequest);
      } catch (err) {
        logger.error(
          { err, accountId, actionRef: result.actionRef },
          'email-adapter: unexpected error creating gated fallback draft — draft not created',
        );
        return;
      }

      if (draftResult && draftResult.success && draftResult.draftId) {
        if (result.actionRef) {
          // linkGatedAction is internally guarded (no-throw), so no outer try/catch needed here.
          // Pass context.taskEventId so linkPayload can scope the update to this specific task,
          // preventing short_ref collisions across tasks from smearing draft_id onto the wrong row.
          // Only draft_id needs linking — account was already stored in reExecRecipe.partialPayload
          // at gate time, so the merged payload matches send-draft's expected inputs exactly.
          await outboundGateway.linkGatedAction(result.actionRef, context.taskEventId, {
            draft_id: draftResult.draftId,
          });
        } else {
          // actionRef is absent either because taskEventId was not passed, or because
          // the action_log insert failed (gateway logs the DB error separately).
          // In either case the draft is created but won't appear in list-pending-actions.
          logger.warn(
            { accountId, draftId: draftResult.draftId },
            'email-adapter: gated fallback draft created but no actionRef available — draft will not appear in list-pending-actions (taskEventId absent or action_log insert failed)',
          );
        }
        // Log inside the success branch only — if the draft failed, we already logged
        // the error below and logging "draft created" would be misleading.
        logger.info(
          { accountId, draftId: draftResult.draftId, actionRef: result.actionRef },
          'email-adapter: send gated — fallback draft created',
        );
      } else if (draftResult && !draftResult.success) {
        logger.error(
          { accountId, actionRef: result.actionRef, reason: draftResult.blockedReason },
          'email-adapter: gated fallback draft creation failed — send blocked, no draft created',
        );
      }
      return;
    }

    // Non-gated failure (blocked contact, content filter, etc.) — already logged by gateway
  }

  /**
   * Save a blocked dispatcher-relayed reply as a draft after rewrite retries are exhausted (#1355).
   * Skips the send path entirely — createEmailDraft still runs blocked-contact and content-filter checks.
   */
  private async saveContentBlockSalvageDraft(
    sendRequest: EmailSendRequest,
    context: { taskEventId?: string; conversationId?: string },
  ): Promise<void> {
    const { outboundGateway, logger, accountId } = this.config;
    let draftResult: Awaited<ReturnType<typeof outboundGateway.createEmailDraft>> | undefined;
    try {
      draftResult = await outboundGateway.createEmailDraft(sendRequest);
    } catch (err) {
      logger.error(
        { err, accountId, conversationId: context.conversationId },
        'email-adapter: unexpected error creating content-block salvage draft',
      );
      return;
    }

    if (draftResult?.success && draftResult.draftId) {
      logger.info(
        { accountId, draftId: draftResult.draftId, conversationId: context.conversationId },
        'email-adapter: content-block salvage draft created',
      );
    } else if (draftResult && !draftResult.success) {
      logger.error(
        { accountId, conversationId: context.conversationId, reason: draftResult.blockedReason },
        'email-adapter: content-block salvage draft creation failed',
      );
    }
  }

  /**
   * Auto-create contacts from email participants (From/To/CC).
   * Uses source 'email_participant' which is auto-verified per spec.
   * Skips participants that already have a contact record, and skips
   * our own email address (selfEmail) to avoid self-contact creation.
   *
   * Rate limits (#36):
   *   - Per-message: at most contactCreationMaxPerMessage new contacts per email
   *   - Per-hour:    at most contactCreationMaxPerHour new contacts per sliding window
   * When a limit is hit, remaining participants are skipped and a principal
   * notification is sent (deduplicated to one per limit type per hour).
   */
  private async extractParticipants(
    participants: Array<{ email: string; name?: string; role: string }>,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { contactService, logger, selfEmail, contactCreationMaxPerMessage, contactCreationMaxPerHour } = this.config;

    // Reset (or lazily start) the hourly window if it has expired.
    // hourlyWindowStart = 0 means the window hasn't opened yet — treat it as always-expired
    // so the window anchors to the first actual contact creation, not process startup.
    const now = Date.now();
    if (now - this.hourlyWindowStart >= 3_600_000) {
      this.hourlyContactCount = 0;
      this.hourlyWindowStart = now;
    }

    let createdThisMessage = 0;
    let skippedThisMessage = 0;
    let hitPerMessageCap = false;
    let hitPerHourCap = false;

    for (const p of participants) {
      // Don't create a contact for ourselves — normalizeForComparison handles casing
      // and plus-address variations (e.g. "curia+tag@example.com" vs "curia@example.com").
      if (normalizeForComparison(p.email) === normalizeForComparison(selfEmail)) continue;

      try {
        // Check if this email is already linked to a contact
        const existing = await contactService.resolveByChannelIdentity('email', p.email);
        if (existing) continue;

        // Check per-message cap (existing contacts don't count — only new creations)
        if (createdThisMessage >= contactCreationMaxPerMessage) {
          skippedThisMessage++;
          if (!hitPerMessageCap) {
            hitPerMessageCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerMessage, emailSubject },
              'Contact auto-creation per-message cap reached — skipping remaining participants',
            );
          }
          continue;
        }

        // Check per-hour cap
        if (this.hourlyContactCount >= contactCreationMaxPerHour) {
          skippedThisMessage++;
          if (!hitPerHourCap) {
            hitPerHourCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerHour, hourlyCount: this.hourlyContactCount },
              'Contact auto-creation per-hour cap reached — skipping remaining participants',
            );
          }
          continue;
        }

        // Create a new contact and link the email identity to it.
        // Display name sanitization happens inside createContact() (see issue #39).
        // We pass the email as fallbackDisplayName so that if the participant name
        // sanitizes to empty (e.g., pure injection text), the email is used instead.
        // primaryEmail is passed so createContact() can route business senders to an
        // existing or new organization KG node instead of minting a person node.
        const { contact, kgNodeCreated } = await contactService.createContactWithKgOutcome({
          displayName: p.name || p.email,
          fallbackDisplayName: p.email,
          source: 'email_participant',
          tier: 'unknown',
          primaryEmail: p.email,
        });

        // Link the identity, guarding against a concurrent call that may have created
        // and linked the same identity between our resolveByChannelIdentity check and
        // now. If linkIdentity hits a unique-constraint violation (23505), the concurrent
        // caller won — clean up our orphaned contact (issue #946: no identity-less rows)
        // and skip. For any other error, clean up the orphan then rethrow to the outer
        // catch so the participant is skipped with a warning.
        let linked = false;
        try {
          await contactService.linkIdentity({
            contactId: contact.id,
            channel: 'email',
            channelIdentifier: p.email,
            source: 'email_participant',
          });
          linked = true;
        } catch (linkErr) {
          const pgCode = (linkErr as { code?: string }).code;
          try {
            // Orphan cleanup. Retire the node only if THIS call minted it: an adopted node
            // carries facts accrued long before this attempt (ADR-040), and this path runs
            // per participant on every inbound email — archiving indiscriminately here
            // would be the highest-traffic way to lose knowledge in the system.
            await contactService.deleteContact(contact.id, { archiveAnchoredNode: kgNodeCreated });
          } catch (deleteErr) {
            // Include linkErr so both failure modes are co-located in the log entry.
            logger.warn(
              { deleteErr, linkErr, orphanId: contact.id },
              'extractParticipants: could not clean up orphaned contact after linkIdentity failure',
            );
          }
          if (pgCode !== '23505') throw linkErr;
          logger.info(
            { email: p.email, orphanId: contact.id },
            'extractParticipants: concurrent link conflict — orphan removed, participant already linked',
          );
        }

        if (linked) {
          createdThisMessage++;
          this.hourlyContactCount++;
          logger.info({ email: p.email, name: p.name }, 'Auto-created contact from email participant');
        }
      } catch (err) {
        // Warn rather than error — participant auto-creation is best-effort.
        // The inbound message will still be published even if contact creation fails.
        logger.warn({ err, email: p.email }, 'Failed to auto-create contact from email participant');
      }
    }

    // Send a deduplicated principal notification for each rate limit type that was hit.
    // Both caps can fire simultaneously (e.g. per-hour was already at limit when the email
    // arrived and per-message is also reached), so notify for each independently so that
    // the dedup timestamps are updated correctly.
    if (skippedThisMessage > 0) {
      if (hitPerHourCap) {
        await this.notifyRateLimitHit('per_hour', skippedThisMessage, emailSubject, emailSender);
      }
      if (hitPerMessageCap) {
        await this.notifyRateLimitHit('per_message', skippedThisMessage, emailSubject, emailSender);
      }
    }
  }

  /**
   * Send a deduplicated principal notification when contact auto-creation rate limits
   * are hit. At most one notification per limit type per hour to avoid notification
   * spam during a sustained flood.
   */
  private async notifyRateLimitHit(
    limitType: 'per_message' | 'per_hour',
    skippedCount: number,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { outboundGateway, logger } = this.config;
    const ceoEmail = resolvePrincipalEmail(this.config.ceoEmail);
    const now = Date.now();

    // Dedup: skip if we already sent a notification for this limit type within the last hour
    const lastNotified = limitType === 'per_message' ? this.lastNotifiedPerMessage : this.lastNotifiedPerHour;
    if (now - lastNotified < 3_600_000) {
      logger.debug({ limitType, skippedCount }, 'Rate-limit notification suppressed (already sent within the hour)');
      return;
    }

    if (!ceoEmail) {
      logger.warn({ limitType, skippedCount }, 'Contact rate-limit hit but ceoEmail not configured — cannot notify');
      return;
    }

    const limitLabel = limitType === 'per_message'
      ? `per-message limit (${this.config.contactCreationMaxPerMessage})`
      : `per-hour limit (${this.config.contactCreationMaxPerHour})`;

    try {
      await outboundGateway.sendNotification({
        notificationType: 'contact_rate_limited',
        ceoEmail,
        subject: `Contact auto-creation rate limit reached (${limitLabel})`,
        body: [
          `Contact auto-creation was throttled on the ${this.config.accountId} email account.`,
          '',
          `Limit hit: ${limitLabel}`,
          `Participants skipped: ${skippedCount}`,
          `Triggering email subject: ${emailSubject}`,
          `Triggering email sender: ${emailSender}`,
          '',
          'Skipped participants will be auto-created if they send an email directly.',
          'If this is unexpected, check for spam activity on this account.',
        ].join('\n'),
      });
      // Commit the dedup timestamp only after a successful send — if the send fails we
      // allow a retry on the next limit hit rather than silencing the principal for an hour.
      if (limitType === 'per_message') {
        this.lastNotifiedPerMessage = now;
      } else {
        this.lastNotifiedPerHour = now;
      }
    } catch (err) {
      // Non-fatal — the rate limit is already enforced, this is just a notification.
      // The timestamp was NOT committed, so the next limit hit will attempt to notify again.
      logger.warn({ err, limitType, skippedCount }, 'Failed to send contact rate-limit notification — will retry on next limit hit');
    }
  }
}
