// @vitest-environment happy-dom
// Principal mailboxes list (#2475): what the section shows and sends. Only apiFetch is mocked.
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

const { PrincipalMailboxesSection } = await import('./PrincipalMailboxesSection.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const work = { id: 'work', label: 'Work', address: 'boss@acme-example.com', isDefault: true, triageStartAt: null };
const personal = { id: 'personal', label: 'Personal', address: 'boss@gmail.com', isDefault: false, triageStartAt: null };

function preview(over: Record<string, unknown> = {}) {
  return {
    mailbox: work, isDefault: true, isPrimaryEmail: false, stillOwnedDefault: false,
    otherLive: [personal], primaryEmailCandidates: ['boss@gmail.com', 'boss@home-example.org'], scopedRules: [{ title: 'Newsletter rule', onlyThisMailbox: false }],
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

  it('drops a Test answer for a grant that was changed while the test ran', async () => {
    let answer!: (r: Response) => void;
    const base = mocks.respond;
    mocks.respond = (path, init) => path.endsWith('/test')
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : base(path, init);
    await mount();
    await type('Mailbox id', 'work2');
    await type('Label', 'Work 2');
    await type('Grant ID', 'g-a');
    await click('Test');
    await type('Grant ID', 'g-b');
    await act(async () => { answer(json({ email: 'a@example.com', provider: 'google' })); });
    await settle();
    expect(container.textContent).not.toContain('a@example.com');
    const add = [...container.querySelectorAll('button')].find(b => b.textContent === 'Add mailbox')!;
    expect(add.disabled).toBe(true);
  });

  it('starts a removal of another mailbox with fresh choices', async () => {
    mocks.respond = (path) => {
      if (path.endsWith('/work/removal-preview')) return json(preview());
      if (path.endsWith('/personal/removal-preview')) {
        return json(preview({ mailbox: personal, isDefault: false, otherLive: [work], stillOwnedDefault: false }));
      }
      return json({ mailboxes: [work, personal] });
    };
    await mount();
    await click('Remove');
    await act(async () => { (byLabel('Still mine: yes') as HTMLInputElement).click(); });
    expect((byLabel('Still mine: yes') as HTMLInputElement).checked).toBe(true);
    const removeButtons = [...container.querySelectorAll('button')].filter(b => b.textContent === 'Remove');
    await act(async () => { removeButtons[1]!.click(); });
    await settle();
    expect(container.textContent).toContain('Remove Personal');
    expect((byLabel('Still mine: no') as HTMLInputElement).checked).toBe(true);
  });

  it('a removal whose cleanup did not finish still reloads, and says so with the restart', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'DELETE'
      ? json({ ok: true, removed: true, cleanup_incomplete: ['identity'], restart_required: true })
      : base(path, init);
    await mount();
    await click('Remove');
    await type('New default mailbox', 'personal');
    const loadsBefore = mocks.calls.filter(c => c.path === '/api/registry/principal-mailboxes' && !c.init).length;
    await click('Remove mailbox');
    expect(byLabel('New default mailbox')).toBeNull();
    expect(mocks.calls.filter(c => c.path === '/api/registry/principal-mailboxes' && !c.init).length).toBe(loadsBefore + 1);
    expect(container.textContent).toContain('some cleanup did not finish (identity)');
    expect(container.textContent).toContain('Restart Curia');
  });

  it('shows the warning of a change that committed with a pending copy', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'PATCH' ? json({ ok: true, warning: 'Saved. Copying pending.' }) : base(path, init);
    await mount();
    await click('Make default');
    expect(container.textContent).toContain('Saved. Copying pending.');
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

  describe('rules scoped only to the mailbox', () => {
    const only = { scopedRules: [{ title: 'Work invoices', onlyThisMailbox: true }], isDefault: false };
    const withOnly = () => {
      mocks.respond = (path) => path.endsWith('/removal-preview') ? json(preview(only)) : json({ mailboxes: [work, personal] });
    };
    const confirmButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Remove mailbox')!;
    const radio = async (label: string) => {
      await act(async () => { (byLabel(label) as HTMLInputElement).click(); });
    };

    it('keeps Remove disabled until the rules choice is made, then sends delete', async () => {
      withOnly();
      await mount();
      await click('Remove');
      expect(container.textContent).toContain('Work invoices (only this mailbox, will stop applying)');
      expect(confirmButton().disabled).toBe(true);
      await radio('Rules: delete them');
      expect(confirmButton().disabled).toBe(false);
      await click('Remove mailbox');
      const del = mocks.calls.find(c => c.init?.method === 'DELETE')!;
      expect(JSON.parse(del.init!.body as string)).toEqual({ still_owned: false, rules: 'delete' });
    });

    it('moving the rules needs a target mailbox and sends rescope_to', async () => {
      withOnly();
      await mount();
      await click('Remove');
      await radio('Rules: move them');
      expect(confirmButton().disabled).toBe(true);
      await type('Move rules to', 'personal');
      expect(confirmButton().disabled).toBe(false);
      await click('Remove mailbox');
      const del = mocks.calls.find(c => c.init?.method === 'DELETE')!;
      expect(JSON.parse(del.init!.body as string)).toEqual({ still_owned: false, rules: { rescope_to: 'personal' } });
    });

    it('offers no choice and sends no rules when every listed rule is shared', async () => {
      mocks.respond = (path) => path.endsWith('/removal-preview') ? json(preview({ isDefault: false })) : json({ mailboxes: [work, personal] });
      await mount();
      await click('Remove');
      expect(byLabel('Rules: delete them')).toBeNull();
      expect(confirmButton().disabled).toBe(false);
      await click('Remove mailbox');
      const del = mocks.calls.find(c => c.init?.method === 'DELETE')!;
      expect(JSON.parse(del.init!.body as string)).toEqual({ still_owned: false });
    });
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

  it('shows a pending-migration mailbox read-only with a note, and hides the Add form', async () => {
    mocks.respond = () => json({ mailboxes: [{ ...work, id: 'mailbox', pending_migration: true }] });
    await mount();
    expect(container.textContent).not.toContain('it will finish on its own');
    expect(container.textContent).toContain('Curia retries at each restart and once a day');
    expect(container.textContent).toContain('check the Nylas API key and the grant');
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent);
    expect(buttons).not.toContain('Remove');
    expect(buttons).not.toContain('Replace grant');
    expect(buttons).not.toContain('Add mailbox');
    expect(byLabel('Grant ID')).toBeNull();
  });

  it('shows why the migration is still pending when the server knows', async () => {
    mocks.respond = () => json({ mailboxes: [{ ...work, id: 'mailbox', pending_migration: true, pending_migration_reason: 'The flat grant is not a Google account' }] });
    await mount();
    expect(container.textContent).toContain('it has not finished because: The flat grant is not a Google account.');
  });

  it('replaces a mailbox grant with PATCH { grant_id } and drops it from the page after', async () => {
    await mount();
    await click('Replace grant');
    await type('New grant ID for Work', 'g-new');
    await click('Save grant');
    const p = mocks.calls.find(c => c.init?.method === 'PATCH')!;
    expect(p.path).toBe('/api/registry/principal-mailboxes/work');
    expect(JSON.parse(p.init!.body as string)).toEqual({ grant_id: 'g-new' });
    expect(byLabel('New grant ID for Work')).toBeNull();
    expect(container.innerHTML).not.toContain('g-new');
  });

  it('shows the refusal when a replacement grant is for another address', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'PATCH'
      ? json({ refusal: 'address_mismatch', detail: 'That grant is for other@example.com, not boss@acme-example.com' }, 422)
      : base(path, init);
    await mount();
    await click('Replace grant');
    await type('New grant ID for Work', 'g-other');
    await click('Save grant');
    expect(container.textContent).toContain('That grant is for other@example.com');
  });

  it('says calendar changes take effect after a restart', async () => {
    await mount();
    expect(container.textContent).toContain('Calendar changes take effect after a restart');
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
