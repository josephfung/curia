// @vitest-environment happy-dom
// Secrets page drawers (#2453): what each drawer sends and shows. Only apiFetch is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SecretRowData } from './secrets-utils.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; init?: RequestInit };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (_path: string, _init?: RequestInit): Response => new Response('{}', { status: 200 }),
}));

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    mocks.calls.push({ path, init });
    return mocks.respond(path, init);
  }),
}));

const { SecretViewDrawer, SecretEditDrawer, SecretCreateDrawer } = await import('./SecretsDrawers.js');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function row(overrides: Partial<SecretRowData>): SecretRowData {
  return {
    name: 'user.rogers_password',
    kind: 'personal',
    configured: true,
    required: false,
    envFallback: null,
    declaredBy: [],
    valueFormat: 'string',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-04T12:00:00.000Z',
    lastUsedAt: null,
    readAtStartup: false,
    ...overrides,
  };
}

let root: Root | null = null;

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
}

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

function field(label: string): HTMLInputElement {
  const el = [...document.querySelectorAll('label')].find(l => l.textContent === label);
  if (!el) throw new Error(`no field labelled ${label}`);
  const input = document.getElementById(el.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`label ${label} has no input`);
  return input;
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    // React tracks the value through the native setter; assigning .value directly is ignored.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent === text);
}

async function click(el: HTMLElement | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => { el.click(); });
  await settle();
}

function bodyOf(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init?.body));
}

beforeEach(() => {
  mocks.calls = [];
  mocks.respond = () => json({});
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('SecretEditDrawer — personal', () => {
  const personal = row({ loginUrl: 'https://www.rogers.com/signin', username: 'boss@example.com' });

  it('sends only the changed details, null for a cleared one, and no value when New password is blank', async () => {
    const onSaved = vi.fn();
    await render(<SecretEditDrawer row={personal} onClose={() => {}} onSaved={onSaved} />);
    await type(field('Username'), '');
    await click(button('Save'));
    const patch = mocks.calls.find(c => c.init?.method === 'PATCH');
    expect(patch?.path).toBe('/api/vault/user-secrets/user.rogers_password');
    expect(bodyOf(patch)).toEqual({ username: null });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('sends the new password when one is entered, and clears it from the DOM afterwards', async () => {
    await render(<SecretEditDrawer row={personal} onClose={() => {}} onSaved={() => {}} />);
    await type(field('New password'), 'fixture-value-1');
    await click(button('Save'));
    expect(bodyOf(mocks.calls.find(c => c.init?.method === 'PATCH'))).toEqual({ value: 'fixture-value-1' });
    expect(field('New password').value).toBe('');
  });

  it('hides the value field for a JSON-valued secret and says why', async () => {
    await render(<SecretEditDrawer row={row({ valueFormat: 'json' })} onClose={() => {}} onSaved={() => {}} />);
    expect(document.body.textContent).toContain('Recapture through Curia to change a structured value.');
    expect([...document.querySelectorAll('label')].some(l => l.textContent === 'New password')).toBe(false);
  });

  it('shows a server error inline and stays open', async () => {
    mocks.respond = () => json({ error: 'loginUrl must be an http(s) URL' }, 400);
    const onSaved = vi.fn();
    await render(<SecretEditDrawer row={personal} onClose={() => {}} onSaved={onSaved} />);
    await type(field('Sign-in page URL'), 'nope');
    await click(button('Save'));
    expect(document.body.textContent).toContain('loginUrl must be an http(s) URL');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('SecretEditDrawer — system', () => {
  const system = row({
    name: 'ceo_self_email', kind: 'system', valueFormat: 'string',
    declaredBy: [{ kind: 'principal-mailbox', name: 'Principal inbox', required: false, enabled: true }],
  });

  it('PUTs a single New value and keeps the server validation message', async () => {
    mocks.respond = () => json({ error: 'ceo_self_email must be an email address.' }, 400);
    await render(<SecretEditDrawer row={system} onClose={() => {}} onSaved={() => {}} />);
    await type(field('New value'), 'fixture-value-2');
    await click(button('Save'));
    const put = mocks.calls.find(c => c.init?.method === 'PUT');
    expect(put?.path).toBe('/api/vault/secrets/ceo_self_email');
    expect(bodyOf(put)).toEqual({ value: 'fixture-value-2' });
    expect(document.body.textContent).toContain('ceo_self_email must be an email address.');
  });
});

describe('SecretViewDrawer', () => {
  it('lists recent uses with the "Used" note', async () => {
    mocks.respond = path => path.includes('/uses')
      ? json({ uses: [{ at: new Date().toISOString(), agentId: 'travel', toolName: 'web-browser', source: 'tool', byReference: null }] })
      : json({});
    await render(<SecretViewDrawer row={row({})} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    expect(mocks.calls[0]?.path).toBe('/api/vault/secrets/user.rogers_password/uses?limit=5');
    expect(document.body.textContent).toContain('travel · web-browser');
    expect(document.body.textContent).toContain('"Used" means Curia read it; whether the sign-in worked isn\'t recorded.');
  });

  it('labels a system-initiated read as System', async () => {
    mocks.respond = path => path.includes('/uses')
      ? json({ uses: [{ at: new Date().toISOString(), agentId: null, toolName: 'boot', source: 'vault', byReference: false }] })
      : json({});
    await render(<SecretViewDrawer row={row({})} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('System · boot');
    expect(document.body.textContent).not.toContain('Unknown agent');
  });

  it('shows the empty state when nothing has read it', async () => {
    mocks.respond = () => json({ uses: [] });
    await render(<SecretViewDrawer row={row({})} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('Curia hasn\'t read this secret yet.');
  });

  it('shows the startup text for a key read at boot', async () => {
    const channel = row({
      name: 'channel.telegram.bot_token', kind: 'system', readAtStartup: true,
      declaredBy: [{ kind: 'channel', name: 'telegram', required: true, enabled: true }],
    });
    await render(<SecretViewDrawer row={channel} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    expect(document.body.textContent).toContain('Read when Curia starts; individual reads aren\'t recorded.');
  });

  it('fetches uses for a startup-read key with a recorded use', async () => {
    mocks.respond = path => path.includes('/uses')
      ? json({ uses: [{ at: new Date().toISOString(), agentId: 'ceo-inbox', toolName: '', source: 'vault', byReference: false }] })
      : json({});
    const grant = row({
      name: 'ceo_nylas_grant_id', kind: 'system', readAtStartup: true, lastUsedAt: new Date().toISOString(),
      declaredBy: [{ kind: 'principal-mailbox', name: 'Calendar and principal inbox', required: true, enabled: true }],
    });
    await render(<SecretViewDrawer row={grant} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    expect(mocks.calls[0]?.path).toBe('/api/vault/secrets/ceo_nylas_grant_id/uses?limit=5');
    // An empty toolName falls back to the source.
    expect(document.body.textContent).toContain('ceo-inbox · vault');
    expect(document.body.textContent).not.toContain('Read when Curia starts');
  });

  it('does not claim an unset startup-read key is read at startup', async () => {
    const unset = row({
      name: 'channel.telegram.bot_token', kind: 'system', configured: false, readAtStartup: true, valueFormat: null,
      declaredBy: [{ kind: 'channel', name: 'telegram', required: true, enabled: true }],
    });
    await render(<SecretViewDrawer row={unset} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    expect(document.body.textContent).not.toContain('Read when Curia starts');
  });

  it('gives a configured orphan Remove but no Edit or Set value', async () => {
    const orphan = row({ name: 'old_tool_key', kind: 'system', declaredBy: [] });
    await render(<SecretViewDrawer row={orphan} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    expect(button('Remove')).toBeDefined();
    expect(button('Edit')).toBeUndefined();
    expect(button('Set value')).toBeUndefined();
  });

  it('has no footer buttons for a platform key', async () => {
    const platform = row({
      name: 'api_token', kind: 'platform', required: true, readAtStartup: true,
      declaredBy: [{ kind: 'platform', name: 'API token', required: true, enabled: true }],
    });
    await render(<SecretViewDrawer row={platform} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    expect(document.body.textContent).toContain('Managed by deployment — change it in the deploy environment, not here.');
    expect(document.querySelector('.drawer-footer')).toBeNull();
  });

  it('offers Set value and no Remove for a system key not in the vault', async () => {
    const unset = row({
      name: 'tavily_api_key', kind: 'system', configured: false, valueFormat: null, createdAt: null, updatedAt: null,
      declaredBy: [{ kind: 'tool', name: 'web-search', required: true, enabled: true }], required: true,
    });
    await render(<SecretViewDrawer row={unset} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    expect(button('Set value')).toBeDefined();
    expect(button('Edit')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
  });

  it('asks a second time when the server says the key is still required, then forces', async () => {
    let deletes = 0;
    mocks.respond = (_path, init) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        return deletes === 1 ? json({ error: 'Telegram stops working.' }, 409) : json({ ok: true });
      }
      return json({ uses: [] });
    };
    // happy-dom has no window.confirm; the drawer calls it like a browser would.
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal('confirm', confirm);
    const onRemoved = vi.fn();
    const channel = row({
      name: 'channel.telegram.bot_token', kind: 'system', readAtStartup: true, required: true,
      declaredBy: [{ kind: 'channel', name: 'telegram', required: true, enabled: true }],
    });
    await render(<SecretViewDrawer row={channel} onClose={() => {}} onEdit={() => {}} onRemoved={onRemoved} />);
    await click(button('Remove'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toContain('Telegram stops working.');
    const dels = mocks.calls.filter(c => c.init?.method === 'DELETE').map(c => c.path);
    expect(dels).toEqual([
      '/api/vault/secrets/channel.telegram.bot_token',
      '/api/vault/secrets/channel.telegram.bot_token?force=true',
    ]);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('SecretCreateDrawer', () => {
  it('previews the name once per pause in typing and warns about a replace', async () => {
    // shortDate drops the year only within the current year: pin "now" to 2026.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    mocks.respond = (path) => path.endsWith('/preview')
      ? json({ name: 'user.rogers_password', existing: { updatedAt: '2026-06-04T12:00:00.000Z', valueFormat: 'string' } })
      : json({ name: 'user.rogers_password', replaced: true });
    const onSaved = vi.fn();
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={onSaved} />);
    const url = field('Sign-in page URL');
    await type(url, 'https://www.rog');
    await type(url, 'https://www.rogers.com/signin');
    await settle(400);
    const previews = mocks.calls.filter(c => c.path === '/api/vault/user-secrets/preview');
    expect(previews).toHaveLength(1);
    expect(bodyOf(previews[0])).toEqual({ type: 'website_login', loginUrl: 'https://www.rogers.com/signin' });
    expect(document.body.textContent).toContain('Saved as user.rogers_password — named from the site.');
    expect(document.body.textContent).toContain('You already have user.rogers_password (updated Jun 4). Saving replaces it instead of adding a duplicate.');

    await type(field('Password'), 'fixture-value-3');
    await click(button('Save'));
    const post = mocks.calls.find(c => c.path === '/api/vault/user-secrets');
    expect(bodyOf(post)).toEqual({ type: 'website_login', loginUrl: 'https://www.rogers.com/signin', value: 'fixture-value-3' });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('requires a label and value for Other, and offers Card only as a disabled option', async () => {
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={() => {}} />);
    const card = button('Card (later)');
    expect(card?.disabled).toBe(true);
    expect(card?.closest('[title]')?.getAttribute('title')).toBe('Coming soon — ADR-027');
    await click(button('Other'));
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Label'), 'Bank PIN');
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Value'), 'fixture-value-4');
    // Both filled, but the name preview is not back yet: a save now could replace a key
    // without the replacement notice.
    expect(button('Save')?.disabled).toBe(true);
    await settle(400);
    expect(button('Save')?.disabled).toBe(false);
  });

  it('refuses to replace a JSON-valued key', async () => {
    mocks.respond = () => json({ name: 'user.aircanada_password', existing: { updatedAt: '2026-06-04T12:00:00.000Z', valueFormat: 'json' } });
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={() => {}} />);
    await type(field('Sign-in page URL'), 'https://aircanada.com');
    await type(field('Password'), 'fixture-value-5');
    await settle(400);
    expect(document.body.textContent).toContain('Recapture through Curia to change a structured value.');
    expect(button('Save')?.disabled).toBe(true);
  });
});
