// Unit tests for the adaptive settle (#2244). A scripted fake page plays a redirect
// timeline against a fake clock, so a 28-second sign-in chain runs in milliseconds.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { Page } from 'playwright';
import {
  DEFAULT_SETTLE_TIMING,
  PageActivity,
  actionStartedNavigation,
  isHandoffUrl,
  reportableChain,
  settlePage,
  type SettleClock,
} from './settle.js';
import type { FrameProbe } from './settle-probe.js';

const log = pino({ level: 'silent' });

const BLANK: FrameProbe = { textChars: 0, labelledControls: 0, credentialFields: 0 };
const CONTENT: FrameProbe = { textChars: 2_000, labelledControls: 40, credentialFields: 0 };
const LOGIN_FORM: FrameProbe = { textChars: 300, labelledControls: 4, credentialFields: 2 };

/** One state of the page from time `at` (ms) on. `probe: null` = the main frame can't be read. */
interface Stage { at: number; url: string; probe: FrameProbe | null }

function fakeClock(): SettleClock & { sleeps: number[]; t: number } {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => { clock.sleeps.push(ms); clock.t += ms; },
  };
  return clock;
}

/** A page that follows `stages` by the fake clock. Emits framenavigated on URL change when evented. */
function timelinePage(stages: Stage[], clock: SettleClock, evented = false) {
  const emitter = new EventEmitter();
  const current = (): Stage => [...stages].reverse().find((s) => clock.now() >= s.at) ?? stages[0]!;
  let lastUrl = current().url;
  const mainFrame = {
    url: () => current().url,
    evaluate: vi.fn(async () => {
      const probe = current().probe;
      if (probe === null) throw new Error('Execution context was destroyed, most likely because of a navigation');
      return probe;
    }),
  };
  const page = {
    url: () => {
      const url = current().url;
      if (evented && url !== lastUrl) {
        lastUrl = url;
        emitter.emit('framenavigated', mainFrame);
      }
      return url;
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    ...(evented ? { on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) } : {}),
  };
  return { page: page as unknown as Page, emitter, mainFrame };
}

async function settle(stages: Stage[], opts: { chainFromStart?: boolean; capMs?: number; navigated?: boolean } = {}) {
  const clock = fakeClock();
  const { page } = timelinePage(stages, clock);
  const activity = new PageActivity(page, clock);
  // A navigate's goto commits the first page: that counts as the page moving.
  if (opts.navigated ?? true) activity.recordUrl(page.url(), true);
  // The handler takes chainStart before the action; a navigate leaves out the page it left.
  const chainStart = activity.chainStart(opts.chainFromStart ?? true);
  const result = await settlePage(page, activity, {
    timing: { ...DEFAULT_SETTLE_TIMING, ...(opts.capMs ? { capMs: opts.capMs } : {}) },
    chainStart,
    log,
    sessionId: 's',
    clock,
  });
  return { result, clock };
}

describe('isHandoffUrl', () => {
  it.each([
    'https://www.aircanada.com/ca/en/aco/home.html?isAuth=true',
    'https://www.aircanada.com/clogin/pages/proxy?context=R123&client_id=x',
    'https://www.aircanada.com/clogin/pages/proxy?mode=afterConsent&consent=abc',
    'https://www.aircanada.com/clogin/pages/consent?x=1',
    'https://login.example.com/authorize?response_type=code&client_id=a&redirect_uri=b',
    'https://app.example.com/oauth2/idpresponse?code=abc&state=xyz',
    'https://app.example.com/auth/callback?code=abc&state=xyz',
    'https://app.example.com/landing#id_token=eyJ&state=1',
    'https://idp.example.com/authorize-proxy',
  ])('flags %s', (url) => {
    expect(isHandoffUrl(url)).toBe(true);
  });

  it.each([
    // The real Air Canada login form: gig_client_id is not an OAuth client_id parameter.
    'https://www.aircanada.com/clogin/pages/login?gig_client_id=abc&lang=en',
    'https://www.example.com/stores?state=CA',
    'https://shop.example.com/cart?code=SPRING10',
    'https://news.example.com/2026/10/22/story',
  ])('does not flag %s', (url) => {
    expect(isHandoffUrl(url)).toBe(false);
  });
});

describe('settlePage', () => {
  it('returns at once, without waiting, for a page with a stable URL and real content', async () => {
    const { result, clock } = await settle([{ at: 0, url: 'https://news.example.com/', probe: CONTENT }], { navigated: false });
    expect(result).toMatchObject({ settled: true, reasons: [], blank: false, handoff: false });
    expect(result.redirectChain).toEqual(['https://news.example.com/']);
    expect(clock.sleeps).toEqual([]);
  });

  // The fixture from the acceptance criteria: two blank hops with a gap of more than 5s
  // before the form renders.
  it('waits through two blank JS-redirect hops and a 6s gap, returning the form settled', async () => {
    const { result, clock } = await settle([
      { at: 0, url: 'https://sso.example.com/start', probe: BLANK },
      { at: 1_000, url: 'https://sso.example.com/hop', probe: BLANK },
      { at: 7_000, url: 'https://sso.example.com/login', probe: BLANK },
      { at: 7_800, url: 'https://sso.example.com/login', probe: LOGIN_FORM },
    ]);
    expect(result.settled).toBe(true);
    expect(result.redirectChain).toEqual([
      'https://sso.example.com/start',
      'https://sso.example.com/hop',
      'https://sso.example.com/login',
    ]);
    // Returns once the URL has been quiet for quietMs with the form showing, not at the cap.
    expect(clock.t).toBeGreaterThanOrEqual(7_000 + DEFAULT_SETTLE_TIMING.quietMs);
    expect(clock.t).toBeLessThan(10_000);
  });

  // The 2026-10-22 trace: content-bearing handoff pages, then two blank proxy pages, then
  // the login form at ~28s. The settle returns with the form, not after the 35s cap.
  it('follows the Air Canada sign-in chain to the login form at ~28s', async () => {
    const { result, clock } = await settle([
      { at: 0, url: 'https://www.aircanada.com/signin', probe: BLANK },
      { at: 3_100, url: 'https://www.aircanada.com/ca/en/aco/home.html?isAuth=true', probe: CONTENT },
      { at: 10_300, url: 'https://www.aircanada.com/home/ca/en/aco/flights?isAuth=true', probe: CONTENT },
      { at: 12_700, url: 'https://www.aircanada.com/clogin/pages/proxy?context=R1', probe: BLANK },
      { at: 23_000, url: 'https://www.aircanada.com/clogin/pages/login?gig_client_id=g1', probe: BLANK },
      { at: 28_000, url: 'https://www.aircanada.com/clogin/pages/login?gig_client_id=g1', probe: LOGIN_FORM },
    ]);
    expect(result.settled).toBe(true);
    expect(clock.t).toBeGreaterThanOrEqual(28_000);
    expect(clock.t).toBeLessThan(DEFAULT_SETTLE_TIMING.capMs);
    expect(result.redirectChain.at(-1)).toBe('https://www.aircanada.com/clogin/pages/login?gig_client_id=g1');
    expect(result.redirectChain).toHaveLength(5);
  });

  it('keeps waiting while the main frame is unreadable mid-navigation', async () => {
    const { result, clock } = await settle([
      { at: 0, url: 'https://a.example.com/', probe: null },
      { at: 4_000, url: 'https://a.example.com/', probe: CONTENT },
    ]);
    expect(result.settled).toBe(true);
    expect(clock.t).toBeGreaterThanOrEqual(4_000);
  });

  it('stops at the cap on a page that stays blank, reporting why', async () => {
    const { result, clock } = await settle([{ at: 0, url: 'https://a.example.com/redirecting', probe: BLANK }], { capMs: 10_000 });
    expect(result).toMatchObject({ settled: false, reasons: ['blank'], blank: true, handoff: false });
    expect(clock.t).toBe(10_000);
  });

  it('flags a handoff page that never renders, like the stuck consent page', async () => {
    const { result } = await settle([{ at: 0, url: 'https://www.aircanada.com/clogin/pages/consent', probe: BLANK }]);
    expect(result.settled).toBe(false);
    // handoff drives the cap note. As a wait reason it has lapsed (no URL change for
    // handoffStableMs); the blank page is what holds it to the cap.
    expect(result.handoff).toBe(true);
    expect(result.reasons).toEqual(['blank']);
  });

  it('settles a content-bearing handoff URL that stops moving after handoffStableMs', async () => {
    // e.g. a signed-in home page that keeps ?isAuth=true in its URL.
    const { result, clock } = await settle([{ at: 0, url: 'https://www.aircanada.com/ca/en/aco/home.html?isAuth=true', probe: CONTENT }], { navigated: false });
    expect(result.settled).toBe(true);
    // No navigation was seen in this call, so nothing holds it.
    expect(clock.t).toBe(0);
  });

  it('settles a handoff URL as soon as it shows a sign-in form', async () => {
    const { result, clock } = await settle([
      { at: 0, url: 'https://x.example.com/', probe: CONTENT },
      { at: 100, url: 'https://login.example.com/authorize?client_id=a&redirect_uri=b', probe: LOGIN_FORM },
    ]);
    expect(result.settled).toBe(true);
    // Only the quiet window after the URL change, not handoffStableMs.
    expect(clock.t).toBeLessThan(100 + DEFAULT_SETTLE_TIMING.quietMs + DEFAULT_SETTLE_TIMING.pollMs + 1);
  });

  // Review fixes: a static blank page (an image, an expired session's about:blank) must not
  // cost the cap on every call, and a closed page must not be polled.
  it('does not hold a blank page that nothing is moving', async () => {
    const { result, clock } = await settle([{ at: 0, url: 'https://cdn.example.com/photo.jpg', probe: BLANK }], { navigated: false });
    expect(result.settled).toBe(true);
    expect(result.blank).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  it('returns at once on about:blank', async () => {
    const { result, clock } = await settle([{ at: 0, url: 'about:blank', probe: null }]);
    expect(result.settled).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  it('returns at once when the page has crashed or closed', async () => {
    const clock = fakeClock();
    const { page, mainFrame } = timelinePage([{ at: 0, url: 'https://a.example.com/', probe: CONTENT }], clock);
    mainFrame.evaluate.mockRejectedValue(new Error('Target crashed'));
    const activity = new PageActivity(page, clock);
    activity.recordUrl(page.url(), true);
    const result = await settlePage(page, activity, { timing: DEFAULT_SETTLE_TIMING, chainStart: 0, log, sessionId: 's', clock });
    expect(result.settled).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  it('never waits past the deadline', async () => {
    const clock = fakeClock();
    const { page } = timelinePage([{ at: 0, url: 'https://a.example.com/', probe: BLANK }], clock);
    const activity = new PageActivity(page, clock);
    activity.recordUrl(page.url(), true);
    const result = await settlePage(page, activity, {
      timing: DEFAULT_SETTLE_TIMING, chainStart: activity.chainStart(true), deadline: 3_000, log, sessionId: 's', clock,
    });
    expect(result.settled).toBe(false);
    expect(clock.t).toBe(3_000);
  });
});

describe('actionStartedNavigation', () => {
  const timing = { ...DEFAULT_SETTLE_TIMING, navGraceMs: 250, actionNetworkMs: 5_000 };

  function eventedPage(clock: SettleClock) {
    return timelinePage([{ at: 0, url: 'https://a.example.com/form', probe: CONTENT }], clock, true);
  }

  function request(opts: { navigation: boolean; frame: unknown; type?: string }) {
    return {
      isNavigationRequest: () => opts.navigation,
      frame: () => opts.frame,
      resourceType: () => opts.type ?? (opts.navigation ? 'document' : 'fetch'),
    };
  }

  it('is false after the grace window when nothing starts', async () => {
    const clock = fakeClock();
    const { page } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    expect(await actionStartedNavigation(activity, activity.mark(), timing, undefined, clock)).toBe(false);
    expect(clock.t).toBeGreaterThanOrEqual(250);
    expect(clock.t).toBeLessThan(400);
  });

  it('is true when a main-frame navigation request starts', async () => {
    const clock = fakeClock();
    const { page, emitter, mainFrame } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    const mark = activity.mark();
    emitter.emit('request', request({ navigation: true, frame: mainFrame }));
    expect(await actionStartedNavigation(activity, mark, timing, undefined, clock)).toBe(true);
    expect(clock.t).toBe(0);
  });

  it('ignores a child frame navigating', async () => {
    const clock = fakeClock();
    const { page, emitter } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    const mark = activity.mark();
    emitter.emit('request', request({ navigation: true, frame: { other: true } }));
    emitter.emit('requestfinished', request({ navigation: true, frame: { other: true } }));
    expect(await actionStartedNavigation(activity, mark, timing, undefined, clock)).toBe(false);
  });

  // A sign-in code submit: the click posts an XHR, and the page navigates when it returns.
  it('waits for a request the action started, then sees the navigation that follows it', async () => {
    const clock = fakeClock();
    const { page, emitter, mainFrame } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    const mark = activity.mark();
    const xhr = request({ navigation: false, frame: mainFrame });
    emitter.emit('request', xhr);
    const sleep = clock.sleep;
    clock.sleep = async (ms) => {
      await sleep(ms);
      if (clock.t >= 1_200 && clock.t - ms < 1_200) {
        emitter.emit('requestfinished', xhr);
        emitter.emit('request', request({ navigation: true, frame: mainFrame }));
      }
    };
    expect(await actionStartedNavigation(activity, mark, timing, undefined, clock)).toBe(true);
    expect(clock.t).toBeGreaterThanOrEqual(1_200);
  });

  it('ignores requests that are not fetch or XHR (media, event streams)', async () => {
    const clock = fakeClock();
    const { page, emitter, mainFrame } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    const mark = activity.mark();
    emitter.emit('request', request({ navigation: false, frame: mainFrame, type: 'eventsource' }));
    emitter.emit('request', request({ navigation: false, frame: mainFrame, type: 'media' }));
    expect(await actionStartedNavigation(activity, mark, timing, undefined, clock)).toBe(false);
    expect(clock.t).toBeLessThan(400);
  });

  it('stops waiting on requests at the deadline', async () => {
    const clock = fakeClock();
    const { page, emitter, mainFrame } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    const mark = activity.mark();
    emitter.emit('request', request({ navigation: false, frame: mainFrame }));
    expect(await actionStartedNavigation(activity, mark, timing, 1_000, clock)).toBe(false);
    expect(clock.t).toBeLessThanOrEqual(1_050);
  });

  it('detaches its listeners', () => {
    const clock = fakeClock();
    const { page, emitter } = eventedPage(clock);
    const activity = new PageActivity(page, clock);
    expect(emitter.listenerCount('request')).toBe(1);
    activity.detach();
    activity.detach();
    expect(emitter.listenerCount('request')).toBe(0);
    expect(emitter.listenerCount('framenavigated')).toBe(0);
  });
});

describe('reportableChain', () => {
  it('replaces OAuth grant and credential values, in the query and the fragment', () => {
    const [callback, implicit] = reportableChain([
      'https://app.example.com/callback?code=SECRET1&state=s1&lang=en',
      'https://app.example.com/landing#id_token=SECRET2&expires_in=3600',
    ]);
    expect(callback).not.toContain('SECRET1');
    expect(callback).toContain('lang=en');
    expect(implicit).not.toContain('SECRET2');
    expect(implicit).toContain('expires_in=3600');
  });

  it('redacts each raw URL before re-encoding or truncating it', () => {
    const secret = 'Hunter2!';
    const url = `https://a.example.com/cb?state=s1&echo=${secret}&pad=${'x'.repeat(400)}`;
    const [out] = reportableChain([url], (u) => u.split(secret).join('[REDACTED]'));
    expect(out).not.toContain('Hunter2');
    expect(out).toContain('REDACTED');
  });

  it('caps a long chain, keeping its start and end', () => {
    const chain = Array.from({ length: 30 }, (_, i) => `https://a.example.com/${i}`);
    const out = reportableChain(chain);
    expect(out).toHaveLength(15);
    expect(out[0]).toBe('https://a.example.com/0');
    expect(out.at(-1)).toBe('https://a.example.com/29');
  });
});
