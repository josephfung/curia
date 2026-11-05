// @vitest-environment happy-dom
// Secrets page: a drawer's save or remove that finishes after the operator opened another
// drawer must not close or replace that drawer. Only apiFetch and the sidebar are mocked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SecretRowData } from './secrets-utils.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  respond: (_path: string, _init?: RequestInit): Response | Promise<Response> => new Response('{}', { status: 200 }),
}));

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => mocks.respond(path, init)),
}));
// The sidebar needs the router; it plays no part in the drawers.
vi.mock('../components/Sidebar.js', () => ({ Sidebar: () => null }));

const { SecretsPage } = await import('./SecretsPage.js');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function personal(name: string): SecretRowData {
  return {
    name, kind: 'personal', configured: true, required: false, envFallback: null, declaredBy: [],
    valueFormat: 'string', createdAt: '2026-06-01T12:00:00.000Z', updatedAt: '2026-06-04T12:00:00.000Z',
    lastUsedAt: null, readAtStartup: false,
  };
}

let root: Root | null = null;

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
}

async function click(el: HTMLElement | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => { el.click(); });
  await settle();
}

const drawerTitle = () => document.querySelector('.drawer-title-h2')?.textContent ?? null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SecretsPage drawers', () => {
  it('opens View from a focusable row button', async () => {
    mocks.respond = path => path === '/api/vault/secrets'
      ? json({ secrets: [personal('user.a_password')] })
      : json({ uses: [] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<SecretsPage />); });
    await settle();
    const view = button('View user.a_password');
    expect(view?.tagName).toBe('BUTTON');
    await click(view);
    expect(drawerTitle()).toBe('A password');
  });

  it('keeps the drawer the operator opened while an earlier remove was still running', async () => {
    let finishDelete: (() => void) | undefined;
    mocks.respond = (path, init) => {
      if (init?.method === 'DELETE') {
        return new Promise<Response>(resolve => { finishDelete = () => resolve(json({ ok: true, removed: true })); });
      }
      if (path === '/api/vault/secrets') return json({ secrets: [personal('user.a_password'), personal('user.b_password')] });
      return json({ uses: [] });
    };
    vi.stubGlobal('confirm', vi.fn(() => true));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<SecretsPage />); });
    await settle();

    await click(button('View user.a_password'));
    await click(button('Remove'));
    expect(finishDelete).toBeDefined();
    // The remove is still in flight: the operator moves on to B.
    await click(button('View user.b_password'));
    expect(drawerTitle()).toBe('B password');

    await act(async () => { finishDelete!(); });
    await settle();
    expect(drawerTitle()).toBe('B password');
  });
});
