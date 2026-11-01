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

  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
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
let historyUrls: string[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let session: ReturnType<typeof useChatSession> | null = null;

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

// Rows with increasing timestamps, so the fake can page with `before`.
let seq = 0;
function saved(id: string, role: Row['role'], content: string): Row {
  seq += 1;
  const timestamp = new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
  return { id, role, content, html: null, timestamp };
}

/** The newest `limit` rows older than `before`, as GET /api/chat/history pages them. */
function historyPage(path: string): { messages: Row[]; hasMore: boolean } {
  const params = new URL(path, 'http://localhost').searchParams;
  const limit = Number(params.get('limit') ?? '25');
  const before = params.get('before');
  const older = before ? history.filter((item) => (item.timestamp ?? '') < before) : history;
  return { messages: older.slice(-limit), hasMore: older.length > limit };
}

function Probe(): ReactElement {
  const current = useChatSession();
  session = current;
  return (
    <div>
      <p data-testid="error">{current.connectionError ?? ''}</p>
      <p data-testid="sending">{current.sending ? 'yes' : 'no'}</p>
      <p data-testid="has-more">{current.hasMore ? 'yes' : 'no'}</p>
      <ul>
        {current.messages.map((message) => (
          <li key={message.id} data-id={message.id} data-kind={message.kind}>{message.text}</li>
        ))}
      </ul>
      <button type="button" data-testid="send-q2" onClick={() => { void current.send('q2'); }}>send-q2</button>
      <button type="button" data-testid="send-again" onClick={() => { void current.send('again'); }}>send-again</button>
      <button type="button" data-testid="send-ok" onClick={() => { void current.send('ok'); }}>send-ok</button>
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
  historyUrls = [];
  seq = 0;
  history = [row('q1', 'user', 'q1'), row('r1', 'assistant', 'first reply')];
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  apiFetch.mockImplementation((path: string) => {
    if (String(path).startsWith('/api/chat/conversation')) {
      return Promise.resolve(json(200, { conversationId: 'conv-1' }));
    }
    if (String(path).startsWith('/api/chat/history')) {
      historyUrls.push(String(path));
      if (historyStatus !== 200) return Promise.resolve(json(historyStatus, {}));
      return Promise.resolve(json(200, historyPage(String(path))));
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
  session = null;
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
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

  it('posts once when two sends start while the thread id is loading', async () => {
    let releaseThread: () => void = () => {};
    const threadGate = new Promise<Response>((resolve) => {
      releaseThread = () => resolve(json(200, { conversationId: 'conv-1' }));
    });
    let posts = 0;
    apiFetch.mockImplementation((path: string) => {
      if (String(path).startsWith('/api/chat/conversation')) return threadGate;
      if (String(path).startsWith('/api/chat/history')) {
        return Promise.resolve(json(200, historyPage(String(path))));
      }
      if (String(path) === '/api/chat/messages') {
        posts += 1;
        return Promise.resolve(json(202, { conversationId: 'conv-1' }));
      }
      return Promise.resolve(json(404, {}));
    });
    await mount();
    await act(async () => {
      container?.querySelector('[data-testid="send-q2"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      container?.querySelector('[data-testid="send-again"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    releaseThread();
    await flush();
    await act(async () => { latestSource().open(); });
    await flush();
    expect(posts).toBe(1);
    expect(texts().filter((text) => text === 'q2' || text === 'again')).toHaveLength(1);
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

function sending(): string | null | undefined {
  return container?.querySelector('[data-testid="sending"]')?.textContent;
}

async function setVisibility(state: 'visible' | 'hidden'): Promise<void> {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function sendText(text: string): Promise<void> {
  await act(async () => { await session!.send(text); });
  await flush();
}

/** A turn this tab sends and gets the reply to live. The server saves both rows. */
async function liveTurn(question: string, reply: string): Promise<void> {
  await sendText(question);
  history.push(saved(`srv-${question}`, 'user', question));
  history.push(saved(`srv-${reply}`, 'assistant', reply));
  await act(async () => {
    latestSource().emit({ type: 'message', content: reply, html: null });
  });
  await flush();
}

describe('useChatSession reconnect', () => {
  it('reconnects after a stream error and catches up on open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    const first = latestSource();
    await act(async () => { first.fail(); });
    expect(FakeEventSource.instances).toHaveLength(1);
    history = [...history, row('q-phone', 'user', 'from the phone'), row('r-phone', 'assistant', 'phone reply')];
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(['q1', 'first reply', 'from the phone', 'phone reply']);
  });

  it('renders a reply that landed while hidden and settles the turn', async () => {
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await sendText('q2');
    expect(sending()).toBe('yes');
    await setVisibility('hidden');
    expect(latestSource().readyState).toBe(FakeEventSource.CLOSED);
    history = [...history, row('q2-row', 'user', 'q2'), row('r2-row', 'assistant', 'second reply')];
    await setVisibility('visible');
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(['q1', 'first reply', 'q2', 'second reply']);
    expect(sending()).toBe('no');
    // The same reply replayed on the stream is not shown twice.
    await act(async () => {
      latestSource().emit({ type: 'message', content: 'second reply', html: null });
    });
    expect(texts().filter((text) => text === 'second reply')).toHaveLength(1);
  });

  it('replaces a half-open socket when the browser comes back online', async () => {
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    const halfOpen = latestSource();
    history = [...history, row('q-phone', 'user', 'from the phone')];
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(halfOpen.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(['q1', 'first reply', 'from the phone']);
  });

  it('does not settle a repeated ok with the previous reply after a stream error', async () => {
    history = [saved('q1', 'user', 'q1'), saved('r1', 'assistant', 'first')];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await liveTurn('ok', 'Done.');
    expect(sending()).toBe('no');
    await act(async () => { latestSource().fail(); });
    // send() opens a new stream and waits for it before posting.
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = session!.send('ok'); });
    await act(async () => { latestSource().open(); });
    await act(async () => { await pending; });
    await flush();
    expect(sending()).toBe('yes');
    expect(texts()).toEqual(['q1', 'first', 'ok', 'Done.', 'ok']);
  });
});

describe('useChatSession catch-up across pages', () => {
  it('keeps every row after 13 live turns and needs one page next time', async () => {
    history = [saved('q0', 'user', 'q0'), saved('r0', 'assistant', 'r0')];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    for (let i = 1; i <= 13; i += 1) await liveTurn(`q${i}`, `r${i}`);
    const before = texts();
    expect(before).toHaveLength(28);

    historyUrls = [];
    await setVisibility('hidden');
    await setVisibility('visible');
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(before);
    expect(historyUrls).toHaveLength(2);
    expect(container?.querySelector('[data-testid="has-more"]')?.textContent).toBe('no');

    // The live rows now carry their server ids, so one page anchors.
    await liveTurn('q14', 'r14');
    historyUrls = [];
    await setVisibility('hidden');
    await setVisibility('visible');
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual([...before, 'q14', 'r14']);
    expect(historyUrls).toHaveLength(1);
  });

  it('pages back over a gap larger than one page and keeps the order', async () => {
    history = [
      saved('ok-old', 'user', 'ok'),
      saved('done-old', 'assistant', 'Done.'),
      saved('a2', 'user', 'a2'),
      saved('b2', 'assistant', 'b2'),
    ];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await setVisibility('hidden');
    for (let i = 1; i <= 12; i += 1) history.push(saved(`p${i}`, 'user', `p${i}`), saved(`pr${i}`, 'assistant', `pr${i}`));
    history.push(saved('ok-new', 'user', 'ok'));
    await setVisibility('visible');
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(history.map((item) => item.content));
  });

  it('replaces the thread after a gap of more than four pages, and loadMore fills the rest', async () => {
    history = [saved('a1', 'user', 'a1'), saved('b1', 'assistant', 'b1')];
    await mount();
    await act(async () => { latestSource().open(); });
    await flush();
    await setVisibility('hidden');
    for (let i = 1; i <= 60; i += 1) history.push(saved(`p${i}`, 'user', `p${i}`), saved(`pr${i}`, 'assistant', `pr${i}`));
    await setVisibility('visible');
    await act(async () => { latestSource().open(); });
    await flush();
    expect(texts()).toEqual(history.slice(-100).map((item) => item.content));
    expect(container?.querySelector('[data-testid="has-more"]')?.textContent).toBe('yes');

    await act(async () => { await session!.loadMore(); });
    await flush();
    expect(texts()).toEqual(history.map((item) => item.content));
  });
});
