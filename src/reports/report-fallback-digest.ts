// report-fallback-digest.ts — the weekly summary for installs with no digest (#2159).
//
// Report items (principal.report) normally reach the principal through a digest job that
// calls list-principal-reports and acknowledges what it sent. An install with no such job
// would collect them forever, so a daily system check sends a plain weekly summary itself
// once the oldest unreported item is more than maxAgeDays old.
//
// It keys on the age of the oldest unreported item, not on whether a digest job exists: a
// digest job that exists but is broken (or forgets to acknowledge) still lets items age, and
// the fallback then covers it. An install whose digest acknowledges never triggers it.
//
// The marker advances only after the send succeeds. A failed send logs at error and the next
// daily check tries again; a failed acknowledgement after a successful send logs at error,
// and the same items repeat in the next summary rather than vanish. When the content filter
// holds the summary, an item-free notice goes out instead, so one bad item cannot leave the
// principal hearing nothing.
//
// Shaped like ApprovalExpirySweep: an interval with an in-flight guard, a first check shortly
// after boot, and a tick() that tests can call directly.

import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { resolvePrincipalEmail, type PrincipalEmailRef } from '../contacts/types.js';
import type { ReportItem, ReportQueue } from './report-queue.js';
import type { SpotCheckSampler } from './spot-check-sampler.js';

export interface ReportFallbackDigestOptions {
  queue: Pick<ReportQueue, 'oldestUnreported' | 'list' | 'ack'>;
  /**
   * Absent in setup-required mode or with no outbound client: the check logs and skips.
   * The summary is sent with send(), not sendNotification(): the marker may advance only on
   * a confirmed delivery, and sendNotification() reports success once the bus publish
   * succeeds, before the email adapter has tried (or been blocked).
   */
  outboundGateway?: Pick<OutboundGateway, 'send'>;
  /** Plain string (tests) or the live ref, so a post-boot email bind takes effect (#1514). */
  ceoEmail: string | PrincipalEmailRef;
  logger: Logger;
  maxAgeDays: number;
  checkIntervalHours: number;
  /** IANA zone for the dates shown beside each item. */
  timezone?: string;
  /**
   * Draws the "Spot check" block appended to the summary. Optional: without it (or when it
   * draws nothing) the summary goes out unchanged. draw() never throws.
   */
  spotChecks?: Pick<SpotCheckSampler, 'draw'>;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface ReportFallbackDigestResult {
  sent: boolean;
  items: number;
  /** Set when the content filter held the summary: whether the item-free notice went out. */
  noticeSent?: boolean;
}

const FIRST_TICK_DELAY_MS = 60_000;
const PAGE_SIZE = 100;
// A summary past this many items is long enough; the rest go out the next day.
const MAX_PAGES = 5;

export class ReportFallbackDigest {
  private intervalHandle: NodeJS.Timeout | null = null;
  private firstTickHandle: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private readonly now: () => Date;

  constructor(private readonly opts: ReportFallbackDigestOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.intervalHandle) return;
    this.firstTickHandle = setTimeout(() => {
      this.firstTickHandle = null;
      this.runGuardedTick();
    }, FIRST_TICK_DELAY_MS);
    this.intervalHandle = setInterval(() => this.runGuardedTick(), this.opts.checkIntervalHours * 3_600_000);
    this.opts.logger.info(
      { checkIntervalHours: this.opts.checkIntervalHours, maxAgeDays: this.opts.maxAgeDays },
      'ReportFallbackDigest started',
    );
  }

  stop(): void {
    if (this.firstTickHandle) {
      clearTimeout(this.firstTickHandle);
      this.firstTickHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.opts.logger.info('ReportFallbackDigest stopped');
  }

  private runGuardedTick(): void {
    if (this.tickInFlight) {
      this.opts.logger.warn('ReportFallbackDigest: previous check still in flight — skipping');
      return;
    }
    this.tickInFlight = true;
    this.tick()
      .catch((err: unknown) => {
        this.opts.logger.error({ err }, 'ReportFallbackDigest: check failed — will retry next interval');
      })
      .finally(() => {
        this.tickInFlight = false;
      });
  }

  /** One check: send the summary if the oldest unreported item is past maxAgeDays. */
  async tick(): Promise<ReportFallbackDigestResult> {
    const { logger } = this.opts;
    const oldest = await this.opts.queue.oldestUnreported();
    if (!oldest) return { sent: false, items: 0 };

    const ageDays = (this.now().getTime() - oldest.getTime()) / 86_400_000;
    if (ageDays <= this.opts.maxAgeDays) {
      logger.debug({ ageDays }, 'ReportFallbackDigest: oldest item is recent — a digest may still report it');
      return { sent: false, items: 0 };
    }

    if (!this.opts.outboundGateway) {
      logger.warn({ ageDays }, 'ReportFallbackDigest: no outbound gateway — weekly summary not sent');
      return { sent: false, items: 0 };
    }
    // Read at tick time: the ref is refreshed in place when the principal's identities change.
    const ceoEmail = resolvePrincipalEmail(this.opts.ceoEmail);
    if (!ceoEmail) {
      logger.warn({ ageDays }, 'ReportFallbackDigest: no principal email on file — weekly summary not sent');
      return { sent: false, items: 0 };
    }

    const items: ReportItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Each page starts after the previous one; list() never moves the stored marker.
      const batch = await this.opts.queue.list({ limit: PAGE_SIZE, ...(cursor ? { after: cursor } : {}) });
      items.push(...batch.items);
      if (batch.cursor) cursor = batch.cursor;
      if (!batch.hasMore) break;
    }
    // Every row read could be malformed and skipped; there is then nothing to say, but the
    // cursor still moves past them so they don't hold the queue.
    if (items.length === 0) {
      if (cursor && !(await this.opts.queue.ack(cursor))) {
        logger.error({ cursor }, 'ReportFallbackDigest: could not move the marker past unreadable report rows');
      }
      return { sent: false, items: 0 };
    }

    // The spot-check set is stored against this id by draw(); the same id goes to the gateway
    // so the binder can match the delivered email back to the set (a reply of "2 good" then
    // resolves against this summary).
    const conversationId = `report-fallback:${this.now().toISOString()}`;
    // Anything but a drawn block (empty pool, or a draw that failed and logged why) sends the
    // summary unchanged.
    const drawn = await this.opts.spotChecks?.draw(conversationId);
    const body = drawn?.kind === 'drawn' ? `${this.renderBody(items)}\n\n${drawn.block}` : this.renderBody(items);

    // isSystemNotification: the principal must hear this even when the score is below the
    // send threshold. skipNotificationOnBlock: a blocked summary must not report itself.
    const result = await this.opts.outboundGateway.send(
      { channel: 'email', to: ceoEmail, subject: 'Curia: weekly summary', body },
      { isSystemNotification: true, skipNotificationOnBlock: true, conversationId },
    );
    if (!result.success) {
      // Not acknowledged, so the same items go out with tomorrow's check.
      logger.error(
        { items: items.length, ageDays, blockedReason: result.blockedReason, blockedRules: result.blockedRules },
        'ReportFallbackDigest: weekly summary not delivered — will retry tomorrow',
      );
      // A content-filter hold (blockedRules set) can repeat every day: one item with a
      // secret-like string, or a third-party address while the contact lookup is down,
      // holds the whole summary. Tell the principal the items exist with a notice that
      // carries no item text, so it cannot trip the same rule. The items stay queued for a
      // digest, or for the principal to ask about.
      if (result.blockedRules && result.blockedRules.length > 0) {
        return { sent: false, items: items.length, noticeSent: await this.sendHeldNotice(this.opts.outboundGateway, ceoEmail, items.length, result.blockedRules) };
      }
      return { sent: false, items: items.length };
    }

    if (cursor && !(await this.opts.queue.ack(cursor))) {
      logger.error({ items: items.length }, 'ReportFallbackDigest: summary sent but the marker did not advance — these items will repeat');
    }
    logger.info({ items: items.length, ageDays }, 'ReportFallbackDigest: weekly summary sent');
    return { sent: true, items: items.length };
  }

  /** Item-free notice for a summary the content filter held. Returns whether it was delivered. */
  private async sendHeldNotice(
    gateway: Pick<OutboundGateway, 'send'>,
    ceoEmail: string,
    count: number,
    rules: string[],
  ): Promise<boolean> {
    const body = [
      `${count} ${count === 1 ? 'item has' : 'items have'} waited more than ${this.opts.maxAgeDays} days for a digest.`,
      `Curia's content filter held the summary (${rules.join(', ')}), so this note leaves the items out.`,
      'Ask Curia to show the items waiting for your digest.',
    ].join('\n');
    const result = await gateway.send(
      { channel: 'email', to: ceoEmail, subject: 'Curia: weekly summary', body },
      { isSystemNotification: true, skipNotificationOnBlock: true },
    );
    if (!result.success) {
      this.opts.logger.error(
        { items: count, blockedReason: result.blockedReason },
        'ReportFallbackDigest: the item-free notice was not delivered either — the principal has not heard about these items',
      );
      return false;
    }
    this.opts.logger.warn({ items: count, rules }, 'ReportFallbackDigest: summary held by the content filter — item-free notice sent');
    return true;
  }

  private renderBody(items: ReportItem[]): string {
    const date = new Intl.DateTimeFormat('en-CA', {
      month: 'short',
      day: 'numeric',
      ...(this.opts.timezone ? { timeZone: this.opts.timezone } : {}),
    });
    const lines = items.map((item, i) => {
      // Numbered, never ids (mobile UX). Continuation lines stay indented under their number.
      const [first, ...rest] = item.summary.split('\n');
      return [`${i + 1}. ${first} (${date.format(item.at)})`, ...rest.map((l) => `   ${l}`)].join('\n');
    });
    return [
      'There was no digest this week, so here is what Curia did and noticed since the last summary.',
      '',
      ...lines,
    ].join('\n');
  }
}
