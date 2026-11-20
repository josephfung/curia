// @vitest-environment happy-dom
// The Messaging step (#2358): an arrow-key pick saves and the page refreshes without taking
// the keyboard focus away, and picks either side of a visit to another step save in order
// (CodeRabbit on #2688).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagingStep } from './ChannelSteps.js';
import type { MessagingRoute, SetupFields } from './setup-api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fields = (messagingRoute: MessagingRoute | null): SetupFields => ({ setupFor: 'other', operatorName: null, operatorEmail: null, messagingRoute, voiceRoute: 'app' });

/** One test's mount: its own host and root, so a late render from one test can't reach another. */
interface Page { host: HTMLDivElement; root: Root | null }
const pages: Page[] = [];

function newPage(): Page {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const page = { host, root: null };
  pages.push(page);
  return page;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function radio(page: Page, title: string): HTMLElement {
  const g = page.host.querySelector('[role="radiogroup"][aria-label="Messaging route"]')!;
  return Array.from(g.querySelectorAll('[role="radio"]')).find((r) => r.textContent?.startsWith(title)) as HTMLElement;
}

async function mount(page: Page, route: MessagingRoute | null, onSaved: () => Promise<void>): Promise<void> {
  await act(async () => { show(page, route, onSaved); });
  await settle();
}

/** Renders the step into the page, inside whatever act is running (the page's refresh runs within a click's). */
function show(page: Page, route: MessagingRoute | null, onSaved: () => Promise<void>): void {
  page.root ??= createRoot(page.host);
  page.root.render(<MessagingStep key="messaging" task={undefined} principal="Dana" fields={fields(route)} contactId={null} onSaved={onSaved} onContinue={() => {}} />);
}

afterEach(() => {
  for (const page of pages.splice(0)) {
    act(() => page.root?.unmount());
    page.host.remove();
  }
  vi.unstubAllGlobals();
});

describe('MessagingStep', () => {
  it('keeps the focus on the picked route through the refresh after its save, so the arrows keep working', async () => {
    let stored: MessagingRoute | null = 'app';
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/setup/state' && init?.method === 'PUT') {
        stored = (JSON.parse(String(init.body)) as { messagingRoute: MessagingRoute }).messagingRoute;
        return json(200, { setup: fields(stored) });
      }
      return json(404, { error: 'not in this test' });
    }));
    // The page's refresh: re-render the step with the stored fields, as SetupPage does. Off
    // once the test ends, so a late one doesn't mount into the next test.
    const page = newPage();
    let done = false;
    const refresh = async (): Promise<void> => { if (!done) show(page, stored, refresh); };
    await mount(page, 'app', refresh);
    radio(page, 'Curia app').focus();
    await act(async () => { radio(page, 'Curia app').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await settle();
    expect(stored).toBe('signal');
    expect(document.activeElement).toBe(radio(page, 'Signal'));
    await act(async () => { radio(page, 'Signal').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await settle();
    expect(stored).toBe('sms');
    expect(document.activeElement).toBe(radio(page, 'Text message (SMS)'));
    done = true;
  });

  it('a pick after coming back to the step waits for the slow save from before, and lands last', async () => {
    const saves: MessagingRoute[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/setup/state' && init?.method === 'PUT') {
        const route = (JSON.parse(String(init.body)) as { messagingRoute: MessagingRoute }).messagingRoute;
        if (route === 'signal') await gate;
        saves.push(route);
        return json(200, { setup: fields(route) });
      }
      return json(404, { error: 'not in this test' });
    }));
    const noop = async (): Promise<void> => {};
    const before = newPage();
    await mount(before, 'app', noop);
    await act(async () => { radio(before, 'Signal').click(); });
    // Another step opens (this one unmounts), then this one again; SMS is picked.
    act(() => before.root!.unmount());
    before.root = null;
    const after = newPage();
    await mount(after, 'app', noop);
    await act(async () => { radio(after, 'Text message (SMS)').click(); });
    await settle();
    expect(saves).toEqual([]);
    await act(async () => { release(); });
    await settle();
    expect(saves).toEqual(['signal', 'sms']);
  });
});
