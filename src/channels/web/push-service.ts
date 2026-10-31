// push-service.ts — deliver a message to the phone app (#2341, ADR-055).
//
// A delivery writes the shared web thread, tells open browsers, and pushes
// only when none of them has the thread on screen. 404/410 deletes that
// subscription. 403 and other 4xx keep it and record the push service's
// reason. 429/5xx are retried here and do not fall back to another channel.

import type { Logger } from '../../logger.js';
import { getOrCreateWebThread, type WebThreadQueryable } from '../http/web-thread.js';
import { classifyPushStatus, pushPreview, pushRetryDelayMs } from './push-preview.js';

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

export interface PushSendError extends Error {
  statusCode?: number;
}

export interface PushSender {
  send(sub: PushSubscriptionRow, body: string): Promise<void>;
}

export type WebDelivery =
  | { outcome: 'delivered' | 'visible' }
  | { outcome: 'fallback'; detail: string }
  | { outcome: 'unavailable'; detail: string }
  | { outcome: 'unconfigured'; detail: string };

export interface PushServiceDeps {
  pool: WebThreadQueryable;
  sender: PushSender;
  logger: Logger;
  /** True when VAPID is loaded and APP_ORIGIN is https. */
  configured: boolean;
  publicKey?: string | null;
  isWatching?: (conversationId: string) => boolean;
  anyoneWatching?: () => boolean;
  broadcast?: (conversationId: string, payload: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** First try, then retries at 1s, 2s, and 4s. A busy push service does not fall back. */
const MAX_ATTEMPTS = 4;

export class WebPushService {
  readonly publicKey: string | null;
  private isWatching: (conversationId: string) => boolean;
  private anyoneWatching: () => boolean;
  private broadcast: (conversationId: string, payload: Record<string, unknown>) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private liveSubscription = false;

  constructor(private readonly deps: PushServiceDeps) {
    this.publicKey = deps.publicKey ?? null;
    this.isWatching = deps.isWatching ?? (() => false);
    this.anyoneWatching = deps.anyoneWatching ?? (() => false);
    this.broadcast = deps.broadcast ?? (() => undefined);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  setWatch(isWatching: (conversationId: string) => boolean, anyoneWatching?: () => boolean): void {
    this.isWatching = isWatching;
    if (anyoneWatching) this.anyoneWatching = anyoneWatching;
  }

  /** A subscribed phone, or a browser with the chat open. Used by approval delivery. */
  reachableNow(): boolean {
    return this.deps.configured && (this.liveSubscription || this.anyoneWatching());
  }

  noteSubscribed(live: boolean): void {
    this.liveSubscription = live;
  }

  setBroadcast(broadcast: (conversationId: string, payload: Record<string, unknown>) => void): void {
    this.broadcast = broadcast;
  }

  /** A chat reply that is already in the thread. Push only; no second copy, no fallback. */
  async notifyReply(content: string, conversationId: string): Promise<void> {
    if (!this.deps.configured) return;
    if (this.isWatching(conversationId)) return;
    // A reply already lives on the thread. No subscription is not a failure to announce.
    await this.pushText(content, { noticeOnEmpty: false });
  }

  /**
   * Proactive delivery used by web-send. The thread gains the message either
   * way, so a later reply on the phone has the context.
   */
  async deliver(message: string): Promise<WebDelivery> {
    if (!this.deps.configured) {
      return {
        outcome: 'unconfigured',
        detail: 'The phone app needs HTTPS before it can send notifications.',
      };
    }
    let conversationId: string;
    try {
      conversationId = await getOrCreateWebThread(this.deps.pool);
      await this.deps.pool.query(
        `INSERT INTO working_memory (conversation_id, agent_id, role, content, channel_id, expires_at)
         VALUES ($1, 'coordinator', 'assistant', $2, 'web', NOW() + interval '90 days')`,
        [conversationId, message],
      );
    } catch (err) {
      this.deps.logger.error({ err }, 'web push: failed to record the message on the shared thread');
      return { outcome: 'unavailable', detail: 'The message could not be saved on the shared thread.' };
    }
    try {
      this.broadcast(conversationId, { type: 'message', content: message, conversationId });
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'web push: live broadcast failed');
    }
    if (this.isWatching(conversationId)) return { outcome: 'visible' };
    return this.pushText(message, { noticeOnEmpty: true });
  }

  private async pushText(message: string, opts: { noticeOnEmpty: boolean }): Promise<WebDelivery> {
    const hide = await this.hidePreviews();
    const body = JSON.stringify({
      title: 'Curia',
      body: pushPreview(message, hide),
      url: '/chat',
    });
    const subs = await this.listSubscriptions();
    if (subs.length === 0) {
      this.liveSubscription = false;
      const detail = 'No phone is subscribed to notifications.';
      if (opts.noticeOnEmpty) await this.recordNotice('dead', detail);
      return { outcome: 'fallback', detail };
    }
    this.liveSubscription = true;

    const gone: string[] = [];
    let delivered = 0;
    let setupDetail: string | null = null;
    let retrying = false;

    for (const sub of subs) {
      const result = await this.sendWithRetry(sub, body);
      if (result === 'ok') {
        delivered += 1;
        continue;
      }
      if (result === 'gone') {
        gone.push(sub.id);
        continue;
      }
      if (typeof result !== 'string') {
        setupDetail = result.detail;
        continue;
      }
      retrying = true;
    }

    if (gone.length > 0) await this.deleteSubscriptions(gone);
    const remaining = subs.length - gone.length;
    if (remaining === 0) this.liveSubscription = false;

    if (delivered > 0) return { outcome: 'delivered' };
    if (retrying) {
      return { outcome: 'unavailable', detail: 'The push service is busy. It will be retried; do not send this another way yet.' };
    }
    if (setupDetail) {
      await this.recordNotice('setup', setupDetail);
      return { outcome: 'fallback', detail: setupDetail };
    }
    if (remaining === 0) {
      const detail = 'The phone stopped receiving notifications.';
      await this.recordNotice('dead', detail);
      return { outcome: 'fallback', detail };
    }
    return { outcome: 'unavailable', detail: 'The push did not complete.' };
  }

  private async sendWithRetry(sub: PushSubscriptionRow, body: string): Promise<'ok' | 'gone' | { kind: 'setup'; detail: string } | 'retry'> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.sender.send(sub, body);
        return 'ok';
      } catch (err) {
        const status = statusOf(err);
        const klass = classifyPushStatus(status);
        if (klass === 'gone') return 'gone';
        if (klass === 'setup') {
          return { kind: 'setup', detail: setupDetail(status, err) };
        }
        if (attempt === MAX_ATTEMPTS - 1) return 'retry';
        await this.sleep(pushRetryDelayMs(attempt));
      }
    }
    return 'retry';
  }

  private async hidePreviews(): Promise<boolean> {
    const result = await this.deps.pool.query(`SELECT hide_previews FROM push_settings WHERE id = 1`);
    return result.rows[0]?.['hide_previews'] === true;
  }

  private async listSubscriptions(): Promise<PushSubscriptionRow[]> {
    const result = await this.deps.pool.query(
      `SELECT id, endpoint, p256dh, auth_secret FROM push_subscriptions`,
    );
    return result.rows.map((row) => ({
      id: String(row['id']),
      endpoint: String(row['endpoint']),
      p256dh: String(row['p256dh']),
      authSecret: String(row['auth_secret']),
    }));
  }

  private async deleteSubscriptions(ids: string[]): Promise<void> {
    await this.deps.pool.query(
      `DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  private async recordNotice(kind: 'dead' | 'setup', detail: string): Promise<void> {
    const trimmed = detail.slice(0, 300);
    try {
      const existing = await this.deps.pool.query(
        `SELECT id FROM push_notices WHERE kind = $1 AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [kind],
      );
      const id = existing.rows[0]?.['id'];
      if (typeof id === 'string') {
        await this.deps.pool.query(
          `UPDATE push_notices SET detail = $2, created_at = NOW() WHERE id = $1`,
          [id, trimmed],
        );
        return;
      }
      await this.deps.pool.query(
        `INSERT INTO push_notices (kind, detail) VALUES ($1, $2)`,
        [kind, trimmed],
      );
    } catch (err) {
      this.deps.logger.error({ err, kind }, 'web push: failed to record a console notice');
    }
  }
}

function statusOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function setupDetail(status: number, err: unknown): string {
  const message = err instanceof Error ? err.message : 'push rejected';
  const clean = message.replace(/\s+/g, ' ').slice(0, 180);
  return `Push setup was rejected (${status}): ${clean}`;
}

/** True when this origin can be a VAPID subject Apple will accept. */
export function vapidSubject(appOrigin: string | undefined): string | null {
  if (!appOrigin || !appOrigin.startsWith('https://')) return null;
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
