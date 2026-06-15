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
 */
function makeMockPage(content: string, fill: ReturnType<typeof vi.fn>, url = 'https://aeroplan.com/account') {
  const locator = {
    count: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockReturnThis(),
    fill,
    click: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
  return {
    url: vi.fn().mockReturnValue(url),
    evaluate: vi.fn().mockResolvedValue(content),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
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
