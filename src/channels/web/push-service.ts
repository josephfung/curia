// push-service.ts — deliver a message to the phone app (#2341, ADR-055).
//
// A delivery writes the shared web thread only after the outcome is known:
// when a browser is watching, or when a push was accepted. A dead subscription
// or a setup error does not also land on the thread, because the same message
// then goes out on another channel. No subscription is a failure, not a
// fallback, and it does not record a dead-phone notice. A push the service
// does not accept is not described as waiting for a retry that never runs.

import type { Logger } from '../../logger.js';
import { markdownToHtml } from '../../format/markdown-to-html.js';
import { getOrCreateWebThread, type WebThreadQueryable } from '../http/web-thread.js';
import { classifyPushStatus, pushPreview } from './push-preview.js';

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  authSecret: string;
  deviceName: string | null;
}

export interface PushSendOptions {
  /** The most this attempt may take. The push phase shrinks it to the time it has left. */
  timeoutMs: number;
}

export interface PushSender {
  send(sub: PushSubscriptionRow, body: string, options: PushSendOptions): Promise<void>;
}

export type WebDelivery =
  | { outcome: 'delivered' | 'visible' }
  | { outcome: 'fallback'; detail: string }
  | { outcome: 'unavailable'; detail: string }
  | { outcome: 'unconfigured'; detail: string };

/** A writer for the shared thread. WorkingMemory.addTurn satisfies this. */
export interface WebThreadWriter {
  addTurn(
    conversationId: string,
    agentId: string,
    turn: { role: 'assistant'; content: string },
    meta?: { channelId?: string },
  ): Promise<void>;
}

export interface PushServiceDeps {
  pool: WebThreadQueryable;
  sender: PushSender;
  logger: Logger;
  /** True when VAPID is loaded and APP_ORIGIN is https. */
  configured: boolean;
  publicKey?: string | null;
  memory?: WebThreadWriter;
  isWatching?: (conversationId: string) => boolean;
  anyoneWatching?: () => boolean;
  broadcast?: (conversationId: string, payload: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Consecutive transport failures after which a subscription is treated as dead.
 * Setup rejections (403 and other 4xx) do not count: those are a bad
 * configuration, and deleting the row would blame a working phone.
 */
const DEAD_AFTER = 5;
/** Two retries, about 1s then 2s. */
const RETRY_BACKOFF_MS = [1_000, 2_000];
/**
 * Wall time for the whole push phase, attempts included, so web-send can still
 * fall back inside its 30s tool timeout. An attempt gets the smaller of
 * PUSH_ATTEMPT_TIMEOUT_MS and what is left; a round with less than
 * MIN_ATTEMPT_MS left is not started.
 */
const PUSH_PHASE_MS = 12_000;
const PUSH_ATTEMPT_TIMEOUT_MS = 10_000;
const MIN_ATTEMPT_MS = 1_000;
const RETRY_AFTER_CAP_MS = 5_000;

const NO_SUBSCRIPTION = 'No phone is subscribed to notifications.';
const PUSH_REJECTED = 'The push service did not accept the message.';
const PHONE_DEAD = 'The phone stopped receiving notifications. Open the Curia app on it to reconnect.';

export class WebPushService {
  readonly publicKey: string | null;
  private isWatching: (conversationId: string) => boolean;
  private anyoneWatching: () => boolean;
  private broadcast: (conversationId: string, payload: Record<string, unknown>) => void;
  private readonly sleep: (ms: number) => Promise<void>;

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

  /**
   * A subscribed phone, or a browser watching a thread. The subscription check
   * reads the table. A process-local flag goes stale when a session is revoked
   * and the row disappears with it.
   */
  async reachableNow(): Promise<boolean> {
    if (!this.deps.configured) return false;
    if (this.anyoneWatching()) return true;
    try {
      // An expired session's subscription is not a phone that can still read the
      // thread: its row lingers until the prune sweep deletes the session.
      const result = await this.deps.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM push_subscriptions ps
           JOIN sessions s ON s.id = ps.session_id
           WHERE s.expires_at > NOW()
         ) AS live`,
      );
      return result.rows[0]?.['live'] === true;
    } catch (err) {
      this.deps.logger.error({ err }, 'web push: could not read subscriptions');
      return false;
    }
  }

  setBroadcast(broadcast: (conversationId: string, payload: Record<string, unknown>) => void): void {
    this.broadcast = broadcast;
  }

  /** A chat reply that is already in the thread. Push only; no second copy, no fallback. */
  async notifyReply(content: string, conversationId: string): Promise<void> {
    if (!this.deps.configured) return;
    if (this.isWatching(conversationId)) return;
    await this.pushText(content, conversationId);
  }

  /**
   * Proactive delivery used by web-send. The thread gains the message when a
   * browser is watching or a push is accepted. A fallback does not write it.
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
    } catch (err) {
      this.deps.logger.error({ err }, 'web push: failed to resolve the shared thread');
      return { outcome: 'unavailable', detail: 'The message could not be saved on the shared thread.' };
    }
    if (this.isWatching(conversationId)) {
      const saved = await this.record(conversationId, message);
      if (!saved) return { outcome: 'unavailable', detail: 'The message could not be saved on the shared thread.' };
      this.broadcastMessage(conversationId, message);
      return { outcome: 'visible' };
    }
    const pushed = await this.pushText(message, conversationId);
    if (pushed.outcome !== 'delivered') return pushed;
    // The notification opens the shared thread, so a push without the saved
    // message is not a delivery. No fallback runs: the phone was already notified.
    if (!(await this.record(conversationId, message))) {
      return {
        outcome: 'unavailable',
        detail: 'The phone was notified, but the message could not be saved on the shared thread.',
      };
    }
    this.broadcastMessage(conversationId, message);
    return pushed;
  }

  private async pushText(message: string, conversationId: string): Promise<WebDelivery> {
    let hide: boolean;
    try {
      hide = await this.hidePreviews();
    } catch (err) {
      this.deps.logger.error({ err }, 'web push: could not read preview settings');
      return { outcome: 'unavailable', detail: 'Notifications are temporarily unavailable.' };
    }
    // Turns have no stored id, so the notification opens the thread rather than
    // a message that does not exist.
    const body = JSON.stringify({
      title: 'Curia',
      body: pushPreview(message, hide),
      url: '/chat',
      tag: `curia-${conversationId}`,
      conversationId,
    });
    let subs: PushSubscriptionRow[];
    try {
      subs = await this.listSubscriptions();
    } catch (err) {
      this.deps.logger.error({ err }, 'web push: could not list subscriptions');
      return { outcome: 'unavailable', detail: 'Notifications are temporarily unavailable.' };
    }
    if (subs.length === 0) {
      return { outcome: 'unavailable', detail: NO_SUBSCRIPTION };
    }

    const started = Date.now();
    const latest = new Map<string, Attempt>();
    let pending = subs;
    for (let round = 0; round <= RETRY_BACKOFF_MS.length; round += 1) {
      if (pending.length === 0) break;
      if (round > 0) {
        const wait = this.retryWait(pending, latest, RETRY_BACKOFF_MS[round - 1]!, started);
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      const remaining = PUSH_PHASE_MS - (Date.now() - started);
      if (remaining < MIN_ATTEMPT_MS) break;
      const timeoutMs = Math.min(PUSH_ATTEMPT_TIMEOUT_MS, remaining);
      const rows = await Promise.all(pending.map((sub) => this.attempt(sub, body, timeoutMs)));
      for (const row of rows) latest.set(row.id, row);
      pending = subs.filter((sub) => latest.get(sub.id)?.kind === 'retry');
    }

    const gone: string[] = [];
    const goneNames: Array<string | null> = [];
    let delivered = 0;
    let setupDetail: string | null = null;
    let rejected = false;

    for (const sub of subs) {
      const result = latest.get(sub.id);
      if (!result) continue;
      if (result.kind === 'ok') {
        delivered += 1;
        await this.noteSuccess(sub.id);
        continue;
      }
      if (result.kind === 'gone' || result.kind === 'dead') {
        gone.push(sub.id);
        goneNames.push(sub.deviceName);
        this.deps.logger.warn(
          { endpointHost: endpointHost(sub.endpoint), device: sub.deviceName },
          'web push: subscription is gone',
        );
        continue;
      }
      if (result.kind === 'setup') {
        setupDetail = result.detail;
        this.deps.logger.error(
          { endpointHost: endpointHost(sub.endpoint), device: sub.deviceName, detail: result.detail },
          'web push: setup rejected',
        );
        continue;
      }
      rejected = true;
      this.deps.logger.error(
        {
          endpointHost: endpointHost(sub.endpoint),
          device: sub.deviceName,
          status: result.kind === 'failed' || result.kind === 'retry' ? result.status : 0,
        },
        'web push: the push service did not accept the message',
      );
      if (await this.noteFailure(sub.id)) {
        gone.push(sub.id);
        goneNames.push(sub.deviceName);
      }
    }

    if (gone.length > 0) {
      try {
        await this.deleteSubscriptions(gone);
      } catch (err) {
        this.deps.logger.error({ err }, 'web push: failed to delete a dead subscription');
      }
      await this.recordNotice('dead', stoppedNotice(goneNames));
    }
    if (setupDetail) await this.recordNotice('setup', setupDetail);

    if (delivered > 0) return { outcome: 'delivered' };
    if (gone.length > 0 && gone.length === subs.length) {
      return { outcome: 'fallback', detail: stoppedNotice(goneNames) };
    }
    if (setupDetail) return { outcome: 'fallback', detail: setupDetail };
    if (rejected) return { outcome: 'fallback', detail: PUSH_REJECTED };
    return { outcome: 'fallback', detail: PUSH_REJECTED };
  }

  /**
   * Retry-After when the service sent one, otherwise the round's backoff. The wait
   * leaves at least MIN_ATTEMPT_MS of the phase for the attempt; 0 or less means
   * there is no time for another round.
   */
  private retryWait(
    pending: readonly PushSubscriptionRow[],
    latest: ReadonlyMap<string, Attempt>,
    backoffMs: number,
    started: number,
  ): number {
    let hinted = 0;
    for (const sub of pending) {
      const row = latest.get(sub.id);
      if (row?.kind === 'retry' && row.retryAfterMs !== undefined) hinted = Math.max(hinted, row.retryAfterMs);
    }
    const base = hinted > 0 ? Math.min(hinted, RETRY_AFTER_CAP_MS) : jitter(backoffMs);
    const remaining = PUSH_PHASE_MS - (Date.now() - started) - MIN_ATTEMPT_MS;
    return Math.min(base, remaining);
  }

  /**
   * One send, bounded here as well as by the sender: web-push's timeout is a socket
   * idle timeout, so a response that trickles in can outlast it. A send that is
   * still running at the deadline counts as a local failure and is not retried.
   */
  private async attempt(sub: PushSubscriptionRow, body: string, timeoutMs: number): Promise<Attempt> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        this.deps.sender.send(sub, body, { timeoutMs }).then(() => 'sent' as const),
        deadline,
      ]);
      if (outcome === 'timeout') {
        this.deps.logger.warn(
          { endpointHost: endpointHost(sub.endpoint), timeoutMs },
          'web push: the push service did not answer in time',
        );
        return { id: sub.id, kind: 'failed', status: 0 };
      }
      return { id: sub.id, kind: 'ok' };
    } catch (err) {
      const status = statusOf(err);
      const klass = classifyPushStatus(status);
      if (klass === 'gone') return { id: sub.id, kind: 'gone' };
      if (klass === 'setup') return { id: sub.id, kind: 'setup', detail: setupDetail(status, err) };
      if (klass === 'retry') {
        return { id: sub.id, kind: 'retry', status, retryAfterMs: retryAfterOf(err) };
      }
      return { id: sub.id, kind: 'failed', status };
    } finally {
      clearTimeout(timer);
    }
  }

  private broadcastMessage(conversationId: string, message: string): void {
    let html: string | null = null;
    try {
      html = markdownToHtml(message);
    } catch (err) {
      this.deps.logger.warn({ err, conversationId }, 'web push: markdown render failed; sending html null');
    }
    try {
      this.broadcast(conversationId, {
        type: 'message',
        conversation_id: conversationId,
        content: message,
        html,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'web push: live broadcast failed');
    }
  }

  private async record(conversationId: string, message: string): Promise<boolean> {
    if (!this.deps.memory) {
      this.deps.logger.error({ conversationId }, 'web push: no working-memory writer');
      return false;
    }
    try {
      await this.deps.memory.addTurn(
        conversationId,
        'coordinator',
        { role: 'assistant', content: message },
        { channelId: 'web' },
      );
      return true;
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'web push: failed to record the message on the shared thread');
      return false;
    }
  }

  private async hidePreviews(): Promise<boolean> {
    const result = await this.deps.pool.query(`SELECT hide_previews FROM push_settings WHERE id = 1`);
    return result.rows[0]?.['hide_previews'] === true;
  }

  private async listSubscriptions(): Promise<PushSubscriptionRow[]> {
    const result = await this.deps.pool.query(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth_secret, s.name AS device_name
       FROM push_subscriptions ps
       JOIN sessions s ON s.id = ps.session_id
       WHERE s.expires_at > NOW()`,
    );
    return result.rows.map((row) => ({
      id: String(row['id']),
      endpoint: String(row['endpoint']),
      p256dh: String(row['p256dh']),
      authSecret: String(row['auth_secret']),
      deviceName: typeof row['device_name'] === 'string' && row['device_name'].length > 0 ? row['device_name'] : null,
    }));
  }

  private async deleteSubscriptions(ids: string[]): Promise<void> {
    await this.deps.pool.query(
      `DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  private async noteSuccess(id: string): Promise<void> {
    try {
      await this.deps.pool.query(
        `UPDATE push_subscriptions SET last_success_at = NOW(), consecutive_failures = 0 WHERE id = $1`,
        [id],
      );
    } catch (err) {
      this.deps.logger.error({ err, id }, 'web push: failed to record a successful push');
    }
  }

  /** True when this failure crossed the dead threshold. */
  private async noteFailure(id: string): Promise<boolean> {
    try {
      const result = await this.deps.pool.query(
        `UPDATE push_subscriptions
         SET last_failure_at = NOW(), consecutive_failures = consecutive_failures + 1
         WHERE id = $1
         RETURNING consecutive_failures`,
        [id],
      );
      const count = result.rows[0]?.['consecutive_failures'];
      return typeof count === 'number' && count >= DEAD_AFTER;
    } catch (err) {
      this.deps.logger.error({ err, id }, 'web push: failed to record a push failure');
      return false;
    }
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

type Attempt =
  | { id: string; kind: 'ok' }
  | { id: string; kind: 'gone' | 'dead' }
  | { id: string; kind: 'setup'; detail: string }
  | { id: string; kind: 'retry'; status: number; retryAfterMs?: number }
  | { id: string; kind: 'failed'; status: number };

function statusOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function retryAfterOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'retryAfterMs' in err) {
    const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

function jitter(ms: number): number {
  const delta = Math.floor(Math.random() * 201) - 100;
  return Math.max(0, ms + delta);
}

function stoppedNotice(names: ReadonlyArray<string | null>): string {
  const labelled = names.filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (labelled.length === 0) return PHONE_DEAD;
  if (labelled.length === 1) {
    return `Your ${labelled[0]} stopped receiving notifications. Open the Curia app on it to reconnect.`;
  }
  return `Your ${labelled.join(' and ')} stopped receiving notifications. Open the Curia app on them to reconnect.`;
}

function setupDetail(status: number, err: unknown): string {
  const message = err instanceof Error ? err.message : 'push rejected';
  const body = typeof err === 'object' && err !== null && 'body' in err && typeof (err as { body?: unknown }).body === 'string'
    ? (err as { body: string }).body
    : '';
  const clean = `${message} ${body}`.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `Push setup was rejected (${status}): ${clean}`;
}

/**
 * A live session still has a push subscription. Any session kind counts: a
 * phone that signed in with the access key and then subscribed is done too.
 * The caller passes false when push itself is off, so a leftover row does
 * not mark the setup task done.
 */
export async function hasLivePushSubscription(
  pool: WebThreadQueryable,
  pushConfigured: boolean,
): Promise<boolean> {
  if (!pushConfigured) return false;
  const result = await pool.query(
    `SELECT 1
     FROM push_subscriptions
     JOIN sessions ON sessions.id = push_subscriptions.session_id
     WHERE sessions.expires_at > NOW()
     LIMIT 1`,
  );
  return result.rows.length > 0;
}

/** True when this origin can be a VAPID subject Apple will accept. */
export function vapidSubject(
  appOrigin: string | undefined,
  logger?: Pick<Logger, 'warn'>,
): string | null {
  if (!appOrigin || !appOrigin.startsWith('https://')) return null;
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch (err) {
    logger?.warn({ err }, 'web push: APP_ORIGIN is not a URL');
    return null;
  }
}
