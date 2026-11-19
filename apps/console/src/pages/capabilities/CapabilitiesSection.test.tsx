// @vitest-environment happy-dom
// The Capabilities switches (#2358 section 4): a flip calls the registry routes in order,
// asks before turning off what other agents use, says when it stopped part way, and the Setup
// page keeps Meetings on and Email triage off.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RegistryEntry } from '../registry-rows.js';
import { CapabilitiesSection } from './CapabilitiesSection.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(kind: RegistryEntry['kind'], name: string, state: RegistryEntry['state'], meta: Record<string, unknown> = {}): RegistryEntry {
  return {
    name, kind, state, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
    metadata: { name, description: '', version: '0.1.0', ...meta },
  };
}

function registry(): Record<'agents' | 'skills' | 'tools', RegistryEntry[]> {
  return {
    agents: [
      entry('agent', 'coordinator', 'enabled', { pinnedTools: ['web', 'tasks'] }),
      entry('agent', 'meeting-debrief', 'enabled'),
      entry('agent', 'research-analyst', 'enabled'),
      entry('agent', 'diagnostics', 'installed', { pinnedTools: ['diagnostics'] }),
      entry('agent', 'ceo-inbox', 'installed'),
    ],
    skills: [
      entry('skill', 'meetings', 'enabled'),
      entry('skill', 'web', 'enabled', { tools: ['web-search'] }),
      entry('skill', 'tasks', 'enabled'),
      entry('skill', 'diagnostics', 'uninstalled'),
      entry('skill', 'ceo-inbox', 'uninstalled'),
      entry('skill', 'learning', 'uninstalled'),
    ],
    tools: [entry('tool', 'meeting-notes-start', 'enabled'), entry('tool', 'meeting-agenda-load', 'enabled')],
  };
}

function stub(opts: { failOn?: string } = {}) {
  const reg = registry();
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const list = /^\/api\/registry\/(agents|skills|tools)$/.exec(path);
    if (list) return json(200, { [list[1]!]: reg[list[1] as 'agents'] });
    const act = /^\/api\/registry\/(agents|skills|tools)\/([^/]+)\/(install-enable|disable)$/.exec(path);
    if (act && init?.method === 'POST') {
      const [, kind, name, op] = act;
      posts.push(`${op} ${kind}/${name}`);
      if (opts.failOn === name) return json(400, { error: 'missing a required secret' });
      const e = reg[kind as 'agents'].find((x) => x.name === name)!;
      e.state = op === 'disable' ? 'installed' : 'enabled';
      return json(200, { entry: e });
    }
    return json(404, { error: 'unexpected' });
  }));
  return { posts, reg };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(place: 'setup' | 'settings', confirm = vi.fn((_text: string) => true)) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<CapabilitiesSection principal="Dana" place={place} confirm={confirm} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return confirm;
}

const sw = (label: string) => host!.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;

async function click(label: string): Promise<void> {
  await act(async () => { sw(label).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('CapabilitiesSection', () => {
  it('shows each capability’s state from the registry', async () => {
    stub();
    await render('settings');
    expect(sw('Web research').getAttribute('aria-checked')).toBe('true');
    expect(sw('Diagnostics').getAttribute('aria-checked')).toBe('false');
    expect(sw('Email triage').disabled).toBe(false);
  });

  it('turns a capability on, what it pins first, and says when it applies', async () => {
    const { posts } = stub();
    await render('settings');
    await click('Diagnostics');
    expect(posts).toEqual(['install-enable skills/diagnostics', 'install-enable agents/diagnostics']);
    expect(sw('Diagnostics').getAttribute('aria-checked')).toBe('true');
    expect(host!.querySelector('[role="status"]')!.textContent).toBe('Diagnostics on. It applies after a restart.');
  });

  it('asks before turning off what other agents use, and does nothing when declined', async () => {
    const { posts } = stub();
    const confirm = await render('settings', vi.fn((_text: string) => false));
    await click('Web research');
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain('coordinator also uses web');
    expect(posts).toEqual([]);
    expect(sw('Web research').getAttribute('aria-checked')).toBe('true');
  });

  it('turns it off, the agent first, once confirmed', async () => {
    const { posts } = stub();
    await render('setup');
    await click('Web research');
    expect(posts).toEqual(['disable agents/research-analyst', 'disable skills/web']);
    expect(host!.querySelector('[role="status"]')!.textContent).toBe('Web research off. It applies when you apply and restart.');
  });

  it('says when it stopped part way, and shows where the switch is now', async () => {
    const { posts } = stub({ failOn: 'ceo-inbox' });
    await render('settings');
    await click('Email triage');
    // ceo-inbox (the bundle) failed after nothing else ran; the agent was never enabled.
    expect(posts).toEqual(['install-enable skills/ceo-inbox']);
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t turn Email triage on: ceo-inbox: missing a required secret');
    expect(sw('Email triage').getAttribute('aria-checked')).toBe('false');
  });

  it('in Setup, keeps Meetings on and Email triage off, both locked', async () => {
    stub();
    await render('setup');
    expect(sw('Meetings').disabled).toBe(true);
    expect(sw('Meetings').getAttribute('aria-checked')).toBe('true');
    expect(sw('Email triage').disabled).toBe(true);
    expect(sw('Email triage').getAttribute('aria-checked')).toBe('false');
    expect(host!.textContent).toContain('Dana turns this on during onboarding');
  });
});
