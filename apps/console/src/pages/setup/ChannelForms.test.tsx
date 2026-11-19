// @vitest-environment happy-dom
// The channel steps' credential form (#2358, PR 3b): saves only what was typed, turns the
// channel on only once its credentials resolve, and stops at the field that fails.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelCredentialsForm, normalizePhone } from './ChannelForms.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeServer {
  calls: string[];
  resolvable: boolean;
  state: 'uninstalled' | 'installed' | 'enabled';
  failKey?: string;
  /** Fail the enable call, after the saves succeed. */
  failEnable?: boolean;
  puts?: string[];
  /** Keys the server reports as configured after a save. */
  configured?: Set<string>;
}

function stubFetch(server: FakeServer): void {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    server.calls.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/registry/channels') {
      return json(200, { channels: [{ name: 'sms', state: server.state, requiredResolvable: server.resolvable, credentialFields: [
        { key: 'api_key', label: 'API key', secret: true, configured: server.configured?.has('api_key') ?? false },
        { key: 'from_number', label: 'Number', secret: false, configured: server.configured?.has('from_number') ?? false },
      ] }] });
    }
    if (path.startsWith('/api/vault/secrets/')) {
      if (server.failKey && path.endsWith(encodeURIComponent(`channel.sms.${server.failKey}`))) return json(400, { error: 'not a valid number' });
      const key = decodeURIComponent(path.split('/').pop()!).replace('channel.sms.', '');
      server.configured ??= new Set();
      server.configured.add(key);
      server.puts ??= [];
      server.puts.push(JSON.parse(String(init?.body)).value as string);
      return json(200, { ok: true });
    }
    if (path.endsWith('/install')) { server.state = 'installed'; return json(200, {}); }
    if (path.endsWith('/enable')) {
      if (server.failEnable) return json(400, { error: "Cannot enable 'sms': required credentials are not configured." });
      server.state = 'enabled';
      return json(200, {});
    }
    return json(404, { error: 'unexpected' });
  }));
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(onChanged = vi.fn(async () => {}), incompleteNote?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChannelCredentialsForm channel="sms" onChanged={onChanged} incompleteNote={incompleteNote} fields={[
      { key: 'api_key', label: 'Telnyx API key' },
      { key: 'from_number', label: 'Curia’s number', phone: true },
    ]} />);
  });
  return onChanged;
}

function type(label: string, value: string): void {
  const input = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save(): Promise<void> {
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('ChannelCredentialsForm', () => {
  it('saves only the fields typed in, and leaves the channel off while it is incomplete', async () => {
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled' };
    stubFetch(server);
    const onChanged = await mount();
    type('Telnyx API key', 'KEY_1');
    await save();
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toEqual([`PUT /api/vault/secrets/${encodeURIComponent('channel.sms.api_key')}`]);
    expect(server.calls.some((c) => c.endsWith('/enable'))).toBe(false);
    expect(document.body.textContent).toContain('Saved. Add the rest to turn it on.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('installs and turns the channel on once its credentials resolve', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled' };
    stubFetch(server);
    await mount();
    type('Telnyx API key', 'KEY_1');
    type('Curia’s number', '+14165550188');
    await save();
    expect(server.calls).toContain('POST /api/registry/channels/sms/install');
    expect(server.calls).toContain('POST /api/registry/channels/sms/enable');
    expect(server.state).toBe('enabled');
    expect(document.body.textContent).toContain('Saved and turned on.');
  });

  it('stops at the field that fails, names it, and saves nothing after it', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled', failKey: 'api_key' };
    stubFetch(server);
    await mount();
    type('Telnyx API key', 'bad');
    type('Curia’s number', '+14165550188');
    await save();
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
    expect(server.calls.some((c) => c.endsWith('/enable'))).toBe(false);
    expect(document.body.textContent).toContain('Telnyx API key: not a valid number');
  });

  it('saves a typed phone number as E.164', async () => {
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled' };
    stubFetch(server);
    await mount();
    type('Curia’s number', '+1 (416) 555-0188');
    await save();
    expect(server.puts).toEqual(['+14165550188']);
  });

  it('refuses a number without a country code, and saves nothing', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled' };
    stubFetch(server);
    await mount();
    type('Telnyx API key', 'KEY_1');
    type('Curia’s number', '416 555 0188');
    await save();
    expect(server.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    expect(document.body.textContent).toContain('Curia’s number: Enter the number with its country code');
  });

  it('says what else is needed once every field on the page is saved but the channel stays off', async () => {
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled' };
    stubFetch(server);
    await mount(undefined, 'Saved. It also needs LiveKit’s keys.');
    type('Telnyx API key', 'KEY_1');
    await save();
    // One field still empty: that is what's missing.
    expect(document.body.textContent).toContain('Saved. Add the rest to turn it on.');
    type('Curia’s number', '+14165550188');
    await save();
    expect(document.body.textContent).toContain('Saved. It also needs LiveKit’s keys.');
  });

  it('says the keys were saved when only turning the channel on fails', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled', failEnable: true };
    stubFetch(server);
    const onChanged = await mount();
    type('Telnyx API key', 'KEY_1');
    await save();
    expect(document.body.textContent).toContain('Saved, but couldn’t turn it on:');
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('normalizePhone', () => {
  it.each([['+1 416 555 0100', '+14165550100'], ['+1 (416) 555-0100', '+14165550100'], ['+44.20.7946.0958', '+442079460958']])(
    'stores %j as %j', (raw, value) => {
      expect(normalizePhone(raw)).toEqual({ value });
    },
  );

  it.each(['4165550100', '+0123456789', '+1 416 CALL NOW', '+12'])('refuses %j', (raw) => {
    expect(normalizePhone(raw)).toHaveProperty('error');
  });
});
