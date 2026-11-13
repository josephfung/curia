// @vitest-environment happy-dom
// Settings → Personality → Email & Calendar (#2475, R79): the principal's mailboxes page, its
// place in the Personality nav, and the alert + read-only list when the Nylas API key is missing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  respond: (_path: string): Response | Promise<Response> => new Response('{}', { status: 200 }),
}));

vi.mock('../api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    mocks.calls.push(path);
    return mocks.respond(path);
  }),
}));
vi.mock('../components/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, className }: {
    to: string; search?: Record<string, string>; children: ReactNode; className?: string;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} className={className}>{children}</a>
  ),
}));

const { EmailCalendarPage } = await import('./EmailCalendarSettingsPage.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const work = { id: 'work', label: 'Work', address: 'boss@acme-example.com', isDefault: true };

function channels(keyConfigured: boolean, source: 'vault' | 'env' = 'vault') {
  return {
    channels: [
      { name: 'cli', credentialFields: [] },
      { name: 'email', credentialFields: [{ key: 'nylas_api_key', label: 'Nylas API key', secret: true, configured: keyConfigured, source: keyConfigured ? source : 'missing' }] },
    ],
  };
}

let root: Root | null = null;
let container: HTMLElement;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<EmailCalendarPage />); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text);

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.respond = (path) => path === '/api/registry/channels'
    ? json(channels(true))
    : json({ mailboxes: [work] });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('EmailCalendarPage', () => {
  it('sits in the Personality nav and lists the mailboxes', async () => {
    await mount();
    const nav = container.querySelector('nav.settings-nav')!;
    const item = [...nav.querySelectorAll('a')].find(a => a.textContent === 'Email & Calendar')!;
    expect(item.getAttribute('href')).toBe('/settings/email-calendar');
    expect(item.className).toContain('active');
    expect(nav.querySelector('.settings-nav-title')?.textContent).toBe('Personality');
    expect(container.querySelector('h2')?.textContent).toBe('Email & Calendar');
    expect(container.textContent).toContain('boss@acme-example.com');
  });

  it("points to Channels → Email for Curia's own accounts", async () => {
    await mount();
    expect(container.textContent).toContain('To change the email accounts Curia sends from, go to');
    const link = [...container.querySelectorAll('a')].find(a => a.textContent === 'Channels → Email')!;
    expect(link.getAttribute('href')).toBe('/channels?channel=email');
  });

  it('with the key set: no alert, and the add and change controls are on', async () => {
    await mount();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((container.querySelector('[aria-label="Grant ID"]') as HTMLInputElement).disabled).toBe(false);
    expect(button('Rename')!.disabled).toBe(false);
    expect(container.textContent).toContain('Changes apply at once');
  });

  it('a key from the environment counts as set', async () => {
    mocks.respond = (path) => path === '/api/registry/channels'
      ? json(channels(true, 'env'))
      : json({ mailboxes: [work] });
    await mount();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((container.querySelector('[aria-label="Grant ID"]') as HTMLInputElement).disabled).toBe(false);
  });

  it('stays read-only, with no alert, until the key check answers', async () => {
    let answer!: (r: Response) => void;
    mocks.respond = (path) => path === '/api/registry/channels'
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : json({ mailboxes: [work] });
    await mount();
    expect(container.textContent).toContain('boss@acme-example.com');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect((container.querySelector('[aria-label="Grant ID"]') as HTMLInputElement).disabled).toBe(true);
    expect(button('Rename')!.disabled).toBe(true);
    await act(async () => { answer(json(channels(true))); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect((container.querySelector('[aria-label="Grant ID"]') as HTMLInputElement).disabled).toBe(false);
    expect(button('Rename')!.disabled).toBe(false);
  });

  it('without the key: alerts, links to the email channel, lists mailboxes read-only', async () => {
    mocks.respond = (path) => path === '/api/registry/channels'
      ? json(channels(false))
      : json({ mailboxes: [work] });
    await mount();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Finish setting up the email channel first');
    expect(alert.querySelector('a')!.getAttribute('href')).toBe('/channels?channel=email');
    // Existing mailboxes still listed …
    expect(container.textContent).toContain('boss@acme-example.com');
    // … but nothing can be added or changed.
    for (const label of ['Mailbox id', 'Label', 'Grant ID']) {
      expect((container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).disabled).toBe(true);
    }
    for (const text of ['Test', 'Add mailbox', 'Replace grant', 'Rename', 'Remove']) {
      expect(button(text)!.disabled).toBe(true);
    }
    // No "changes apply at once" beside a form that is off.
    expect(container.textContent).not.toContain('Changes apply at once');
  });

  it('treats a missing email channel entry as no key', async () => {
    mocks.respond = (path) => path === '/api/registry/channels'
      ? json({ channels: [] })
      : json({ mailboxes: [] });
    await mount();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a failed status check is shown, and leaves the controls on', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.respond = (path) => path === '/api/registry/channels'
      ? json({ error: 'boom' }, 500)
      : json({ mailboxes: [work] });
    await mount();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe("Couldn't check whether the email channel is set up: boom");
    expect(container.textContent).not.toContain('Finish setting up the email channel first');
    expect((container.querySelector('[aria-label="Grant ID"]') as HTMLInputElement).disabled).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
