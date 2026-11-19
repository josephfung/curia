// @vitest-environment happy-dom
// The optional extras (#2358, PR 3c): the vault key form Google Workspace and the Tavily key
// use, and Working style's tone and independence, each saved as soon as it is picked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VaultKeysForm, type FieldGroupHandle } from './ChannelForms.js';
import { independenceFor, toneFor, WorkingStyleStep } from './ExtraSteps.js';
import { STYLE_TEMPLATES } from '../wizard-utils.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (method: string, path: string, body: unknown) => { status: number; body: unknown } | undefined;

function stubFetch(handler: Handler): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    const res = handler(method, path, body) ?? { status: 404, body: { error: 'unexpected' } };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function type(label: string, value: string): void {
  const input = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
}

function radio(group: string, title: string): HTMLElement {
  const g = document.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!;
  return Array.from(g.querySelectorAll('[role="radio"]')).find((r) => r.textContent?.startsWith(title)) as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const GOOGLE = [
  { key: 'curia_google_email', label: 'Curia’s Google address', plain: true, email: true },
  { key: 'google_oauth_client_secret', label: 'OAuth client secret' },
] as const;

describe('VaultKeysForm', () => {
  it('saves each typed key under its own vault name, and shows saved keys as saved', async () => {
    const configured = new Set(['google_oauth_client_secret']);
    const puts: Array<{ key: string; value: string }> = [];
    stubFetch((method, path, body) => {
      if (path === '/api/vault/status') return { status: 200, body: { configured_keys: [...configured] } };
      if (method === 'PUT' && path.startsWith('/api/vault/secrets/')) {
        const key = decodeURIComponent(path.split('/').pop()!);
        puts.push({ key, value: (body as { value: string }).value });
        configured.add(key);
        return { status: 200, body: { ok: true } };
      }
      return undefined;
    });
    const ref = createRef<FieldGroupHandle>();
    const onChanged = vi.fn(async () => {});
    await render(<VaultKeysForm ref={ref} fields={GOOGLE} onChanged={onChanged} />);
    expect(document.body.textContent).toContain('OAuth client secret Saved');

    type('Curia’s Google address', '  curia@example.com ');
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(true);
    // Only the typed key, trimmed; the saved secret is left alone.
    expect(puts).toEqual([{ key: 'curia_google_email', value: 'curia@example.com' }]);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(document.querySelector('input')!.value).toBe('');
  });

  it('refuses an address that isn’t one before saving anything', async () => {
    const calls = stubFetch((_m, path) => (path === '/api/vault/status' ? { status: 200, body: { configured_keys: [] } } : undefined));
    const ref = createRef<FieldGroupHandle>();
    await render(<VaultKeysForm ref={ref} fields={GOOGLE} onChanged={vi.fn(async () => {})} />);
    type('Curia’s Google address', 'curia');
    type('OAuth client secret', 'shh');
    let ok = true;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('enter an email address');
  });

  it('Save and continue also saves what was typed while a save ran', async () => {
    let release: () => void = () => {};
    let gate: Promise<void> | null = new Promise((r) => { release = r; });
    const puts: string[] = [];
    stubFetch((method, path, body) => {
      if (path === '/api/vault/status') return { status: 200, body: { configured_keys: [] } };
      if (method === 'PUT') { puts.push((body as { value: string }).value); return { status: 200, body: { ok: true } }; }
      return undefined;
    });
    // Hold the first PUT until released, so a second value can be typed while it runs.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && gate) { const g = gate; gate = null; await g; }
      return realFetch(path, init);
    }));
    const ref = createRef<FieldGroupHandle>();
    await render(<VaultKeysForm ref={ref} fields={GOOGLE} onChanged={vi.fn(async () => {})} />);
    type('OAuth client secret', 'first');
    let flushed: Promise<boolean> = Promise.resolve(false);
    await act(async () => { flushed = ref.current!.flush(); });
    type('OAuth client secret', 'second');
    release();
    let ok = false;
    await act(async () => { ok = await flushed; });
    expect(ok).toBe(true);
    expect(puts).toEqual(['first', 'second']);
  });

  it('says a key saved even when re-reading the saved keys fails', async () => {
    let statusFails = false;
    stubFetch((method, path) => {
      if (path === '/api/vault/status') return statusFails ? { status: 500, body: { error: 'status down' } } : { status: 200, body: { configured_keys: [] } };
      if (method === 'PUT') return { status: 200, body: { ok: true } };
      return undefined;
    });
    const ref = createRef<FieldGroupHandle>();
    await render(<VaultKeysForm ref={ref} fields={GOOGLE} onChanged={vi.fn(async () => {})} />);
    statusFails = true;
    type('OAuth client secret', 'shh');
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Saved, but couldn’t re-read which keys are saved: status down');
  });

  it('names the field that failed, and lets the step move on with nothing typed', async () => {
    stubFetch((method, path) => {
      if (path === '/api/vault/status') return { status: 200, body: { configured_keys: [] } };
      if (method === 'PUT') return { status: 400, body: { error: 'not declared' } };
      return undefined;
    });
    const ref = createRef<FieldGroupHandle>();
    await render(<VaultKeysForm ref={ref} fields={GOOGLE} onChanged={vi.fn(async () => {})} />);
    let ok = false;
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(true);
    type('OAuth client secret', 'shh');
    await act(async () => { ok = await ref.current!.flush(); });
    expect(ok).toBe(false);
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('OAuth client secret: not declared');
  });
});

describe('Working style', () => {
  const warm = STYLE_TEMPLATES.find((t) => t.id === 'warm')!;
  const crisp = STYLE_TEMPLATES.find((t) => t.id === 'crisp')!;
  const identity = {
    assistant: { name: 'Alex Curia', title: 'EA', emailSignature: 'Alex' },
    tone: { style: warm.text, verbosity: 40 },
    behavioralPreferences: ['keep it short'],
    constraints: [],
  };

  it('reads the stored choices: a template’s tone, and a score’s band among the three', () => {
    expect(toneFor(crisp.text)).toBe('crisp');
    expect(toneFor('Something written in Settings')).toBeNull();
    expect(independenceFor(65)).toBe('draft-only');
    expect(independenceFor(75)).toBe('approval-required');
    expect(independenceFor(85)).toBe('spot-check');
    expect(independenceFor(95)).toBeNull();
    expect(independenceFor(10)).toBeNull();
  });

  function server(opts: { failAutonomy?: boolean; failAutonomyRead?: () => boolean } = {}) {
    const state = { identity: structuredClone(identity), score: 75 };
    const writes: Array<{ path: string; body: unknown }> = [];
    const calls = stubFetch((method, path, body) => {
      if (path === '/api/identity' && method === 'GET') return { status: 200, body: { identity: state.identity, configured: true } };
      if (path === '/api/identity' && method === 'PUT') {
        writes.push({ path, body });
        state.identity = (body as { identity: typeof identity }).identity;
        return { status: 200, body: { updated: true } };
      }
      if (path === '/api/autonomy' && method === 'GET') {
        if (opts.failAutonomyRead?.()) return { status: 503, body: { error: 'restarting' } };
        return { status: 200, body: { autonomy: { score: state.score } } };
      }
      if (path === '/api/autonomy' && method === 'PUT') {
        writes.push({ path, body });
        if (opts.failAutonomy) return { status: 429, body: { error: 'Too Many Requests' } };
        state.score = (body as { score: number }).score;
        return { status: 200, body: { updated: true } };
      }
      return undefined;
    });
    return { state, writes, calls };
  }

  it('shows the stored tone and independence', async () => {
    server();
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    expect(radio('Tone', 'Warm & personable').getAttribute('aria-checked')).toBe('true');
    expect(radio('Independence', 'Ask first').getAttribute('aria-checked')).toBe('true');
  });

  it('saves a picked tone as the tone’s style only, keeping everything else', async () => {
    const { state, writes } = server();
    const onSaved = vi.fn(async () => {});
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={onSaved} onContinue={vi.fn()} />);
    await click(radio('Tone', 'Crisp & direct'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({ changedBy: 'working_style' });
    expect(state.identity).toEqual({ ...identity, tone: { style: crisp.text, verbosity: 40 } });
    expect(onSaved).toHaveBeenCalled();
  });

  it('saves a picked independence at its score', async () => {
    const { state } = server();
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    await click(radio('Independence', 'Spot-check'));
    expect(state.score).toBe(85);
    expect(radio('Independence', 'Spot-check').getAttribute('aria-checked')).toBe('true');
  });

  it('shows a failed save and the stored choice again', async () => {
    server({ failAutonomy: true });
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    await click(radio('Independence', 'Draft only'));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t save Draft only: Too Many Requests');
    expect(radio('Independence', 'Ask first').getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to the last stored choice when re-reading it fails too', async () => {
    let readFails = false;
    server({ failAutonomy: true, failAutonomyRead: () => readFails });
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    readFails = true;
    await click(radio('Independence', 'Draft only'));
    expect(document.querySelector('[role="alert"]')!.textContent)
      .toBe('Couldn’t save Draft only: Too Many Requests. Couldn’t re-read the stored choice either: restarting');
    expect(radio('Independence', 'Ask first').getAttribute('aria-checked')).toBe('true');
  });

  it('when two quick picks fail together, shows the stored choice again', async () => {
    server({ failAutonomy: true });
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    await act(async () => {
      radio('Independence', 'Draft only').click();
      radio('Independence', 'Spot-check').click();
    });
    await settle();
    await settle();
    expect(radio('Independence', 'Ask first').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Couldn’t save Spot-check');
  });

  it('a slow first read never undoes a pick that saved', async () => {
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((r) => { releaseRead = r; });
    let readFails = false;
    let autonomyPuts = 0;
    const { state } = server({ failAutonomy: false, failAutonomyRead: () => readFails });
    const realFetch = globalThis.fetch;
    let firstRead = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/autonomy' && (init?.method ?? 'GET') === 'GET' && firstRead) {
        firstRead = false;
        await readGate;
        return new Response(JSON.stringify({ autonomy: { score: 75 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/autonomy' && init?.method === 'PUT' && ++autonomyPuts === 2) {
        return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(path, init);
    }));
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={vi.fn()} />);
    await click(radio('Independence', 'Spot-check'));
    expect(state.score).toBe(85);
    // The first read, started before the pick, lands late with the old value: ignored.
    await act(async () => { releaseRead(); });
    await settle();
    expect(radio('Independence', 'Spot-check').getAttribute('aria-checked')).toBe('true');
    // A failing save whose re-read fails too falls back to the last stored: Spot-check.
    readFails = true;
    await click(radio('Independence', 'Draft only'));
    expect(radio('Independence', 'Spot-check').getAttribute('aria-checked')).toBe('true');
  });

  it('locks the choices while Save and continue waits', async () => {
    server();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/identity' && init?.method === 'PUT') await gate;
      return realFetch(path, init);
    }));
    const onContinue = vi.fn();
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={onContinue} />);
    await act(async () => {
      radio('Tone', 'Formal').click();
      (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save and continue') as HTMLElement).click();
    });
    expect(radio('Tone', 'Dry & understated').getAttribute('aria-disabled')).toBe('true');
    expect(radio('Independence', 'Spot-check').getAttribute('aria-disabled')).toBe('true');
    expect(onContinue).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await settle();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('Save and continue waits for a pick’s save, and stays on the step when it failed', async () => {
    server({ failAutonomy: true });
    const onContinue = vi.fn();
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={onContinue} />);
    // Pick, then Save and continue before the save has answered.
    await act(async () => {
      radio('Independence', 'Spot-check').click();
      (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save and continue') as HTMLElement).click();
    });
    await settle();
    expect(onContinue).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Couldn’t save Spot-check');
  });

  it('Save and continue moves on once the picks have saved', async () => {
    const { state } = server();
    const onContinue = vi.fn();
    await render(<WorkingStyleStep task={undefined} principal="Dana" onSaved={vi.fn(async () => {})} onContinue={onContinue} />);
    await act(async () => {
      radio('Tone', 'Formal').click();
      (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save and continue') as HTMLElement).click();
    });
    await settle();
    expect(onContinue).toHaveBeenCalledOnce();
    expect(state.identity.tone.style).toBe(STYLE_TEMPLATES.find((t) => t.id === 'formal')!.text);
  });
});
