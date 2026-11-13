import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthService } from '../../../src/health/health-service.js';
import { DEFAULT_HEALTH_CONFIG } from '../../../src/config.js';
import { MissingNylasApiKeyError } from '../../../src/principal-mailboxes/types.js';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    db: { query: vi.fn().mockResolvedValue({}) },
    bus: { subscribe: vi.fn(), publish: vi.fn(), listenerCount: vi.fn().mockReturnValue(5) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scheduler: { lastTickAt: new Date() },
    emailAdapter: undefined,
    signalRpcClient: undefined,
    browserService: undefined,
    mcpSessions: [],
    modelRoutingConfig: {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-8' },
      },
      default_tier: 'standard',
    },
    config: DEFAULT_HEALTH_CONFIG,
    openaiApiKey: undefined,
    ...overrides,
  };
}

describe('HealthService.getStatus()', () => {
  it('returns ok when all critical checks pass', async () => {
    const svc = new HealthService(makeDeps() as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('ok');
    expect(result.checks.db).toBe('ok');
    expect(result.checks.bus).toBe('ok');
    expect(result.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('principal_mailbox_triage: skipped without a heartbeat, ok, or a failure that degrades (R67)', async () => {
    const check = async (inboxTriageHealth?: () => unknown) =>
      new HealthService(makeDeps({ inboxTriageHealth }) as never).getStatus();
    expect((await check()).checks.principal_mailbox_triage).toBe('skipped');
    expect((await check(() => null)).checks.principal_mailbox_triage).toBe('skipped');
    expect((await check(() => ({ ok: true }))).checks.principal_mailbox_triage).toBe('ok');
    const failing = await check(() => ({ ok: false, detail: 'stuck' }));
    expect(failing.checks.principal_mailbox_triage).toBe('fail');
    expect(failing.status).toBe('degraded');
    expect((await check(() => { throw new Error('boom'); })).checks.principal_mailbox_triage).toBe('fail');
  });

  it('returns down when db fails', async () => {
    const svc = new HealthService(makeDeps({
      db: { query: vi.fn().mockRejectedValue(new Error('connection lost')) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('down');
    expect(result.checks.db).toBe('fail');
  });

  it('skips signal/email/browser/slack/sms/voice when not configured', async () => {
    const svc = new HealthService(makeDeps() as never);
    const result = await svc.getStatus();
    expect(result.checks.signal).toBe('skipped');
    expect(result.checks.email).toBe('skipped');
    expect(result.checks.browser).toBe('skipped');
    expect(result.checks.mcp).toEqual({});
    expect(result.checks.nylas_calendar).toBe('skipped');
    expect(result.checks.slack).toBe('skipped');
    expect(result.checks.sms).toBe('skipped');
    expect(result.checks.voice).toBe('skipped');
  });

  it('returns degraded when Slack client never started (#1567)', async () => {
    // Enabled adapter that failed start → fail (not skipped). Disconnect-past-grace
    // is covered in checkSlack unit tests.
    const svc = new HealthService(makeDeps({
      slackClient: {
        isStarted: () => false,
        isSocketConnected: () => false,
      },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.slack).toBe('fail');
  });

  it('returns degraded when SMS webhook is not installed (#1567)', async () => {
    const svc = new HealthService(makeDeps({
      smsHealth: { isWebhookInstalled: () => false },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.sms).toBe('fail');
  });

  it('returns degraded when LiveKit management probe fails (#1567)', async () => {
    const svc = new HealthService(makeDeps({
      voiceLiveKit: { listRooms: vi.fn().mockRejectedValue(new Error('timeout')) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.voice).toBe('fail');
  });

  // #1760. Two separate wiring mistakes are easy to make here and neither is caught
  // by the probe's own unit tests: forgetting to surface the check in `checks`, and
  // forgetting to add it to aggregateStatus's `nonCritical` list — that list is
  // enumerated by hand, so a new key renders a console chip while the overall status
  // dot stays green. That is the exact failure mode #1760 was filed about.
  it('returns degraded when the Signal voice audio socket is dead (#1760)', async () => {
    const svc = new HealthService(makeDeps({
      // Path that cannot connect — stands in for a dead PulseAudio daemon.
      signalPulseSocketPath: '/nonexistent/pulse-shared/native',
    }) as never);
    const result = await svc.getStatus();
    expect(result.checks.signal_voice).toBe('fail');
    expect(result.status).toBe('degraded');
  });

  it('skips the Signal voice check when the call bridge was not constructed (#1760)', async () => {
    // Instances without Signal voice must not show a permanently failing chip.
    const svc = new HealthService(makeDeps({}) as never);
    const result = await svc.getStatus();
    expect(result.checks.signal_voice).toBe('skipped');
    expect(result.status).toBe('ok');
  });

  // #1762 moved checkBrowser from the synchronous block into the awaited Promise.all,
  // because it now round-trips to Chrome. A mis-wire there (an un-awaited promise
  // landing in `checks.browser`) would not be a type error at the call site's edges,
  // and would read as truthy — i.e. permanently healthy. This pins the real value.
  it('returns degraded when the browser probe fails (#1762)', async () => {
    const svc = new HealthService(makeDeps({
      browserService: {
        browserContext: { cookies: vi.fn().mockRejectedValue(new Error('Target closed')) },
      },
    }) as never);
    const result = await svc.getStatus();
    expect(result.checks.browser).toBe('fail');
    expect(result.status).toBe('degraded');
  });

  it('reports ok when the browser answers the probe (#1762)', async () => {
    const svc = new HealthService(makeDeps({
      browserService: { browserContext: { cookies: vi.fn().mockResolvedValue([]) } },
    }) as never);
    const result = await svc.getStatus();
    expect(result.checks.browser).toBe('ok');
  });

  it('reports ok for healthy Slack/SMS/Voice probes (#1567)', async () => {
    const svc = new HealthService(makeDeps({
      slackClient: {
        isStarted: () => true,
        isSocketConnected: () => true,
      },
      smsHealth: { isWebhookInstalled: () => true },
      voiceLiveKit: { listRooms: vi.fn().mockResolvedValue([]) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('ok');
    expect(result.checks.slack).toBe('ok');
    expect(result.checks.sms).toBe('ok');
    expect(result.checks.voice).toBe('ok');
  });

  it('returns degraded when an enabled MCP server booted with 0 tools (#1500)', async () => {
    const svc = new HealthService(makeDeps({
      mcpServerStatuses: new Map([
        ['google-workspace', { status: 'zero_tools' }],
      ]),
      mcpSessions: [{
        serverId: 'google-workspace',
        client: { listTools: vi.fn() },
      }],
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.mcp.google_workspace).toBe('fail');
  });

  it('returns degraded when an enabled MCP server failed to connect (#1500)', async () => {
    const svc = new HealthService(makeDeps({
      mcpServerStatuses: new Map([
        ['google-workspace', { status: 'unavailable', reason: 'connect failed' }],
      ]),
      mcpSessions: [],
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.mcp.google_workspace).toBe('fail');
  });

  it('does not fail health for MCP servers that were not enabled', async () => {
    // Disabled servers are absent from mcpServerStatuses (loader skips them).
    const svc = new HealthService(makeDeps({
      mcpServerStatuses: new Map(),
      mcpSessions: [],
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('ok');
    expect(result.checks.mcp).toEqual({});
  });

  it('returns degraded when the calendar probe through the router fails (#1561)', async () => {
    const svc = new HealthService(makeDeps({
      calendarRouterProbe: {
        liveMailboxIds: vi.fn().mockResolvedValue(['work']),
        listCalendars: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 })),
      },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.nylas_calendar).toBe('fail');
  });

  it('health calendar probe goes through the router, every live mailbox (#2475, SF-I4)', async () => {
    const liveMailboxIds = vi.fn().mockResolvedValue(['work', 'personal']);
    const listCalendars = vi.fn().mockResolvedValue(undefined);
    const svc = new HealthService(makeDeps({ calendarRouterProbe: { liveMailboxIds, listCalendars } }) as never);
    expect((await svc.getStatus()).checks.nylas_calendar).toBe('ok');
    expect(listCalendars.mock.calls.map((c) => c[0])).toEqual(['work', 'personal']);
    // A broken non-default mailbox fails the check.
    listCalendars.mockImplementation(async (id: string) => { if (id === 'personal') throw new Error('revoked'); });
    expect((await svc.getStatus()).checks.nylas_calendar).toBe('fail');
    // No mailbox connected yet: nothing to probe, not a failure.
    liveMailboxIds.mockResolvedValue([]);
    expect((await svc.getStatus()).checks.nylas_calendar).toBe('skipped');
    // No router (no Nylas key or no principal): skipped.
    expect((await new HealthService(makeDeps({}) as never).getStatus()).checks.nylas_calendar).toBe('skipped');
  });

  it('checkCalendarRouter names the failing mailbox and flags an auth failure', async () => {
    const { checkCalendarRouter } = await import('../../../src/health/health-checks.js');
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const r = await checkCalendarRouter({
      liveMailboxIds: async () => ['work', 'personal'],
      listCalendars: async (id) => { if (id === 'personal') throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }); },
    }, log);
    expect(r).toEqual({ status: 'fail', authFailure: true, failedMailboxes: ['personal'] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'personal' }), expect.any(String));
  });

  describe('principal mailbox canaries (#2475)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    function mailbox(id: string, opts: { grant?: unknown; messages?: unknown; calendars?: unknown; isDefault?: boolean } = {}) {
      return {
        view: { id, label: id[0]!.toUpperCase() + id.slice(1), address: `${id}@example.com`, isDefault: opts.isDefault ?? false, triageStartAt: null },
        client: {
          getGrant: opts.grant ?? vi.fn().mockResolvedValue({ email: `${id}@example.com`, provider: 'google' }),
          listMessages: opts.messages ?? vi.fn().mockResolvedValue([]),
        },
        calendar: { listCalendars: opts.calendars ?? vi.fn().mockResolvedValue([]) },
      };
    }
    function mailboxDeps(boxes: ReturnType<typeof mailbox>[], extra: Record<string, unknown> = {}) {
      const principalMailboxes = {
        list: vi.fn().mockResolvedValue(boxes.map((b) => b.view)),
        credentials: vi.fn(async (id: string) => ({ apiKey: 'k', grantId: `g-${id}` })),
        gatewayClient: vi.fn(async (id: string) => boxes.find((b) => b.view.id === id)!.client),
        calendarClient: vi.fn(async (id: string) => boxes.find((b) => b.view.id === id)!.calendar),
        isFallbackActive: vi.fn().mockResolvedValue(false),
        pendingMigrationReason: vi.fn((): string | null => null),
        setPendingMigrationReason: vi.fn(),
      };
      const mailboxOutageNotifier = { record: vi.fn().mockResolvedValue(undefined) };
      return { principalMailboxes, mailboxOutageNotifier, ...extra };
    }

    it('one canary per live mailbox', async () => {
      const boxes = [mailbox('work', { isDefault: true }), mailbox('personal')];
      const svc = new HealthService(makeDeps(mailboxDeps(boxes)) as never);
      const results = await svc.runCanaries();
      const names = results.filter((r) => r.name.startsWith('principal_mailbox:')).map((r) => r.name);
      expect(names).toEqual(['principal_mailbox:work', 'principal_mailbox:personal']);
      expect(results.find((r) => r.name === 'principal_mailbox:work')?.status).toBe('ok');
      expect(results.find((r) => r.name === 'nylas_calendar')).toBeUndefined();
    });

    it('probes the grant, one message and the calendars', async () => {
      const b = mailbox('work', { isDefault: true });
      const svc = new HealthService(makeDeps(mailboxDeps([b])) as never);
      await svc.runCanaries();
      expect(b.client.getGrant).toHaveBeenCalled();
      expect(b.client.listMessages).toHaveBeenCalledWith({ limit: 1 });
      expect(b.calendar.listCalendars).toHaveBeenCalled();
    });

    it('one failing mailbox does not fail the other, and reports to the outage notifier', async () => {
      const bad = mailbox('personal', { calendars: vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 })) });
      const good = mailbox('work', { isDefault: true });
      const deps = mailboxDeps([good, bad]);
      const svc = new HealthService(makeDeps(deps) as never);
      const results = await svc.runCanaries();
      expect(results.find((r) => r.name === 'principal_mailbox:work')?.status).toBe('ok');
      const failed = results.find((r) => r.name === 'principal_mailbox:personal');
      expect(failed?.status).toBe('fail');
      expect(failed?.detail).toMatch(/reconnect/i);
      // Names the console control that does it (R29).
      expect(failed?.detail).toContain('Replace grant');
      expect(failed?.detail).toContain('Settings → Personality → Email & Calendar');
      expect(deps.mailboxOutageNotifier.record).toHaveBeenCalledWith('work', 'Work', true, { authFailure: false });
      expect(deps.mailboxOutageNotifier.record).toHaveBeenCalledWith('personal', 'Personal', false, { authFailure: true });
    });

    it('omits reconnect guidance for non-auth failures and never leaks the error text', async () => {
      const b = mailbox('work', { isDefault: true, messages: vi.fn().mockRejectedValue(Object.assign(new Error('boom grant-abc123'), { statusCode: 500 })) });
      const svc = new HealthService(makeDeps(mailboxDeps([b])) as never);
      const r = (await svc.runCanaries()).find((x) => x.name === 'principal_mailbox:work');
      expect(r?.status).toBe('fail');
      expect(r?.detail).not.toMatch(/reconnect/i);
      expect(r?.detail).not.toContain('grant-abc123');
    });

    it('maps the default mailbox result to the existing nylas_calendar heartbeat', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const config = { ...DEFAULT_HEALTH_CONFIG, heartbeats: { ...DEFAULT_HEALTH_CONFIG.heartbeats, nylas_calendar: 'https://hb.example.com/cal' } };
      const boxes = [mailbox('personal'), mailbox('work', { isDefault: true })];
      const svc = new HealthService(makeDeps({ ...mailboxDeps(boxes), config }) as never);
      await svc.runCanaries();
      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls.filter((u) => u === 'https://hb.example.com/cal')).toHaveLength(1);
    });

    it('does not ping the heartbeat when the default mailbox fails', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const config = { ...DEFAULT_HEALTH_CONFIG, heartbeats: { ...DEFAULT_HEALTH_CONFIG.heartbeats, nylas_calendar: 'https://hb.example.com/cal' } };
      const bad = mailbox('work', { isDefault: true, calendars: vi.fn().mockRejectedValue(new Error('x')) });
      const svc = new HealthService(makeDeps({ ...mailboxDeps([bad]), config }) as never);
      await svc.runCanaries();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports the fallback grant under principal_mailbox:mailbox', async () => {
      const b = mailbox('mailbox', { isDefault: true });
      const deps = mailboxDeps([b]);
      deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
      const svc = new HealthService(makeDeps(deps) as never);
      const names = (await svc.runCanaries()).map((r) => r.name);
      expect(names).toContain('principal_mailbox:mailbox');
    });

    it('retries the deferred migration on the tick and clears the fallback when it migrates', async () => {
      const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
      deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
      const setFallback = vi.fn();
      const retry = vi.fn().mockResolvedValue('migrated');
      const svc = new HealthService(makeDeps({
        ...deps,
        principalMailboxes: { ...deps.principalMailboxes, setFallback },
        retryMailboxMigration: retry,
      }) as never);
      await svc.runCanaries();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(setFallback).toHaveBeenCalledWith(null);
    });

    it('logs the migration outcome only when it changes', async () => {
      const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
      deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
      const retry = vi.fn().mockResolvedValue('deferred');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const svc = new HealthService(makeDeps({
        ...deps,
        logger,
        principalMailboxes: { ...deps.principalMailboxes, setFallback: vi.fn() },
        retryMailboxMigration: retry,
      }) as never);
      await svc.runCanaries();
      await svc.runCanaries();
      const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls]
        .filter((c) => typeof c[1] === 'string' && c[1].includes('Mailbox migration retry'));
      expect(logged).toHaveLength(1);
    });

    it('principalMailboxReady is true once a live mailbox passes its canary', async () => {
      const svc = new HealthService(makeDeps(mailboxDeps([mailbox('work', { isDefault: true })])) as never);
      expect(await svc.principalMailboxReady()).toBe('ready');
    });

    it('reports skipped, and does not notify, when no Nylas API key is configured', async () => {
      const deps = mailboxDeps([mailbox('work', { isDefault: true })]);
      deps.principalMailboxes.gatewayClient.mockRejectedValue(new MissingNylasApiKeyError());
      const svc = new HealthService(makeDeps(deps) as never);
      const r = (await svc.runCanaries()).find((x) => x.name === 'principal_mailbox:work');
      expect(r?.status).toBe('skipped');
      expect(deps.mailboxOutageNotifier.record).not.toHaveBeenCalled();
    });

    it('never logs the grant id when the migration retry throws a Nylas error (R20)', async () => {
      const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
      deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
      const timeout = Object.assign(new Error('timed out'), {
        name: 'NylasSdkTimeoutError', url: 'https://api.us.nylas.com/v3/grants/grant-secret-1',
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const svc = new HealthService(makeDeps({
        ...deps,
        logger,
        principalMailboxes: { ...deps.principalMailboxes, setFallback: vi.fn() },
        retryMailboxMigration: vi.fn().mockRejectedValue(timeout),
      }) as never);
      await svc.runCanaries();
      const warned = logger.warn.mock.calls.find((c) => typeof c[1] === 'string' && c[1].includes('Mailbox migration retry failed'));
      expect(warned).toBeDefined();
      expect(warned![0]).toEqual({ errName: 'NylasSdkTimeoutError' });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('grant-secret-1');
    });

    it('principalMailboxReady re-probes a mailbox whose last result was not ok', async () => {
      const messages = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue([]);
      const svc = new HealthService(makeDeps(mailboxDeps([mailbox('work', { isDefault: true, messages })])) as never);
      expect(await svc.principalMailboxReady()).toBe('pending');
      expect(await svc.principalMailboxReady()).toBe('ready');
      expect(messages).toHaveBeenCalledTimes(2);
    });

    it('principalMailboxReady does not re-probe a mailbox that passed', async () => {
      const b = mailbox('work', { isDefault: true });
      const svc = new HealthService(makeDeps(mailboxDeps([b])) as never);
      await svc.principalMailboxReady();
      await svc.principalMailboxReady();
      expect(b.client.listMessages).toHaveBeenCalledTimes(1);
    });

    it('principalMailboxReady is false when the only mailbox fails', async () => {
      const bad = mailbox('work', { isDefault: true, messages: vi.fn().mockRejectedValue(new Error('x')) });
      const svc = new HealthService(makeDeps(mailboxDeps([bad])) as never);
      expect(await svc.principalMailboxReady()).toBe('pending');
    });

    it('principalMailboxReady re-probes a mailbox whose grant was replaced since it passed', async () => {
      const b = mailbox('work', { isDefault: true });
      const deps = mailboxDeps([b]);
      const svc = new HealthService(makeDeps(deps) as never);
      expect(await svc.principalMailboxReady()).toBe('ready');
      deps.principalMailboxes.credentials.mockImplementation(async () => ({ apiKey: 'k', grantId: 'g-replaced' }));
      const listMessages = b.client.listMessages as ReturnType<typeof vi.fn>;
      listMessages.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
      expect(await svc.principalMailboxReady()).toBe('pending');
      expect(listMessages).toHaveBeenCalledTimes(2);
    });

    it('the probe deadline covers reading the credentials', async () => {
      vi.useFakeTimers();
      try {
        const deps = mailboxDeps([mailbox('work', { isDefault: true })]);
        deps.principalMailboxes.credentials.mockImplementation(() => new Promise(() => {}));
        const svc = new HealthService(makeDeps(deps) as never);
        const done = svc.principalMailboxReady();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await done).toBe('pending');
      } finally {
        vi.useRealTimers();
      }
    });

    it('tells the outage notifier whether the failure was an auth failure', async () => {
      const auth = mailbox('work', { isDefault: true, messages: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { statusCode: 401 })) });
      const other = mailbox('personal', { messages: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { statusCode: 503 })) });
      const deps = mailboxDeps([auth, other]);
      const svc = new HealthService(makeDeps(deps) as never);
      await svc.runCanaries();
      expect(deps.mailboxOutageNotifier.record).toHaveBeenCalledWith('work', 'Work', false, { authFailure: true });
      expect(deps.mailboxOutageNotifier.record).toHaveBeenCalledWith('personal', 'Personal', false, { authFailure: false });
    });

    it('a stalled registry read or migration retry does not hold the later canaries', async () => {
      vi.useFakeTimers();
      try {
        const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
        deps.principalMailboxes.isFallbackActive.mockImplementation(() => new Promise(() => {}));
        deps.principalMailboxes.list.mockImplementation(() => new Promise(() => {}));
        const svc = new HealthService(makeDeps({
          ...deps,
          principalMailboxes: { ...deps.principalMailboxes, setFallback: vi.fn() },
          retryMailboxMigration: vi.fn(),
        }) as never);
        const pending = svc.runCanaries();
        await vi.advanceTimersByTimeAsync(30_000);
        const results = await pending;
        expect(results.find((r) => r.name === 'principal_mailboxes')?.status).toBe('fail');
        expect(results.map((r) => r.name)).toContain('signal');
      } finally {
        vi.useRealTimers();
      }
    });

    it('while the fallback is served, reports principal_mailbox_migration as failing with the reason (silent-failure 5)', async () => {
      const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
      deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
      const setPendingMigrationReason = vi.fn();
      deps.principalMailboxes.pendingMigrationReason.mockReturnValue('The flat grant is not a Google account');
      const svc = new HealthService(makeDeps({
        ...deps,
        principalMailboxes: { ...deps.principalMailboxes, setFallback: vi.fn(), setPendingMigrationReason },
        retryMailboxMigration: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'NylasApiError', statusCode: 401 })),
      }) as never);
      const r = (await svc.runCanaries()).find((x) => x.name === 'principal_mailbox_migration');
      expect(r?.status).toBe('fail');
      expect(r?.detail).toContain('The flat grant is not a Google account');
      expect(setPendingMigrationReason).toHaveBeenCalledWith(expect.stringContaining('NylasApiError, HTTP 401'));
    });

    it('a default mailbox that answers is ok and pings the heartbeat: calendar never waits for a restart (#2475)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      const config = { ...DEFAULT_HEALTH_CONFIG, heartbeats: { ...DEFAULT_HEALTH_CONFIG.heartbeats, nylas_calendar: 'https://hb.example.com/cal' } };
      const deps = mailboxDeps([mailbox('work', { isDefault: true })]);
      const svc = new HealthService(makeDeps({ ...deps, config }) as never);
      const r = (await svc.runCanaries()).find((x) => x.name === 'principal_mailbox:work');
      expect(r?.status).toBe('ok');
      expect(fetchMock).toHaveBeenCalledWith('https://hb.example.com/cal');
      expect(await svc.principalMailboxReady()).toBe('ready');
    });

    it('setup-status probes never send an outage email (silent-failure 13)', async () => {
      const deps = mailboxDeps([mailbox('work', { isDefault: true, messages: vi.fn().mockRejectedValue(new Error('x')) })]);
      const svc = new HealthService(makeDeps(deps) as never);
      expect(await svc.principalMailboxReady()).toBe('pending');
      expect(deps.mailboxOutageNotifier.record).not.toHaveBeenCalled();
    });

    it('principalMailboxReady is pending once every mailbox was removed (F2)', async () => {
      const svc = new HealthService(makeDeps(mailboxDeps([])) as never);
      expect(await svc.principalMailboxReady()).toBe('pending');
    });

    it('names a probe timeout as such (silent-failure 8)', async () => {
      vi.useFakeTimers();
      try {
        const b = mailbox('work', { isDefault: true, messages: vi.fn(() => new Promise(() => {})) });
        const svc = new HealthService(makeDeps(mailboxDeps([b])) as never);
        const pending = svc.runCanaries();
        await vi.advanceTimersByTimeAsync(10_000);
        const r = (await pending).find((x) => x.name === 'principal_mailbox:work');
        expect(r?.detail).toContain('timed out after 5 s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a migration retry that outlives its deadline is joined, never run twice at once', async () => {
      vi.useFakeTimers();
      try {
        const deps = mailboxDeps([mailbox('mailbox', { isDefault: true })]);
        deps.principalMailboxes.isFallbackActive.mockResolvedValue(true);
        const retry = vi.fn(() => new Promise<never>(() => {}));
        const svc = new HealthService(makeDeps({
          ...deps,
          principalMailboxes: { ...deps.principalMailboxes, setFallback: vi.fn() },
          retryMailboxMigration: retry,
        }) as never);
        for (let i = 0; i < 2; i++) {
          const run = svc.runCanaries();
          await vi.advanceTimersByTimeAsync(30_000);
          await run;
        }
        expect(retry).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a stalled outage notice never holds the canaries, and is not sent twice at once', async () => {
      const bad = mailbox('work', { isDefault: true, messages: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { statusCode: 401 })) });
      const deps = mailboxDeps([bad]);
      deps.mailboxOutageNotifier.record.mockImplementation(() => new Promise(() => {}));
      const svc = new HealthService(makeDeps(deps) as never);
      const first = await svc.runCanaries();
      expect(first.map((r) => r.name)).toContain('signal');
      await svc.runCanaries();
      expect(deps.mailboxOutageNotifier.record).toHaveBeenCalledTimes(1);
    });
  });

  it('returns degraded when a non-critical check fails', async () => {
    const svc = new HealthService(makeDeps({
      signalRpcClient: { listGroups: vi.fn().mockRejectedValue(new Error('EACCES')) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.signal).toBe('fail');
    expect(result.checks.db).toBe('ok');
  });
});

// #2242: both canaries were hard-wired to `skipped` at bootstrap, so their heartbeats
// never fired. They now make one cheap live call each and only report ok on success.
describe('HealthService google_workspace canary (#2242)', () => {
  const FIXED = { user_google_email: 'curia@example.com' };

  function gwsDeps(callTool: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
    return makeDeps({
      mcpServerStatuses: new Map([['google-workspace', { status: 'ok', toolCount: 30 }]]),
      mcpSessions: [{ serverId: 'google-workspace', client: { callTool } }],
      mcpFixedInputs: new Map([['google-workspace', FIXED]]),
      ...overrides,
    });
  }

  async function gwsResult(deps: ReturnType<typeof makeDeps>) {
    const results = await new HealthService(deps as never).runCanaries();
    return results.find((r) => r.name === 'google_workspace');
  }

  it('is ok when a one-item Drive listing succeeds, sending the resolved fixed inputs', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Found 1 item' }] });
    const result = await gwsResult(gwsDeps(callTool));
    expect(result?.status).toBe('ok');
    expect(callTool).toHaveBeenCalledWith(
      { name: 'list_drive_items', arguments: { ...FIXED, page_size: 1 } },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('keeps page_size at 1 even when a fixed input sets it', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    await gwsResult(gwsDeps(callTool, {
      mcpFixedInputs: new Map([['google-workspace', { ...FIXED, page_size: '100' }]]),
    }));
    expect(callTool.mock.calls[0]![0].arguments).toEqual({ ...FIXED, page_size: 1 });
  });

  it('pings the google_workspace heartbeat when the probe succeeds', async () => {
    const heartbeat = 'https://uptime.example.com/api/v1/heartbeat/gws';
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const callTool = vi.fn().mockResolvedValue({ content: [] });
      await new HealthService(gwsDeps(callTool, {
        config: {
          ...DEFAULT_HEALTH_CONFIG,
          heartbeats: { ...DEFAULT_HEALTH_CONFIG.heartbeats, google_workspace: heartbeat },
        },
      }) as never).runCanaries();
      expect(fetchMock).toHaveBeenCalledWith(heartbeat);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails with a fixed detail, not the server text, when the tool returns isError', async () => {
    // The server's error text can echo fixed_inputs back, and canary detail is logged.
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'invalid_grant for curia@example.com' }],
    });
    const result = await gwsResult(gwsDeps(callTool));
    expect(result?.status).toBe('fail');
    expect(result?.detail).toMatch(/list_drive_items/);
    expect(result?.detail).not.toMatch(/curia@example\.com|invalid_grant/);
  });

  it('fails with the error class only when the call throws or times out', async () => {
    const err = Object.assign(new Error('Request timed out for curia@example.com'), { name: 'McpError' });
    const callTool = vi.fn().mockRejectedValue(err);
    const result = await gwsResult(gwsDeps(callTool));
    expect(result?.status).toBe('fail');
    expect(result?.detail).toMatch(/McpError/);
    expect(result?.detail).not.toMatch(/curia@example\.com/);
  });

  it('still fails on a zero_tools or unavailable boot without calling the server', async () => {
    const callTool = vi.fn();
    for (const boot of [{ status: 'zero_tools' }, { status: 'unavailable', reason: 'connect failed' }]) {
      const result = await gwsResult(gwsDeps(callTool, {
        mcpServerStatuses: new Map([['google-workspace', boot]]),
      }));
      expect(result?.status).toBe('fail');
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it('is skipped when the server is not enabled', async () => {
    const result = await gwsResult(makeDeps());
    expect(result?.status).toBe('skipped');
  });
});

describe('HealthService tavily canary (#2242)', () => {
  const USAGE_URL = 'https://api.tavily.com/usage';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function tavilyResult(deps: ReturnType<typeof makeDeps>) {
    const results = await new HealthService(deps as never).runCanaries();
    return results.find((r) => r.name === 'tavily');
  }

  it('reports keyless mode, without probing, when no key resolves (#2445)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await tavilyResult(makeDeps({ resolveTavilyApiKey: vi.fn().mockResolvedValue(null) }));
    expect(result?.status).toBe('skipped');
    expect(result?.detail).toMatch(/keyless/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is ok when the usage endpoint accepts the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await tavilyResult(makeDeps({ resolveTavilyApiKey: vi.fn().mockResolvedValue('tvly-good') }));
    expect(result?.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(USAGE_URL, expect.objectContaining({
      headers: { Authorization: 'Bearer tvly-good' },
    }));
  });

  it('fails when the usage endpoint rejects the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const result = await tavilyResult(makeDeps({ resolveTavilyApiKey: vi.fn().mockResolvedValue('tvly-revoked') }));
    expect(result?.status).toBe('fail');
    expect(result?.detail).toMatch(/401/);
    expect(result?.detail).not.toMatch(/tvly-revoked/);
  });

  it('fails when the usage request errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' })));
    const result = await tavilyResult(makeDeps({ resolveTavilyApiKey: vi.fn().mockResolvedValue('tvly-good') }));
    expect(result?.status).toBe('fail');
  });
});

describe('HealthService LLM outcome tracking', () => {
  it('records a successful llm.call event for the matching tier after start()', async () => {
    const deps = makeDeps();
    const svc = new HealthService(deps as never);
    await svc.start();

    // Retrieve the llm.call subscriber that start() registered on the mock bus.
    const subscribeMock = deps.bus.subscribe as ReturnType<typeof vi.fn>;
    const llmCallArgs = subscribeMock.mock.calls.find((args: unknown[]) => args[0] === 'llm.call');
    expect(llmCallArgs).toBeDefined();
    const handler = llmCallArgs![2] as (event: unknown) => void;

    // Fire a synthetic llm.call event for the 'fast' tier model (claude-haiku-4-5).
    // The model string must match modelRoutingConfig.tiers.fast.model for the tier
    // reverse-map lookup in HealthService to succeed.
    handler({ payload: { requestedModel: 'claude-haiku-4-5' } });

    // The LlmOutcomeTracker should now record a success — no billed probe calls.
    const tracker = (svc as unknown as {
      tracker: { getOutcome: (key: string) => { lastSuccessAt: Date | null; lastErrorAt: Date | null } }
    }).tracker;
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastSuccessAt).not.toBeNull();
    expect(outcome.lastErrorAt).toBeNull();
  });
});

describe('HealthService embeddings canary', () => {
  it('runs on the embedding service entity memory uses, with or without an OpenAI key', async () => {
    const svc = new HealthService(makeDeps({ embeddingsEnabled: true, openaiApiKey: undefined }) as never);
    const results = await svc.runCanaries();
    expect(results.find((r) => r.name === 'embeddings')?.status).not.toBe('skipped');
  });

  it('is skipped when entity memory has no embedding service, even with an OpenAI key', async () => {
    const svc = new HealthService(makeDeps({ embeddingsEnabled: false, openaiApiKey: 'sk-test' }) as never);
    const results = await svc.runCanaries();
    expect(results.find((r) => r.name === 'embeddings')?.status).toBe('skipped');
    expect(results.find((r) => r.name === 'image_gen')?.status).not.toBe('skipped');
  });
});
