// @vitest-environment happy-dom
// Google Workspace sign-in result page (#2683): a distinct message for every outcome, and the
// restart wait after a successful sign-in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WORKSPACE_SIGNIN_OUTCOMES } from '../../../../src/google/workspace-signin-outcome.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: Page, workspaceResultMessage } = await import('./GoogleWorkspaceSignInDonePage.js');

let root: Root | null = null;
let host: HTMLElement;
const fetchMock = vi.fn();

async function mount(search: string) {
  window.history.replaceState({}, '', `/google-workspace/done${search}`);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Page pollIntervalMs={10} maxWaitMs={1000} />); });
}
async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GoogleWorkspaceSignInDonePage', () => {
  it('has its own title for every outcome the server sends, and only signed_in is ok', () => {
    const titles = WORKSPACE_SIGNIN_OUTCOMES.map((o) => workspaceResultMessage(o).title);
    expect(new Set(titles).size).toBe(WORKSPACE_SIGNIN_OUTCOMES.length);
    expect(titles).not.toContain('Something went wrong');
    expect(WORKSPACE_SIGNIN_OUTCOMES.filter((o) => workspaceResultMessage(o).ok)).toEqual(['signed_in']);
  });

  it('tells a wrong account from missing permissions', () => {
    expect(workspaceResultMessage('wrong_account').body).toMatch(/not Curia’s Google address/);
    expect(workspaceResultMessage('missing_scopes').body).toMatch(/Drive, Docs and Sheets boxes/);
  });

  it('treats an unknown result as unknown, never as signed in', async () => {
    await mount('?result=<script>&restart=1');
    expect(host.textContent).toMatch(/Something went wrong/);
    expect(host.textContent).not.toMatch(/restarting/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for the restart, then links back', async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      // The old process answers once, goes away, then the new one answers.
      if (call === 2) throw new Error('down');
      return new Response(JSON.stringify({ uptime_s: call === 1 ? 500 : 2 }), { status: 200 });
    });
    await mount('?result=signed_in&restart=1');
    expect(host.textContent).toMatch(/restarting/);
    expect(host.querySelector('a')).toBeNull();
    await wait(50);
    expect(host.textContent).toMatch(/Curia is back/);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/setup?step=google_workspace');
  });

  it('notices a restart that finished before the first poll (#2697 review)', async () => {
    // Only the new process ever answers: it booted after this page loaded.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uptime_s: 0 }), { status: 200 }));
    await mount('?result=signed_in&restart=1');
    await wait(15);
    expect(host.textContent).toMatch(/Curia is back/);
  });

  describe('with the old process’s start in the URL (since)', () => {
    const OLD = '2026-11-20T10:00:00.000Z';
    const NEW = '2026-11-20T10:01:30.000Z';
    const health = (startedAt: string) => async () => new Response(JSON.stringify({ uptime_s: 86_400, started_at: startedAt }), { status: 200 });

    it('is back as soon as a process with another start answers, even on its first poll', async () => {
      fetchMock.mockImplementation(health(NEW));
      await mount(`?result=signed_in&restart=1&since=${encodeURIComponent(OLD)}`);
      await wait(15);
      expect(host.textContent).toMatch(/Curia is back/);
    });

    it('keeps waiting while the old process answers, even after a failed poll', async () => {
      let call = 0;
      fetchMock.mockImplementation(async () => {
        call++;
        if (call === 1) throw new Error('blip');
        return health(OLD)();
      });
      await mount(`?result=signed_in&restart=1&since=${encodeURIComponent(OLD)}`);
      await wait(60);
      expect(host.textContent).toMatch(/restarting/);
    });
  });

  it('keeps waiting while only the old process answers', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uptime_s: 86_400 }), { status: 200 }));
    await mount('?result=signed_in&restart=1');
    await wait(50);
    expect(host.textContent).toMatch(/restarting/);
  });

  it('links back straight away after a refusal', async () => {
    await mount('?result=cancelled&restart=0');
    expect(host.textContent).toMatch(/Sign-in cancelled/);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/setup?step=google_workspace');
  });
});
