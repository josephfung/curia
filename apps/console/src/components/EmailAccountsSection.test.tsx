// @vitest-environment happy-dom
// Email accounts section (#2361): Connect with Google first, grant-id form behind a disclosure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: RequestInit }> }));
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    mocks.calls.push({ path, init });
    if (path === '/api/registry/nylas/signin') return json({ ready: false, reason: 'no_api_key', detail: 'Save the Nylas API key first.' });
    return json({ accounts: [] });
  }),
}));

const { EmailAccountsSection } = await import('./EmailAccountsSection.js');

let root: Root | null = null;
let container: HTMLElement;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container?.remove(); });

describe('EmailAccountsSection sign-in', () => {
  it('disables Connect with Google with the reason and tucks the grant form away', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<EmailAccountsSection />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Connect with Google') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toContain('Save the Nylas API key first.');
    const details = container.querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Paste a grant ID instead');
    expect(details.querySelector('[aria-label="Nylas grant ID"]')).not.toBeNull();
  });
});
