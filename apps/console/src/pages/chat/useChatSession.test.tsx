// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSession } from './useChatSession.js';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api.js', () => ({ apiFetch }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState: number = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

interface Row {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html?: string | null;
  timestamp?: string;
}

let historyStatus = 200;
let history: Row[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

function row(id: string, role: Row['role'], content: string): Row {
  return { id, role, content, html: null, timestamp: '2026-10-01T00:00:00.000Z' };
}

function Probe(): ReactElement {
  const session = useChatSession();
  return (
    <div>
      <p data-testid="error">{session.connectionError ?? ''}</p>
      <p data-testid="sending">{session.sending ? 'yes' : 'no'}</p>
      <ul>
        {session.messages.map((message) => (
          <li key={message.id} data-id={message.id} data-kind={message.kind}>{message.text}</li>
        ))}
      </ul>
      <button type="button" data-testid="send-q2" onClick={() => { void session.send('q2'); }}>send-q2</button>
      <button type="button" data-testid="send-again" onClick={() => { void session.send('again'); }}>send-again</button>
      <button type="button" data-testid="send-ok" onClick={() => { void session.send('ok'); }}>send-ok</button>
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await flush();
}

function texts(): string[] {
  return [...(container?.querySelectorAll('li') ?? [])].map((node) => node.textContent ?? '');
}

function latestSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error('no event source');
  return source;
}

beforeEach(() => {
  historyStatus = 200;
  history = [row('q1', 'user', 'q1'), row('r1', 'assistant', 'first reply')];
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  apiFetch.mockImplementation((path: string) => {
    if (String(path).startsWith('/api/chat/conversation')) {
      return Promise.resolve(json(200, { conversationId: 'conv-1' }));
    }
    if (String(path).startsWith('/api/chat/history')) {
      if (historyStatus !== 200) return Promise.resolve(json(historyStatus, {}));
      return Promise.resolve(json(200, { messages: history, hasMore: false }));
    }
    if (String(path) === '/api/chat/messages') {
      return Promise.resolve(json(202, { conversationId: 'conv-1' }));
    }
    return Promise.resolve(json(404, {}));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.removeItem('curia:onboarding:welcome-banner-pending');
});

describe('useChatSession catch-up', () => {
  it('does not settle a new turn with the previous reply', async () => {
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(['q1', 'first reply']);

    latestSource().close();
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container?.querySelector('[data-testid="sending"]')?.textContent).toBe('yes');

    await act(async () => { latestSource().open(); });
    await flush();
    expect(container?.querySelector('[data-testid="sending"]')?.textContent).toBe('yes');
    expect(texts().filter((text) => text === 'first reply')).toHaveLength(1);
  });

  it('keeps older rows when catch-up returns only the newest page', async () => {
    history = [
      row('q1', 'user', 'q1'),
      row('r1', 'assistant', 'first reply'),
      row('q2', 'user', 'q2'),
      row('r2', 'assistant', 'second'),
    ];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    history = [row('q2', 'user', 'q2'), row('r2', 'assistant', 'second'), row('q3', 'user', 'q3'), row('r3', 'assistant', 'third')];
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(['q1', 'first reply', 'q2', 'second', 'q3', 'third']);
  });

  it('does not swallow the next reply that repeats the caught-up text', async () => {
    history = [row('q1', 'user', 'q1'), row('r1', 'assistant', 'Done.')];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    history = [
      row('q1', 'user', 'q1'),
      row('r1', 'assistant', 'Done.'),
      row('q2-row', 'user', 'q2'),
      row('r2', 'assistant', 'Done.'),
    ];
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts().filter((text) => text === 'Done.')).toHaveLength(2);

    await act(async () => {
      container?.querySelectorAll('button')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      latestSource().emit({ type: 'message', content: 'Done.', html: null });
    });
    expect(texts().filter((text) => text === 'Done.')).toHaveLength(3);
  });

  it('clears the retry banner when the tab returns after the first load failed', async () => {
    historyStatus = 503;
    await mount();
    expect(container?.querySelector('[data-testid="error"]')?.textContent).toContain("Can't reach Curia");
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    historyStatus = 200;
    history = [row('q1', 'user', 'q1'), row('r1', 'assistant', 'back')];
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(container?.querySelector('[data-testid="error"]')?.textContent).toBe('');
    expect(texts()).toEqual(['q1', 'back']);
  });

  it('does not settle a repeated ok with the previous reply', async () => {
    history = [row('q1', 'user', 'q1'), row('r1', 'assistant', 'first')];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await act(async () => {
      container?.querySelector('[data-testid="send-ok"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      latestSource().emit({ type: 'message', content: 'Done.', html: null });
    });
    latestSource().close();
    history = [
      row('q1', 'user', 'q1'),
      row('r1', 'assistant', 'first'),
      row('srv-ok', 'user', 'ok'),
      row('srv-done', 'assistant', 'Done.'),
    ];
    await act(async () => {
      container?.querySelector('[data-testid="send-ok"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => { latestSource().open(); });
    await flush();
    expect(container?.querySelector('[data-testid="sending"]')?.textContent).toBe('yes');
    expect(texts().filter((text) => text === 'Done.')).toHaveLength(1);
    expect(texts().filter((text) => text === 'ok')).toHaveLength(2);
  });

  it('posts the onboarding kickoff once when the tab comes online during load', async () => {
    history = [];
    localStorage.setItem('curia:onboarding:welcome-banner-pending', '1');
    let releaseHistory: () => void = () => {};
    const historyGate = new Promise<Response>((resolve) => {
      releaseHistory = () => resolve(json(200, { messages: [], hasMore: false }));
    });
    let posts = 0;
    apiFetch.mockImplementation((path: string) => {
      if (String(path).startsWith('/api/chat/conversation')) {
        return Promise.resolve(json(200, { conversationId: 'conv-1' }));
      }
      if (String(path).startsWith('/api/chat/history')) return historyGate;
      if (String(path) === '/api/chat/messages') {
        posts += 1;
        return Promise.resolve(json(202, { conversationId: 'conv-1' }));
      }
      return Promise.resolve(json(404, {}));
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    await flush();
    window.dispatchEvent(new Event('online'));
    releaseHistory();
    await flush();
    await act(async () => { latestSource().open(); });
    await flush();
    expect(posts).toBe(1);
    expect(texts()).toContain('Just finished setup — say hi!');
  });

  it('ignores the echo of the message this tab just sent', async () => {
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await act(async () => {
      container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const sent = container?.querySelector('li:last-child');
    expect(sent?.textContent).toBe('q2');
    const clientId = sent?.getAttribute('data-id');
    await act(async () => {
      latestSource().emit({
        type: 'user.message',
        content: 'q2',
        client_message_id: clientId,
      });
    });
    expect(texts().filter((text) => text === 'q2')).toEqual(['q2']);
    await act(async () => {
      latestSource().emit({
        type: 'user.message',
        content: 'from the phone',
        client_message_id: 'other-device',
      });
    });
    expect(texts()).toContain('from the phone');
  });
});
