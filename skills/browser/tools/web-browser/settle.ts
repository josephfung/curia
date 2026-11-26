// settle.ts — wait for a page to finish redirecting before reading it (#2244).
//
// Playwright's navigation resolves at the first document. Single-sign-on flows keep going
// after that, driven by JavaScript: Air Canada's /signin passes through four URLs and two
// blank pages over ~28s before the login form renders. Returning at the first document
// showed the agent a page it couldn't use, and navigating away from it cut off the chain
// (and once left the profile half-signed-in).
//
// The rule is adaptive: an ordinary page returns as soon as it is read, and the wait only
// extends while there is a reason to, capped. See settlePage.

import type { Frame, Page, Request } from 'playwright';
import type { ToolContext } from '../../../../src/skills/types.js';
import { isBlockedFrameUrl } from './frame-url.js';
import { probeFrameContent, type FrameProbe } from './settle-probe.js';

/**
 * URLs that are sign-in handoffs: hops a single-sign-on flow passes through on its way
 * somewhere else, where leaving aborts the sign-in. Data, not logic: adding a site's
 * pattern is one line here. Matched against the full URL.
 *
 * OAuth parameters are matched as whole query parameter names (`[?&#]name=`), so
 * Air Canada's `gig_client_id` on the real login page is not a handoff. `state` and
 * `code` on their own are too common outside OAuth (a US-state filter, a promo code), so
 * they count only as the pair an authorization-code callback carries.
 */
export const HANDOFF_URL_PATTERNS: readonly RegExp[] = [
  /\/authorize(?:[/?#]|$)/i,
  /authorize-proxy/i,
  /\/proxy\?context=/i,
  /[?&#]isAuth=true/i,
  /[?&#](?:redirect_uri|client_id|response_type)=/i,
  /[?&#]code=.*[?&#]state=|[?&#]state=.*[?&#]code=/i,
  /[?&#]id_token=/i,
  /[?&#]mode=afterConsent/i,
  /\/clogin\/pages\/consent/i,
  /\/clogin\/pages\/proxy/i,
  /\/oauth2\/idpresponse/i,
  /\/callback(?:[/?#]|$)/i,
];

/** True when `url` looks like a sign-in handoff (see HANDOFF_URL_PATTERNS). */
export function isHandoffUrl(url: string): boolean {
  return HANDOFF_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/** Timings for the settle loop and post-action navigation detection. */
export interface SettleTiming {
  /** Longest a settle may wait (config `browser.settleCapMs`). */
  capMs: number;
  /** How often to re-check the page while waiting. */
  pollMs: number;
  /** A URL change this recent means the page is still redirecting. */
  quietMs: number;
  /** A handoff URL whose page has content (but no sign-in form) is waited on this long
   *  since its last URL change, then treated as settled. Air Canada's content-bearing
   *  handoff (the homepage with ?isAuth=true) moved on after ~7s. */
  handoffStableMs: number;
  /** After a click, key press or select: how long to watch for a navigation or request to start. */
  navGraceMs: number;
  /** After such an action: how long to wait for requests it started (say a code
   *  submit's XHR) to finish, to see whether they lead to a navigation. */
  actionNetworkMs: number;
}

export const DEFAULT_SETTLE_TIMING: SettleTiming = {
  capMs: 35_000,
  pollMs: 500,
  quietMs: 1_500,
  handoffStableMs: 12_000,
  navGraceMs: 250,
  actionNetworkMs: 5_000,
};

/** Request types an action's navigation can wait on (see PageActivity). */
const AWAITED_REQUEST_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch']);

/** A page that is gone: polling it only delays the error its next read returns. */
const PAGE_GONE = /target (?:page, context or browser )?(?:has been )?closed|target crashed|page crashed|browser has been closed/i;

/** Fewer visible characters than this, with no labelled control, is a blank page. */
const BLANK_TEXT_CHARS = 25;

/** Most URLs a redirect chain reports, and the longest each may be. */
const MAX_CHAIN_URLS = 15;
const MAX_CHAIN_URL_LENGTH = 300;

/**
 * Query and fragment parameters whose values are credentials or one-time grants. Their
 * values are replaced in a reported redirect chain: an OAuth `code` or `id_token` passed
 * through the chain is still live when the agent reads it.
 */
const SENSITIVE_URL_PARAMS = /^(?:code|id_token|access_token|refresh_token|token|client_secret|password|session_state|consent|context|state|SAMLResponse|SAMLRequest)$/i;

/** Why a settle is still waiting. */
export type SettleReason = 'redirecting' | 'blank' | 'handoff' | 'unreadable';

export interface SettleResult {
  settled: boolean;
  /** Main-frame URLs observed from the action's start, oldest first. Length 1 when the URL never changed. */
  redirectChain: string[];
  /** What still held when a settle hit its cap (empty when settled). */
  reasons: SettleReason[];
  /** The last probe found the page blank. */
  blank: boolean;
  /** The final URL is a sign-in handoff. */
  handoff: boolean;
  /** How long this settle waited. */
  waitedMs: number;
}

/** Wall clock and sleep, injectable so a test can run a 30-second redirect chain instantly. */
export interface SettleClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const REAL_CLOCK: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Watches one page for the duration of a call: main-frame URL commits (the redirect
 * chain), main-frame navigation requests (a navigation starting, before its URL commits),
 * and other requests in flight (a submit's XHR that may lead to a navigation).
 */
export class PageActivity {
  private readonly page: Page;
  private readonly clock: SettleClock;
  private readonly urls: string[] = [];
  /** Number of navigation signals seen so far; a mark snapshots it. */
  private navEvents = 0;
  private lastNavAt: number | null = null;
  private readonly mainNavInFlight = new Set<Request>();
  /** In-flight non-navigation requests, with the time each started. */
  private readonly inflight = new Map<Request, number>();
  private readonly detachers: Array<() => void> = [];
  /** False when the page exposes no event API, so nothing here can be observed. */
  readonly observable: boolean;
  /** Set by chainStart(false): record the next URL even if it repeats the current one. */
  private forceNextRecord = false;

  constructor(page: Page, clock: SettleClock = REAL_CLOCK) {
    this.page = page;
    this.clock = clock;
    this.urls.push(safeUrl(page));
    this.observable = typeof page.on === 'function' && typeof page.off === 'function';
    if (!this.observable) return;

    const onFrameNavigated = (frame: Frame): void => {
      if (frame !== page.mainFrame()) return;
      // The navigation committed, so its request has its response: don't let one that
      // never reports finishing hold a settle to the cap.
      this.mainNavInFlight.clear();
      this.recordUrl(frame.url(), true);
    };
    const onRequest = (request: Request): void => {
      // A service-worker request has no frame and frame() throws; it isn't the page navigating.
      let frame: Frame | null = null;
      try {
        frame = request.frame();
      } catch {
        // Expected for worker requests, not an error worth logging per request.
        frame = null;
      }
      if (request.isNavigationRequest() && frame === page.mainFrame()) {
        this.mainNavInFlight.add(request);
        this.noteNavigation();
      } else if (AWAITED_REQUEST_TYPES.has(request.resourceType())) {
        // Only fetch/XHR: a submit's request. Media, event streams and beacons can stay
        // open or don't lead anywhere, and would hold every click for actionNetworkMs.
        this.inflight.set(request, this.clock.now());
      }
    };
    const onRequestDone = (request: Request): void => {
      this.mainNavInFlight.delete(request);
      this.inflight.delete(request);
    };
    page.on('framenavigated', onFrameNavigated);
    page.on('request', onRequest);
    page.on('requestfinished', onRequestDone);
    page.on('requestfailed', onRequestDone);
    this.detachers.push(
      () => page.off('framenavigated', onFrameNavigated),
      () => page.off('request', onRequest),
      () => page.off('requestfinished', onRequestDone),
      () => page.off('requestfailed', onRequestDone),
    );
  }

  /** Stop listening. Safe to call more than once. */
  detach(): void {
    for (const detach of this.detachers.splice(0)) detach();
  }

  /** Snapshot for navigatedSince / requestsInFlightSince, taken just before an action. */
  mark(): { navEvents: number; at: number; url: string } {
    // Fold in a URL change the events missed (or that happened with no event source).
    this.recordUrl(safeUrl(this.page));
    return { navEvents: this.navEvents, at: this.clock.now(), url: safeUrl(this.page) };
  }

  /** True when the main frame navigated, or started to, since `mark`. */
  navigatedSince(mark: { navEvents: number; url: string }): boolean {
    this.recordUrl(safeUrl(this.page));
    return this.navEvents > mark.navEvents;
  }

  /** Non-navigation requests started since `mark` that are still in flight. */
  requestsInFlightSince(mark: { at: number }): number {
    let count = 0;
    for (const startedAt of this.inflight.values()) if (startedAt >= mark.at) count++;
    return count;
  }

  /** True once any navigation was seen during this call. */
  hasNavigated(): boolean {
    return this.lastNavAt !== null;
  }

  /** Time of the most recent navigation signal, or null if none. */
  lastNavigationAt(): number | null {
    return this.lastNavAt;
  }

  /** A main-frame navigation request is still in flight. */
  navigationInFlight(): boolean {
    return this.mainNavInFlight.size > 0;
  }

  /**
   * Main-frame URLs seen from history index `fromIndex` on (see chainStart), oldest first.
   * Never empty: when nothing was recorded from there, it is just the current URL.
   */
  chainFrom(fromIndex: number): string[] {
    const chain = this.urls.slice(Math.max(0, fromIndex));
    return chain.length > 0 ? chain : [this.urls[this.urls.length - 1] ?? ''];
  }

  /**
   * History index for chainFrom. Before a click or key press, `includeCurrent` keeps the
   * page the action started on as the chain's first URL. Before a navigate it is left
   * out: the chain starts at the URL navigated to.
   */
  chainStart(includeCurrent: boolean): number {
    this.recordUrl(safeUrl(this.page));
    // A navigate to the URL the page is already on must still start its chain there.
    if (!includeCurrent) this.forceNextRecord = true;
    return includeCurrent ? this.urls.length - 1 : this.urls.length;
  }

  /**
   * Record `url` as the main frame's current URL. Polled as well as evented: a poll counts
   * as a navigation only when the URL changed, a `committed` main-frame navigation event
   * always does (a reload commits the same URL). A repeated URL joins the chain only as
   * the first URL after a navigate began (see chainStart).
   */
  recordUrl(url: string, committed = false): void {
    if (!url) return;
    const changed = this.urls[this.urls.length - 1] !== url;
    if (changed || this.forceNextRecord) {
      this.urls.push(url);
      this.forceNextRecord = false;
    }
    if (changed || committed) this.noteNavigation();
  }

  private noteNavigation(): void {
    this.navEvents++;
    this.lastNavAt = this.clock.now();
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    // A closed page has no URL; the caller's next page call surfaces that properly.
    return '';
  }
}

/** Result of probing every readable frame. */
interface PageProbe {
  blank: boolean;
  credentialFields: number;
}

/** null: the main frame couldn't be read (mid-navigation). 'gone': the page closed or crashed. */
type ProbeOutcome = PageProbe | null | 'gone';

/**
 * Probe the main frame and readable child frames. A main frame that can't be evaluated
 * (mid-navigation: "Execution context was destroyed") makes the page unreadable, which
 * keeps a settle waiting (#2244 point 5). A child frame that fails is skipped.
 */
async function probePage(page: Page, log: ToolContext['log']): Promise<ProbeOutcome> {
  if (typeof page.isClosed === 'function' && page.isClosed()) return 'gone';
  const mainFrame = page.mainFrame();
  let textChars = 0;
  let labelledControls = 0;
  let credentialFields = 0;
  for (const frame of page.frames()) {
    if (frame !== mainFrame && isBlockedFrameUrl(frame.url())) continue;
    let probe: unknown;
    try {
      probe = await frame.evaluate(probeFrameContent);
    } catch (err) {
      if (frame === mainFrame) {
        if (PAGE_GONE.test(err instanceof Error ? err.message : String(err))) return 'gone';
        log.debug({ err }, 'Settle probe: main frame unreadable (likely mid-navigation)');
        return null;
      }
      log.debug({ err, frameUrl: frame.url() }, 'Settle probe: skipping unreadable child frame');
      continue;
    }
    if (!isFrameProbe(probe)) {
      // Our own function returned something else. Nothing to judge by, so don't hold the
      // page on it: an ordinary read follows, exactly as before this check existed.
      log.debug({ frameUrl: frame.url() }, 'Settle probe returned an unexpected shape — treating frame as having content');
      return { blank: false, credentialFields };
    }
    textChars += probe.textChars;
    labelledControls += probe.labelledControls;
    credentialFields += probe.credentialFields;
  }
  return { blank: textChars < BLANK_TEXT_CHARS && labelledControls === 0, credentialFields };
}

function isFrameProbe(value: unknown): value is FrameProbe {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.textChars === 'number' && typeof v.labelledControls === 'number' && typeof v.credentialFields === 'number';
}

/**
 * Wait until the page has settled, or the cap (or `deadline`) is reached.
 *
 * Checks immediately, so a page with a stable URL and real content returns with no added
 * latency. Otherwise polls while any of these holds:
 *   - redirecting: the main-frame URL changed within quietMs, or a navigation is in flight;
 *   - unreadable: the main frame can't be read (it is mid-navigation);
 *   - blank: almost no visible text and no labelled control;
 *   - handoff: the URL is a sign-in handoff, the page shows no sign-in field, and the URL
 *     changed within handoffStableMs.
 * Returns as soon as none holds. `chainStart` is from activity.chainStart() taken before
 * the action, so the reported chain covers that action's redirects.
 */
export async function settlePage(
  page: Page,
  activity: PageActivity,
  opts: { timing: SettleTiming; chainStart: number; deadline?: number; log: ToolContext['log']; sessionId: string; clock?: SettleClock },
): Promise<SettleResult> {
  const clock = opts.clock ?? REAL_CLOCK;
  const { timing } = opts;
  const startedAt = clock.now();
  const stopAt = Math.min(startedAt + timing.capMs, opts.deadline ?? Number.POSITIVE_INFINITY);
  let reasons: SettleReason[] = [];
  let probe: PageProbe | null = null;
  let polls = 0;

  for (;;) {
    const url = safeUrl(page);
    activity.recordUrl(url);
    // about:blank and friends never redirect on their own (an expired session's fresh tab).
    if (/^(?:about|data|blob|chrome-error):/i.test(url)) {
      reasons = [];
      probe = null;
      break;
    }
    const outcome = await probePage(page, opts.log);
    if (outcome === 'gone') {
      // Closed or crashed: return now so the read surfaces the real error.
      reasons = [];
      probe = null;
      break;
    }
    probe = outcome;
    const now = clock.now();
    const lastNav = activity.lastNavigationAt();
    const sinceNav = lastNav === null ? Number.POSITIVE_INFINITY : now - lastNav;

    reasons = [];
    if (sinceNav < timing.quietMs || activity.navigationInFlight()) reasons.push('redirecting');
    // A blank page holds the settle only while something is moving: a navigation during
    // this call, or a sign-in handoff URL. A static blank page (an image, an empty
    // document) would otherwise cost the full cap on every call.
    const moving = activity.hasNavigated() || isHandoffUrl(url);
    if (probe === null) reasons.push('unreadable');
    else if (probe.blank && moving) reasons.push('blank');
    if (isHandoffUrl(url) && !(probe && probe.credentialFields > 0) && sinceNav < timing.handoffStableMs) {
      reasons.push('handoff');
    }

    if (reasons.length === 0) break;
    if (now >= stopAt) {
      opts.log.info(
        { sessionId: opts.sessionId, reasons, waitedMs: now - startedAt },
        'Page still settling at the cap — returning it as it stands',
      );
      break;
    }
    polls++;
    await clock.sleep(Math.max(0, Math.min(timing.pollMs, stopAt - now)));
  }

  const finalUrl = safeUrl(page);
  if (reasons.length === 0 && polls > 0) {
    opts.log.debug({ sessionId: opts.sessionId, waitedMs: clock.now() - startedAt }, 'Page settled after waiting');
  }
  return {
    settled: reasons.length === 0,
    redirectChain: activity.chainFrom(opts.chainStart),
    reasons,
    blank: probe?.blank === true,
    handoff: isHandoffUrl(finalUrl),
    waitedMs: clock.now() - startedAt,
  };
}

/**
 * After a click, key press or select: did it start a main-frame navigation? Watches for
 * navGraceMs; if the action started requests (a sign-in code submit's XHR), waits up to
 * actionNetworkMs for them to finish, then watches navGraceMs again, since the navigation
 * often follows the response. Returns early the moment a navigation is seen. A page with
 * no event API can't be watched, so this returns at once on whatever the URL shows.
 */
export async function actionStartedNavigation(
  activity: PageActivity,
  mark: { navEvents: number; at: number; url: string },
  timing: SettleTiming,
  deadline?: number,
  clock: SettleClock = REAL_CLOCK,
): Promise<boolean> {
  if (activity.navigatedSince(mark)) return true;
  if (!activity.observable) return false;
  const stopAt = deadline ?? Number.POSITIVE_INFINITY;

  const step = Math.max(1, Math.min(50, timing.navGraceMs));
  const watch = async (ms: number): Promise<boolean> => {
    const until = Math.min(clock.now() + ms, stopAt);
    while (clock.now() < until) {
      if (activity.navigatedSince(mark)) return true;
      await clock.sleep(step);
    }
    return activity.navigatedSince(mark);
  };

  if (await watch(timing.navGraceMs)) return true;
  if (activity.requestsInFlightSince(mark) === 0) return false;

  const networkUntil = Math.min(clock.now() + timing.actionNetworkMs, stopAt);
  while (activity.requestsInFlightSince(mark) > 0 && clock.now() < networkUntil) {
    if (activity.navigatedSince(mark)) return true;
    await clock.sleep(step);
  }
  return watch(timing.navGraceMs);
}

/**
 * A redirect chain fit to return to the agent: `redact` applied to each raw URL (injected
 * secrets, tracked codes), credential and one-time-grant parameter values replaced (see
 * SENSITIVE_URL_PARAMS), each URL length-capped, and the chain capped to its first and
 * last URLs when long.
 */
export function reportableChain(chain: string[], redact: (url: string) => string = (u) => u): string[] {
  const cleaned = chain.map((url) => {
    // Redact the raw URL first: truncation or re-encoding could split a secret so the
    // exact-value redaction no longer matches it.
    const scrubbed = scrubUrlParams(redact(url));
    return scrubbed.length > MAX_CHAIN_URL_LENGTH ? `${scrubbed.slice(0, MAX_CHAIN_URL_LENGTH)}…` : scrubbed;
  });
  if (cleaned.length <= MAX_CHAIN_URLS) return cleaned;
  const head = cleaned.slice(0, 2);
  const tail = cleaned.slice(cleaned.length - (MAX_CHAIN_URLS - 3));
  return [...head, `… ${cleaned.length - head.length - tail.length} more …`, ...tail];
}

function scrubUrlParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const scrubParams = (params: URLSearchParams): boolean => {
    let changed = false;
    for (const key of [...params.keys()]) {
      if (SENSITIVE_URL_PARAMS.test(key)) {
        params.set(key, 'redacted');
        changed = true;
      }
    }
    return changed;
  };
  scrubParams(parsed.searchParams);
  // OAuth implicit and hybrid flows put tokens in the fragment as a query string.
  if (parsed.hash.includes('=')) {
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    if (scrubParams(fragment)) parsed.hash = fragment.toString();
  }
  return parsed.toString();
}
