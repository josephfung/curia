import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatUptime,
  flattenHealthChecks,
  healthCheckPillClass,
  healthStatusMeta,
  isHealthResponse,
  fetchHealth,
  fetchAttention,
  fetchActivity,
  aggregateAttention,
  mapDirective,
  getGreeting,
  type SceneDirective,
} from './dashboard-utils.js';

// Minimal fetch mock mirroring api.test.ts — returns a Response-like object.
function mockFetch(status: number, body: unknown, ct = 'application/json') {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === 'content-type' ? ct : null) },
    json: () => Promise.resolve(body),
  });
}

// URL-dispatching mock for the multi-endpoint fetchers. Keys are matched with
// String(url).includes(key), so pass full query strings for the two jobs calls.
interface RouteResponse { status?: number; body: unknown; ct?: string }
function mockFetchByUrl(routes: Record<string, RouteResponse>) {
  return vi.fn().mockImplementation((url: string) => {
    const key = Object.keys(routes).find(k => String(url).includes(k));
    const r: RouteResponse = key ? routes[key]! : { status: 404, body: {} };
    const status = r.status ?? 200;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h: string) => (h === 'content-type' ? (r.ct ?? 'application/json') : null) },
      json: () => Promise.resolve(r.body),
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('formatUptime', () => {
  it('formats days/hours/minutes', () => {
    // 6d 14h 22m = 6*86400 + 14*3600 + 22*60 = 570120s
    expect(formatUptime(570_120)).toBe('6d 14h 22m');
  });
  it('formats a short uptime with zero days/hours', () => {
    expect(formatUptime(183)).toBe('0d 0h 3m');
  });
  it('renders unknown for the -1 internal-error sentinel', () => {
    expect(formatUptime(-1)).toBe('unknown');
  });
  it('renders unknown for non-finite input', () => {
    expect(formatUptime(Number.NaN)).toBe('unknown');
  });
});

describe('flattenHealthChecks', () => {
  it('flattens top-level checks and expands nested mcp.*', () => {
    const pills = flattenHealthChecks({
      db: 'ok',
      bus: 'ok',
      signal: 'skipped',
      mcp: { google_workspace: 'fail', github: 'ok' },
    });
    expect(pills).toEqual([
      { name: 'db', result: 'ok' },
      { name: 'bus', result: 'ok' },
      { name: 'signal', result: 'skipped' },
      { name: 'mcp.google_workspace', result: 'fail' },
      { name: 'mcp.github', result: 'ok' },
    ]);
  });
});

describe('healthCheckPillClass', () => {
  it('maps results to existing status-pill modifiers', () => {
    expect(healthCheckPillClass('ok')).toBe('confirmed');
    expect(healthCheckPillClass('fail')).toBe('blocked');
    expect(healthCheckPillClass('skipped')).toBe('');
  });
});

describe('healthStatusMeta', () => {
  it('maps the traffic-light status to label + tone', () => {
    expect(healthStatusMeta('ok')).toEqual({ label: 'All systems nominal', tone: 'ok' });
    expect(healthStatusMeta('degraded')).toEqual({ label: 'Degraded', tone: 'warn' });
    expect(healthStatusMeta('down')).toEqual({ label: 'Down', tone: 'danger' });
  });
});

describe('isHealthResponse', () => {
  it('accepts a health-shaped body', () => {
    expect(isHealthResponse({ status: 'down', uptime_s: 3, checks: { db: 'fail' } })).toBe(true);
  });
  it('rejects a non-health body', () => {
    expect(isHealthResponse({ error: 'boom' })).toBe(false);
    expect(isHealthResponse(null)).toBe(false);
    expect(isHealthResponse('nope')).toBe(false);
  });
});

describe('fetchHealth — 503-as-data branch', () => {
  it('treats a 503 with a health-shaped body as data (Down), not an error', async () => {
    const body = { status: 'down', uptime_s: 3, checks: { db: 'fail', bus: 'ok' } };
    vi.stubGlobal('fetch', mockFetch(503, body));
    const result = await fetchHealth();
    expect(result.status).toBe('down');
    expect(result.uptime_s).toBe(3);
  });
  it('returns the body on a normal 200', async () => {
    const body = { status: 'ok', uptime_s: 100, checks: { db: 'ok' } };
    vi.stubGlobal('fetch', mockFetch(200, body));
    expect((await fetchHealth()).status).toBe('ok');
  });
  it('throws on a JSON 503 whose body is not health-shaped', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'gateway' }));
    await expect(fetchHealth()).rejects.toThrow(/unexpected response/);
  });
  it('throws HTTP 503 on a non-JSON 503 (e.g. a gateway HTML page)', async () => {
    vi.stubGlobal('fetch', mockFetch(503, '<html>bad gateway</html>', 'text/html'));
    await expect(fetchHealth()).rejects.toThrow(/HTTP 503/);
  });
  it('throws on a 500', async () => {
    vi.stubGlobal('fetch', mockFetch(500, {}));
    await expect(fetchHealth()).rejects.toThrow(/HTTP 500/);
  });
});

describe('aggregateAttention', () => {
  it('returns an empty list when nothing needs attention', () => {
    expect(
      aggregateAttention({
        failedJobs: [],
        suspendedJobs: [],
        channels: [
          { name: 'http', state: 'enabled', isToggleable: false },
          { name: 'slack', state: 'enabled', isToggleable: true },
          { name: 'signal', state: 'uninstalled', isToggleable: true }, // not started ≠ attention
        ],
        emailAccounts: [{ name: 'ops', selfEmail: 'ops@example.com', hasGrant: true }],
      }),
    ).toEqual([]);
  });

  it('aggregates failed + suspended jobs, disconnected channels, and missing grants', () => {
    const items = aggregateAttention({
      failedJobs: [
        { id: '1', agentId: 'digest.weekly', status: 'failed' },
        { id: '2', agentId: 'crm.sync', status: 'failed' },
      ],
      suspendedJobs: [{ id: '3', agentId: 'contract.review', status: 'suspended' }],
      channels: [
        { name: 'slack', state: 'installed', isToggleable: true }, // configured, not enabled
        { name: 'signal', state: 'uninstalled', isToggleable: true }, // ignored
      ],
      emailAccounts: [{ name: 'ops', selfEmail: 'ops@example.com', hasGrant: false }],
    });

    expect(items).toEqual([
      { key: 'jobs-failed', title: '2 jobs failed', detail: 'digest.weekly · crm.sync', tone: 'danger', to: '/jobs' },
      { key: 'jobs-suspended', title: '1 job suspended', detail: 'contract.review', tone: 'warn', to: '/jobs' },
      { key: 'channel-slack', title: 'slack channel not enabled', detail: 'Configured but not enabled', tone: 'warn', to: '/channels' },
      { key: 'email-ops', title: 'ops@example.com missing grant', detail: 'No mail grant connected', tone: 'danger', to: '/channels' },
    ]);
  });

  it('singularises the job count and truncates a long agent list', () => {
    const failed = aggregateAttention({
      failedJobs: [
        { id: '1', agentId: 'a', status: 'failed' },
        { id: '2', agentId: 'b', status: 'failed' },
        { id: '3', agentId: 'c', status: 'failed' },
        { id: '4', agentId: 'd', status: 'failed' },
      ],
      suspendedJobs: [],
      channels: [],
      emailAccounts: [],
    });
    expect(failed[0]?.title).toBe('4 jobs failed');
    expect(failed[0]?.detail).toBe('a · b · c +1 more');
  });
});

describe('mapDirective', () => {
  const base = { id: 'x', logicalTs: 1000 };

  it('maps agent lifecycle directives', () => {
    expect(mapDirective({ ...base, kind: 'agent.state', agentId: 'analyst', state: 'active' })).toEqual({
      id: 'x', logicalTs: 1000, actor: 'analyst', text: 'started working.',
    });
    expect(mapDirective({ ...base, kind: 'agent.state', agentId: 'analyst', state: 'error' })?.text).toBe('ran into an error.');
    expect(mapDirective({ ...base, kind: 'agent.walk', agentId: 'coordinator', targetAgentId: 'analyst' })?.text)
      .toBe('handed off to analyst.');
  });

  it('maps speak with and without content', () => {
    expect(mapDirective({ ...base, kind: 'agent.speak', agentId: 'counsel', content: 'hello there' })?.text)
      .toBe('said “hello there”.');
    expect(mapDirective({ ...base, kind: 'agent.speak', agentId: 'counsel' })?.text).toBe('sent a message.');
  });

  it('maps think start/stop with a tool name', () => {
    expect(mapDirective({ ...base, kind: 'agent.think', agentId: 'analyst', phase: 'start', toolName: 'kg-search' })?.text)
      .toBe('started using kg-search.');
    expect(mapDirective({ ...base, kind: 'agent.think', agentId: 'analyst', phase: 'stop' })?.text)
      .toBe('finished thinking.');
  });

  it('maps task, tube, deliver and badge directives', () => {
    expect(mapDirective({ ...base, kind: 'claw.deliver', agentId: 'scheduler', jobId: 'j1' })?.text)
      .toBe('delivered a completed job.');
    expect(mapDirective({ ...base, kind: 'task.appear', taskId: 't1', title: 'Q3 board pack' })).toEqual({
      id: 'x', logicalTs: 1000, actor: 'tasks', text: 'new task: Q3 board pack.',
    });
    expect(mapDirective({ ...base, kind: 'tube.in' })?.actor).toBe('inbound');
    expect(mapDirective({ ...base, kind: 'badge', badgeKind: 'human.decision', label: 'Escalated for review' })).toEqual({
      id: 'x', logicalTs: 1000, actor: 'operator', text: 'Escalated for review',
    });
    expect(mapDirective({ ...base, kind: 'badge', badgeKind: 'autonomy.blocked', label: 'Blocked' })?.actor).toBe('autonomy');
  });

  it('drops unknown kinds', () => {
    expect(mapDirective({ ...base, kind: 'some.future.kind' } as SceneDirective)).toBeNull();
  });
});

describe('fetchAttention', () => {
  it('aggregates across the four endpoints on the happy path', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl({
      '/api/jobs?status=failed': { body: { jobs: [{ id: '1', agentId: 'crm.sync', status: 'failed' }] } },
      '/api/jobs?status=suspended': { body: { jobs: [] } },
      '/api/registry/channels': { body: { channels: [{ name: 'slack', state: 'installed', isToggleable: true }] } },
      '/api/registry/email-accounts': { body: { accounts: [{ name: 'ops', selfEmail: 'ops@x.com', hasGrant: true }] } },
    }));
    const items = await fetchAttention();
    expect(items.map(i => i.key)).toEqual(['jobs-failed', 'channel-slack']);
  });

  it('throws (not a false all-clear) when a 200 response is missing its array', async () => {
    // A broken jobs endpoint returning `{}` must surface an error, never read as clean.
    vi.stubGlobal('fetch', mockFetchByUrl({
      '/api/jobs?status=failed': { body: {} }, // no `jobs` array
      '/api/jobs?status=suspended': { body: { jobs: [] } },
      '/api/registry/channels': { body: { channels: [] } },
      '/api/registry/email-accounts': { body: { accounts: [] } },
    }));
    await expect(fetchAttention()).rejects.toThrow(/unexpected response/);
  });
});

describe('fetchActivity', () => {
  it('maps directives newest-first', async () => {
    vi.stubGlobal('fetch', mockFetch(200, {
      directives: [
        { id: 'a', logicalTs: 100, kind: 'agent.state', agentId: 'x', state: 'active' },
        { id: 'b', logicalTs: 200, kind: 'agent.state', agentId: 'y', state: 'error' },
      ],
    }));
    const lines = await fetchActivity();
    expect(lines.map(l => l.id)).toEqual(['b', 'a']); // newest (higher logicalTs) first
  });

  it('scopes the request with a from= lookback so assertTimelineScope accepts it', async () => {
    const fetchMock = mockFetch(200, { directives: [] });
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now() - 24 * 60 * 60 * 1000;
    await fetchActivity();
    const after = Date.now() - 24 * 60 * 60 * 1000;
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/^\/api\/antfarm\/timeline\?/);
    const params = new URL(url, 'http://test').searchParams;
    expect(params.get('limit')).toBe('20');
    const fromMs = Date.parse(params.get('from')!);
    expect(Number.isFinite(fromMs)).toBe(true);
    // from should be ~now-24h, allowing for the call itself.
    expect(fromMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fromMs).toBeLessThanOrEqual(after + 1000);
  });

  it('throws when the 200 body is missing its directives array', async () => {
    vi.stubGlobal('fetch', mockFetch(200, {}));
    await expect(fetchActivity()).rejects.toThrow(/unexpected response/);
  });
});

describe('getGreeting', () => {
  it('picks morning / afternoon / evening by hour', () => {
    expect(getGreeting(6)).toBe('Good morning');
    expect(getGreeting(11)).toBe('Good morning');
    expect(getGreeting(12)).toBe('Good afternoon');
    expect(getGreeting(17)).toBe('Good afternoon');
    expect(getGreeting(18)).toBe('Good evening');
    expect(getGreeting(23)).toBe('Good evening');
  });
});
