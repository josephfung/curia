// outbound-queue-repo.ts — durable queue for outbound sends while a channel is down (#1380).

import type { Pool } from 'pg';
import type { OutboundSendRequest } from './outbound-gateway.js';

export interface OutboundQueueRow {
  id: string;
  channel: string;
  recipient: string;
  payload: OutboundSendRequest;
  /**
   * The send was a system notification (an infrastructure alert), not correspondence (#2710).
   * The flush path must not record the recipient as a contact for one: the operator is told,
   * never talked with, and holds no tier or approval rights (ADR-068).
   */
  systemNotification: boolean;
  enqueuedAt: Date;
  expiresAt: Date;
}

/**
 * The marker that carries `systemNotification` through the JSONB payload. It is stripped by
 * `listPending`, so it never reaches a channel client, and it needs no column or migration.
 * Namespaced so no send request can collide with it.
 */
const SYSTEM_NOTIFICATION_MARKER = '__systemNotification';

/**
 * A queued system notice's notification type, carried the same way (#2710 review), so a notice
 * that expires unsent can be audited as one that reached nobody. Stripped by `listPending`. The
 * expiry DELETEs name it as a literal in their RETURNING clause; keep the two in step.
 */
const NOTIFICATION_TYPE_MARKER = '__notificationType';

/** Told the notification types of queued system notices that expired unsent. Must not throw. */
export type ExpiredNotificationHandler = (notificationTypes: string[]) => void;

export interface OutboundQueueRepoConfig {
  /** Max pending rows per channel. Default 100. */
  maxPerChannel?: number;
  /** Hours until a queued row expires. Default 24. */
  ttlHours?: number;
}

const DEFAULT_MAX = 100;
const DEFAULT_TTL_HOURS = 24;

export class OutboundQueueRepo {
  private readonly maxPerChannel: number;
  private readonly ttlHours: number;
  private onExpiredNotifications?: ExpiredNotificationHandler;

  constructor(
    private readonly pool: Pool,
    config: OutboundQueueRepoConfig = {},
  ) {
    this.maxPerChannel = config.maxPerChannel ?? DEFAULT_MAX;
    this.ttlHours = config.ttlHours ?? DEFAULT_TTL_HOURS;
  }

  /**
   * Who hears about queued system notices that expired unsent (#2710 review). The gateway sets it,
   * so such a notice leaves an `outbound.notification_undelivered` row instead of vanishing. A
   * notice whose flush keeps failing stays queued until it expires, so this covers that too.
   */
  setExpiredNotificationHandler(handler: ExpiredNotificationHandler): void {
    this.onExpiredNotifications = handler;
  }

  /** Hand expired notification types to the handler, when there are any. */
  private reportExpired(rows: Array<{ notification_type: string | null }> | undefined): void {
    const types = (rows ?? []).map((row) => row.notification_type).filter((t): t is string => typeof t === 'string');
    if (types.length > 0) this.onExpiredNotifications?.(types);
  }

  get maxPendingPerChannel(): number {
    return this.maxPerChannel;
  }

  /** Delete expired rows for a channel (or all channels). Returns deleted count. */
  async deleteExpired(channel?: string): Promise<number> {
    if (channel) {
      const result = await this.pool.query<{ notification_type: string | null }>(
        `DELETE FROM outbound_queue WHERE channel = $1 AND expires_at < now()
         RETURNING payload->>'__notificationType' AS notification_type`,
        [channel],
      );
      this.reportExpired(result.rows);
      return result.rowCount ?? 0;
    }
    const result = await this.pool.query<{ notification_type: string | null }>(
      `DELETE FROM outbound_queue WHERE expires_at < now()
       RETURNING payload->>'__notificationType' AS notification_type`,
    );
    this.reportExpired(result.rows);
    return result.rowCount ?? 0;
  }

  /** Count non-expired pending rows for a channel. */
  async countPending(channel: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbound_queue
       WHERE channel = $1 AND expires_at >= now()`,
      [channel],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Enqueue a post-policy send request. Fails when the per-channel cap is reached
   * (fail closed — never silently drop). Prunes expired rows first.
   * Uses a per-channel advisory lock so concurrent enqueues cannot breach the cap.
   */
  async enqueue(
    request: OutboundSendRequest,
    options: { systemNotification?: boolean; notificationType?: string } = {},
  ): Promise<{ id: string }> {
    const channel = request.channel;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes concurrent enqueue() calls for the same channel (TOCTOU fix).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [channel]);
      const expired = await client.query<{ notification_type: string | null }>(
        `DELETE FROM outbound_queue WHERE channel = $1 AND expires_at < now()
         RETURNING payload->>'__notificationType' AS notification_type`,
        [channel],
      );
      const countResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbound_queue
         WHERE channel = $1 AND expires_at >= now()`,
        [channel],
      );
      const pending = Number(countResult.rows[0]?.count ?? 0);
      if (pending >= this.maxPerChannel) {
        throw new OutboundQueueFullError(channel, this.maxPerChannel);
      }
      const recipient = recipientLabel(request);
      const expiresAt = new Date(Date.now() + this.ttlHours * 3_600_000);
      const result = await client.query<{ id: string }>(
        `INSERT INTO outbound_queue (channel, recipient, payload, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id`,
        [
          channel,
          recipient,
          JSON.stringify(
            options.systemNotification === true
              ? {
                  ...request,
                  [SYSTEM_NOTIFICATION_MARKER]: true,
                  ...(options.notificationType ? { [NOTIFICATION_TYPE_MARKER]: options.notificationType } : {}),
                }
              : request,
          ),
          expiresAt,
        ],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('outbound_queue insert returned no id');
      await client.query('COMMIT');
      // After the commit: the rows are gone only once it lands.
      this.reportExpired(expired.rows);
      return { id };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors — original err is what callers need.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load non-expired pending rows for a channel in enqueue order.
   * Caller owns flush atomicity (send-all then delete-all, or leave all).
   */
  async listPending(channel: string): Promise<OutboundQueueRow[]> {
    await this.deleteExpired(channel);
    const result = await this.pool.query<{
      id: string;
      channel: string;
      recipient: string;
      payload: OutboundSendRequest;
      enqueued_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, channel, recipient, payload, enqueued_at, expires_at
       FROM outbound_queue
       WHERE channel = $1 AND expires_at >= now()
       ORDER BY enqueued_at ASC`,
      [channel],
    );
    return result.rows.map((row) => {
      // Runtime: payload was inserted as JSONB from OutboundSendRequest, possibly with the
      // system-notification markers. Strip them so a channel client never sees them.
      const payload = { ...(row.payload as unknown as Record<string, unknown>) };
      const marker = payload[SYSTEM_NOTIFICATION_MARKER];
      delete payload[SYSTEM_NOTIFICATION_MARKER];
      delete payload[NOTIFICATION_TYPE_MARKER];
      return {
        id: row.id,
        channel: row.channel,
        recipient: row.recipient,
        payload: payload as unknown as OutboundSendRequest,
        systemNotification: marker === true,
        enqueuedAt: row.enqueued_at,
        expiresAt: row.expires_at,
      };
    });
  }

  /** Delete a set of row ids (used after a successful all-or-nothing flush). */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `DELETE FROM outbound_queue WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rowCount ?? 0;
  }
}

export class OutboundQueueFullError extends Error {
  constructor(
    readonly channel: string,
    readonly maxPerChannel: number,
  ) {
    super(
      `Outbound queue for channel '${channel}' is full (max ${maxPerChannel}); `
      + 'message not queued',
    );
    this.name = 'OutboundQueueFullError';
  }
}

function recipientLabel(request: OutboundSendRequest): string {
  if (request.channel === 'signal') {
    return request.recipient ?? (request.groupId ? `group:${request.groupId}` : 'unknown');
  }
  if (request.channel === 'email') {
    return request.to;
  }
  if (request.channel === 'slack') {
    return request.slackChannelId;
  }
  if (request.channel === 'sms') {
    return request.recipient;
  }
  if (request.channel === 'web') {
    return 'principal';
  }
  return 'unknown';
}
