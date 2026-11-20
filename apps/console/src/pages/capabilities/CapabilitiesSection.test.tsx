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
      entry('agent', 'meeting-debrief', 'enabled', { pinnedTools: ['task-create'] }),
      entry('agent', 'research-analyst', 'enabled'),
      entry('agent', 'diagnostics', 'installed', { pinnedTools: ['diagnostics'] }),
      entry('agent', 'ceo-inbox', 'installed'),
    ],
    skills: [
      entry('skill', 'meetings', 'enabled'),
      entry('skill', 'web', 'enabled', { tools: ['web-search'] }),
      entry('skill', 'tasks', 'enabled', { tools: ['task-create'] }),
      entry('skill', 'diagnostics', 'uninstalled'),
      entry('skill', 'ceo-inbox', 'uninstalled'),
      entry('skill', 'learning', 'uninstalled'),
    ],
    tools: [entry('tool', 'meeting-notes-start', 'enabled'), entry('tool', 'meeting-agenda-load', 'enabled')],
  };
}

function stub(opts: { failOn?: string; edit?: (reg: ReturnType<typeof registry>) => void } = {}) {
  const reg = registry();
  opts.edit?.(reg);
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

const sw = (label: string) => host!.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${label}"]`)!;

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

  it('turning one on also turns on what its agent needs, once asked', async () => {
    const off = (reg: ReturnType<typeof registry>) => {
      reg.agents.find((e) => e.name === 'meeting-debrief')!.state = 'installed';
      reg.skills.find((e) => e.name === 'tasks')!.state = 'installed';
    };
    const { posts } = stub({ edit: off });
    const confirm = await render('settings');
    await click('Meeting debriefs');
    expect(confirm.mock.calls[0]![0]).toBe('Meeting debriefs needs Projects and tasks, which is off. Turn it on too?');
    expect(posts).toEqual(['install-enable skills/tasks', 'install-enable agents/meeting-debrief']);
    expect(host!.querySelector('[role="status"]')!.textContent).toBe('Meeting debriefs on, with Projects and tasks. It applies after a restart.');
  });

  it('won’t turn one on when what it needs isn’t available on this install', async () => {
    const { posts } = stub({ edit: (reg) => {
      reg.agents.find((e) => e.name === 'meeting-debrief')!.state = 'installed';
      reg.skills = reg.skills.filter((e) => e.name !== 'tasks');
    } });
    const confirm = await render('settings');
    await click('Meeting debriefs');
    expect(confirm).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t turn Meeting debriefs on: it needs Projects and tasks, which isn’t available on this install.');
  });

  it('says when an on capability needs one that is off, and shows locked ones as they really are', async () => {
    stub({ edit: (reg) => {
      reg.skills.find((e) => e.name === 'tasks')!.state = 'installed';
      reg.skills.find((e) => e.name === 'meetings')!.state = 'installed';
    } });
    await render('setup');
    expect(host!.textContent).toContain('Needs Projects and tasks');
    // Meetings' lock never claims it is on: its bundle is off here, its tools on.
    expect(sw('Meetings').getAttribute('aria-checked')).toBe('mixed');
    expect(sw('Meetings').disabled).toBe(true);
    expect(sw('Meeting debriefs').getAttribute('aria-describedby')).toBe('cap-debriefs-state cap-debriefs-desc');
  });

  it('in Setup, shows Email triage as it really is, still locked', async () => {
    stub({ edit: (reg) => {
      reg.agents.find((e) => e.name === 'ceo-inbox')!.state = 'enabled';
      for (const b of ['ceo-inbox', 'learning']) reg.skills.find((e) => e.name === b)!.state = 'enabled';
    } });
    await render('setup');
    expect(sw('Email triage').getAttribute('aria-checked')).toBe('true');
    expect(sw('Email triage').disabled).toBe(true);
  });

  it('a switch left partly on by a failed turn-off finishes turning it off', async () => {
    let failWeb = true;
    const posts: string[] = [];
    const reg = registry();
    vi.stubGlobal('fetch', vi.fn(async (path: string, _init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const list = /^\/api\/registry\/(agents|skills|tools)$/.exec(path);
      if (list) return json(200, { [list[1]!]: reg[list[1] as 'agents'] });
      const act = /^\/api\/registry\/(agents|skills|tools)\/([^/]+)\/(install-enable|disable)$/.exec(path)!;
      posts.push(`${act[3]} ${act[1]}/${act[2]}`);
      if (act[2] === 'web' && failWeb) return json(500, { error: 'Operation failed. Check server logs.' });
      reg[act[1] as 'agents'].find((x) => x.name === act[2])!.state = act[3] === 'disable' ? 'installed' : 'enabled';
      return json(200, {});
    }));
    await render('settings');
    await click('Web research');
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Part of it changed');
    expect(sw('Web research').getAttribute('aria-checked')).toBe('mixed');
    failWeb = false;
    posts.length = 0;
    await click('Web research');
    // Off again (the coordinator warning is confirmed), never back on.
    expect(posts).toEqual(['disable skills/web']);
    expect(sw('Web research').getAttribute('aria-checked')).toBe('false');
  });

  it('names what is missing, and lets the rest that still runs be turned off', async () => {
    const { posts } = stub({ edit: (reg) => {
      reg.agents.find((e) => e.name === 'ceo-inbox')!.state = 'enabled';
      reg.skills.find((e) => e.name === 'ceo-inbox')!.state = 'enabled';
      reg.skills.find((e) => e.name === 'learning')!.manifestError = 'bad yaml';
    } });
    await render('settings');
    expect(host!.textContent).toContain('Not available: learning is missing or broken. The rest is on');
    expect(sw('Email triage').getAttribute('aria-checked')).toBe('mixed');
    await click('Email triage');
    expect(posts).toEqual(['disable agents/ceo-inbox', 'disable skills/ceo-inbox']);
  });

  it('a failed re-read after a switch keeps its outcome and locks the stale switches', async () => {
    const { reg } = stub();
    let calls = 0;
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/registry/skills' && ++calls > 1) return new Response(JSON.stringify({ error: 'db down' }), { status: 500, headers: { 'content-type': 'application/json' } });
      return real(path, init);
    }));
    void reg;
    await render('settings');
    await click('Meeting debriefs');
    expect(host!.querySelector('[role="alert"]')!.textContent)
      .toBe('Meeting debriefs off. It applies after a restart. Couldn’t read Curia’s capabilities: db down Reload the page to see where things are.');
    expect(host!.querySelectorAll('[role="checkbox"]').length).toBe(6);
    expect(sw('Web research').disabled).toBe(true);
  });

  it('in Setup, keeps Meetings on and Email triage off, both locked', async () => {
    stub();
    await render('setup');
    expect(sw('Meetings').disabled).toBe(true);
    expect(sw('Meetings').getAttribute('aria-checked')).toBe('true');
    expect(sw('Email triage').disabled).toBe(true);
    expect(sw('Email triage').getAttribute('aria-checked')).toBe('false');
    expect(host!.textContent).toContain('Left for Dana to choose, later in Settings');
  });
});
