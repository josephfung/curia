import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatUptime,
  flattenHealthChecks,
  healthCheckPillClass,
  healthStatusMeta,
  isHealthResponse,
  fetchHealth,
  fetchSetupGaps,
  setupGaps,
  fetchActivity,
  fetchHiccups,
  fetchStats,
  activityHref,
  agentLabel,
  formatActivityTime,
  groupActivityByDay,
  getGreeting,
  greetingSubtitle,
  showCaughtUp,
  caughtUpDetail,
  formatTimeSaved,
  formatCountDelta,
  formatTimeSavedDelta,
  overdueMeta,
  heldMeta,
  orderWaitingItems,
  pendingUndoMessage,
  scheduleUndoCommit,
  UNDO_WINDOW_MS,
  histogramDateLabel,
  agentColor,
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
  // #1760 relies on this being fully dynamic: a check added to /api/health must render
  // as a chip with NO console change. During curia-deploy#221 the dashboard showed
  // "All systems nominal" while Signal voice audio was dead, and the backend fix was a
  // new `signal_voice` check. If this function (or HealthResponse['checks']) is ever
  // narrowed to a fixed key set, that contract breaks silently — the backend reports a
  // failure the operator never sees. This test is the tripwire.
  it('renders a chip for a check key it has never seen before (#1760)', () => {
    const pills = flattenHealthChecks({
      db: 'ok',
      signal: 'ok',
      voice: 'ok',
      signal_voice: 'fail',
    });
    expect(pills).toContainEqual({ name: 'signal_voice', result: 'fail' });
    // And the failing one must be visually distinct, not merely present.
    expect(healthCheckPillClass('fail')).toBe('blocked');
  });

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

describe('setupGaps', () => {
  it('returns an empty list when setup is finished', () => {
    expect(setupGaps({
      channels: [
        { name: 'http', state: 'enabled', isToggleable: false },
        { name: 'slack', state: 'enabled', isToggleable: true },
        { name: 'signal', state: 'uninstalled', isToggleable: true },
      ],
      emailAccounts: [{ name: 'ops', selfEmail: 'ops@example.com', hasGrant: true }],
    })).toEqual([]);
  });

  it('lists channels that are installed but not enabled, and grants that are missing', () => {
    expect(setupGaps({
      channels: [
        { name: 'slack', state: 'installed', isToggleable: true },
        { name: 'signal', state: 'uninstalled', isToggleable: true },
      ],
      emailAccounts: [{ name: 'ops', selfEmail: 'ops@example.com', hasGrant: false }],
    })).toEqual([
      { key: 'channel-slack', title: 'slack channel not enabled' },
      { key: 'email-ops', title: 'ops@example.com missing grant' },
    ]);
  });
});

describe('fetchSetupGaps', () => {
  it('reads channels and email accounts', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl({
      '/api/registry/channels': { body: { channels: [{ name: 'slack', state: 'installed', isToggleable: true }] } },
      '/api/registry/email-accounts': { body: { accounts: [{ name: 'ops', selfEmail: 'ops@x.com', hasGrant: true }] } },
    }));
    const items = await fetchSetupGaps();
    expect(items.map(i => i.key)).toEqual(['channel-slack']);
  });

  it('throws (not a false all-clear) when a 200 response is missing its array', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl({
      '/api/registry/channels': { body: {} },
      '/api/registry/email-accounts': { body: { accounts: [] } },
    }));
    await expect(fetchSetupGaps()).rejects.toThrow(/unexpected response/);
  });
});

describe('fetchActivity', () => {
  const item = {
    id: 'a', ts: '2026-10-24T13:00:00.000Z', actor: 'coordinator', headline: 'drafted a reply to John Doe',
    details: [], outcome: 'success', autonomy: null, link: null,
  };

  it('returns the items and the timezone the backend wrote', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { items: [item], hasMore: false, timezone: 'America/Toronto' }));
    const data = await fetchActivity();
    expect(data.items.map(i => i.id)).toEqual(['a']);
    expect(data.timezone).toBe('America/Toronto');
    expect(data.hasMore).toBe(false);
  });

  it('passes hasMore through', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { items: [item], hasMore: true, timezone: 'UTC' }));
    expect((await fetchActivity()).hasMore).toBe(true);
  });

  it('asks /api/activity for the last 24h, 50 items', async () => {
    const fetchMock = mockFetch(200, { items: [], timezone: 'UTC' });
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now() - 24 * 60 * 60 * 1000;
    await fetchActivity();
    const after = Date.now() - 24 * 60 * 60 * 1000;
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/^\/api\/activity\?/);
    const params = new URL(url, 'http://test').searchParams;
    expect(params.get('limit')).toBe('50');
    const fromMs = Date.parse(params.get('from')!);
    expect(fromMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fromMs).toBeLessThanOrEqual(after + 1000);
  });

  it('throws when the 200 body is missing its items array', async () => {
    vi.stubGlobal('fetch', mockFetch(200, {}));
    await expect(fetchActivity()).rejects.toThrow(/unexpected response/);
  });
});

describe('fetchStats', () => {
  const body = {
    timezone: 'America/Toronto',
    minutesSaved: { current: 90, previous: 60, help: 'help', detail: 'detail' },
    done: { current: 12, previous: 9 },
    openTasks: { total: 5, overdue: 2 },
    hiccups: { current: 1, byDay: [0, 1] },
    handledSinceYesterday: 4,
  };

  it('reads the open-task counts', async () => {
    vi.stubGlobal('fetch', mockFetch(200, body));
    expect((await fetchStats()).openTasks).toEqual({ total: 5, overdue: 2 });
  });

  it('throws when open tasks are missing rather than showing a zero', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ...body, openTasks: undefined }));
    await expect(fetchStats()).rejects.toThrow(/unexpected response/);
  });
});

describe('fetchHiccups', () => {
  const item = {
    id: 'h', ts: '2026-11-02T13:00:00.000Z', actor: 'coordinator', headline: "couldn't send an email",
    details: [], outcome: 'failed', autonomy: null, link: null,
  };

  it('asks for the 7-day list by default and returns it', async () => {
    const fetchMock = mockFetch(200, { timezone: 'UTC', day: null, total: 3, items: [item] });
    vi.stubGlobal('fetch', fetchMock);
    const data = await fetchHiccups();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/dashboard/hiccups');
    expect(data).toMatchObject({ timezone: 'UTC', day: null, total: 3 });
    expect(data.items.map(i => i.id)).toEqual(['h']);
  });

  it('narrows to one day', async () => {
    const fetchMock = mockFetch(200, { timezone: 'UTC', day: '2026-11-02', total: 1, items: [item] });
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchHiccups('2026-11-02')).day).toBe('2026-11-02');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/dashboard/hiccups?day=2026-11-02');
  });

  it('throws on a body without items', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { timezone: 'UTC', total: 0 }));
    await expect(fetchHiccups()).rejects.toThrow(/unexpected response/);
  });
});

describe('activityHref', () => {
  it('links a scheduled job to its page', () => {
    expect(activityHref({ kind: 'job', jobId: 'j-1' })).toBe('/jobs/j-1');
  });

  it('links a conversation to an Ant Farm replay of its window', () => {
    const href = activityHref({ kind: 'conversation', conversationId: 'conv 1', from: '2026-10-24T09:00:00.000Z', to: '2026-10-24T09:05:00.000Z' })!;
    const url = new URL(href, 'http://test');
    expect(url.pathname).toBe('/antfarm/');
    expect(url.searchParams.get('conversationId')).toBe('conv 1');
    expect(url.searchParams.get('from')).toBe('2026-10-24T09:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-10-24T09:05:00.000Z');
  });

  it('returns null without a link', () => {
    expect(activityHref(null)).toBeNull();
  });
});

describe('formatActivityTime', () => {
  it('formats in the given timezone, not the browser\'s', () => {
    const ts = '2026-10-24T13:00:00.000Z';
    expect(formatActivityTime(ts, 'America/Toronto')).toMatch(/^09.00/);
    expect(formatActivityTime(ts, 'Asia/Tokyo')).toMatch(/^(22.00|10.00)/);
  });

  it('shows only the time, even for an older item', () => {
    expect(formatActivityTime('2026-10-20T13:00:00.000Z', 'America/Toronto')).not.toMatch(/Oct/);
  });

  it('falls back to the browser zone on a bad zone name', () => {
    expect(() => formatActivityTime('2026-10-24T13:00:00.000Z', 'Not/AZone')).not.toThrow();
  });
});

describe('groupActivityByDay', () => {
  const item = (id: string, ts: string) => ({
    id, ts, actor: 'coordinator', headline: 'x', details: [], outcome: 'success' as const, autonomy: null, link: null,
  });
  // 10:00 on Oct 24 in Toronto.
  const now = new Date('2026-10-24T14:00:00.000Z');

  it('labels today null, then Yesterday, then the date', () => {
    const groups = groupActivityByDay([
      item('a', '2026-10-24T13:00:00.000Z'),
      item('b', '2026-10-24T05:00:00.000Z'), // 01:00 Oct 24 Toronto
      item('c', '2026-10-24T03:00:00.000Z'), // 23:00 Oct 23 Toronto: yesterday, though the UTC date is today
      item('d', '2026-10-21T15:00:00.000Z'),
    ], 'America/Toronto', now);
    expect(groups.map(g => [g.label, g.items.map(i => i.id)])).toEqual([
      [null, ['a', 'b']],
      ['Yesterday', ['c']],
      ['Oct 21', ['d']],
    ]);
  });

  it('gives the first group a day row when nothing is from today', () => {
    const groups = groupActivityByDay([item('a', '2026-10-23T15:00:00.000Z')], 'America/Toronto', now);
    expect(groups[0]!.label).toBe('Yesterday');
  });

  it('handles yesterday across a month boundary', () => {
    const groups = groupActivityByDay([item('a', '2026-10-31T15:00:00.000Z')], 'America/Toronto', new Date('2026-11-01T15:00:00.000Z'));
    expect(groups[0]!.label).toBe('Yesterday');
  });

  it('does not throw on a bad zone name', () => {
    expect(() => groupActivityByDay([item('a', '2026-10-23T15:00:00.000Z')], 'Not/AZone', now)).not.toThrow();
  });
});

describe('agentLabel', () => {
  it('turns an agent id into words', () => {
    expect(agentLabel('ceo-inbox')).toBe('ceo inbox');
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

describe('greetingSubtitle', () => {
  it('never reads a missing count as zero', () => {
    expect(greetingSubtitle(null, 4)).toBe('Curia handled 4 things since yesterday.');
    expect(greetingSubtitle(null, 4)).not.toMatch(/Nothing is waiting/);
    expect(greetingSubtitle(2, null)).toBe('2 things are waiting on you.');
  });

  it('matches the empty and occupied sentences, including the singular', () => {
    expect(greetingSubtitle(0, 41)).toBe('Nothing is waiting on you. Curia handled 41 things since yesterday.');
    expect(greetingSubtitle(2, 41)).toBe('2 things are waiting on you. Curia handled 41 things since yesterday.');
    expect(greetingSubtitle(1, 1)).toBe('1 thing is waiting on you. Curia handled 1 thing since yesterday.');
  });
});

describe('showCaughtUp', () => {
  it('is true only for a loaded, error-free empty list', () => {
    expect(showCaughtUp({ loaded: true, error: null, count: 0 })).toBe(true);
    expect(showCaughtUp({ loaded: false, error: null, count: 0 })).toBe(false);
    expect(showCaughtUp({ loaded: true, error: 'down', count: 0 })).toBe(false);
    expect(showCaughtUp({ loaded: true, error: null, count: 2 })).toBe(false);
  });
});

describe('caughtUpDetail', () => {
  it('omits the cleared clause at zero and keeps it otherwise', () => {
    expect(caughtUpDetail(0, 4)).toBe('Curia is handling 4 things');
    expect(caughtUpDetail(2, 4)).toBe('2 cleared today · Curia is handling 4 things');
    expect(caughtUpDetail(1, 1)).toBe('1 cleared today · Curia is handling 1 thing');
  });
});

describe('briefing number formatting', () => {
  it('formats time saved in minutes under an hour and hours above it', () => {
    expect(formatTimeSaved(0)).toBe('0m');
    expect(formatTimeSaved(0.5)).toBe('≈0.5m');
    expect(formatTimeSaved(5)).toBe('≈5m');
    expect(formatTimeSaved(15.5)).toBe('≈15.5m');
    expect(formatTimeSaved(60)).toBe('≈1h');
    expect(formatTimeSaved(216)).toBe('≈3.6h');
    expect(formatTimeSavedDelta(15.5, 10)).toEqual({ direction: 'up', text: '▲ 5.5m vs last wk' });
    expect(formatTimeSavedDelta(45, 65)).toEqual({ direction: 'down', text: '▼ 20m vs last wk' });
    expect(formatTimeSavedDelta(216, 180)).toEqual({ direction: 'up', text: '▲ 0.6h vs last wk' });
    expect(formatTimeSavedDelta(216, 213.2)).toEqual({ direction: 'flat', text: '0h vs last wk' });
    expect(formatTimeSavedDelta(3, 3)).toEqual({ direction: 'flat', text: '0m vs last wk' });
    expect(formatCountDelta(214, 181)).toEqual({ direction: 'up', text: '▲ 18%' });
    expect(formatCountDelta(4, 0)).toEqual({ direction: 'up', text: '▲ new' });
  });
});

describe('waiting row copy and order', () => {
  const now = new Date('2026-10-28T15:00:00.000Z');

  it('describes an overdue task in the principal timezone', () => {
    expect(overdueMeta('2026-10-26T15:00:00.000Z', now, 'America/Toronto'))
      .toBe('Your task · due Mon, 2 days overdue');
  });

  it('labels a held draft differently from another approval', () => {
    const created = new Date(now.getTime() - 5 * 3_600_000).toISOString();
    expect(heldMeta(created, now, true)).toBe('Draft held for approval · 5h');
    expect(heldMeta(created, now, false)).toBe('Held for approval · 5h');
  });

  it('puts the most overdue task first, then the oldest approval', () => {
    const rows = orderWaitingItems(
      [
        { id: 'later', title: 'Later', dueAt: '2026-10-27T00:00:00.000Z' },
        { id: 'earlier', title: 'Earlier', dueAt: '2026-10-20T00:00:00.000Z' },
      ],
      [
        { id: 2, title: 'Newer', createdAt: '2026-10-28T00:00:00.000Z', toolName: 'send-draft', summary: '' },
        { id: 1, title: 'Older', createdAt: '2026-10-01T00:00:00.000Z', toolName: 'calendar', summary: '' },
      ],
    );
    expect(rows.map((row) => row.id)).toEqual(['earlier', 'later', 1, 2]);
    expect(rows.map((row) => row.kind)).toEqual(['task', 'task', 'approval', 'approval']);
  });
});

describe('scheduleUndoCommit', () => {
  afterEach(() => vi.useRealTimers());

  it('commits at the undo window and not a millisecond earlier', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    scheduleUndoCommit(commit, UNDO_WINDOW_MS);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('cancel prevents the commit', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const handle = scheduleUndoCommit(commit, UNDO_WINDOW_MS);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    handle.cancel();
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(commit).not.toHaveBeenCalled();
  });

  it('flush commits immediately and a later cancel is a no-op', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const handle = scheduleUndoCommit(commit, UNDO_WINDOW_MS);
    vi.advanceTimersByTime(1_000);
    handle.flush();
    expect(commit).toHaveBeenCalledOnce();
    handle.cancel();
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe('pendingUndoMessage', () => {
  it('keeps a single change in its own words and folds the rest into one undo', () => {
    expect(pendingUndoMessage([])).toBeNull();
    expect(pendingUndoMessage(['dismissed'])).toBe('Dismissed');
    expect(pendingUndoMessage(['marked done'])).toBe('Marked done');
    expect(pendingUndoMessage(['dismissed', 'marked done'])).toBe('2 changes');
  });
});

describe('histogramDateLabel and agentColor', () => {
  it('labels a day from its calendar key, and today as so-far', () => {
    expect(histogramDateLabel('2026-10-21', false)).toBe('Wed, Oct 21');
    expect(histogramDateLabel('2026-10-28', true)).toBe('Today (so far)');
  });

  it('keeps a stable color for a name, and mutes the other bucket', () => {
    const agents = ['research', 'inbox', 'calendar', 'other'];
    expect(agentColor('other', agents)).toBe('var(--app-fg-subtle)');
    expect(agentColor('inbox', agents)).toBe(agentColor('inbox', ['calendar', 'other', 'research', 'inbox']));
    expect(agentColor('calendar', agents)).not.toBe(agentColor('inbox', agents));
  });
});
