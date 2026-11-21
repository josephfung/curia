// @vitest-environment happy-dom
// The last Setup step (#2360): "Not right now" asks first, in words that depend on who Curia
// is set up for (design §3); Start's refusals each say what to do.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Checklist } from './setup-steps.js';
import type { MessagingRoute, SetupFor } from './setup-api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: { channel?: string } }) => (
    <a href={search?.channel ? `${to}?channel=${search.channel}` : to}>{children}</a>
  ),
}));

const { StartStep } = await import('./FinishSteps.js');

const READY: Checklist = { setupFor: null, tasks: [], setupComplete: true, missing: [] };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(setupFor: SetupFor, route: MessagingRoute = 'app'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StartStep checklist={{ ...READY, setupFor }} principal="Dana" setupFor={setupFor} route={route} onRefresh={async () => {}} />);
  });
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)!;
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const SYSTEM = {
  system: { version: '1', nodeVersion: '26', timezone: 'UTC', bootedAt: '2026-11-21T00:00:00.000Z', models: { defaultTier: 'standard', tiers: [] } },
};

/** Setup completes; GET /api/system and POST /api/onboarding/start answer as given. */
function stubStart(start: (body: unknown) => { status: number; body: unknown }, system = { status: 200, body: SYSTEM as unknown }): unknown[] {
  const startBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const json = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/setup/complete') return json({ status: 200, body: { inSetup: false } });
    if (path === '/api/system') return json(system);
    if (path === '/api/onboarding/start') {
      const body: unknown = JSON.parse(String(init?.body));
      startBodies.push(body);
      return json(start(body));
    }
    return json({ status: 404, body: { error: 'unexpected' } });
  }));
  return startBodies;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('StartStep — Not right now', () => {
  it('asks first, in the words for someone setting Curia up for themselves', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await render('self');
    await clickButton('Not right now');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Onboarding is where Curia learns how you like to work. It’s required before Curia acts for you. You can start it any time from the dashboard.');
    // Nothing is finished until the confirmation.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks first, in the words for someone setting Curia up for their principal', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await render('other');
    await clickButton('Not right now');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Onboarding is Dana’s first conversation with Curia. It’s required before Curia acts for them. Start it from the dashboard when they’re ready. Curia won’t contact them until you do.',
    );
  });
});

describe('StartStep — Start onboarding', () => {
  it('route_unreachable points at Channels and the principal’s contact, not the Setup page', async () => {
    stubStart(() => ({ status: 409, body: { ok: false, code: 'route_unreachable' } }));
    await render('other', 'signal');
    await clickButton('Start onboarding');
    const alert = host!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(
      'Curia can’t reach Dana on Signal yet. Check that the Signal channel is on in Channels and that Dana’s Signal details are on their contact.',
    );
    expect(Array.from(alert.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['/channels?channel=signal', '/contacts']);
  });

  it('confirm_working_principal asks with the signals, then starts once confirmed', async () => {
    const bodies = stubStart((body) => (body as { confirmWorkingPrincipal: boolean }).confirmWorkingPrincipal
      ? { status: 200, body: { ok: true, taskId: 't1', invitation: null, restartScheduled: false } }
      : { status: 409, body: { ok: false, code: 'confirm_working_principal', signals: ['email_triage_enabled'] } });
    await render('other', 'signal');
    await clickButton('Start onboarding');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Email triage is already on.');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Start onboarding')!;
    await act(async () => { confirm.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(bodies).toEqual([{ confirmWorkingPrincipal: false }, { confirmWorkingPrincipal: true }]);
    expect(host!.textContent).toContain('Curia has said hello on Signal.');
  });

  it('starts even when the server’s start time can’t be read, and says a restart can’t be watched', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubStart(() => ({ status: 200, body: { ok: true, taskId: 't1', invitation: null, restartScheduled: true } }), { status: 500, body: { error: 'boom' } });
    await render('other', 'signal');
    await clickButton('Start onboarding');
    expect(host!.textContent).toContain('Onboarding started.');
    expect(host!.textContent).toContain('Give it a minute');
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
