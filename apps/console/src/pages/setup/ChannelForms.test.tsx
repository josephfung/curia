// @vitest-environment happy-dom
// The channel steps' credential form (#2358, PR 3b): saves only what was typed, turns the
// channel on only once its credentials resolve, and stops at the field that fails.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelCredentialsForm, normalizePhone, PrincipalIdentityField, type FieldGroupHandle } from './ChannelForms.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeServer {
  calls: string[];
  resolvable: boolean;
  state: 'uninstalled' | 'installed' | 'enabled';
  failKey?: string;
  /** Fail the enable call, after the saves succeed. */
  failEnable?: boolean;
  puts?: string[];
  /** When set, each PUT waits for this before answering. */
  gate?: Promise<void>;
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
      if (server.gate) await server.gate;
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

/** Leaves the last input, which saves what is typed (there is no Save button). */
async function save(): Promise<void> {
  const inputs = Array.from(document.querySelectorAll('input'));
  await act(async () => {
    const last = inputs.at(-1)!;
    last.focus();
    last.blur();
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

// Save and continue calls flush() on each field group and moves on only when all return true.
describe('ChannelCredentialsForm flush (Save and continue)', () => {
  async function mountWithRef() {
    const ref = createRef<FieldGroupHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ChannelCredentialsForm ref={ref} channel="sms" onChanged={async () => {}} fields={[
        { key: 'api_key', label: 'Telnyx API key' },
        { key: 'from_number', label: 'Curia’s number', phone: true },
      ]} />);
    });
    return ref;
  }

  it('is true with nothing typed, and saves nothing', async () => {
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled' };
    stubFetch(server);
    const ref = await mountWithRef();
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(true);
    expect(server.calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  it('is false for a number that cannot be saved, so the step stays put', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled' };
    stubFetch(server);
    const ref = await mountWithRef();
    type('Curia’s number', '416 555 0188');
    let ok = true;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(false);
    expect(server.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    expect(document.body.textContent).toContain('Enter the number with its country code');
  });
});

describe('ChannelCredentialsForm review fixes (#2690 round 1)', () => {
  async function mountWithRef() {
    const ref = createRef<FieldGroupHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ChannelCredentialsForm ref={ref} channel="sms" onChanged={async () => {}} fields={[
        { key: 'api_key', label: 'Telnyx API key' },
        { key: 'from_number', label: 'Curia’s number', phone: true },
      ]} />);
    });
    return ref;
  }
  const flush = async (ref: ReturnType<typeof createRef<FieldGroupHandle>>) => {
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    return ok;
  };

  it('retries turning the channel on before moving on, and stays put while that fails', async () => {
    const server: FakeServer = { calls: [], resolvable: true, state: 'uninstalled', failEnable: true };
    stubFetch(server);
    const ref = await mountWithRef();
    type('Telnyx API key', 'KEY_1');
    expect(await flush(ref)).toBe(false);
    // Nothing typed now; the keys resolve but the channel is still off.
    expect(await flush(ref)).toBe(false);
    expect(document.body.textContent).toContain('Couldn’t turn it on');
    server.failEnable = false;
    expect(await flush(ref)).toBe(true);
    expect(server.state).toBe('enabled');
  });

  it('lets a step move on when its keys were never entered', async () => {
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled' };
    stubFetch(server);
    const ref = await mountWithRef();
    expect(await flush(ref)).toBe(true);
    expect(server.calls.some((c) => c.includes('/enable'))).toBe(false);
  });

  it('keeps a value typed while a save runs, and sends it next', async () => {
    let release!: () => void;
    const server: FakeServer = { calls: [], resolvable: false, state: 'uninstalled', gate: new Promise<void>((r) => { release = r; }) };
    stubFetch(server);
    const ref = await mountWithRef();
    type('Telnyx API key', 'KEY_OLD');
    let first!: Promise<boolean>;
    act(() => { first = ref.current!.flush(); });
    type('Telnyx API key', 'KEY_NEW');
    await act(async () => { release(); await first; });
    const input = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith('Telnyx API key'))!.querySelector('input')!;
    expect(input.value).toBe('KEY_NEW');
    server.gate = undefined;
    expect(await flush(ref)).toBe(true);
    expect(server.puts).toEqual(['KEY_OLD', 'KEY_NEW']);
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

describe('PrincipalIdentityField', () => {
  it('keeps a number typed while a link runs, and links it next', async () => {
    let release!: () => void;
    let gate: Promise<void> | null = new Promise<void>((r) => { release = r; });
    const linked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        if (gate) await gate;
        linked.push((JSON.parse(String(init.body)) as { channelIdentifier: string }).channelIdentifier);
        return json(201, {});
      }
      return json(200, { identities: linked.map((id, i) => ({ id: String(i), channel: 'sms', channelIdentifier: id, status: 'active' })) });
    }));
    const ref = createRef<FieldGroupHandle>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<PrincipalIdentityField ref={ref} contactId="c1" channel="sms" label="Dana’s mobile number" onChanged={async () => {}} />);
    });
    type('Dana’s mobile number', '+14165550100');
    let first!: Promise<boolean>;
    act(() => { first = ref.current!.flush(); });
    type('Dana’s mobile number', '+14165550199');
    await act(async () => { release(); await first; });
    expect(document.querySelector('input')!.value).toBe('+14165550199');
    gate = null;
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(true);
    expect(linked).toEqual(['+14165550100', '+14165550199']);
  });
});
