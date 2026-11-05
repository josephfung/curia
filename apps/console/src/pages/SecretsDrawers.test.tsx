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

  it('requires a label and value for Other, and offers Card as an enabled type', async () => {
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={() => {}} />);
    const card = button('Card');
    expect(card?.disabled).toBe(false);
    expect(card?.closest('[title]')).toBeNull();
    await click(button('Other'));
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Label'), 'Bank PIN');
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Value'), 'fixture-value-4');
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

// ── Saved cards (#1358) ───────────────────────────────────────────────────────

const NUMBER = '4111 1111 1111 1111';
const CVV = '737';

const cardRow = (over: Partial<NonNullable<SecretRowData['card']>> = {}) => row({
  name: 'user.personal_visa_card',
  valueFormat: 'json',
  card: { label: 'Personal', brand: 'visa', last4: '1111', expiry: '12/2037', expired: false, ...over },
});

function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

async function choose(id: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select(id), value);
    select(id).dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const patchCall = () => mocks.calls.find(c => c.init?.method === 'PATCH');

describe('SecretCreateDrawer — card', () => {
  it('posts the card payload with the label on top and shows the previewed name', async () => {
    mocks.respond = path => path.endsWith('/preview')
      ? json({ name: 'user.personal_visa_card', existing: null })
      : json({ name: 'user.personal_visa_card', replaced: false });
    const onSaved = vi.fn();
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={onSaved} />);
    await click(button('Card'));
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Label'), 'Personal');
    await type(field('Card number'), NUMBER);
    await settle(400);
    const preview = mocks.calls.find(c => c.path === '/api/vault/user-secrets/preview');
    expect(bodyOf(preview)).toEqual({ type: 'credit_card', label: 'Personal', card: { number: '4111111111111111' } });
    expect(document.body.textContent).toContain('Saved as user.personal_visa_card.');

    await choose('card-exp-month', '03');
    await choose('card-exp-year', String(new Date().getFullYear() + 2));
    await type(field('Security code (CVV)'), CVV);
    await type(field('Name on card'), 'Ada Lovelace');
    await click(button('Save'));
    const post = mocks.calls.find(c => c.path === '/api/vault/user-secrets');
    expect(bodyOf(post)).toEqual({
      type: 'credit_card',
      label: 'Personal',
      card: {
        number: '4111111111111111', cvv: CVV, expiry_month: '03', expiry_year: String(new Date().getFullYear() + 2),
        cardholder_name: 'Ada Lovelace',
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('warns that saving replaces an existing card', async () => {
    mocks.respond = () => json({ name: 'user.personal_visa_card', existing: { updatedAt: '2026-06-04T12:00:00.000Z', valueFormat: 'json' } });
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={() => {}} />);
    await click(button('Card'));
    await type(field('Label'), 'Personal');
    await type(field('Card number'), NUMBER);
    await settle(400);
    expect(document.body.textContent).toContain('Saving replaces it instead of adding a duplicate.');
    expect(document.body.textContent).not.toContain('Recapture through Curia');
  });

  it('shows validation messages and posts nothing for a bad card', async () => {
    await render(<SecretCreateDrawer existingRows={[]} onClose={() => {}} onSaved={() => {}} />);
    await click(button('Card'));
    await type(field('Label'), 'Personal');
    await type(field('Card number'), '1234');
    await click(button('Save'));
    expect(document.body.textContent).toContain('The card number should be 12 to 19 digits.');
    expect(mocks.calls.some(c => c.path === '/api/vault/user-secrets')).toBe(false);
  });
});

describe('SecretViewDrawer — card', () => {
  it('view shows public fields only', async () => {
    mocks.respond = () => json({ uses: [] });
    await render(<SecretViewDrawer row={cardRow({ expired: true, expiry: '01/2020' })} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Personal');
    expect(text).toContain('Visa');
    expect(text).toContain('••1111');
    expect(text).toContain('01/2020');
    expect(text).toContain('Expired');
    expect(text).not.toContain('Sign-in page');
    expect(text).not.toContain('Structured value');
    expect(text).not.toContain('4111');
  });

  it('shows the filled field and the principal\'s card-use decision', async () => {
    mocks.respond = () => json({ uses: [
      { kind: 'read', at: new Date().toISOString(), agentId: 'travel', toolName: 'web-browser', source: 'vault', byReference: false, secretField: 'expiry_mm' },
      { kind: 'card_use', at: new Date().toISOString(), decision: 'approved', siteDomain: 'aircanada.com', amount: 'CA$412.30' },
    ] });
    await render(<SecretViewDrawer row={cardRow()} onClose={() => {}} onEdit={() => {}} onRemoved={() => {}} />);
    await settle();
    expect(document.body.textContent).toContain('travel · web-browser · Filled expiry_mm');
    expect(document.body.textContent).toContain('You approved CA$412.30 at aircanada.com');
  });
});

describe('SecretEditDrawer — card', () => {
  it('edit public fields sends PATCH without cvv or number', async () => {
    const onSaved = vi.fn();
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={onSaved} />);
    expect(button('Save')?.disabled).toBe(true);
    await type(field('Label'), 'Work');
    await type(field('Name on card'), 'Ada L');
    await click(button('Save'));
    const patch = patchCall();
    expect(patch?.path).toBe('/api/vault/user-secrets/user.personal_visa_card');
    expect(bodyOf(patch)).toEqual({ label: 'Work', cardholder_name: 'Ada L' });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sends '' to clear the label", async () => {
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await type(field('Label'), '');
    await click(button('Save'));
    expect(bodyOf(patchCall())).toEqual({ label: '' });
  });

  it('lets an expired card take a new label without touching the expiry', async () => {
    await render(<SecretEditDrawer row={cardRow({ expired: true, expiry: '01/2020' })} onClose={() => {}} onSaved={() => {}} />);
    await type(field('Label'), 'Old');
    await click(button('Save'));
    expect(bodyOf(patchCall())).toEqual({ label: 'Old' });
  });

  it('new cvv sends cvv only', async () => {
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await type(field('New CVV'), CVV);
    await click(button('Save'));
    expect(bodyOf(patchCall())).toEqual({ cvv: CVV });
  });

  it('refuses a malformed new cvv', async () => {
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await type(field('New CVV'), '12');
    await click(button('Save'));
    expect(document.body.textContent).toContain('The security code should be 3 or 4 digits.');
    expect(patchCall()).toBeUndefined();
  });

  it('replace card sends replace object', async () => {
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await click(button('Replace card'));
    await type(field('Card number'), NUMBER);
    await choose('card-exp-month', '06');
    await choose('card-exp-year', String(new Date().getFullYear() + 3));
    await type(field('Security code (CVV)'), CVV);
    await type(field('Name on card'), 'Ada Lovelace');
    await click(button('Save'));
    expect(bodyOf(patchCall())).toEqual({
      replace: {
        number: '4111111111111111', cvv: CVV, expiry_month: '06', expiry_year: String(new Date().getFullYear() + 3),
        cardholder_name: 'Ada Lovelace',
      },
    });
  });

  it('no number or cvv in the DOM after save', async () => {
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await click(button('Replace card'));
    await type(field('Card number'), NUMBER);
    await choose('card-exp-month', '06');
    await choose('card-exp-year', String(new Date().getFullYear() + 3));
    await type(field('Security code (CVV)'), CVV);
    await type(field('Name on card'), 'Ada Lovelace');
    await click(button('Save'));
    expect(patchCall()).toBeDefined();
    const html = document.body.innerHTML;
    expect(html).not.toContain('4111');
    expect(html).not.toContain(CVV);
  });

  it('shows a server error inline and stays open', async () => {
    mocks.respond = () => json({ error: 'That card number is not valid.' }, 400);
    await render(<SecretEditDrawer row={cardRow()} onClose={() => {}} onSaved={() => {}} />);
    await type(field('Label'), 'Work');
    await click(button('Save'));
    expect(document.body.textContent).toContain('That card number is not valid.');
  });
});
