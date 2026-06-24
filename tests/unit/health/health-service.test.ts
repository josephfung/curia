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

  it('skips signal/email/browser when not configured', async () => {
    const svc = new HealthService(makeDeps() as never);
    const result = await svc.getStatus();
    expect(result.checks.signal).toBe('skipped');
    expect(result.checks.email).toBe('skipped');
    expect(result.checks.browser).toBe('skipped');
    expect(result.checks.mcp.google_workspace).toBe('skipped');
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
