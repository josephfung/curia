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

async function mount(props: { readOnly?: boolean } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<PrincipalMailboxesSection {...props} />); });
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

  // #2600: rows have their own class (no status-pill dot or text-transform).
  it('renders mailbox rows without the status-pill class', async () => {
    await mount();
    expect(container.querySelectorAll('.mailbox-row')).toHaveLength(2);
    expect(container.querySelector('.status-pill')).toBeNull();
  });

  // #2600: the id is chosen by the user, has a format, and is permanent.
  it('explains the mailbox id under the field', async () => {
    await mount();
    const help = container.querySelector('#mailbox-id-help')!;
    expect(help.textContent).toContain('A short name you choose');
    expect(help.textContent).toContain('Lowercase letters, numbers and hyphens');
    expect(help.textContent).toContain("can't be changed later");
    expect(byLabel('Mailbox id').getAttribute('aria-describedby')).toBe('mailbox-id-help');
  });

  it.each([
    ['Work', 'Start with a lowercase letter.'],
    ['work_1', 'Use only lowercase letters, numbers and hyphens.'],
    ['primary', '"primary" is reserved. Choose another name.'],
    ['default', '"default" is reserved. Choose another name.'],
    // The server's fallback-mailbox id: reserved there, so it must be explained here too.
    ['mailbox', '"mailbox" is reserved. Choose another name.'],
    ['a'.repeat(33), 'Use at most 32 characters.'],
  ])('says why the id %s is refused', async (value, message) => {
    await mount();
    await type('Mailbox id', value);
    const error = container.querySelector('#mailbox-id-error');
    expect(error?.textContent).toBe(message);
    expect(byLabel('Mailbox id').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows no id error while the field is empty or valid', async () => {
    await mount();
    expect(container.querySelector('#mailbox-id-error')).toBeNull();
    await type('Mailbox id', 'side-gig2');
    expect(container.querySelector('#mailbox-id-error')).toBeNull();
  });

  it('says what is still missing while Add mailbox is disabled', async () => {
    const blocker = () => container.querySelector('#mailbox-add-blocker')?.textContent ?? null;
    await mount();
    expect(blocker()).toBe('Enter a mailbox id.');
    await type('Mailbox id', 'side');
    expect(blocker()).toBe('Enter a label.');
    await type('Label', 'Side');
    expect(blocker()).toBe('Enter the Nylas grant ID.');
    await type('Grant ID', 'g-1');
    expect(blocker()).toBe('Test the grant ID first.');
    await click('Test');
    expect(blocker()).toBeNull();
    // Editing the grant after a test drops the tested address and asks for a test again.
    await type('Grant ID', 'g-2');
    expect(blocker()).toBe('Test the grant ID first.');
  });

  it('leaves the add blocker to the id error when the id itself is invalid', async () => {
    await mount();
    await type('Mailbox id', 'Bad');
    expect(container.querySelector('#mailbox-id-error')).not.toBeNull();
    expect(container.querySelector('#mailbox-add-blocker')).toBeNull();
  });

  it('uses a full-size primary Add mailbox button that does not stretch', async () => {
    await mount();
    const add = [...container.querySelectorAll('button')].find(b => b.textContent === 'Add mailbox')!;
    expect(add.className).toBe('btn btn-primary');
    expect(add.style.alignSelf).toBe('flex-start');
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

  it('a removal whose cleanup did not finish still reloads, and says so', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'DELETE'
      ? json({ ok: true, removed: true, cleanup_incomplete: ['identity'] })
      : base(path, init);
    await mount();
    await click('Remove');
    await type('New default mailbox', 'personal');
    const loadsBefore = mocks.calls.filter(c => c.path === '/api/registry/principal-mailboxes' && !c.init).length;
    await click('Remove mailbox');
    expect(byLabel('New default mailbox')).toBeNull();
    expect(mocks.calls.filter(c => c.path === '/api/registry/principal-mailboxes' && !c.init).length).toBe(loadsBefore + 1);
    expect(container.textContent).toContain('some cleanup did not finish (identity)');
    expect(container.textContent).not.toContain('Restart Curia');
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

    it("says the rules could not be checked and still lets the removal go ahead", async () => {
      mocks.respond = (path) => path.endsWith('/removal-preview')
        ? json(preview({ scopedRules: null, rulesUnreadable: true, isDefault: false }))
        : json({ mailboxes: [work, personal] });
      await mount();
      await click('Remove');
      expect(container.textContent).toContain("Couldn't check the inbox rules");
      expect(confirmButton().disabled).toBe(false);
      await click('Remove mailbox');
      const del = mocks.calls.find(c => c.init?.method === 'DELETE')!;
      expect(JSON.parse(del.init!.body as string)).toEqual({ still_owned: false });
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
    expect(buttons).not.toContain('Edit');
    expect(buttons).not.toContain('Add mailbox');
    expect(byLabel('Grant ID')).toBeNull();
  });

  it('shows why the migration is still pending when the server knows', async () => {
    mocks.respond = () => json({ mailboxes: [{ ...work, id: 'mailbox', pending_migration: true, pending_migration_reason: 'The flat grant is not a Google account' }] });
    await mount();
    expect(container.textContent).toContain('it has not finished because: The flat grant is not a Google account.');
  });

  // One Edit button per row replaces the separate Replace grant and Rename (#2600 follow-up).
  const patches = () => mocks.calls.filter(c => c.init?.method === 'PATCH')
    .map(c => ({ path: c.path, body: JSON.parse(c.init!.body as string) as unknown }));
  const clickIn = async (rowText: string, text: string) => {
    const row = [...container.querySelectorAll('.mailbox-row')].find(r => r.textContent?.includes(rowText))!;
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent === text)!;
    await act(async () => { btn.click(); });
    await settle();
  };

  it('offers one Edit button per row, not Replace grant or Rename', async () => {
    await mount();
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent);
    expect(buttons.filter(t => t === 'Edit')).toHaveLength(2);
    expect(buttons).not.toContain('Replace grant');
    expect(buttons).not.toContain('Rename');
  });

  it('opens a form with the label filled in and the grant blank', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    expect((byLabel('Label for Work') as HTMLInputElement).value).toBe('Work');
    expect((byLabel('New grant ID for Work') as HTMLInputElement).value).toBe('');
    expect(container.textContent).toContain('Leave blank to keep the current grant');
    // Nothing changed yet, so there is nothing to save.
    const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
    expect(save.disabled).toBe(true);
  });

  it('saves only the label when only the label changed', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('Label for Work', 'Office');
    await click('Save');
    expect(patches()).toEqual([{ path: '/api/registry/principal-mailboxes/work', body: { label: 'Office' } }]);
    expect(byLabel('Label for Work')).toBeNull();
  });

  it('saves only the grant when only the grant changed, and drops it from the page after', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('New grant ID for Work', 'g-new');
    await click('Save');
    expect(patches()).toEqual([{ path: '/api/registry/principal-mailboxes/work', body: { grant_id: 'g-new' } }]);
    expect(byLabel('New grant ID for Work')).toBeNull();
    expect(container.innerHTML).not.toContain('g-new');
  });

  it('saves the grant first, then the label, when both changed', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('Label for Work', 'Office');
    await type('New grant ID for Work', 'g-new');
    await click('Save');
    expect(patches().map(p => p.body)).toEqual([{ grant_id: 'g-new' }, { label: 'Office' }]);
  });

  it('keeps the label unchanged when the grant is refused', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => init?.method === 'PATCH'
      ? json({ refusal: 'address_mismatch', detail: 'That grant is for other@example.com, not boss@acme-example.com' }, 422)
      : base(path, init);
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('Label for Work', 'Office');
    await type('New grant ID for Work', 'g-other');
    await click('Save');
    expect(container.textContent).toContain('That grant is for other@example.com');
    // The refused grant stops the save: the label is never sent, and the form stays open.
    expect(patches().map(p => p.body)).toEqual([{ grant_id: 'g-other' }]);
    expect(byLabel('Label for Work')).not.toBeNull();
  });

  it('says the grant was saved when only the label then fails, and keeps the form for a retry', async () => {
    const base = mocks.respond;
    mocks.respond = (path, init) => {
      if (init?.method === 'PATCH' && (init.body as string).includes('label')) return json({ error: 'database unavailable' }, 500);
      return base(path, init);
    };
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('Label for Work', 'Office');
    await type('New grant ID for Work', 'g-new');
    await click('Save');
    expect(container.textContent).toContain('The new grant was saved, but the label was not: database unavailable');
    // The grant went through, so it's cleared; the label edit stays for a retry.
    expect((byLabel('New grant ID for Work') as HTMLInputElement).value).toBe('');
    expect((byLabel('Label for Work') as HTMLInputElement).value).toBe('Office');
  });

  it('does not save an empty label', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('Label for Work', '   ');
    const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain('Enter a label.');
  });

  it('Cancel closes the form without saving', async () => {
    await mount();
    await clickIn('boss@acme-example.com', 'Edit');
    await type('New grant ID for Work', 'g-new');
    await click('Cancel');
    expect(patches()).toEqual([]);
    expect(byLabel('New grant ID for Work')).toBeNull();
  });

  it('says changes need no restart', async () => {
    await mount();
    expect(container.textContent).toContain('no restart needed');
    expect(container.textContent).not.toContain('take effect after a restart');
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
      ? json({ refusal: 'address_in_use', detail: 'pat@work.example.com is already a connected mailbox' }, 422)
      : base(path, init);
    await mount();
    await type('Mailbox id', 'third');
    await type('Label', 'Third');
    await type('Grant ID', 'g');
    await click('Test');
    await click('Add mailbox');
    expect(container.textContent).toContain('pat@work.example.com is already a connected mailbox');
  });

  it('read-only lists the mailboxes and turns every change control off (R79)', async () => {
    await mount({ readOnly: true });
    expect(container.textContent).toContain('boss@acme-example.com');
    for (const label of ['Mailbox id', 'Label', 'Grant ID']) expect(byLabel(label).disabled).toBe(true);
    for (const text of ['Test', 'Add mailbox', 'Edit', 'Make default', 'Remove']) {
      const btn = [...container.querySelectorAll('button')].find(b => b.textContent === text)!;
      expect(btn.disabled).toBe(true);
    }
  });
});

describe('PrincipalMailboxesSection: Connect with Google (#2361)', () => {
  const signinPath = '/api/registry/nylas/signin';
  const assign = vi.fn();
  beforeEach(() => {
    mocks.calls.length = 0;
    assign.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, value: { origin: 'https://curia.example.com', href: 'https://curia.example.com/', search: '', assign } });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
  });

  const connectBtn = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Connect with Google') as HTMLButtonElement;

  it('is disabled with the readiness reason when sign-in is not ready', async () => {
    mocks.respond = (path) => path === signinPath
      ? json({ ready: false, reason: 'no_google_connector', detail: 'Create the Google connector first.' })
      : json({ mailboxes: [] });
    await mount();
    expect(connectBtn().disabled).toBe(true);
    expect(container.textContent).toContain('Create the Google connector first.');
  });

  it('mints a principal link and navigates to it when ready', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ url: `${window.location.origin}/api/mailbox-signin/start/abc`, expiresAt: 'x' });
      return json({ mailboxes: [] });
    };
    await mount();
    expect(connectBtn().disabled).toBe(false);
    await act(async () => { connectBtn().click(); });
    await settle();
    const mint = mocks.calls.find(c => c.path === '/api/registry/nylas/signin-links')!;
    expect(JSON.parse(mint.init!.body as string)).toEqual({ target: 'principal' });
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/api/mailbox-signin/start/abc`);
  });

  it('refuses to navigate to a link on another origin', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ url: 'https://evil.example.net/start/abc', expiresAt: 'x' });
      return json({ mailboxes: [] });
    };
    await mount();
    await act(async () => { connectBtn().click(); });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('not opened');
    // M: the usual cause is a console opened at an address other than APP_ORIGIN.
    expect(container.textContent).toContain('open the console at its APP_ORIGIN address');
  });

  it('keeps the grant-id form behind a "Paste a grant ID instead" disclosure', async () => {
    mocks.respond = () => json({ mailboxes: [] });
    await mount();
    const details = container.querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Paste a grant ID instead');
    expect(details.contains(byLabel('Grant ID'))).toBe(true);
    expect(details.hasAttribute('open')).toBe(false);
  });

  it('reconnect on a mailbox row mints a link pinned to that mailbox address (A7)', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ url: `${window.location.origin}/api/mailbox-signin/start/abc`, expiresAt: 'x' });
      return json({ mailboxes: [{ id: 'work', label: 'Work', address: 'boss@acme.com', isDefault: true }] });
    };
    await mount();
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Reconnect with Google') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await settle();
    const mint = mocks.calls.find(c => c.path === '/api/registry/nylas/signin-links')!;
    expect(JSON.parse(mint.init!.body as string)).toEqual({ target: 'principal', address: 'boss@acme.com' });
  });

  it('top-level connect passes a typed address, trimmed, while row reconnects stay pinned', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ url: `${window.location.origin}/api/mailbox-signin/start/abc`, expiresAt: 'x' });
      return json({ mailboxes: [{ id: 'work', label: 'Work', address: 'boss@acme.com', isDefault: true }] });
    };
    await mount();
    await type('Google account address', '  second@gmail.com ');
    await act(async () => { connectBtn().click(); });
    await settle();
    const mint = mocks.calls.find(c => c.path === '/api/registry/nylas/signin-links')!;
    expect(JSON.parse(mint.init!.body as string)).toEqual({ target: 'principal', address: 'second@gmail.com' });
    // The row's own button is unaffected by the typed address.
    mocks.calls.length = 0;
    const reconnect = [...container.querySelectorAll('button')].find(b => b.textContent === 'Reconnect with Google') as HTMLButtonElement;
    await act(async () => { reconnect.click(); });
    await settle();
    const row = mocks.calls.find(c => c.path === '/api/registry/nylas/signin-links')!;
    expect(JSON.parse(row.init!.body as string)).toEqual({ target: 'principal', address: 'boss@acme.com' });
  });

  it('a blank address input sends no address', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ url: `${window.location.origin}/api/mailbox-signin/start/abc`, expiresAt: 'x' });
      return json({ mailboxes: [] });
    };
    await mount();
    await type('Google account address', '   ');
    await act(async () => { connectBtn().click(); });
    await settle();
    const mint = mocks.calls.find(c => c.path === '/api/registry/nylas/signin-links')!;
    expect(JSON.parse(mint.init!.body as string)).toEqual({ target: 'principal' });
  });

  it('shows the server refusal for an address', async () => {
    mocks.respond = (path) => {
      if (path === signinPath) return json({ ready: true });
      if (path === '/api/registry/nylas/signin-links') return json({ error: 'That address is not allowed.' }, 422);
      return json({ mailboxes: [] });
    };
    await mount();
    await type('Google account address', 'x@gmail.com');
    await act(async () => { connectBtn().click(); });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('That address is not allowed.');
  });
});
