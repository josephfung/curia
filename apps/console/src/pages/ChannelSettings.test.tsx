// @vitest-environment happy-dom
// Channels → Email drawer (#2475, R79): the principal's mailboxes moved to Settings →
// Personality → Email & Calendar, so the drawer holds only Curia's own accounts and a pointer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  search: {} as { channel?: string },
}));

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string) => {
    mocks.calls.push(path);
    const body = path === '/api/registry/channels'
      ? {
        channels: [
          { name: 'email', description: 'Email via Nylas', state: 'installed', isToggleable: true, credentialFields: [], requiredResolvable: false, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null },
          { name: 'signal', description: 'Signal', state: 'uninstalled', isToggleable: true, credentialFields: [], requiredResolvable: false, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null },
        ],
      }
      : { accounts: [], mailboxes: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));
vi.mock('../components/Sidebar.js', () => ({ Sidebar: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useSearch: () => mocks.search,
}));

const { ChannelsPage } = await import('./ChannelSettings.js');

let root: Root | null = null;
let container: HTMLElement;

async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ChannelsPage />); });
  await settle();
}

async function openRow(name: string) {
  const row = [...container.querySelectorAll('tbody tr')].find(r => r.querySelector('td')?.textContent === name)!;
  await act(async () => { (row as HTMLElement).click(); });
  await settle();
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.search = {};
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('Channels → Email drawer', () => {
  it("no longer holds the principal's mailboxes; points to Email & Calendar instead", async () => {
    await mount();
    await openRow('email');
    const drawer = container.querySelector('aside.drawer')!;
    expect(drawer).not.toBeNull();
    expect(mocks.calls).not.toContain('/api/registry/principal-mailboxes');
    expect(drawer.textContent).not.toContain('Replace grant');
    const link = [...drawer.querySelectorAll('a')].find(a => a.getAttribute('href') === '/settings/email-calendar')!;
    expect(link.textContent).toBe('Settings → Personality → Email & Calendar');
  });

  it('other channels show no pointer', async () => {
    await mount();
    await openRow('signal');
    expect(container.querySelector('aside.drawer a[href="/settings/email-calendar"]')).toBeNull();
  });

  it('?channel=email opens the email drawer', async () => {
    mocks.search = { channel: 'email' };
    await mount();
    expect(container.querySelector('aside.drawer h2')?.textContent).toBe('email');
  });
});
