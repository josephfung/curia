// @vitest-environment happy-dom
// The setup guide panel (#2358, PR 4): step markers in the thread, the composer draft the
// "Need help?" link fills, and the greeting on an empty thread.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatComposer } from '../chat/ChatComposer.js';
import type { Message } from '../chat/types.js';
import { SETUP_GUIDE_GREETING, SetupGuidePanel, withStepMarkers } from './SetupGuidePanel.js';

// The panel's own logic, over a stand-in chat session (useChatSession has its own tests).
const chat = vi.hoisted(() => ({
  state: { messages: [] as Message[], loadingHistory: false, historyLoaded: true },
}));
vi.mock('../chat/useChatSession.js', () => ({
  useChatSession: () => ({
    messages: chat.state.messages, sending: false, hasMore: false, loadingHistory: chat.state.loadingHistory, historyLoaded: chat.state.historyLoaded,
    connectionError: null, send: async () => {}, loadMore: async () => {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const msg = (id: string, text: string): Message => ({ id, kind: 'user', text });

describe('withStepMarkers', () => {
  it('puts each marker after the message it followed, and early ones first', () => {
    const out = withStepMarkers(
      [msg('a', 'hi'), msg('b', 'hello'), msg('c', 'which key?')],
      [
        { id: 'm0', text: 'Now on: Email', afterId: null },
        { id: 'm1', text: 'Now on: Voice', afterId: 'b' },
      ],
    );
    expect(out.map((m) => m.text)).toEqual(['Now on: Email', 'hi', 'hello', 'Now on: Voice', 'which key?']);
    expect(out.find((m) => m.id === 'm1')!.kind).toBe('status');
  });

  it('keeps a marker whose message is no longer loaded, at the top', () => {
    const out = withStepMarkers([msg('x', 'newer')], [{ id: 'm', text: 'Now on: Email', afterId: 'gone' }]);
    expect(out.map((m) => m.text)).toEqual(['Now on: Email', 'newer']);
  });
});

describe('ChatComposer draft', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function render(draft?: { text: string; seq: number }): void {
    act(() => root!.render(<ChatComposer disabled={false} onSend={() => {}} draft={draft} />));
  }

  it('fills and focuses the composer with each new draft, and leaves typing alone otherwise', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    render();
    const box = () => host!.querySelector('textarea')!;
    expect(box().value).toBe('');
    render({ text: 'I’m on the Email step. ', seq: 1 });
    expect(box().value).toBe('I’m on the Email step. ');
    expect(document.activeElement).toBe(box());
    expect(host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    // A re-render with the same draft doesn't overwrite what the operator typed since.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box(), 'I’m on the Email step. Which key?');
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    render({ text: 'I’m on the Email step. ', seq: 1 });
    expect(box().value).toBe('I’m on the Email step. Which key?');
    // A new draft never replaces what is typed (Need help? after a close keeps the question)…
    render({ text: 'I’m on the Voice step. ', seq: 2 });
    expect(box().value).toBe('I’m on the Email step. Which key?');
    // …but fills an empty composer.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box(), '');
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    render({ text: 'I’m on the Voice step. ', seq: 3 });
    expect(box().value).toBe('I’m on the Voice step. ');
  });
});

describe('SetupGuidePanel', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    chat.state = { messages: [], loadingHistory: false, historyLoaded: true };
  });

  function render(step: 'email' | 'voice' | 'apply', extra: { notice?: string; onClose?: () => void; hidden?: boolean } = {}): void {
    if (!root) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    const names = { email: 'Email', voice: 'Voice', apply: 'Apply & restart' };
    act(() => root!.render(
      <SetupGuidePanel hidden={extra.hidden ?? false} step={step} stepName={names[step]} notice={extra.notice}
        onClose={extra.onClose ?? (() => {})} onShowSteps={() => {}} />,
    ));
  }
  // ChatThread scrolls with scrollTo, which happy-dom lacks.
  Element.prototype.scrollTo ??= function scrollTo() {};
  const lines = () => Array.from(host!.querySelectorAll('.msg-bubble')).map((b) => b.textContent);

  it('marks a step change after the message that was last', () => {
    chat.state.messages = [msg('a', 'which key?')];
    render('email');
    render('voice');
    chat.state.messages = [msg('a', 'which key?'), msg('b', 'and this one?')];
    render('voice');
    expect(lines()).toEqual(['which key?', 'Now on: Voice', 'and this one?']);
  });

  // The hook's real state before its first history request: not loading, nothing loaded.
  const beforeHistory = () => ({ messages: [] as Message[], loadingHistory: false, historyLoaded: false });

  it('records no marker before the history has loaded', () => {
    chat.state = beforeHistory();
    render('email');
    render('voice');
    chat.state = { messages: [msg('a', 'older question')], loadingHistory: false, historyLoaded: true };
    render('voice');
    expect(lines()).toEqual(['older question']);
  });

  it('shows no greeting before the history has loaded, nor above a thread that has one', () => {
    chat.state = beforeHistory();
    render('email');
    expect(lines()).toEqual([]);
    chat.state = { ...beforeHistory(), loadingHistory: true };
    render('email');
    chat.state = { messages: [msg('a', 'older question')], loadingHistory: false, historyLoaded: true };
    render('email');
    expect(lines()).toEqual(['older question']);
  });

  it('greets on an empty thread once the history has loaded, and keeps the greeting at the top', () => {
    chat.state = beforeHistory();
    render('email');
    expect(lines()).toEqual([]);
    chat.state = { messages: [], loadingHistory: false, historyLoaded: true };
    render('email');
    expect(lines()).toEqual([SETUP_GUIDE_GREETING.text]);
    chat.state.messages = [msg('a', 'which key?')];
    render('email');
    expect(lines()).toEqual([SETUP_GUIDE_GREETING.text, 'which key?']);
  });

  it('scrolls to the newest message when it opens again', () => {
    chat.state.messages = [msg('a', 'which key?')];
    render('email', { hidden: true });
    const thread = host!.querySelector<HTMLElement>('.chat-messages')!;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 900 });
    thread.scrollTop = 0;
    render('email', { hidden: false });
    expect(thread.scrollTop).toBe(900);
  });

  it('closes on Escape and shows why messages may not reach the guide', () => {
    const onClose = vi.fn();
    render('email', { notice: 'Couldn’t start Setup (HTTP 500).', onClose });
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t start Setup (HTTP 500).');
    act(() => {
      host!.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
