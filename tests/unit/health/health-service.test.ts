import { describe, it, expect, vi } from 'vitest';
import { HealthService } from '../../../src/health/health-service.js';
import { DEFAULT_HEALTH_CONFIG } from '../../../src/config.js';

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

  it('returns degraded when the principal calendar grant probe fails (#1561)', async () => {
    const svc = new HealthService(makeDeps({
      nylasCalendarClient: {
        listCalendars: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 })),
      },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.nylas_calendar).toBe('fail');
  });

  it('nylas_calendar canary fails independently of the email nylas canary (#1561)', async () => {
    const listMessages = vi.fn().mockResolvedValue([]);
    const listCalendars = vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    const svc = new HealthService(makeDeps({
      nylasClient: { listMessages },
      nylasCalendarClient: { listCalendars },
    }) as never);

    const results = await svc.runCanaries();
    const email = results.find((r) => r.name === 'nylas');
    const calendar = results.find((r) => r.name === 'nylas_calendar');
    expect(email?.status).toBe('ok');
    expect(calendar?.status).toBe('fail');
    expect(calendar?.detail).toMatch(/reconnect|grant/i);
  });

  it('nylas_calendar canary omits reconnect guidance for non-auth failures (#1561)', async () => {
    // A 500 is a connectivity/server problem, not a bad grant — reconnect won't help.
    const listCalendars = vi.fn().mockRejectedValue(Object.assign(new Error('Server Error'), { statusCode: 500 }));
    const svc = new HealthService(makeDeps({
      nylasCalendarClient: { listCalendars },
    }) as never);

    const calendar = (await svc.runCanaries()).find((r) => r.name === 'nylas_calendar');
    expect(calendar?.status).toBe('fail');
    expect(calendar?.detail).not.toMatch(/reconnect/i);
    expect(calendar?.detail).toMatch(/connectivity/i);
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
