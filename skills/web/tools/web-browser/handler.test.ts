// skills/web-browser/handler.test.ts — tests for the web-browser skill's
// secret-by-reference fill path (#973).
//
// Focus: the `type` action's `secret_ref` input dereferences a user.* secret via
// ctx.resolveSecretRef and fills the resolved value WITHOUT the value ever entering
// the skill's return data, and any page content read back is scrubbed of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the human-behavior module so dwell/presence/click/type are observable spies with no
// real delays. Hoisted by vitest; the handler imports these and gets the spies. (#1053)
vi.mock('../../../../src/browser/human-behavior.js', () => ({
  jitteredDelay: vi.fn().mockResolvedValue(undefined),
  simulateHumanPresence: vi.fn().mockResolvedValue(undefined),
  humanClick: vi.fn().mockResolvedValue(undefined),
  humanType: vi.fn().mockResolvedValue(undefined),
}));

import {
  jitteredDelay,
  simulateHumanPresence,
  humanClick,
  humanType,
} from '../../../../src/browser/human-behavior.js';

import pino from 'pino';
import { WebBrowserHandler } from './handler.js';
import { BrowserSession } from '../../../../src/browser/browser-session.js';
import type { BrowserService } from '../../../../src/browser/browser-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { BrowserContext, Page } from 'playwright';

const logger = pino({ level: 'silent' });

// Reset human-behavior spies between tests so call counts don't bleed across cases.
beforeEach(() => {
  vi.mocked(jitteredDelay).mockClear();
  vi.mocked(simulateHumanPresence).mockClear();
  vi.mocked(humanClick).mockClear();
  vi.mocked(humanType).mockClear();
});

const SECRET_VALUE = 'sup3r-s3cr3t-pw';

/**
 * Build a mock Playwright page. `content` is what get_content reads back (used to
 * verify value-aware redaction). The shared `fill` spy records what got typed.
 *
 * The mock now models the frame surface (`frames()` / `mainFrame()`) the handler
 * uses for iframe-aware content extraction and locator resolution: a single main
 * frame whose `evaluate` returns `content`. `opts` lets a test set the navigation
 * HTTP status and page title (for hard-block detection).
 */
function makeMockPage(
  content: string,
  fill: ReturnType<typeof vi.fn>,
  url = 'https://aeroplan.com/account',
  opts: { status?: number; title?: string } = {},
) {
    const locator = {
    count: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockReturnThis(),
    nth: vi.fn().mockReturnThis(),
    isVisible: vi.fn().mockResolvedValue(true),
    locator: vi.fn().mockReturnThis(),
    fill,
    click: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
  const mainFrame = {
    url: vi.fn().mockReturnValue(url),
    name: vi.fn().mockReturnValue(''),
    evaluate: vi.fn().mockResolvedValue(content),
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
  };
  return {
    url: vi.fn().mockReturnValue(url),
    evaluate: vi.fn().mockResolvedValue(content),
    title: vi.fn().mockResolvedValue(opts.title ?? ''),
    goto: vi.fn().mockResolvedValue({ status: () => opts.status ?? 200 }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    keyboard: { press: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined) },
    mouse: { wheel: vi.fn().mockResolvedValue(undefined), move: vi.fn().mockResolvedValue(undefined) },
    reload: vi.fn().mockResolvedValue({ status: () => 200 }),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
    frames: vi.fn().mockReturnValue([mainFrame]),
    mainFrame: vi.fn().mockReturnValue(mainFrame),
  };
}

/** Build a ToolContext + a real BrowserSession wrapping the mock page. */
function makeToolContext(opts: {
  input: Record<string, unknown>;
  pageContent?: string;
  pageUrl?: string;
  resolveSecretRef?: (ref: string) => Promise<string>;
}): { ctx: ToolContext; session: BrowserSession; fill: ReturnType<typeof vi.fn> } {
  const fill = vi.fn().mockResolvedValue(undefined);
  const page = makeMockPage(opts.pageContent ?? 'nothing sensitive here', fill, opts.pageUrl);
  const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);

  const browserService = {
    getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', session }),
    closeSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserService;

  const ctx = {
    input: opts.input,
    log: logger,
    browserService,
    resolveSecretRef: opts.resolveSecretRef,
  } as unknown as ToolContext;

  return { ctx, session, fill };
}

describe('web-browser type action with secret_ref (#973)', () => {
  it('fills the resolved secret value and never returns it', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const { ctx } = makeToolContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(resolveSecretRef).toHaveBeenCalledWith('user.aeroplan_password');
    // The resolved value was typed into the field via humanType (human keystroke cadence)...
    expect(vi.mocked(humanType)).toHaveBeenCalledWith(expect.anything(), SECRET_VALUE, expect.anything());
    // ...but never appears in the data returned to the LLM.
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('redacts an injected value reflected back through get_content', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    // First fill the secret, then a page whose content echoes it back.
    const { ctx, session } = makeToolContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
      pageContent: `Welcome. Your entered password was ${SECRET_VALUE} (oops).`,
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string };
      expect(data.content).not.toContain(SECRET_VALUE);
      expect(data.content).toContain('[REDACTED]');
    }
    // The session recorded the value so subsequent get_content calls are scrubbed too.
    expect(session.redactInjectedSecrets(SECRET_VALUE)).toBe('[REDACTED]');
  });

  it('redacts an injected value reflected back through the returned url (GET form)', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const { ctx } = makeToolContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
      // A form that submits via GET puts the field value into the query string.
      pageUrl: `https://aeroplan.com/login?pw=${SECRET_VALUE}`,
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { url: string };
      expect(data.url).not.toContain(SECRET_VALUE);
      expect(data.url).toContain('[REDACTED]');
    }
  });

  it('suppresses a screenshot on the same action that injects a secret', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const { ctx } = makeToolContext({
      // screenshot:true on a secret_ref fill — the field may render the value (non-password
      // input), and an image can't be value-redacted, so capture must be refused.
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password', screenshot: true },
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { screenshot_base64?: string };
      expect(data.screenshot_base64).toBeUndefined();
    }
  });

  it('rejects when both text and secret_ref are supplied (mutually exclusive)', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const { ctx } = makeToolContext({
      input: { action: 'type', selector: '#pass', text: 'literal', secret_ref: 'user.aeroplan_password' },
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(resolveSecretRef).not.toHaveBeenCalled();
    expect(vi.mocked(humanType)).not.toHaveBeenCalled();
  });

  it('rejects when neither text nor secret_ref is supplied', async () => {
    const { ctx } = makeToolContext({ input: { action: 'type', selector: '#pass' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('errors clearly when secret_ref is used but the resolver capability is absent', async () => {
    // resolveSecretRef undefined — the skill was invoked without the secretResolver capability.
    const { ctx } = makeToolContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/secret_ref|resolver|capability/i);
    }
    expect(vi.mocked(humanType)).not.toHaveBeenCalled();
  });

  it('still supports a literal text fill (non-secret path uses humanType for realistic cadence)', async () => {
    const { ctx } = makeToolContext({
      input: { action: 'type', selector: '#search', text: 'hello world' },
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // Literal text now uses humanType (keystroke cadence) rather than fill(), so that
    // behavioral challenge JS scores the typing as human. (#1053)
    expect(vi.mocked(humanType)).toHaveBeenCalledWith(expect.anything(), 'hello world', expect.anything());
  });
});

describe('web-browser block_ads + incognito inputs (#987)', () => {
  it('forwards block_ads and incognito to getOrCreateSession', async () => {
    // Build a mock page that satisfies the navigate action path:
    // - page.goto() — called during navigate
    // - page.url() — called when building the result
    // - page.evaluate() — called by getCleanedContent
    // We reuse makeMockPage (which has url+evaluate) and add goto to the result.
    const fill = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      ...makeMockPage('Example Domain', fill, 'https://example.com/'),
      goto: vi.fn().mockResolvedValue(undefined),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, mockPage as unknown as Page);

    // Track the getOrCreateSession spy directly so we can assert its call args.
    const getOrCreateSession = vi.fn().mockResolvedValue({ sessionId: 'sess-stealth', session });
    const browserService = {
      getOrCreateSession,
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;

    const ctx = {
      input: { action: 'navigate', url: 'https://example.com', block_ads: true, incognito: true },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    await new WebBrowserHandler().execute(ctx);

    // The handler must forward both flags as the second arg to getOrCreateSession.
    // session_id was not supplied, so first arg must be undefined. keep_warm defaults to false.
    expect(getOrCreateSession).toHaveBeenCalledWith(undefined, { incognito: true, blockAds: true, keepWarm: false });
  });

  it('forwards keep_warm:true to getOrCreateSession as keepWarm (pin the session)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page', fill, 'https://example.com/');
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const getOrCreateSession = vi.fn().mockResolvedValue({ sessionId: 'sess-warm', session });
    const browserService = {
      getOrCreateSession,
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'get_content', keep_warm: true, session_id: 'sess-warm' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    await new WebBrowserHandler().execute(ctx);

    expect(getOrCreateSession).toHaveBeenCalledWith('sess-warm', { incognito: false, blockAds: false, keepWarm: true });
  });
});

describe('web-browser new interaction actions (scroll/hover/press_key/wait_for)', () => {
  // Reach into the mock page's shared locator (the one every getBy/locator stub returns).
  function getSharedLocator(session: BrowserSession) {
    return (session.page as unknown as { getByRole: (role: string, opts: { name: string }) => unknown })
      .getByRole('button', { name: 'x' });
  }

  it('scroll with a selector scrolls the target element into view', async () => {
    const { ctx, session } = makeToolContext({
      input: { action: 'scroll', selector: 'load more results' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { scrollIntoViewIfNeeded: ReturnType<typeof vi.fn> };
    expect(loc.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('scroll without a selector scrolls the viewport', async () => {
    const { ctx, session } = makeToolContext({ input: { action: 'scroll' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const page = session.page as unknown as { mouse: { wheel: ReturnType<typeof vi.fn> } };
    expect(page.mouse.wheel).toHaveBeenCalled();
  });

  it('hover hovers the resolved element', async () => {
    const { ctx, session } = makeToolContext({
      input: { action: 'hover', selector: 'July 18' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { hover: ReturnType<typeof vi.fn> };
    expect(loc.hover).toHaveBeenCalled();
  });

  it('hover without a selector errors', async () => {
    const { ctx } = makeToolContext({ input: { action: 'hover' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('press_key presses the given key', async () => {
    const { ctx, session } = makeToolContext({
      input: { action: 'press_key', key: 'Enter' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const page = session.page as unknown as { keyboard: { press: ReturnType<typeof vi.fn> } };
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  it('press_key without a key errors', async () => {
    const { ctx } = makeToolContext({ input: { action: 'press_key' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('wait_for waits for the element to become visible', async () => {
    const { ctx, session } = makeToolContext({
      input: { action: 'wait_for', selector: 'date picker' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { waitFor: ReturnType<typeof vi.fn> };
    expect(loc.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }));
  });

  it('wait_for surfaces a clear error when the element never appears', async () => {
    const { ctx, session } = makeToolContext({
      input: { action: 'wait_for', selector: 'never renders' },
    });
    // Make the shared locator's waitFor reject (timeout).
    const loc = getSharedLocator(session) as unknown as { waitFor: ReturnType<typeof vi.fn> };
    loc.waitFor.mockRejectedValueOnce(new Error('Timeout 10000ms exceeded'));
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/wait_for|timeout/i);
  });

  it('wait_for without a selector errors', async () => {
    const { ctx } = makeToolContext({ input: { action: 'wait_for' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });
});

describe('web-browser iframe awareness', () => {
  it('resolveLocator falls through to a child frame when the top page has no match', async () => {
    // Top-page locators all miss (count 0); the child frame's locator matches (count 1).
    const missLocator = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnThis(),
    };
    const frameLocator = {
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnThis(),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const childFrame = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/widget'),
      name: vi.fn().mockReturnValue('booking'),
      evaluate: vi.fn().mockResolvedValue(''),
      getByRole: vi.fn().mockReturnValue(frameLocator),
      getByLabel: vi.fn().mockReturnValue(missLocator),
      getByText: vi.fn().mockReturnValue(missLocator),
      locator: vi.fn().mockReturnValue(missLocator),
    };
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('restaurant page'),
      getByRole: vi.fn().mockReturnValue(missLocator),
      getByLabel: vi.fn().mockReturnValue(missLocator),
      getByText: vi.fn().mockReturnValue(missLocator),
      locator: vi.fn().mockReturnValue(missLocator),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      evaluate: vi.fn().mockResolvedValue('restaurant page'),
      title: vi.fn().mockResolvedValue('Cambridge Mill'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn().mockReturnValue(missLocator),
      getByLabel: vi.fn().mockReturnValue(missLocator),
      getByText: vi.fn().mockReturnValue(missLocator),
      locator: vi.fn().mockReturnValue(missLocator),
      frames: vi.fn().mockReturnValue([mainFrame, childFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-frame', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'click', selector: 'July 18' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The click resolved to the CHILD FRAME's locator and was dispatched via humanClick
    // (not locator.click directly — humanClick provides realistic mouse-movement telemetry).
    expect(vi.mocked(humanClick)).toHaveBeenCalled();
  });

  it('resolveLocator skips a child frame that throws (detached) and continues', async () => {
    const miss = { count: vi.fn().mockResolvedValue(0), first: vi.fn().mockReturnThis() };
    // This child frame detaches mid-traversal: every locator query throws.
    const detached = new Error('Frame was detached');
    const detachedFrame = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/stale-widget'),
      name: vi.fn().mockReturnValue('stale'),
      evaluate: vi.fn().mockResolvedValue(''),
      getByRole: vi.fn().mockImplementation(() => { throw detached; }),
      getByLabel: vi.fn().mockImplementation(() => { throw detached; }),
      getByText: vi.fn().mockImplementation(() => { throw detached; }),
      locator: vi.fn().mockImplementation(() => { throw detached; }),
    };
    const mainFrameD = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('page'),
      getByRole: vi.fn().mockReturnValue(miss),
      getByLabel: vi.fn().mockReturnValue(miss),
      getByText: vi.fn().mockReturnValue(miss),
      locator: vi.fn().mockReturnValue(miss),
    };
    // Main-frame CSS fallback has a clickable match, so the action still completes.
    const mainClick = vi.fn().mockResolvedValue(undefined);
    const pageD = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      title: vi.fn().mockResolvedValue('Cambridge Mill'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn().mockReturnValue(miss),
      getByLabel: vi.fn().mockReturnValue(miss),
      getByText: vi.fn().mockReturnValue(miss),
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1), first: vi.fn().mockReturnThis(), click: mainClick }),
      frames: vi.fn().mockReturnValue([mainFrameD, detachedFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrameD),
    };
    const sessionD = new BrowserSession({} as unknown as BrowserContext, pageD as unknown as Page);
    const browserServiceD = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-detach', session: sessionD }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctxD = {
      input: { action: 'click', selector: 'Reserve' },
      log: logger,
      browserService: browserServiceD,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctxD);

    // The detached frame's throw must NOT fail the action — it's skipped and the main
    // frame's CSS fallback resolves instead. The click is dispatched via humanClick, not
    // locator.click directly (humanClick provides realistic mouse-movement telemetry). (#1053)
    expect(result.success).toBe(true);
    expect(vi.mocked(humanClick)).toHaveBeenCalled();
  });

  it('get_content includes labelled iframe content', async () => {
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('Cambridge Mill — fine dining'),
    };
    const childFrame = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/widget'),
      name: vi.fn().mockReturnValue('booking'),
      evaluate: vi.fn().mockResolvedValue('Reserve a table — choose date'),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://www.opentable.com/r/cambridge-mill'),
      title: vi.fn().mockResolvedValue('Cambridge Mill'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      frames: vi.fn().mockReturnValue([mainFrame, childFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-frame2', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'get_content' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string };
      expect(data.content).toContain('Cambridge Mill — fine dining');
      expect(data.content).toContain('Reserve a table — choose date');
      // Child frame content is labelled so the LLM knows it's a sub-frame.
      expect(data.content).toMatch(/--- Frame:/);
    }
  });
});

describe('web-browser frame SSRF gating + read-failure detection', () => {
  it('get_content does NOT read a child frame pointing at an internal/metadata host', async () => {
    const internalEvaluate = vi.fn().mockResolvedValue('AWS_SECRET=internal-only');
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('Innocent looking page'),
    };
    const internalFrame = {
      url: vi.fn().mockReturnValue('http://169.254.169.254/latest/meta-data/'),
      name: vi.fn().mockReturnValue('evil'),
      evaluate: internalEvaluate,
    };
    const page = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      title: vi.fn().mockResolvedValue('Page'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      frames: vi.fn().mockReturnValue([mainFrame, internalFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-ssrf', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'get_content' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The internal frame must never be evaluated, and its content must not appear.
    expect(internalEvaluate).not.toHaveBeenCalled();
    if (result.success) {
      const data = result.data as { content: string };
      expect(data.content).not.toContain('AWS_SECRET');
      expect(data.content).toContain('Innocent looking page');
    }
  });

  it('resolveLocator does NOT reach into a private-host child frame', async () => {
    const miss = { count: vi.fn().mockResolvedValue(0), first: vi.fn().mockReturnThis() };
    // The internal frame would "match" if we ever queried it — but we must not.
    const internalGetByRole = vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnThis(),
      click: vi.fn().mockResolvedValue(undefined),
    });
    const internalFrame = {
      url: vi.fn().mockReturnValue('http://10.0.0.5/admin'),
      name: vi.fn().mockReturnValue('evil'),
      evaluate: vi.fn().mockResolvedValue(''),
      getByRole: internalGetByRole,
      getByLabel: vi.fn().mockReturnValue(miss),
      getByText: vi.fn().mockReturnValue(miss),
      locator: vi.fn().mockReturnValue(miss),
    };
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('page'),
      getByRole: vi.fn().mockReturnValue(miss),
      getByLabel: vi.fn().mockReturnValue(miss),
      getByText: vi.fn().mockReturnValue(miss),
      locator: vi.fn().mockReturnValue(miss),
    };
    // Main page CSS fallback has a clickable element so the action still completes.
    const mainClick = vi.fn().mockResolvedValue(undefined);
    const page = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      title: vi.fn().mockResolvedValue('Page'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn().mockReturnValue(miss),
      getByLabel: vi.fn().mockReturnValue(miss),
      getByText: vi.fn().mockReturnValue(miss),
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1), first: vi.fn().mockReturnThis(), click: mainClick }),
      frames: vi.fn().mockReturnValue([mainFrame, internalFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-ssrf2', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'click', selector: 'admin link' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The private frame must never be queried for a locator.
    expect(internalGetByRole).not.toHaveBeenCalled();
  });

  it('get_content skips IPv6 private frames (ULA fc00::/7 and IPv4-mapped loopback)', async () => {
    const ulaEvaluate = vi.fn().mockResolvedValue('ULA internal');
    const mappedEvaluate = vi.fn().mockResolvedValue('mapped loopback internal');
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockResolvedValue('Innocent page'),
    };
    const ulaFrame = {
      url: vi.fn().mockReturnValue('http://[fc00::1]/internal'),
      name: vi.fn().mockReturnValue('ula'),
      evaluate: ulaEvaluate,
    };
    const mappedFrame = {
      url: vi.fn().mockReturnValue('http://[::ffff:127.0.0.1]/admin'),
      name: vi.fn().mockReturnValue('mapped'),
      evaluate: mappedEvaluate,
    };
    const page = {
      url: vi.fn().mockReturnValue('https://attacker.example/page'),
      title: vi.fn().mockResolvedValue('Page'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      frames: vi.fn().mockReturnValue([mainFrame, ulaFrame, mappedFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-ssrf6', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'get_content' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(ulaEvaluate).not.toHaveBeenCalled();
    expect(mappedEvaluate).not.toHaveBeenCalled();
    if (result.success) {
      const data = result.data as { content: string };
      expect(data.content).not.toContain('internal');
    }
  });

  it('get_content fails (does not report empty success) when every frame errors', async () => {
    const mainFrame = {
      url: vi.fn().mockReturnValue('https://example.com/'),
      name: vi.fn().mockReturnValue(''),
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context was destroyed')),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/'),
      title: vi.fn().mockResolvedValue('Example'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      frames: vi.fn().mockReturnValue([mainFrame]),
      mainFrame: vi.fn().mockReturnValue(mainFrame),
    };
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-fail', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'get_content' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
  });
});

describe('web-browser hard-block detection', () => {
  it('navigate returns a distinct, actionable error on an Access Denied page', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('Access Denied', fill, 'https://www.opentable.com/booking/xyz', {
      status: 403,
      title: 'Access Denied',
    });
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-block', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'navigate', url: 'https://www.opentable.com/booking/xyz' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/blocked|access denied/i);
      // Actionable: tells the LLM to hand off rather than retry.
      expect(result.error).toMatch(/hand off|principal|draft/i);
    }
  });

  it('navigate does NOT hard-block a bare 403 with a normal title (app auth, still drivable)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    // 403 is common for auth/authorization the agent can still resolve (log in); only a
    // recognizable challenge title should trip the hard-block path.
    const page = makeMockPage('Please log in to continue', fill, 'https://app.example.com/dashboard', {
      status: 403,
      title: 'Forbidden',
    });
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-403', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'navigate', url: 'https://app.example.com/dashboard' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
  });

  it('navigate succeeds normally on a 200 page', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('Welcome', fill, 'https://example.com/', { status: 200, title: 'Example' });
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-ok', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: { action: 'navigate', url: 'https://example.com' },
      log: logger,
      browserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
  });
});

describe('web-browser navigate hardening — dwell + soft-block reload (#1053)', () => {
  function makeNavCtx(page: ReturnType<typeof makeMockPage>) {
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-nav', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return {
      input: { action: 'navigate', url: 'https://example.com' },
      log: logger,
      browserService,
    } as unknown as ToolContext;
  }

  it('dwells and simulates presence after a clean navigation', async () => {
    const fill = vi.fn();
    const page = makeMockPage('Example Domain content here for a normal page', fill, 'https://example.com/');
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(vi.mocked(simulateHumanPresence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jitteredDelay)).toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('reloads once on a soft block (near-empty body), then succeeds when the reload clears it', async () => {
    const fill = vi.fn();
    const page = makeMockPage('content', fill, 'https://shop.example.com/');
    // Make isLikelyEmpty fire on first check (tiny stub page: minimal text, tiny HTML,
    // no interactive elements), then return a normal-looking page after reload.
    // isLikelyEmpty now requires ALL THREE signals to be below threshold before it
    // treats a page as empty — so the "clear" return must exceed at least one. (#1053)
    page.evaluate = vi.fn()
      .mockResolvedValueOnce('normal page body')  // waitForChallengeClear body snippet
      .mockResolvedValueOnce({ textLength: 10, htmlLength: 200, interactiveCount: 0 })  // first: all thresholds met → empty
      .mockResolvedValue({ textLength: 500, htmlLength: 5_000, interactiveCount: 3 });  // after reload: not empty → success
    // title is always clean (not a hard block title)
    page.title = vi.fn().mockResolvedValue('Shop — Home');
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(simulateHumanPresence)).toHaveBeenCalledTimes(1);
  });

  it('returns a hard-block error when the soft block persists after the reload', async () => {
    const fill = vi.fn();
    const page = makeMockPage('content', fill, 'https://walled.example.com/', { title: 'Access Denied' });
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
    if (!result.success) expect(result.error).toMatch(/blocked automated access/i);
    // No presence simulation once we've declared the page undrivable.
    expect(vi.mocked(simulateHumanPresence)).not.toHaveBeenCalled();
  });

  it('returns a hard-block error when isLikelyEmpty persists after the reload', async () => {
    const fill = vi.fn();
    const page = makeMockPage('content', fill, 'https://empty.example.com/');
    // evaluate always returns a stub-page metrics object — isLikelyEmpty fires on both
    // the first check and the post-reload re-check (all three signals below threshold),
    // so the block persists and the handler fails fast. (#1053)
    page.evaluate = vi.fn()
      .mockResolvedValueOnce('normal page body')  // waitForChallengeClear body snippet
      .mockResolvedValue({ textLength: 10, htmlLength: 200, interactiveCount: 0 });
    page.title = vi.fn().mockResolvedValue('Empty Page'); // not a hard-block title
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(simulateHumanPresence)).not.toHaveBeenCalled();
    if (!result.success) expect(result.error).toMatch(/blocked automated access/i);
  });
});

describe('web-browser click uses human behavior (#1053)', () => {
  it('routes click through humanClick', async () => {
    const fill = vi.fn();
    const page = makeMockPage('page body content for the click target test', fill, 'https://example.com/');
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const ctx = {
      input: { action: 'click', selector: 'Submit button' },
      log: logger,
      browserService: {
        getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-click', session }),
        closeSession: vi.fn(),
      } as unknown as BrowserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(vi.mocked(humanClick)).toHaveBeenCalledTimes(1);
  });
});

describe('web-browser navigate — challenge poll (#1053+)', () => {
  it('waits through a Cloudflare interstitial before proceeding', async () => {
    const fill = vi.fn();
    const page = makeMockPage('Medium article body content here', fill, 'https://josephfung.ca/', {
      title: 'Just a moment...',
    });
    page.title = vi.fn()
      .mockResolvedValueOnce('Just a moment...')
      .mockResolvedValue('Joseph Fung – Medium');
    page.evaluate = vi.fn()
      .mockResolvedValueOnce('Checking if the site connection is secure')
      .mockResolvedValueOnce('Article body loaded on Medium')
      .mockResolvedValue({ textLength: 500, htmlLength: 5_000, interactiveCount: 3 });
    const ctx = {
      input: { action: 'navigate', url: 'https://josephfung.ca' },
      log: logger,
      browserService: {
        getOrCreateSession: vi.fn().mockResolvedValue({
          sessionId: 'sess-cf',
          session: new BrowserSession({} as unknown as BrowserContext, page as unknown as Page),
        }),
        closeSession: vi.fn(),
      } as unknown as BrowserService,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(vi.mocked(simulateHumanPresence)).toHaveBeenCalledTimes(1);
  });
});

describe('web-browser ref-based selectors', () => {
  // Build a ctx around a caller-supplied mock page so the test can assert on how the
  // page's locator methods were called (makeToolContext hides its page).
  function ctxFor(page: ReturnType<typeof makeMockPage>, input: Record<string, unknown>) {
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return { input, log: logger, browserService } as unknown as ToolContext;
  }

  it('resolves an gNfNeM ref via data-curia-ref, bypassing the fuzzy cascade', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'click', selector: 'g1f0e3', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The ref resolved by attribute...
    expect(page.locator).toHaveBeenCalledWith('[data-curia-ref="g1f0e3"]');
    // ...and did NOT fall through to accessible-name matching (which could hit a duplicate).
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it('resolves a ref passed in its bracketed display form ([gNfNeM]) — the shape the agent copies', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    // The page shows refs as "[g1f0e3] radio ...", and models routinely pass the token back with
    // the brackets. The resolver must strip them and still hit the attribute fast-path, NOT
    // fall through to fuzzy matching (which finds nothing and hangs until the action times out).
    const ctx = ctxFor(page, { action: 'click', selector: '[g1f0e3]', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('[data-curia-ref="g1f0e3"]');
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it('fails FAST with a clear message on a stale/unknown ref (no fuzzy fallthrough, no 40s hang)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    // The ref matches nothing this snapshot. resolveLocator must THROW immediately rather than
    // return a guaranteed-miss locator the caller then waits ~40s on (30s boundingBox + 10s click).
    const none = { count: vi.fn().mockResolvedValue(0), first: vi.fn().mockReturnThis() };
    page.locator = vi.fn().mockReturnValue(none);
    const ctx = ctxFor(page, { action: 'click', selector: 'g9f0e9', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(page.locator).toHaveBeenCalledWith('[data-curia-ref="g9f0e9"]');
    expect(page.getByRole).not.toHaveBeenCalled(); // never degraded to fuzzy matching
    expect(page.getByText).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    const err = (result as { error: string }).error;
    expect(err).toMatch(/g9f0e9/);
    expect(err).toMatch(/stale/i);
    expect(err).toMatch(/get_content/); // tells the agent exactly how to recover
  });

  it('fails FAST with a clear message when a ref is duplicated (>1 match, no silent .first())', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    // Two elements carry the same ref (e.g. a hostile page re-injected our attribute).
    const dup = { count: vi.fn().mockResolvedValue(2), first: vi.fn().mockReturnThis() };
    page.locator = vi.fn().mockReturnValue(dup);
    const ctx = ctxFor(page, { action: 'click', selector: 'g1f0e2', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false); // ambiguous ref did not resolve to one element
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
    const err = (result as { error: string }).error;
    expect(err).toMatch(/g1f0e2/);
    expect(err).toMatch(/ambiguous/i);
  });

  it('trips a circuit-breaker after 4 consecutive interaction failures, then short-circuits', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    // Every click targets a stale ref → resolveLocator throws → a failure is recorded.
    const none = { count: vi.fn().mockResolvedValue(0), first: vi.fn().mockReturnThis() };
    page.locator = vi.fn().mockReturnValue(none);
    // One ctx → getOrCreateSession returns the SAME session each call, so the counter persists.
    const ctx = ctxFor(page, { action: 'click', selector: 'g1f0e1', session_id: 'sess-1' });

    for (let i = 0; i < 4; i++) {
      const r = await new WebBrowserHandler().execute(ctx);
      expect(r.success).toBe(false); // 4 real attempts, all fail on the stale ref
    }
    const callsAfter4 = (page.locator as ReturnType<typeof vi.fn>).mock.calls.length;

    // 5th attempt: breaker is tripped → short-circuit WITHOUT touching the page again.
    const tripped = await new WebBrowserHandler().execute(ctx);
    expect(tripped.success).toBe(false);
    expect((tripped as { error: string }).error).toMatch(/failed in a row|Stopping browser interaction/i);
    expect((page.locator as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfter4); // no new page work
  });

  it('resets the breaker after a successful get_content, re-enabling interaction', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    const none = { count: vi.fn().mockResolvedValue(0), first: vi.fn().mockReturnThis() };
    page.locator = vi.fn().mockReturnValue(none);
    const ctx = ctxFor(page, { action: 'click', selector: 'g1f0e1', session_id: 'sess-1' });

    for (let i = 0; i < 4; i++) await new WebBrowserHandler().execute(ctx);
    // Confirm tripped.
    const trippedErr = (await new WebBrowserHandler().execute(ctx) as { error: string }).error;
    expect(trippedErr).toMatch(/failed in a row|Stopping browser interaction/i);

    // A successful get_content (a recovery action, never short-circuited) resets the streak.
    const readCtx = { ...ctx, input: { action: 'get_content', session_id: 'sess-1' } } as unknown as ToolContext;
    const read = await new WebBrowserHandler().execute(readCtx);
    expect(read.success).toBe(true);

    // Now a click is attempted again (not short-circuited): the page is touched for it.
    const before = (page.locator as ReturnType<typeof vi.fn>).mock.calls.length;
    await new WebBrowserHandler().execute(ctx);
    expect((page.locator as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('still resolves a plain label selector via the existing cascade (back-compat)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'click', selector: 'Save', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(page.getByRole).toHaveBeenCalled();               // fuzzy path used
    expect(page.locator).not.toHaveBeenCalledWith('[data-curia-ref="Save"]');
  });

  it('resolves a ref that lives inside a child iframe', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('outer page', fill, 'https://example.com/');
    // Main frame: the ref matches nothing (the element is in the iframe).
    page.locator = vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnThis(),
    });
    // Child frame: the ref matches exactly one element there.
    const childLoc = {
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
      isVisible: vi.fn().mockResolvedValue(true),
      locator: vi.fn().mockReturnThis(),
      click: vi.fn().mockResolvedValue(undefined),
      fill,
    };
    const childFrame = {
      url: vi.fn().mockReturnValue('https://widget.example.com/'),
      name: vi.fn().mockReturnValue('widget'),
      evaluate: vi.fn().mockResolvedValue('widget body'),
      getByRole: vi.fn(), getByLabel: vi.fn(), getByText: vi.fn(),
      locator: vi.fn().mockReturnValue(childLoc),
    };
    const mainFrame = page.mainFrame();
    page.frames = vi.fn().mockReturnValue([mainFrame, childFrame]);
    const ctx = ctxFor(page, { action: 'click', selector: 'g1f1e2', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(childFrame.locator).toHaveBeenCalledWith('[data-curia-ref="g1f1e2"]');
  });

  it('preserves the interactable ref list when the page body exceeds the budget', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const hugeBody = 'x'.repeat(20_000);
    const refList = '[g1f0e1] button "Submit"\n[g1f0e2] link "Next"';
    const raw = `${hugeBody}\n\n--- Interactable elements ---\n${refList}`;
    const page = makeMockPage(raw, fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'get_content', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const content = (result.data as { content: string }).content;
      expect(content).toContain('[content truncated]');       // body was truncated...
      expect(content).toContain('[g1f0e1] button "Submit"');    // ...but refs survived (the point)
      expect(content).toContain('[g1f0e2] link "Next"');
    }
  });

  it('does not truncate the ref list when the whole page fits the budget (small body, long list)', async () => {
    // Regression for the 16personalities survey bug: a survey page has a tiny body but a
    // long interactable list (dozens of radios), with the "Next" button LAST in DOM order.
    // The list exceeded the old 6,000-char ref ceiling, so the tail-slice dropped Next —
    // even though body + refs together sat well under the 15,000-char page budget (43% unused).
    // With a floor (not a ceiling), the ref list may grow into the budget the body leaves free.
    const fill = vi.fn().mockResolvedValue(undefined);
    const body = 'You regularly make new friends.';
    // ~78 chars/line × 100 ≈ 7,800 chars: over the old ceiling, under the page budget.
    const radios = Array.from({ length: 100 }, (_, i) =>
      `[g1f0e${i + 1}] radio "I strongly agree" (group: "You regularly make new friends.")`).join('\n');
    const nextBtn = '[g1f0e999] button "Next"'; // the navigation control, last in DOM order
    const refList = `${radios}\n${nextBtn}`;
    // Guard the premise: the list overflows the old ceiling, yet the whole page fits the budget.
    expect(refList.length).toBeGreaterThan(6_000);
    expect(body.length + refList.length).toBeLessThan(15_000);
    const raw = `${body}\n\n--- Interactable elements ---\n${refList}`;
    const page = makeMockPage(raw, fill, 'https://www.16personalities.com/');
    const ctx = ctxFor(page, { action: 'get_content', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const content = (result.data as { content: string }).content;
      // The Next button at the tail survives — the whole point of the fix.
      expect(content).toContain('[g1f0e999] button "Next"');
      // Nothing was cut: the total fit under the page budget, so neither side truncates.
      expect(content).not.toContain('[interactable list truncated]');
      expect(content).not.toContain('[content truncated]');
    }
  });

  it('guarantees the ref-list floor when the body alone exceeds the budget', async () => {
    // The other half of the fix's contract: 6,000 is a FLOOR. When the body alone is larger
    // than the whole 15,000-char budget, the ref list must still get at least the floor — a
    // giant page body can never starve the agent's selectors to nothing.
    const fill = vi.fn().mockResolvedValue(undefined);
    const hugeBody = 'x'.repeat(20_000); // exceeds MAX_CONTENT_LENGTH on its own
    // A ref list longer than the floor, with a distinctive control FIRST (must survive within
    // the floor) followed by filler that overflows past it.
    const early = '[g1f0e1] button "Submit"';
    const filler = Array.from({ length: 100 }, (_, i) =>
      `[g1f0e${i + 2}] radio "I strongly agree" (group: "You regularly make new friends.")`).join('\n');
    const refList = `${early}\n${filler}`;
    expect(refList.length).toBeGreaterThan(6_000);
    const raw = `${hugeBody}\n\n--- Interactable elements ---\n${refList}`;
    const page = makeMockPage(raw, fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'get_content', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const content = (result.data as { content: string }).content;
      // Body truncated (it alone exceeds the budget)...
      expect(content).toContain('[content truncated]');
      // ...but the ref list still gets its guaranteed floor: the leading control survives,
      // and the overflow past the floor is truncated and marked (not silently dropped).
      expect(content).toContain('[g1f0e1] button "Submit"');
      expect(content).toContain('[interactable list truncated]');
      // Assert the floor QUANTITY, not just that *something* survived: the leading control
      // would pass even with a tiny allocation. Measure only the ref-list content (between
      // the section header and the truncation marker) and require the full 6,000-char floor.
      const refSection = content.split('--- Interactable elements ---\n')[1] ?? '';
      const refContent = refSection.split('\n[interactable list truncated]')[0]!;
      expect(refContent.length).toBeGreaterThanOrEqual(6_000);
    }
  });
});

describe('web-browser batched actions (multi-action per call)', () => {
  // Build a ctx around a caller-supplied mock page. Optionally override the session result
  // getOrCreateSession returns (used by the session_reused cases below).
  function batchCtx(
    page: ReturnType<typeof makeMockPage>,
    input: Record<string, unknown>,
    sessionResult?: { sessionId: string; session: BrowserSession },
  ) {
    const result = sessionResult ?? {
      sessionId: 'sess-1',
      session: new BrowserSession({} as unknown as BrowserContext, page as unknown as Page),
    };
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue(result),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return { input, log: logger, browserService } as unknown as ToolContext;
  }

  it('runs a sequence of actions in order in one call (a whole page of answers + Next)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('survey page', fill, 'https://www.16personalities.com/');
    const ctx = batchCtx(page, {
      session_id: 'sess-1',
      actions: [
        { action: 'click', selector: 'g1f0e1' },
        { action: 'click', selector: 'g1f0e2' },
        { action: 'click', selector: 'g1f0e3' },
        { action: 'click', selector: 'Next' },
      ],
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { actions_total: number; actions_completed: number; failed_action?: number; content: string };
      expect(data.actions_total).toBe(4);
      expect(data.actions_completed).toBe(4);
      expect(data.failed_action).toBeUndefined();
      expect(data.content).toContain('survey page');
    }
    // All four clicks executed against the page (one skill call = one turn).
    expect(vi.mocked(humanClick)).toHaveBeenCalledTimes(4);
  });

  it('stops at the first failing step and reports partial progress with fresh content', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('survey page after one answer', fill, 'https://www.16personalities.com/');
    const ctx = batchCtx(page, {
      session_id: 'sess-1',
      actions: [
        { action: 'click', selector: 'g1f0e1' },
        { action: 'click' }, // missing selector → validation error stops the batch here
        { action: 'click', selector: 'g1f0e3' },
      ],
    });

    const result = await new WebBrowserHandler().execute(ctx);

    // A batch returns success:true so the agent still gets page state to recover from.
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { actions_total: number; actions_completed: number; failed_action: number; action_error: string; content: string };
      expect(data.actions_total).toBe(3);
      expect(data.actions_completed).toBe(1);
      expect(data.failed_action).toBe(1);
      expect(data.action_error).toMatch(/selector/i);
      expect(data.content).toContain('survey page after one answer');
    }
    // Only the first click ran; the batch stopped before the third.
    expect(vi.mocked(humanClick)).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty or non-array actions input', async () => {
    const empty = await new WebBrowserHandler().execute(
      batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), { actions: [] }),
    );
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error).toMatch(/non-empty array/i);

    const notArray = await new WebBrowserHandler().execute(
      batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), { actions: 'click' }),
    );
    expect(notArray.success).toBe(false);
  });

  it('rejects close_session inside a batch (it is terminal)', async () => {
    const ctx = batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), {
      session_id: 'sess-1',
      actions: [{ action: 'get_content' }, { action: 'close_session' }],
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/close_session/);
  });

  it('rejects an unknown action verb in a batch, before any action runs', async () => {
    const ctx = batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), {
      session_id: 'sess-1',
      actions: [{ action: 'click', selector: 'g1f0e1' }, { action: 'frobnicate' }],
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Unknown action/);
      expect(result.error).toMatch(/frobnicate/);
    }
    // Validation happens up front — the valid first step never executed.
    expect(vi.mocked(humanClick)).not.toHaveBeenCalled();
  });

  it('caps the number of actions per call', async () => {
    const tooMany = Array.from({ length: 51 }, () => ({ action: 'get_content' }));
    const result = await new WebBrowserHandler().execute(
      batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), { session_id: 'sess-1', actions: tooMany }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/maximum per call/i);
  });

  it('returns single-action validation errors RAW, without the "Browser action failed" prefix', async () => {
    // Back-compat: the pre-batch handler returned validation messages directly from the switch.
    // Only thrown execution errors carry the "Browser action \"X\" failed:" wrapper.
    const result = await new WebBrowserHandler().execute(
      batchCtx(makeMockPage('x', vi.fn(), 'https://example.com/'), { session_id: 'sess-1', action: 'click' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('click requires selector (string — describe the element in natural language)');
      expect(result.error).not.toMatch(/Browser action/);
    }
  });

  it('suppresses the screenshot even when a secret-injecting step THROWS mid-batch (#973 fail-closed)', async () => {
    // The hard guard must key off "a secret was registered this call", not the step's success
    // return: if humanType throws after the value is registered, a batch call still falls through
    // to the screenshot block and must NOT capture the secret-bearing page.
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('login page', fill, 'https://example.com/');
    // The fill throws AFTER the secret has been registered on the session.
    vi.mocked(humanType).mockRejectedValueOnce(new Error('typing interrupted'));
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    const ctx = {
      input: {
        session_id: 'sess-1',
        screenshot: true,
        actions: [{ action: 'type', selector: 'g1f0e1', secret_ref: 'user.password' }, { action: 'click', selector: 'Sign in' }],
      },
      log: logger,
      browserService,
      resolveSecretRef,
    } as unknown as ToolContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { screenshot_base64?: string; screenshot_skipped?: string };
      expect(data.screenshot_base64).toBeUndefined(); // NOT captured
      expect(data.screenshot_skipped).toBeTruthy(); // suppressed with a note
    }
    // And nothing containing the secret was returned.
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('honors a screenshot ACTION step inside a batch (captures the final page state)', async () => {
    // The skill advertises `screenshot` as a batch action; a `{ action: 'screenshot' }` step must
    // actually capture, not silently no-op. A batch returns one result, so it captures the end
    // state — equivalent to call-level screenshot:true.
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('final page', fill, 'https://example.com/done');
    const ctx = batchCtx(page, {
      session_id: 'sess-1',
      actions: [
        { action: 'click', selector: 'g1f0e1' },
        { action: 'click', selector: 'Next' },
        { action: 'screenshot' },
      ],
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { actions_completed: number; screenshot_base64?: string };
      expect(data.actions_completed).toBe(3); // the screenshot step counts as completed
      expect(data.screenshot_base64).toBeTruthy(); // and the capture actually ran
    }
  });

  it('does NOT capture when a batch stops before reaching its screenshot step', async () => {
    // The screenshot step is only honored if we actually reach it — a batch that fails earlier
    // must not emit an image for a step it never ran.
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('mid-form', fill, 'https://example.com/form');
    vi.mocked(humanClick).mockRejectedValueOnce(new Error('element gone'));
    const ctx = batchCtx(page, {
      session_id: 'sess-1',
      actions: [
        { action: 'click', selector: 'g1f0e1' }, // throws — batch stops here
        { action: 'screenshot' },
      ],
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true); // batch failures are reported in-band
    if (result.success) {
      const data = result.data as { actions_completed: number; failed_action?: number; screenshot_base64?: string };
      expect(data.actions_completed).toBe(0);
      expect(data.failed_action).toBe(0);
      expect(data.screenshot_base64).toBeUndefined();
    }
  });

  it('degrades a screenshot-capture failure to a note instead of failing the whole call', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('form submitted', fill, 'https://example.com/thanks');
    page.screenshot = vi.fn().mockRejectedValue(new Error('page navigated'));
    const ctx = batchCtx(page, {
      session_id: 'sess-1',
      screenshot: true,
      actions: [{ action: 'click', selector: 'g1f0e1' }, { action: 'click', selector: 'Submit' }],
    });

    const result = await new WebBrowserHandler().execute(ctx);

    // The batch succeeded; only the auxiliary screenshot failed — the call must still succeed
    // and return the page state so the agent knows the form was submitted.
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string; actions_completed: number; screenshot_base64?: string; screenshot_error?: string };
      expect(data.actions_completed).toBe(2);
      expect(data.content).toContain('form submitted');
      expect(data.screenshot_base64).toBeUndefined();
      expect(data.screenshot_error).toMatch(/screenshot could not be captured/i);
    }
  });
});

describe('web-browser session_reused signal', () => {
  function ctxWithSession(input: Record<string, unknown>, returnedSessionId: string) {
    const page = makeMockPage('page', vi.fn(), 'https://example.com/');
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: returnedSessionId, session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return { input, log: logger, browserService } as unknown as ToolContext;
  }

  it('reports session_reused:true when a passed session_id reattaches to its live session', async () => {
    const result = await new WebBrowserHandler().execute(
      ctxWithSession({ action: 'get_content', session_id: 'sess-1' }, 'sess-1'),
    );
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { session_reused: boolean }).session_reused).toBe(true);
  });

  it('reports session_reused:false when the passed session_id expired and a fresh one was minted', async () => {
    const result = await new WebBrowserHandler().execute(
      ctxWithSession({ action: 'get_content', session_id: 'stale-sess' }, 'fresh-sess'),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { session_reused: boolean; session_id: string };
      expect(data.session_reused).toBe(false);
      expect(data.session_id).toBe('fresh-sess');
    }
  });

  it('OMITS session_reused entirely when no session_id was passed (nothing to reattach to)', async () => {
    // A boolean false would misread as "your session expired"; a brand-new session the agent
    // didn't ask to reuse should simply carry no session_reused field.
    const result = await new WebBrowserHandler().execute(
      ctxWithSession({ action: 'get_content' }, 'brand-new-sess'),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect('session_reused' in (result.data as object)).toBe(false);
    }
  });
});
