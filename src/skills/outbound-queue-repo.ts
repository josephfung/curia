// outbound-queue-repo.ts — durable queue for outbound sends while a channel is down (#1380).

import type { Pool } from 'pg';
import type { OutboundSendRequest } from './outbound-gateway.js';

export interface OutboundQueueRow {
  id: string;
  channel: string;
  recipient: string;
  payload: OutboundSendRequest;
  enqueuedAt: Date;
  expiresAt: Date;
}

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

  constructor(
    private readonly pool: Pool,
    config: OutboundQueueRepoConfig = {},
  ) {
    this.maxPerChannel = config.maxPerChannel ?? DEFAULT_MAX;
    this.ttlHours = config.ttlHours ?? DEFAULT_TTL_HOURS;
  }

  get maxPendingPerChannel(): number {
    return this.maxPerChannel;
  }

  /** Delete expired rows for a channel (or all channels). Returns deleted count. */
  async deleteExpired(channel?: string): Promise<number> {
    if (channel) {
      const result = await this.pool.query(
        `DELETE FROM outbound_queue WHERE channel = $1 AND expires_at < now()`,
        [channel],
      );
      return result.rowCount ?? 0;
    }
    const result = await this.pool.query(
      `DELETE FROM outbound_queue WHERE expires_at < now()`,
    );
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
  async enqueue(request: OutboundSendRequest): Promise<{ id: string }> {
    const channel = request.channel;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes concurrent enqueue() calls for the same channel (TOCTOU fix).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [channel]);
      await client.query(
        `DELETE FROM outbound_queue WHERE channel = $1 AND expires_at < now()`,
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
        [channel, recipient, JSON.stringify(request), expiresAt],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('outbound_queue insert returned no id');
      await client.query('COMMIT');
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
    return result.rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      recipient: row.recipient,
      // Runtime: payload was inserted as JSONB from OutboundSendRequest.
      payload: row.payload as unknown as OutboundSendRequest,
      enqueuedAt: row.enqueued_at,
      expiresAt: row.expires_at,
    }));
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
  return 'unknown';
}
