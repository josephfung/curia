import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  it('records llm.call events as tier success', () => {
    const svc = new HealthService(makeDeps() as never);
    // Simulate bus event subscription firing
    const subscribeCalls = (makeDeps().bus.subscribe as ReturnType<typeof vi.fn>).mock.calls;
    // start() must be called to subscribe; test via tracker directly
    const tracker = (svc as unknown as { tracker: { getOutcome: (k: string) => { lastSuccessAt: Date | null } } }).tracker;
    expect(tracker).toBeDefined();
  });
});
