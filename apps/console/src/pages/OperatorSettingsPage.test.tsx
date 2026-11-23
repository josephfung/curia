// @vitest-environment happy-dom
// Settings → System → Operator (#2710, ADR-068): an explicit Save that sends the canonical form,
// a confirmed Clear, no save on leaving a field, and responses that arrive out of order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { path: string; method: string; body: unknown }

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  respond: (_path: string, _method: string): Response | Promise<Response> => new Response('{}', { status: 200 }),
}));

vi.mock('../api', () => ({
  apiFetch: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    mocks.calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    return mocks.respond(path, method);
  }),
}));
vi.mock('../components/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

const { OperatorPage } = await import('./OperatorSettingsPage.js');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SAM = { name: 'Sam Rivera', email: 'sam@example.com' };

function historyRow(id: string, current: { name: string; email: string } | null) {
  return { id, previous: null, current, changedBy: 'console', changedAt: '2026-11-22T12:00:00.000Z' };
}

let root: Root | null = null;
let container: HTMLElement;

async function settle() { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<OperatorPage />); });
  await settle();
}

const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);
const inputs = () => [...container.querySelectorAll('input')] as HTMLInputElement[];
const puts = (): Call[] => mocks.calls.filter((c) => c.method === 'PUT');

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.respond = (path, method) => {
    if (path === '/api/operator' && method === 'GET') return json({ operator: SAM, confirmation: { state: 'sent', email: SAM.email } });
    if (path.startsWith('/api/operator/history')) return json({ history: [] });
    if (path === '/api/operator' && method === 'PUT') {
      return json({ operator: { name: 'Alex Kim', email: 'alex@example.com' }, confirmation: { state: 'sent', email: 'alex@example.com' } });
    }
    return json({});
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('OperatorPage', () => {
  it('disables Save until something changed, and for an address that is not an email', async () => {
    await mount();
    expect(button('Save')!.disabled).toBe(true);
    const [, email] = inputs();
    await type(email!, 'not-an-email');
    expect(button('Save')!.disabled).toBe(true);
    expect(container.textContent).toContain("That doesn't look like an email address.");
    // Over the server's 254-character cap: refused here too, not only by the server.
    await type(email!, `${'a'.repeat(64)}@${'b'.repeat(186)}.com`);
    expect(button('Save')!.disabled).toBe(true);
  });

  it('saves nothing when a field loses focus', async () => {
    await mount();
    const [name] = inputs();
    await type(name!, 'Alex Kim');
    await act(async () => { name!.dispatchEvent(new Event('blur', { bubbles: true })); name!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await settle();
    expect(puts()).toEqual([]);
  });

  it('Save sends the trimmed name and the trimmed, lower-cased email', async () => {
    await mount();
    const [name, email] = inputs();
    await type(name!, '  Alex Kim ');
    await type(email!, ' Alex@Example.COM ');
    await act(async () => { button('Save')!.click(); });
    await settle();
    expect(puts()).toEqual([{ path: '/api/operator', method: 'PUT', body: { name: 'Alex Kim', email: 'alex@example.com' } }]);
    expect(email!.value).toBe('alex@example.com');
  });

  it('Clear sends { clear: true } only after "Yes, clear the operator"', async () => {
    await mount();
    await act(async () => { button('Clear')!.click(); });
    expect(puts()).toEqual([]);
    await act(async () => { button('Cancel')!.click(); });
    expect(puts()).toEqual([]);
    await act(async () => { button('Clear')!.click(); });
    await act(async () => { button('Yes, clear the operator')!.click(); });
    await settle();
    expect(puts()).toEqual([{ path: '/api/operator', method: 'PUT', body: { clear: true } }]);
    expect(container.textContent).toContain('Cleared.');
  });

  it('keeps the fields disabled until the first load lands, so nothing typed is overwritten', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = mocks.respond;
    mocks.respond = async (path, method) => {
      if (path === '/api/operator' && method === 'GET') await gate;
      return base(path, method);
    };
    await mount();
    expect(inputs().every((i) => i.disabled)).toBe(true);
    expect(button('Save')!.disabled).toBe(true);
    await act(async () => { release(); });
    await settle();
    expect(inputs().every((i) => !i.disabled)).toBe(true);
    expect(inputs()[1]!.value).toBe(SAM.email);
  });

  it('ignores a history response that is not for the latest request', async () => {
    // The mount-time history request is slow and stale; the one after Save is newer and wins.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let historyCalls = 0;
    const base = mocks.respond;
    mocks.respond = async (path, method) => {
      if (path.startsWith('/api/operator/history')) {
        historyCalls++;
        if (historyCalls === 1) {
          await firstGate;
          return json({ history: [historyRow('old', SAM)] });
        }
        return json({ history: [historyRow('new', { name: 'Alex Kim', email: 'alex@example.com' })] });
      }
      return base(path, method);
    };
    await mount();
    const [name] = inputs();
    await type(name!, 'Alex Kim');
    await act(async () => { button('Save')!.click(); });
    await settle();
    expect(container.textContent).toContain('alex@example.com');
    await act(async () => { releaseFirst(); });
    await settle();
    // The stale list never replaced the newer one.
    expect(container.textContent).not.toContain('cleared → Sam Rivera <sam@example.com>');
    expect(container.textContent).toContain('cleared → Alex Kim <alex@example.com>');
  });
});
