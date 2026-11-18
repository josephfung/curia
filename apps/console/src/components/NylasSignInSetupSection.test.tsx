// @vitest-environment happy-dom
// Nylas sign-in setup section (#2361): the fix line per reason and what each control sends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; init?: RequestInit };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (_path: string, _init?: RequestInit): Response | Promise<Response> => new Response('{}', { status: 200 }),
}));

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    mocks.calls.push({ path, init });
    return mocks.respond(path, init);
  }),
}));

const { NylasSignInSetupSection } = await import('./NylasSignInSetupSection.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const notReady = {
  ready: false, reason: 'no_google_connector', detail: 'x', region: 'us',
  callbackUrl: 'https://curia.example.com/api/mailbox-signin/callback',
  googleRedirectUri: 'https://api.us.nylas.com/v3/connect/callback',
};

let root: Root | null = null;
let container: HTMLElement;

async function settle(ms = 20) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<NylasSignInSetupSection />); });
  await settle();
}

async function type(label: string, value: string) {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(text: string) {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent === text)!;
  await act(async () => { btn.click(); });
  await settle();
}

beforeEach(() => { mocks.calls = []; mocks.respond = () => json(notReady); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
});

describe('NylasSignInSetupSection', () => {
  it('shows the one-line fix, the callback URL and the Google redirect URI', async () => {
    await mount();
    expect(container.textContent).toContain('Create the Google connector below');
    expect(container.textContent).toContain('https://curia.example.com/api/mailbox-signin/callback');
    expect(container.textContent).toContain('https://api.us.nylas.com/v3/connect/callback');
  });

  it('shows Ready when sign-in is set up', async () => {
    mocks.respond = () => json({ ...notReady, ready: true, reason: undefined });
    await mount();
    expect(container.textContent).toContain('Ready.');
  });

  it('Register callback and Detect post to their routes', async () => {
    await mount();
    await click('Register callback');
    await click('Detect');
    const posts = mocks.calls.filter(c => c.init?.method === 'POST').map(c => c.path);
    expect(posts).toEqual(['/api/registry/nylas/callback', '/api/registry/nylas/discover-region']);
  });

  it('creates the connector, omits an empty topic, and clears the secret afterwards', async () => {
    await mount();
    await type('Google client ID', 'abc.apps.googleusercontent.com');
    await type('Google client secret', 'GOCSPX-secret');
    await click('Create connector');
    const post = mocks.calls.find(c => c.path === '/api/registry/nylas/google-connector')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret' });
    expect((container.querySelector('[aria-label="Google client secret"]') as HTMLInputElement).value).toBe('');
  });

  it('shows the server error and keeps the form values when the connector fails', async () => {
    mocks.respond = (_path, init) => (init?.method === 'POST' ? json({ error: 'Nylas rejected the API key.' }, 502) : json(notReady));
    await mount();
    await type('Google client ID', 'abc');
    await type('Google client secret', 's');
    await click('Create connector');
    expect(container.textContent).toContain('Nylas rejected the API key.');
    expect((container.querySelector('[aria-label="Google client ID"]') as HTMLInputElement).value).toBe('abc');
  });
});
