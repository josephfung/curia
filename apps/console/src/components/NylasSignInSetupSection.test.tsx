// @vitest-environment happy-dom
// Nylas sign-in setup section (#2361): per-step status, the steps it does by itself on first
// load, and what each control sends.
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

const CALLBACK = 'https://curia.example.com/api/mailbox-signin/callback';
const REDIRECT = 'https://api.us.nylas.com/v3/connect/callback';

// A production application whose callback is registered but which has no Google connector.
const notReady = {
  ready: false, reason: 'no_google_connector', detail: 'x', region: 'us',
  callbackUrl: CALLBACK, googleRedirectUri: REDIRECT, environment: 'production',
  checks: { callbackRegistered: true, googleConnector: false },
};
const readyProd = { ...notReady, ready: true, reason: undefined, checks: { callbackRegistered: true, googleConnector: true } };
const readySandbox = { ...readyProd, environment: 'sandbox' };

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

const CLIENT_ID = '#nylas-google-client-id';
const CLIENT_SECRET = '#nylas-google-client-secret';
const TOPIC = '#nylas-google-topic';
const field = (sel: string) => container.querySelector(sel) as HTMLInputElement;

async function type(sel: string, value: string) {
  const el = field(sel);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);

async function click(text: string) {
  const btn = button(text)!;
  await act(async () => { btn.click(); });
  await settle();
}

const posts = () => mocks.calls.filter(c => c.init?.method === 'POST').map(c => c.path);

beforeEach(() => { mocks.calls = []; mocks.respond = () => json(notReady); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
});

describe('NylasSignInSetupSection', () => {
  it('production without a connector: points at step 3 and shows the connector form with the redirect URI', async () => {
    await mount();
    expect(container.querySelector('.settings-section-title')!.textContent).toBe('Nylas');
    expect(container.textContent).toContain('Create the Google connector (step 3).');
    expect(container.textContent).toContain(CALLBACK);
    expect(container.textContent).toContain('Registered with Nylas.');
    expect(container.textContent).toContain(REDIRECT);
    // Standard form layout: each label names its input, none wraps one.
    for (const sel of [CLIENT_ID, CLIENT_SECRET, TOPIC]) {
      expect(container.querySelector(`label[for="${sel.slice(1)}"]`)).not.toBeNull();
    }
    expect(container.querySelectorAll('label input')).toHaveLength(0);
    expect(button('Create connector')!.className).toBe('btn btn-primary');
    expect(container.textContent).not.toContain('sandbox');
    expect(posts()).toEqual([]);
  });

  it('sandbox: the built-in connector is done, with the 5-account note and no form or redirect URI', async () => {
    mocks.respond = () => json(readySandbox);
    await mount();
    expect(container.textContent).toContain('Ready.');
    expect(container.textContent).toContain('Built in (Nylas sandbox)');
    expect(container.textContent).toContain('allows up to 5 connected accounts');
    expect(field(CLIENT_ID)).toBeNull();
    expect(container.textContent).not.toContain(REDIRECT);
    expect(container.querySelectorAll('.nylas-step-mark.done')).toHaveLength(3);
  });

  it('a not-ready sandbox never shows the connector form', async () => {
    mocks.respond = () => json({ ...notReady, reason: 'nylas_unreachable', environment: 'sandbox', checks: { callbackRegistered: true } });
    await mount();
    expect(container.textContent).toContain('Built in (Nylas sandbox)');
    expect(field(CLIENT_ID)).toBeNull();
  });

  it('production with a connector marks the step done and hides the form', async () => {
    mocks.respond = () => json(readyProd);
    await mount();
    expect(container.textContent).toContain('Google connector set up.');
    expect(field(CLIENT_ID)).toBeNull();
    expect(container.textContent).not.toContain(REDIRECT);
  });

  it('says to restart for restart_required (D) and acts on no step by itself', async () => {
    mocks.respond = () => json({ ...notReady, reason: 'restart_required', detail: 'Restart Curia to finish setting up sign-in.', checks: undefined });
    await mount();
    expect(container.textContent).toContain('Not ready. Restart Curia to finish setting up sign-in.');
    expect(posts()).toEqual([]);
  });

  it('falls back to the server detail for a reason it does not know (M)', async () => {
    mocks.respond = () => json({ ...notReady, reason: 'something_new', detail: 'A new thing is missing.' });
    await mount();
    expect(container.textContent).toContain('Not ready. A new thing is missing.');
  });

  it('clears the previous status when a later check fails (M)', async () => {
    await mount();
    expect(container.textContent).toContain('Create the Google connector (step 3).');
    mocks.respond = () => json({ error: 'boom' }, 500);
    await click('Check again');
    expect(container.textContent).toContain("Couldn't check sign-in: boom");
    expect(container.textContent).not.toContain('Create the Google connector (step 3).');
  });

  it('registers an unregistered callback by itself once on first load, then re-checks', async () => {
    let registered = false;
    mocks.respond = (path) => {
      if (path.endsWith('/callback')) { registered = true; return json({ ok: true }); }
      return json({ ...notReady, reason: registered ? 'no_google_connector' : 'callback_unregistered', checks: { callbackRegistered: registered, googleConnector: false } });
    };
    await mount();
    expect(posts()).toEqual(['/api/registry/nylas/callback']);
    expect(mocks.calls.filter(c => c.path.endsWith('/signin'))).toHaveLength(2);
    expect(container.textContent).toContain('Callback registered with Nylas.');
    expect(button('Register callback')).toBeUndefined();
  });

  it('shows Register callback, with the error in that step, only when the automatic attempt failed', async () => {
    mocks.respond = (path) => (path.endsWith('/callback')
      ? json({ error: 'Nylas refused the callback.' }, 502)
      : json({ ...notReady, reason: 'callback_unregistered', checks: { callbackRegistered: false, googleConnector: false } }));
    await mount();
    expect(posts()).toEqual(['/api/registry/nylas/callback']);
    const step = [...container.querySelectorAll('.settings-kv-row')][1]!;
    expect(step.textContent).toContain('Nylas refused the callback.');
    expect(step.textContent).toContain('Register callback');
    await click('Register callback');
    expect(posts()).toEqual(['/api/registry/nylas/callback', '/api/registry/nylas/callback']);
  });

  it('detects the region by itself once when Nylas rejects the key, and keeps the result in the region step', async () => {
    mocks.respond = (path) => (path.endsWith('/discover-region')
      ? json({ error: 'Neither Nylas region accepted the API key. Check the key.' }, 422)
      : json({ ...notReady, reason: 'bad_api_key', checks: undefined }));
    await mount();
    expect(posts()).toEqual(['/api/registry/nylas/discover-region']);
    const step = [...container.querySelectorAll('.settings-kv-row')][0]!;
    expect(step.textContent).toContain('Neither Nylas region accepted the API key.');
    expect(button('Detect')).toBeDefined();
  });

  it('shows the region as done with a Change select that saves the new region', async () => {
    mocks.respond = () => json(readyProd);
    await mount();
    expect(container.textContent).toContain('api.us.nylas.com');
    const select = container.querySelector('[aria-label="Change Nylas region"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'eu';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    const put = mocks.calls.find(c => c.init?.method === 'PUT')!;
    expect(put.path).toBe('/api/registry/nylas/region');
    expect(JSON.parse(put.init!.body as string)).toEqual({ region: 'eu' });
    expect(container.textContent).toContain('Region saved.');
  });

  it('creates the connector, omits an empty topic, and clears the secret afterwards', async () => {
    await mount();
    await type(CLIENT_ID, 'abc.apps.googleusercontent.com');
    await type(CLIENT_SECRET, 'GOCSPX-secret');
    await click('Create connector');
    const post = mocks.calls.find(c => c.path === '/api/registry/nylas/google-connector')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret' });
    expect(field(CLIENT_SECRET).value).toBe('');
    const step = [...container.querySelectorAll('.settings-kv-row')][2]!;
    expect(step.textContent).toContain('Google connector created.');
  });

  it('shows the server error in the connector step and keeps the form values when the connector fails', async () => {
    mocks.respond = (_path, init) => (init?.method === 'POST' ? json({ error: 'Nylas rejected the API key.' }, 502) : json(notReady));
    await mount();
    await type(CLIENT_ID, 'abc');
    await type(CLIENT_SECRET, 's');
    await click('Create connector');
    const step = [...container.querySelectorAll('.settings-kv-row')][2]!;
    expect(step.textContent).toContain('Nylas rejected the API key.');
    expect(field(CLIENT_ID).value).toBe('abc');
  });

  it('does not show a US redirect URI or region while readiness is unknown (A3)', async () => {
    mocks.respond = () => json({ error: 'boom' }, 500);
    await mount();
    expect([...container.querySelectorAll('code')].map(c => c.textContent).join(' ')).not.toContain('nylas.com');
    expect((container.querySelector('[aria-label="Nylas region"]') as HTMLSelectElement).value).toBe('');
    expect(button('Detect')!.disabled).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('ignores a slow earlier check that finishes after a newer one (A1)', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let n = 0;
    mocks.respond = () => (++n === 1
      ? new Promise<Response>(r => { releaseFirst = r; })
      : json(readyProd));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<NylasSignInSetupSection />); });
    await click('Check again');
    expect(container.textContent).toContain('Ready.');
    await act(async () => { releaseFirst(json(notReady)); });
    await settle();
    expect(container.textContent).toContain('Ready.');
    expect(container.textContent).not.toContain('Not ready');
  });

  it('a manual Detect during the first check makes the automatic chain step aside', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let releaseDetect: (r: Response) => void = () => {};
    let n = 0;
    const unregistered = { ...notReady, reason: 'callback_unregistered', checks: { callbackRegistered: false, googleConnector: false } };
    mocks.respond = (path) => {
      if (path.endsWith('/discover-region')) return new Promise<Response>(r => { releaseDetect = r; });
      return ++n === 1 ? new Promise<Response>(r => { releaseFirst = r; }) : json(unregistered);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<NylasSignInSetupSection />); });
    await act(async () => { button('Detect')!.click(); });
    // The first check lands while Detect is still in flight: no automatic step may start now.
    await act(async () => { releaseFirst(json(unregistered)); });
    await settle();
    expect(posts()).toEqual(['/api/registry/nylas/discover-region']);
    await act(async () => { releaseDetect(json({ region: 'us' })); });
    await settle();
    expect(posts()).toEqual(['/api/registry/nylas/discover-region']);
  });

  it('keeps every control locked while the automatic chain runs, across its steps', async () => {
    let releaseCallback: (r: Response) => void = () => {};
    const unregistered = { ...notReady, reason: 'callback_unregistered', checks: { callbackRegistered: false, googleConnector: false } };
    mocks.respond = (path) => (path.endsWith('/callback')
      ? new Promise<Response>(r => { releaseCallback = r; })
      : json(unregistered));
    await mount();
    expect(posts()).toEqual(['/api/registry/nylas/callback']);
    expect((container.querySelector('[aria-label="Change Nylas region"]') as HTMLSelectElement).disabled).toBe(true);
    expect(button('Check again')!.disabled).toBe(true);
    await act(async () => { releaseCallback(json({}, 500)); });
    await settle();
    expect(button('Check again')!.disabled).toBe(false);
    expect(button('Register callback')!.disabled).toBe(false);
  });

  it('locks the connector inputs while the create request is in flight (A2)', async () => {
    let release: (r: Response) => void = () => {};
    mocks.respond = (path) => (path.endsWith('/google-connector')
      ? new Promise<Response>(r => { release = r; })
      : json(notReady));
    await mount();
    await type(CLIENT_ID, 'abc');
    await type(CLIENT_SECRET, 's');
    await act(async () => { button('Create connector')!.click(); });
    expect(field(CLIENT_ID).disabled).toBe(true);
    expect(field(CLIENT_SECRET).disabled).toBe(true);
    expect(field(TOPIC).disabled).toBe(true);
    await act(async () => { release(json({}, 200)); });
    await settle();
    expect(field(CLIENT_ID).disabled).toBe(false);
  });

  it('announces each applied readiness result to the page (A6)', async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('curia:nylas-signin-readiness', on);
    mocks.respond = () => json(readyProd);
    await mount();
    window.removeEventListener('curia:nylas-signin-readiness', on);
    expect(seen[0]).toMatchObject({ ready: true });
  });

  it('does not broadcast a result that arrives after the panel unmounted', async () => {
    let release: (r: Response) => void = () => {};
    mocks.respond = () => new Promise<Response>(r => { release = r; });
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('curia:nylas-signin-readiness', on);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<NylasSignInSetupSection />); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { release(json(readyProd)); });
    await settle();
    window.removeEventListener('curia:nylas-signin-readiness', on);
    expect(seen).toEqual([]);
  });

  it('does not act on a step by itself after the panel unmounted', async () => {
    let release: (r: Response) => void = () => {};
    mocks.respond = (path) => (path.endsWith('/signin')
      ? new Promise<Response>(r => { release = r; })
      : json({ ok: true }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<NylasSignInSetupSection />); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { release(json({ ...notReady, reason: 'callback_unregistered', checks: { callbackRegistered: false } })); });
    await settle();
    expect(posts()).toEqual([]);
  });
});
