// skills/web-browser/handler.test.ts — tests for the web-browser skill's
// secret-by-reference fill path (#973).
//
// Focus: the `type` action's `secret_ref` input dereferences a user.* secret via
// ctx.resolveSecretRef and fills the resolved value WITHOUT the value ever entering
// the skill's return data, and any page content read back is scrubbed of it.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { WebBrowserHandler } from './handler.js';
import { BrowserSession } from '../../src/browser/browser-session.js';
import type { BrowserService } from '../../src/browser/browser-service.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { BrowserContext, Page } from 'playwright';

const logger = pino({ level: 'silent' });

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
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
    frames: vi.fn().mockReturnValue([mainFrame]),
    mainFrame: vi.fn().mockReturnValue(mainFrame),
  };
}

/** Build a SkillContext + a real BrowserSession wrapping the mock page. */
function makeSkillContext(opts: {
  input: Record<string, unknown>;
  pageContent?: string;
  pageUrl?: string;
  resolveSecretRef?: (ref: string) => Promise<string>;
}): { ctx: SkillContext; session: BrowserSession; fill: ReturnType<typeof vi.fn> } {
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
  } as unknown as SkillContext;

  return { ctx, session, fill };
}

describe('web-browser type action with secret_ref (#973)', () => {
  it('fills the resolved secret value and never returns it', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    const { ctx, fill } = makeSkillContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(resolveSecretRef).toHaveBeenCalledWith('user.aeroplan_password');
    // The resolved value was typed into the field...
    expect(fill).toHaveBeenCalledWith(SECRET_VALUE);
    // ...but never appears in the data returned to the LLM.
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('redacts an injected value reflected back through get_content', async () => {
    const resolveSecretRef = vi.fn().mockResolvedValue(SECRET_VALUE);
    // First fill the secret, then a page whose content echoes it back.
    const { ctx, session } = makeSkillContext({
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
    const { ctx } = makeSkillContext({
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
    const { ctx } = makeSkillContext({
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
    const { ctx, fill } = makeSkillContext({
      input: { action: 'type', selector: '#pass', text: 'literal', secret_ref: 'user.aeroplan_password' },
      resolveSecretRef,
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(resolveSecretRef).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it('rejects when neither text nor secret_ref is supplied', async () => {
    const { ctx } = makeSkillContext({ input: { action: 'type', selector: '#pass' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('errors clearly when secret_ref is used but the resolver capability is absent', async () => {
    // resolveSecretRef undefined — the skill was invoked without the secretResolver capability.
    const { ctx, fill } = makeSkillContext({
      input: { action: 'type', selector: '#pass', secret_ref: 'user.aeroplan_password' },
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/secret_ref|resolver|capability/i);
    }
    expect(fill).not.toHaveBeenCalled();
  });

  it('still supports a literal text fill (non-secret path unchanged)', async () => {
    const { ctx, fill } = makeSkillContext({
      input: { action: 'type', selector: '#search', text: 'hello world' },
    });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(fill).toHaveBeenCalledWith('hello world');
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
    } as unknown as SkillContext;

    await new WebBrowserHandler().execute(ctx);

    // The handler must forward both flags as the second arg to getOrCreateSession.
    // session_id was not supplied, so first arg must be undefined.
    expect(getOrCreateSession).toHaveBeenCalledWith(undefined, { incognito: true, blockAds: true });
  });
});

describe('web-browser new interaction actions (scroll/hover/press_key/wait_for)', () => {
  // Reach into the mock page's shared locator (the one every getBy/locator stub returns).
  function getSharedLocator(session: BrowserSession) {
    return (session.page as unknown as { getByRole: (role: string, opts: { name: string }) => unknown })
      .getByRole('button', { name: 'x' });
  }

  it('scroll with a selector scrolls the target element into view', async () => {
    const { ctx, session } = makeSkillContext({
      input: { action: 'scroll', selector: 'load more results' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { scrollIntoViewIfNeeded: ReturnType<typeof vi.fn> };
    expect(loc.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('scroll without a selector scrolls the viewport', async () => {
    const { ctx, session } = makeSkillContext({ input: { action: 'scroll' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const page = session.page as unknown as { mouse: { wheel: ReturnType<typeof vi.fn> } };
    expect(page.mouse.wheel).toHaveBeenCalled();
  });

  it('hover hovers the resolved element', async () => {
    const { ctx, session } = makeSkillContext({
      input: { action: 'hover', selector: 'July 18' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { hover: ReturnType<typeof vi.fn> };
    expect(loc.hover).toHaveBeenCalled();
  });

  it('hover without a selector errors', async () => {
    const { ctx } = makeSkillContext({ input: { action: 'hover' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('press_key presses the given key', async () => {
    const { ctx, session } = makeSkillContext({
      input: { action: 'press_key', key: 'Enter' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const page = session.page as unknown as { keyboard: { press: ReturnType<typeof vi.fn> } };
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  it('press_key without a key errors', async () => {
    const { ctx } = makeSkillContext({ input: { action: 'press_key' } });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('wait_for waits for the element to become visible', async () => {
    const { ctx, session } = makeSkillContext({
      input: { action: 'wait_for', selector: 'date picker' },
    });
    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
    const loc = getSharedLocator(session) as unknown as { waitFor: ReturnType<typeof vi.fn> };
    expect(loc.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }));
  });

  it('wait_for surfaces a clear error when the element never appears', async () => {
    const { ctx, session } = makeSkillContext({
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
    const { ctx } = makeSkillContext({ input: { action: 'wait_for' } });
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
    } as unknown as SkillContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The click landed on the CHILD FRAME's element, not the top page.
    expect(frameLocator.click).toHaveBeenCalled();
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
    } as unknown as SkillContext;

    const result = await new WebBrowserHandler().execute(ctxD);

    // The detached frame's throw must NOT fail the action — it's skipped and the main
    // frame's CSS fallback resolves instead.
    expect(result.success).toBe(true);
    expect(mainClick).toHaveBeenCalled();
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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

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
    } as unknown as SkillContext;

    const result = await new WebBrowserHandler().execute(ctx);
    expect(result.success).toBe(true);
  });
});
