// @vitest-environment happy-dom
// The google-workspace drawer's sign-in panel re-checks after a credential is saved, even one
// that replaces a saved value and so changes no flag (#2697 review).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: string[] = [];
vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string) => {
    calls.push(path);
    if (path === '/api/google-workspace/status') {
      return new Response(JSON.stringify({ state: 'signed_in', callbackUrl: 'https://curia.example.com/api/google-workspace/callback' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

const { McpDrawer } = await import('./McpToolsPage.js');

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); calls.length = 0; });

async function settle() { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }

describe('McpDrawer (google-workspace)', () => {
  it('re-checks the sign-in after a saved secret is replaced', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const entry = {
      name: 'google-workspace', state: 'enabled' as const, requiredResolvable: true,
      installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
      secretFields: [{ key: 'google_oauth_client_secret', label: 'Google OAuth client secret', secret: true, configured: true }],
    };
    await act(async () => { root!.render(<McpDrawer entry={entry} onClose={() => {}} onChanged={async () => {}} />); });
    await settle();
    const statusCalls = () => calls.filter((c) => c === '/api/google-workspace/status').length;
    expect(statusCalls()).toBe(1);

    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'GOCSPX-new');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    await act(async () => { save.click(); });
    await settle();
    // The entry is unchanged (still configured), yet the panel asked again.
    expect(statusCalls()).toBe(2);
  });
});
