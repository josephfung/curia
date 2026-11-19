// @vitest-environment happy-dom
// The Setup page's radio cards follow the WAI-ARIA radio pattern (#2358): one tab stop,
// arrow keys move the selection and the focus.
import { describe, it, expect, afterEach } from 'vitest';
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChoiceGroup } from './setup-ui.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Route = 'app' | 'signal' | 'sms';

function Harness({ initial }: { initial: Route | null }): JSX.Element {
  const [value, setValue] = useState<Route | null>(initial);
  return (
    <ChoiceGroup<Route>
      label="Messaging route"
      value={value}
      onChange={setValue}
      options={[
        { value: 'app', title: 'Curia app', description: 'a' },
        { value: 'signal', title: 'Signal', description: 's' },
        { value: 'sms', title: 'Text message', description: 't' },
      ]}
    />
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(initial: Route | null): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness initial={initial} />));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const radios = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const checked = (): string[] => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent ?? '');

function press(el: HTMLElement, key: string): void {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

describe('ChoiceGroup', () => {
  it('has one tab stop: the checked card', () => {
    mount('signal');
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('makes the first card the tab stop when none is checked', () => {
    mount(null);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves the selection and the focus with the arrow keys, wrapping at the ends', () => {
    mount('app');
    const [app, signal, sms] = radios();
    app!.focus();
    press(app!, 'ArrowDown');
    expect(checked()).toEqual(['Signals']);
    expect(document.activeElement).toBe(signal);
    press(signal!, 'ArrowRight');
    expect(document.activeElement).toBe(sms);
    press(sms!, 'ArrowDown');
    expect(checked()[0]).toMatch(/^Curia app/);
    press(app!, 'ArrowUp');
    expect(checked()[0]).toMatch(/^Text message/);
    expect(document.activeElement).toBe(sms);
  });

  it('ignores other keys', () => {
    mount('app');
    press(radios()[0]!, 'a');
    expect(checked()[0]).toMatch(/^Curia app/);
  });
});
