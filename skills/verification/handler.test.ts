import { describe, it, expect, vi, type Mock } from 'vitest';
import pino from 'pino';
import { VerificationToolHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { Verification } from '../../src/verification/types.js';
import type { VerificationRuntime } from '../../src/verification/index.js';
import { registrableDomain } from '../../src/verification/domain.js';
import { DEFAULT_IDENTITY_PROVIDER_DOMAINS } from '../../src/config.js';

const silentLog = pino({ level: 'silent' });
const SESSION = 'sess-1';
const TASK_ID = '11111111-2222-4333-8444-555555555555';

function makeVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: 'ver-1',
    purpose: 'sign_in',
    kind: 'code',
    delivery: 'email',
    site: 'aircanada.com',
    pageDomain: 'b2clogin.com',
    browserSessionId: SESSION,
    taskId: null,
    conversationId: null,
    status: 'pending',
    requestedAt: new Date('2026-10-19T15:00:00Z'),
    expiresAt: new Date('2026-10-19T15:10:00Z'),
    resolvedAt: null,
    metadata: {},
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<VerificationRuntime> = {}) {
  const runtime = {
    service: {
      config: {
        emailWaitSeconds: 180,
        identityProviderDomains: [...DEFAULT_IDENTITY_PROVIDER_DOMAINS],
      },
    },
    open: vi.fn(async (input: { site: string; pageDomain: string; delivery: Verification['delivery'] }) => ({
      // Mirror the service: site and pageDomain are stored as registrable domains.
      verification: makeVerification({
        site: registrableDomain(input.site)!,
        pageDomain: registrableDomain(input.pageDomain)!,
        delivery: input.delivery,
      }),
      reused: false,
    })),
    close: vi.fn(async (_id: string, status: 'satisfied' | 'abandoned') =>
      makeVerification({ status, resolvedAt: new Date('2026-10-19T15:05:00Z') }),
    ),
    listActive: vi.fn(async () => [makeVerification()]),
    askChannel: vi.fn(() => 'signal'),
    tracker: { closed: vi.fn() },
    ...overrides,
  };
  return runtime as unknown as VerificationRuntime & {
    open: Mock;
    close: Mock;
    tracker: { closed: Mock };
  };
}

/** A frame whose in-page verification detection reports `signals`. */
function fakeFrame(url: string, signals: string[] = []) {
  return { url: () => url, evaluate: vi.fn(async () => signals) };
}

/**
 * A session whose top page is `url`. `mainSignals` is what detection finds in the main
 * frame; `childFrames` are the page's other frames.
 */
function makeBrowser(
  url = 'https://aircanada.b2clogin.com/signin/verify',
  mainSignals: string[] = [],
  childFrames: Array<ReturnType<typeof fakeFrame>> = [],
) {
  const mainFrame = fakeFrame(url, mainSignals);
  const page = { url: () => url, mainFrame: () => mainFrame, frames: () => [mainFrame, ...childFrames] };
  const session = { page, keepWarm: false };
  const service = {
    getSession: vi.fn((id: string) => (id === SESSION ? session : undefined)),
  };
  return { service, session };
}

function makeCtx(
  input: Record<string, unknown>,
  runtime: VerificationRuntime,
  browser = makeBrowser(),
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    conversationId: 'conv-1',
    timezone: 'America/Toronto',
    verification: runtime,
    browserService: browser.service,
    ...overrides,
  } as unknown as ToolContext;
}

type Data = Record<string, unknown>;

describe('verification tool', () => {
  it('open derives page_domain b2clogin.com from the session url and returns ask_channel', async () => {
    const runtime = makeRuntime();
    const browser = makeBrowser();
    const result = await new VerificationToolHandler().execute(
      makeCtx(
        { action: 'open', delivery: 'sms', site: 'https://www.aircanada.com/', browser_session_id: SESSION, task_id: TASK_ID },
        runtime,
        browser,
      ),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Data;
    expect(data.page_domain).toBe('b2clogin.com');
    expect(data.ask_channel).toBe('signal');
    expect(data.verification_id).toBe('ver-1');
    expect(data.delivery).toBe('sms');
    expect(data.reused).toBe(false);
    expect(data.email_wait_seconds).toBe(180);
    expect(String(data.expires_at)).toMatch(/-0[45]:00$/);
    expect(typeof data.displayTimezone).toBe('string');
    expect(runtime.open).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'sign_in',
        kind: 'code',
        delivery: 'sms',
        browserSessionId: SESSION,
        taskId: TASK_ID,
        conversationId: 'conv-1',
        pageDomain: 'https://aircanada.b2clogin.com/signin/verify',
      }),
    );
  });

  describe('page_domain when the code input lives in a child frame', () => {
    const IDP_FRAME = 'https://manulife.b2clogin.com/mfa';
    const input = { action: 'open', delivery: 'sms', site: 'manulife.ca', browser_session_id: SESSION };

    it('takes the child frame holding the code input', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [
        fakeFrame('https://ads.adnetwork.com/slot', []),
        fakeFrame(IDP_FRAME, ['one-time-code-input']),
      ]);
      const result = await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));

      expect(result.success).toBe(true);
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: IDP_FRAME }));
      if (result.success) expect((result.data as Data).page_domain).toBe('b2clogin.com');
    });

    it('also recognises a short numeric input with code wording', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [
        fakeFrame(IDP_FRAME, ['short-numeric-input-with-code-wording']),
      ]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: IDP_FRAME }));
    });

    it('keeps the top-level url when the main frame holds the code input', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', ['one-time-code-input'], [
        fakeFrame(IDP_FRAME, ['one-time-code-input']),
      ]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
    });

    it('keeps the top-level url when no frame holds a code input (a delivery choice is not one)', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame(IDP_FRAME, ['delivery-choice'])]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
    });

    it('keeps the top-level url for a third-party iframe with a code input (neither the site nor an identity provider)', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame('https://ads.example/slot', ['one-time-code-input'])]);
      const result = await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(result.success).toBe(true);
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
      if (result.success) expect((result.data as Data).page_domain).toBe('manulife.ca');
    });

    it('never lets the model\'s site argument make a third-party iframe the page_domain', async () => {
      // A confused or prompt-injected coordinator names the ad network as the site.
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame('https://ads.example/slot', ['one-time-code-input'])]);
      await new VerificationToolHandler().execute(
        makeCtx({ ...input, site: 'ads.example' }, runtime, browser),
      );
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
    });

    it('takes a same-site child frame holding the code input', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame('https://login.manulife.ca/otp', ['one-time-code-input'])]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://login.manulife.ca/otp' }));
    });

    it('keeps the top-level url when more than one child frame qualifies', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [
        fakeFrame(IDP_FRAME, ['one-time-code-input']),
        fakeFrame('https://login.manulife.ca/otp', ['one-time-code-input']),
      ]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
    });

    it('trusts only the configured identity providers', async () => {
      const runtime = makeRuntime();
      (runtime.service.config as { identityProviderDomains: string[] }).identityProviderDomains = ['okta.com'];
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame(IDP_FRAME, ['one-time-code-input'])]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));

      const okta = makeRuntime();
      (okta.service.config as { identityProviderDomains: string[] }).identityProviderDomains = ['okta.com'];
      const oktaFrame = 'https://manulife.okta.com/mfa';
      await new VerificationToolHandler().execute(
        makeCtx(input, okta, makeBrowser('https://www.manulife.ca/signin', [], [fakeFrame(oktaFrame, ['one-time-code-input'])])),
      );
      expect(okta.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: oktaFrame }));
    });

    it('ignores a child frame with no registrable domain', async () => {
      const runtime = makeRuntime();
      const browser = makeBrowser('https://www.manulife.ca/signin', [], [
        fakeFrame('http://10.0.0.5/otp', ['one-time-code-input']),
        fakeFrame('about:srcdoc', ['one-time-code-input']),
      ]);
      await new VerificationToolHandler().execute(makeCtx(input, runtime, browser));
      expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ pageDomain: 'https://www.manulife.ca/signin' }));
    });
  });

  it('open with email delivery says to delegate the read to ceo-inbox, not email-list (#2201)', async () => {
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION }, makeRuntime()),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const nextStep = String((result.data as Data).next_step);
    expect(nextStep).toMatch(/ceo-inbox/);
    expect(nextStep).toMatch(/email-list/);
    expect(nextStep).toContain(SESSION);
    expect(nextStep).toContain('2026-10-19T11:00:00.000-04:00'); // requested_at, local time
  });

  it('open with sms delivery says to ask the principal on the ask channel', async () => {
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'sms', site: 'aircanada.com', browser_session_id: SESSION }, makeRuntime()),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const nextStep = String((result.data as Data).next_step);
    expect(nextStep).toMatch(/on signal/);
    expect(nextStep).not.toMatch(/ceo-inbox/);
  });

  it('open pins the browser session warm', async () => {
    const runtime = makeRuntime();
    const browser = makeBrowser();
    await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION }, runtime, browser),
    );
    expect(browser.session.keepWarm).toBe(true);
  });

  it('open with an unknown browser_session_id fails with a message saying the session is gone', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: 'nope' }, runtime),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/session is gone|no longer exists|expired/i);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('open twice for the same site returns reused: true and the same verification_id', async () => {
    const existing = makeVerification();
    const runtime = makeRuntime({
      open: vi.fn(async () => ({ verification: existing, reused: true })),
    } as Partial<VerificationRuntime>);
    const handler = new VerificationToolHandler();
    const input = { action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION };
    const first = await handler.execute(makeCtx(input, runtime));
    const second = await handler.execute(makeCtx(input, runtime));
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect((second.data as Data).reused).toBe(true);
    expect((second.data as Data).verification_id).toBe((first.data as Data).verification_id);
  });

  it('open for another task\'s site returns the fresh row, reused: false, and says the old one was abandoned', async () => {
    const OTHER_TASK = '99999999-8888-4777-8666-555555555555';
    const fresh = makeVerification({ id: 'ver-new', taskId: TASK_ID });
    const old = makeVerification({ id: 'ver-old', taskId: OTHER_TASK, status: 'abandoned', resolvedAt: new Date('2026-10-19T15:01:00Z') });
    const runtime = makeRuntime({
      open: vi.fn(async () => ({ verification: fresh, reused: false, superseded: old })),
    } as Partial<VerificationRuntime>);
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'sms', site: 'aircanada.com', browser_session_id: SESSION, task_id: TASK_ID }, runtime),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Data;
    expect(data.verification_id).toBe('ver-new');
    expect(data.reused).toBe(false);
    expect(data.superseded).toEqual({ verification_id: 'ver-old', task_id: OTHER_TASK, status: 'abandoned' });
    expect(String(data.note)).toContain('abandoned');
    expect(String(data.note)).toContain(OTHER_TASK);
  });

  it('open without a superseded row carries no superseded field or note', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'sms', site: 'aircanada.com', browser_session_id: SESSION }, runtime),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data as Data).not.toHaveProperty('superseded');
    expect(result.data as Data).not.toHaveProperty('note');
  });

  it('open rejects a site with no registrable domain before touching the runtime', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'localhost', browser_session_id: SESSION }, runtime),
    );
    expect(result.success).toBe(false);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('open rejects a session that is not on a website page', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION }, runtime, makeBrowser('about:blank')),
    );
    expect(result.success).toBe(false);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('open turns an unexpected runtime failure into a clean skill error without pinning the session', async () => {
    const runtime = makeRuntime({
      open: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as Partial<VerificationRuntime>);
    const browser = makeBrowser();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION }, runtime, browser),
    );
    expect(result.success).toBe(false);
    expect(browser.session.keepWarm).toBe(false);
  });

  it('satisfy closes the row and calls tracker.closed', async () => {
    const runtime = makeRuntime();
    // The runtime's close owns the tracker call; model it faithfully so the test
    // proves the handler goes through runtime.close and does not skip it.
    runtime.close.mockImplementation(async (id: string, status: 'satisfied' | 'abandoned') => {
      runtime.tracker.closed(id);
      return makeVerification({ status, resolvedAt: new Date('2026-10-19T15:05:00Z') });
    });
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'satisfy', verification_id: 'ver-1' }, runtime),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(runtime.close).toHaveBeenCalledWith('ver-1', 'satisfied');
    expect(runtime.tracker.closed).toHaveBeenCalledTimes(1);
    expect(runtime.tracker.closed).toHaveBeenCalledWith('ver-1');
    expect((result.data as Data).status).toBe('satisfied');
  });

  it('abandon closes with status abandoned', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'abandon', verification_id: 'ver-1' }, runtime),
    );
    expect(result.success).toBe(true);
    expect(runtime.close).toHaveBeenCalledWith('ver-1', 'abandoned');
  });

  it('satisfy requires a verification_id and reports an unknown one', async () => {
    const runtime = makeRuntime({ close: vi.fn(async () => null) } as Partial<VerificationRuntime>);
    const handler = new VerificationToolHandler();
    const missing = await handler.execute(makeCtx({ action: 'satisfy' }, runtime));
    expect(missing.success).toBe(false);
    const unknown = await handler.execute(makeCtx({ action: 'satisfy', verification_id: 'zzz' }, runtime));
    expect(unknown.success).toBe(false);
    if (unknown.success) return;
    expect(unknown.error).toMatch(/not found/i);
  });

  it('list maps active verifications to the same shape', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(makeCtx({ action: 'list' }, runtime));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { verifications: Data[] };
    expect(data.verifications).toHaveLength(1);
    expect(data.verifications[0]).toMatchObject({
      verification_id: 'ver-1',
      site: 'aircanada.com',
      page_domain: 'b2clogin.com',
      delivery: 'email',
      status: 'pending',
    });
  });

  it('rejects delivery other than email|sms|app', async () => {
    const runtime = makeRuntime();
    const result = await new VerificationToolHandler().execute(
      makeCtx({ action: 'open', delivery: 'carrier-pigeon', site: 'aircanada.com', browser_session_id: SESSION }, runtime),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/email\|sms\|app/);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID task_id, a missing site, and an unknown action', async () => {
    const runtime = makeRuntime();
    const handler = new VerificationToolHandler();
    const base = { action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION };
    expect((await handler.execute(makeCtx({ ...base, task_id: 'not-a-uuid' }, runtime))).success).toBe(false);
    expect((await handler.execute(makeCtx({ ...base, site: undefined }, runtime))).success).toBe(false);
    expect((await handler.execute(makeCtx({ ...base, browser_session_id: undefined }, runtime))).success).toBe(false);
    expect((await handler.execute(makeCtx({ action: 'explode' }, runtime))).success).toBe(false);
    expect(runtime.open).not.toHaveBeenCalled();
  });

  it('honours expires_in_minutes and rejects non-positive values', async () => {
    const runtime = makeRuntime();
    const handler = new VerificationToolHandler();
    const base = { action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION };
    const before = Date.now();
    await handler.execute(makeCtx({ ...base, expires_in_minutes: 30 }, runtime));
    const call = runtime.open.mock.calls[0]![0] as unknown as { expiresAt: Date };
    expect(call.expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect((await handler.execute(makeCtx({ ...base, expires_in_minutes: 0 }, runtime))).success).toBe(false);
  });

  it('fails cleanly when the verification runtime or browser service is unavailable', async () => {
    const handler = new VerificationToolHandler();
    const noRuntime = await handler.execute(
      makeCtx({ action: 'list' }, makeRuntime(), makeBrowser(), { verification: undefined }),
    );
    expect(noRuntime.success).toBe(false);
    const noBrowser = await handler.execute(
      makeCtx({ action: 'open', delivery: 'email', site: 'aircanada.com', browser_session_id: SESSION }, makeRuntime(), makeBrowser(), {
        browserService: undefined,
      }),
    );
    expect(noBrowser.success).toBe(false);
  });
});
