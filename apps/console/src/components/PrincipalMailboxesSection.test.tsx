// @vitest-environment happy-dom
// Principal mailboxes list (#2475): what the section shows and sends. Only apiFetch is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

const { PrincipalMailboxesSection } = await import('./PrincipalMailboxesSection.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const work = { id: 'work', label: 'Work', address: 'boss@acme-example.com', isDefault: true, triageStartAt: null };
const personal = { id: 'personal', label: 'Personal', address: 'boss@gmail.com', isDefault: false, triageStartAt: null };

function preview(over: Record<string, unknown> = {}) {
  return {
    mailbox: work, isDefault: true, isPrimaryEmail: false, stillOwnedDefault: false,
    otherLive: [personal], primaryEmailCandidates: ['boss@gmail.com', 'boss@home-example.org'], scopedRules: [{ title: 'Newsletter rule', onlyThisMailbox: true }],
    calendars: [{ calendarId: 'c1', label: 'Work calendar' }], ...over,
  };
}

let root: Root | null = null;
let container: HTMLElement;

async function settle(ms = 20) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<PrincipalMailboxesSection />); });
  await settle();
}

function byLabel(label: string): HTMLInputElement | HTMLSelectElement {
  return container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
}

async function type(label: string, value: string) {
  const el = byLabel(label);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function click(text: string) {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent === text);
  if (!btn) throw new Error(`no button "${text}"`);
  await act(async () => { btn.click(); });
  await settle();
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.respond = (path) => {
    if (path.endsWith('/removal-preview')) return json(preview());
    if (path.endsWith('/test')) return json({ email: 'new@example.com', provider: 'google' });
    return json({ mailboxes: [work, personal] });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('PrincipalMailboxesSection', () => {
  it('lists mailboxes with address and a Default badge on the default one', async () => {
    await mount();
    expect(container.textContent).toContain('boss@acme-example.com');
    expect(container.textContent).toContain('boss@gmail.com');
    expect(container.querySelectorAll('.badge-default')).toHaveLength(1);
  });

  it("shows the grant's address after Test", async () => {
    await mount();
    await type('Grant ID', 'g-123');
    await click('Test');
    expect(container.textContent).toContain('new@example.com');
    expect(container.textContent).toContain('google');
    const test = mocks.calls.find(c => c.path.endsWith('/test'))!;
    expect(JSON.parse(test.init!.body as string)).toEqual({ grant_id: 'g-123' });
  });

  it('remove asks for a new default when removing the default', async () => {
    await mount();
    await click('Remove');
    expect(byLabel('New default mailbox')).toBeTruthy();
    expect(container.textContent).toContain('Newsletter rule');
    expect(container.textContent).toContain('Work calendar');
    await type('New default mailbox', 'personal');
    await click('Remove mailbox');
    const del = mocks.calls.find(c => c.init?.method === 'DELETE')!;
    expect(del.path).toBe('/api/registry/principal-mailboxes/work');
    expect(JSON.parse(del.init!.body as string)).toEqual({ still_owned: false, new_default_id: 'personal' });
  });

  it('asks for a new primary email when removing the primary address', async () => {
    mocks.respond = (path) => path.endsWith('/removal-preview')
      ? json(preview({ isDefault: false, isPrimaryEmail: true }))
      : json({ mailboxes: [work, personal] });
    await mount();
    await click('Remove');
    expect(byLabel('New default mailbox')).toBeNull();
    expect(byLabel('New primary email')).toBeTruthy();
    expect([...byLabel('New primary email').querySelectorAll('option')].map(o => o.value))
      .toContain('boss@home-example.org');
  });

  it('explains and blocks removal when there is no candidate primary email', async () => {
    mocks.respond = (path) => path.endsWith('/removal-preview')
      ? json(preview({ isDefault: false, isPrimaryEmail: true, primaryEmailCandidates: [] }))
      : json({ mailboxes: [work] });
    await mount();
    await click('Remove');
    expect(container.textContent).toContain('Add another email address for yourself (Contacts) before removing this one');
    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'Remove mailbox')!;
    expect(confirm.disabled).toBe(true);
  });

  it('shows a pending-migration mailbox read-only with a note', async () => {
    mocks.respond = () => json({ mailboxes: [{ ...work, id: 'mailbox', pending_migration: true }] });
    await mount();
    expect(container.textContent).toContain('Curia is still moving this mailbox into the list; it will finish on its own.');
    expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Remove')).toBe(false);
  });

  it('still-yours defaults to no for a work domain', async () => {
    await mount();
    await click('Remove');
    expect((byLabel('Still mine: no') as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain('Is this address still yours?');
  });

  it('still-yours defaults to yes when the preview says so', async () => {
    mocks.respond = (path) => path.endsWith('/removal-preview')
      ? json(preview({ stillOwnedDefault: true, isDefault: false }))
      : json({ mailboxes: [work, personal] });
    await mount();
    await click('Remove');
    expect((byLabel('Still mine: yes') as HTMLInputElement).checked).toBe(true);
  });

  it('shows the refusal detail when the add is refused', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'POST' && !path.endsWith('/test')
      ? json({ refusal: 'cap_reached', detail: 'At most 1 mailbox(es) can be connected' }, 422)
      : base(path, init);
    await mount();
    await type('Mailbox id', 'third');
    await type('Label', 'Third');
    await type('Grant ID', 'g');
    await click('Test');
    await click('Add mailbox');
    expect(container.textContent).toContain('At most 1 mailbox(es) can be connected');
  });
});
