// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CardFields } from './CardFields.js';
import { EMPTY_CARD_FORM, type CardFormMode } from '../pages/card-form-utils.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(mode: CardFormMode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<CardFields mode={mode} state={EMPTY_CARD_FORM} onChange={() => {}} errors={{}} />);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('CardFields', () => {
  it('sets cc-* autocomplete', () => {
    const el = render('full');
    const ac = (sel: string) => el.querySelector(sel)?.getAttribute('autocomplete');
    expect(ac('#card-number')).toBe('cc-number');
    expect(ac('#card-exp-month')).toBe('cc-exp-month');
    expect(ac('#card-exp-year')).toBe('cc-exp-year');
    expect(ac('#card-cvv')).toBe('cc-csc');
    expect(ac('#card-name')).toBe('cc-name');
    expect(ac('#card-zip')).toBe('postal-code');
    expect(el.querySelector('#card-cvv')?.getAttribute('type')).toBe('password');
    expect(el.querySelector('#card-number')?.getAttribute('inputmode')).toBe('numeric');
  });

  it('lists months with names and 16 years', () => {
    const el = render('full');
    const months = [...el.querySelectorAll('#card-exp-month option')].map(o => o.textContent);
    expect(months).toContain('01 – January');
    expect(months).toContain('12 – December');
    expect(el.querySelectorAll('#card-exp-year option')).toHaveLength(17); // placeholder + 16
  });

  it('renewal shows only expiry and cvv; edit-public hides number and cvv', () => {
    const r = render('renewal');
    expect(r.querySelector('#card-number')).toBeNull();
    expect(r.querySelector('#card-cvv')).not.toBeNull();
    expect(r.querySelector('#card-name')).toBeNull();
    act(() => root!.unmount());
    r.remove();
    const e = render('edit-public');
    expect(e.querySelector('#card-number')).toBeNull();
    expect(e.querySelector('#card-cvv')).toBeNull();
    expect(e.querySelector('#card-label')).not.toBeNull();
    expect(e.querySelector('#card-name')).not.toBeNull();
  });
});
