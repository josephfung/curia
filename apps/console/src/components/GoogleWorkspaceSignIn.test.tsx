// @vitest-environment happy-dom
// Sign in as Curia with Google Workspace (#2683): the three states, the callback URL, and the
// button opens only Google's consent screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  respond: (_path: string, _init?: RequestInit): Response | Promise<Response> => new Response('{}', { status: 200 }),
}));
vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => mocks.respond(path, init)),
}));

const { GoogleWorkspaceSignIn } = await import('./GoogleWorkspaceSignIn.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CALLBACK = 'https://curia.example.com/api/google-workspace/callback';

let root: Root | null = null;
let container: HTMLElement;
const assign = vi.fn();

async function settle(ms = 20) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }
async function mount(onStatus?: (s: string) => void, props: { fieldsFilled?: boolean; beforeSignIn?: () => Promise<boolean> } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<GoogleWorkspaceSignIn onStatus={onStatus} {...props} />); });
  await settle();
}
const button = () => [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('Sign in as Curia')) as HTMLButtonElement;
const text = () => container.textContent ?? '';

function statusThen(status: object, signin?: () => Response) {
  mocks.respond = (path) => {
    if (path === '/api/google-workspace/status') return json({ callbackUrl: CALLBACK, ...status });
    if (path === '/api/google-workspace/signin' && signin) return signin();
    return json({ error: 'unexpected' }, 500);
  };
}

beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { origin: 'https://curia.example.com', href: 'https://curia.example.com/setup', search: '', assign } });
});
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container?.remove(); });

describe('GoogleWorkspaceSignIn', () => {
  it('shows the callback URL to add to the OAuth client', async () => {
    statusThen({ state: 'not_signed_in' });
    await mount();
    expect(container.querySelector('code')?.textContent).toBe(CALLBACK);
  });

  it.each([
    ['signed_in', {}, /Signed in as Curia/, 'Sign in as Curia again'],
    ['not_signed_in', {}, /Not signed in yet/, 'Sign in as Curia'],
    ['token_rejected', { detail: 'Google no longer accepts it.' }, /Google no longer accepts it\./, 'Sign in as Curia'],
  ])('reports %s', async (state, extra, line, label) => {
    const seen: string[] = [];
    statusThen({ state, ...extra });
    await mount((s) => seen.push(s));
    expect(text()).toMatch(line);
    expect(button().textContent).toBe(label);
    expect(button().disabled).toBe(false);
    expect(seen).toEqual([state]);
  });

  it('says when the token works but the MCP server is turned off', async () => {
    statusThen({ state: 'signed_in', serverEnabled: false });
    await mount();
    expect(text()).toMatch(/google-workspace MCP server is turned off/);
  });

  it('keeps the button off until the fields are saved, naming what is missing', async () => {
    statusThen({ state: 'not_configured', missing: ['the OAuth client ID'] });
    await mount();
    expect(button().disabled).toBe(true);
    expect(text()).toMatch(/Save the OAuth client ID first/);
  });

  it('turns the button on once every field is filled in, and saves them before going to Google (#2683)', async () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
    const order: string[] = [];
    statusThen({ state: 'not_configured', missing: ['the OAuth client ID'] }, () => { order.push('signin'); return json({ url }); });
    await mount(undefined, { fieldsFilled: true, beforeSignIn: async () => { order.push('save'); return true; } });
    expect(button().disabled).toBe(false);
    expect(text()).toMatch(/saves these details first/);
    await act(async () => { button().click(); });
    await settle();
    expect(order).toEqual(['save', 'signin']);
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('stays here when saving the fields fails', async () => {
    statusThen({ state: 'not_configured', missing: ['the OAuth client ID'] }, () => json({ url: 'https://accounts.google.com/x' }));
    await mount(undefined, { fieldsFilled: true, beforeSignIn: async () => false });
    await act(async () => { button().click(); });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  it('keeps the button off without a usable APP_ORIGIN, and says so', async () => {
    statusThen({ state: 'not_signed_in', callbackUrl: null });
    await mount();
    expect(button().disabled).toBe(true);
    expect(text()).toMatch(/APP_ORIGIN/);
  });

  it('opens Google’s consent screen in this tab', async () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
    statusThen({ state: 'not_signed_in' }, () => json({ url }));
    await mount();
    await act(async () => { button().click(); });
    await settle();
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('refuses to open anything but Google', async () => {
    statusThen({ state: 'not_signed_in' }, () => json({ url: 'https://evil.example.com/auth' }));
    await mount();
    await act(async () => { button().click(); });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(text()).toMatch(/did not return a Google sign-in address/);
  });

  it('shows the server’s reason when the sign-in cannot start', async () => {
    statusThen({ state: 'not_signed_in' }, () => json({ error: 'Save the OAuth client secret first.' }, 409));
    await mount();
    await act(async () => { button().click(); });
    await settle();
    expect(text()).toMatch(/Save the OAuth client secret first\./);
    expect(button().disabled).toBe(false);
  });

  it('reads unknown when the status call fails', async () => {
    mocks.respond = () => json({ error: 'down' }, 503);
    await mount();
    expect(text()).toMatch(/Could not check the sign-in/);
  });
});
