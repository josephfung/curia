// @vitest-environment happy-dom
// Connect with Google (#2361): retry after a failed readiness read, follow the setup panel,
// and never navigate after the view is gone.
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

const { ConnectWithGoogle, SIGNIN_READINESS_EVENT } = await import('./ConnectWithGoogle.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let root: Root | null = null;
let container: HTMLElement;
const assign = vi.fn();

async function settle(ms = 20) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ConnectWithGoogle target="principal" />); });
  await settle();
}
const btn = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined;

beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { origin: 'https://curia.example.com', href: 'https://curia.example.com/', search: '', assign } });
});
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container?.remove(); });

describe('ConnectWithGoogle', () => {
  it('offers Check again after a failed readiness read and enables the button once ready (A4)', async () => {
    mocks.respond = () => json({ error: 'down' }, 503);
    await mount();
    expect(btn('Connect with Google')!.disabled).toBe(true);
    mocks.respond = () => json({ ready: true });
    await act(async () => { btn('Check again')!.click(); });
    await settle();
    expect(btn('Connect with Google')!.disabled).toBe(false);
    expect(btn('Check again')).toBeUndefined();
  });

  it('follows the Nylas setup panel when it announces a new result (A6)', async () => {
    mocks.respond = () => json({ ready: false, detail: 'Create the Google connector first.' });
    await mount();
    expect(btn('Connect with Google')!.disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new CustomEvent(SIGNIN_READINESS_EVENT, { detail: { ready: true } })); });
    expect(btn('Connect with Google')!.disabled).toBe(false);
  });

  it('does not navigate when the view unmounts while the link request is pending (A5)', async () => {
    let release: (r: Response) => void = () => {};
    mocks.respond = (path) => (path === '/api/registry/nylas/signin'
      ? json({ ready: true })
      : new Promise<Response>(r => { release = r; }));
    await mount();
    await act(async () => { btn('Connect with Google')!.click(); });
    act(() => root!.unmount()); root = null;
    await act(async () => { release(json({ url: 'https://curia.example.com/api/mailbox-signin/start/abc' })); });
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });
});
