// @vitest-environment happy-dom
// The setup guide panel (#2358, PR 4): step markers in the thread, the composer draft the
// "Need help?" link fills, and when the guide opens by itself.
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatComposer } from '../chat/ChatComposer.js';
import type { Message } from '../chat/types.js';
import { withStepMarkers } from './SetupGuidePanel.js';
import { isFirstRun, type Checklist, type ChecklistTask } from './setup-steps.js';

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

describe('isFirstRun', () => {
  const task = (id: string, status: 'done' | 'pending', optional = false): ChecklistTask =>
    ({ id, label: id, optional, status, credential_how_to: null, docs_url: null });
  const checklist = (tasks: ChecklistTask[]): Checklist => ({ setupFor: null, tasks, setupComplete: false, missing: [] });

  it('is a first run until anything is saved', () => {
    expect(isFirstRun(checklist([task('who', 'pending'), task('working_style', 'done', true)]), { setupFor: null })).toBe(true);
    // Optional extras that are always done don't count.
    expect(isFirstRun(checklist([task('who', 'pending')]), { setupFor: 'other' })).toBe(false);
    expect(isFirstRun(checklist([task('curia_name', 'done')]), { setupFor: null })).toBe(false);
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
    // The same link clicked again offers the text again.
    render({ text: 'I’m on the Email step. ', seq: 2 });
    expect(box().value).toBe('I’m on the Email step. ');
  });
});
