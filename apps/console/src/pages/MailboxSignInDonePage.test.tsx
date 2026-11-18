// @vitest-environment happy-dom
// Mailbox sign-in result page (#2361): one distinct message per outcome, and the restart wait.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MAILBOX_SIGNIN_OUTCOMES } from '../../../../src/nylas/signin-outcome.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: MailboxSignInDonePage, resultMessage, SIGNIN_RESULTS } = await import('./MailboxSignInDonePage.js');

let root: Root | null = null;
let host: HTMLElement;
const fetchMock = vi.fn();

async function mount(search: string, props: { pollIntervalMs?: number; maxWaitMs?: number } = {}) {
  window.history.replaceState({}, '', `/mailbox-signin/done${search}`);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MailboxSignInDonePage {...props} />); });
}

async function wait(ms: number) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

describe('MailboxSignInDonePage', () => {
  it('knows every outcome the server can send, plus the start route results', () => {
    for (const o of MAILBOX_SIGNIN_OUTCOMES) expect(SIGNIN_RESULTS).toContain(o);
    for (const r of ['not_found', 'used']) expect(SIGNIN_RESULTS).toContain(r);
  });

  it('gives every result a distinct message', () => {
    const msgs = SIGNIN_RESULTS.map(r => resultMessage(r, 'principal').body);
    expect(new Set(msgs).size).toBe(msgs.length);
    expect(resultMessage('nonsense', 'principal').body).not.toBe('');
    expect(msgs).not.toContain(resultMessage('nonsense', 'principal').body);
  });

  it('names the Trusted-app fix for admin_blocked', async () => {
    await mount('?result=admin_blocked&target=principal&restart=0');
    expect(host.textContent).toContain("ask your Google Workspace admin to mark Curia's app as Trusted");
  });

  it('explains wrong_account and missing_scopes', async () => {
    await mount('?result=wrong_account&target=principal&restart=0');
    expect(host.textContent).toContain('different Google account');
    act(() => root!.unmount()); host.remove();
    await mount('?result=missing_scopes&target=curia&restart=0');
    expect(host.textContent).toContain('mail and calendar');
  });

  it('shows the generic message for an unknown or missing result', async () => {
    await mount('?result=<script>');
    expect(host.textContent).toContain('Something went wrong');
    expect(host.querySelector('script')).toBeNull();
  });

  it('on restart=1 shows the restart line and polls /api/health until it answers', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error('down'); })
      .mockImplementation(async () => new Response(JSON.stringify({ uptime_s: 3 }), { status: 200 }));
    await mount('?result=connected&target=curia&restart=1', { pollIntervalMs: 5, maxWaitMs: 1000 });
    expect(host.textContent).toContain('Curia is restarting to start using this mailbox');
    await wait(60);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/health');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(host.textContent).toContain('Curia is back');
  });

  it('does not declare success while the old process keeps answering', async () => {
    let up = 100;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uptime_s: (up += 1) }), { status: 200 }));
    await mount('?result=connected&target=curia&restart=1', { pollIntervalMs: 5, maxWaitMs: 1000 });
    await wait(60);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(host.textContent).not.toContain('Curia is back');
    // The process restarted: uptime drops below the first sample.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ uptime_s: 2 }), { status: 200 }));
    await wait(30);
    expect(host.textContent).toContain('Curia is back');
  });

  it('does not trust an ok answer that has no uptime_s', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await mount('?result=connected&target=curia&restart=1', { pollIntervalMs: 5, maxWaitMs: 1000 });
    await wait(50);
    expect(host.textContent).not.toContain('Curia is back');
  });

  it('counts a non-ok answer followed by an ok one as a restart', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ uptime_s: 50 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 503 }))
      .mockImplementation(async () => new Response(JSON.stringify({ uptime_s: 51 }), { status: 200 }));
    await mount('?result=connected&target=curia&restart=1', { pollIntervalMs: 5, maxWaitMs: 1000 });
    await wait(60);
    expect(host.textContent).toContain('Curia is back');
  });

  it('stops polling after the bound and says to refresh', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await mount('?result=connected&target=curia&restart=1', { pollIntervalMs: 5, maxWaitMs: 30 });
    await wait(80);
    expect(host.textContent).toContain('refresh');
    const n = fetchMock.mock.calls.length;
    await wait(40);
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it('does not poll without restart=1', async () => {
    await mount('?result=connected&target=principal&restart=0', { pollIntervalMs: 5 });
    await wait(30);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
