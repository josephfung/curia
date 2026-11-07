// @vitest-environment happy-dom
// Capture page (#1358): card templates post {card}; plain tokens keep the textarea.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; init?: RequestInit };
const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  meta: {} as Record<string, unknown>,
  postStatus: 200,
  postBody: {} as Record<string, unknown>,
}));

vi.mock('../api.js', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    mocks.calls.push({ path, init });
    const isPost = init?.method === 'POST';
    const body = isPost ? mocks.postBody : mocks.meta;
    return new Response(JSON.stringify(body), {
      status: isPost ? mocks.postStatus : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ token: 'tok123' }) }));

const { default: SecretCapturePage } = await import('./SecretCapturePage.js');

let root: Root;
let host: HTMLElement;

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<SecretCapturePage />); });
}

function setValue(sel: string, value: string): void {
  const el = host.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function fillCard(): void {
  setValue('#card-number', '4111 1111 1111 1111');
  setValue('#card-exp-month', '03');
  setValue('#card-exp-year', String(new Date().getFullYear() + 3));
  setValue('#card-cvv', '123');
  setValue('#card-name', 'Ada Lovelace');
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.postStatus = 200;
  mocks.postBody = { ok: true };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('SecretCapturePage', () => {
  it('capture page posts {card} for a card template and clears on success', async () => {
    mocks.meta = { label: 'Work Visa', value_format: 'json', capture_template: 'credit_card' };
    await mount();
    fillCard();
    await submit();
    const post = mocks.calls.find(c => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({
      card: {
        number: '4111111111111111',
        cvv: '123',
        expiry_month: '03',
        expiry_year: String(new Date().getFullYear() + 3),
        cardholder_name: 'Ada Lovelace',
      },
    });
    expect(host.textContent).toContain('Saved.');
    expect(host.querySelector('#card-number')).toBeNull();
    expect(host.innerHTML).not.toContain('4111');
  });

  it('shows the server message on a 400 and keeps the form', async () => {
    mocks.meta = { label: 'Work Visa', value_format: 'json', capture_template: 'credit_card' };
    mocks.postStatus = 400;
    mocks.postBody = { error: 'This card has expired.' };
    await mount();
    fillCard();
    await submit();
    expect(host.textContent).toContain('This card has expired.');
    expect(host.querySelector('#card-number')).not.toBeNull();
  });

  it('renewal shows the card header and posts only expiry and cvv', async () => {
    mocks.meta = {
      label: 'Work Visa', value_format: 'json', capture_template: 'credit_card_renewal',
      card: { brand: 'visa', last4: '1111', label: 'Work' },
    };
    await mount();
    expect(host.textContent).toContain('Visa ••1111');
    expect(host.querySelector('#card-number')).toBeNull();
    setValue('#card-exp-month', '03');
    setValue('#card-exp-year', String(new Date().getFullYear() + 3));
    setValue('#card-cvv', '123');
    await submit();
    const post = mocks.calls.find(c => c.init?.method === 'POST')!;
    expect(Object.keys(JSON.parse(post.init!.body as string).card).sort()).toEqual(['cvv', 'expiry_month', 'expiry_year']);
  });

  it('capture page never writes storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    mocks.meta = { label: 'Work Visa', value_format: 'json', capture_template: 'credit_card' };
    await mount();
    fillCard();
    await submit();
    expect(local).not.toHaveBeenCalled();
  });

  it('textarea still shown for a plain token', async () => {
    mocks.meta = { label: 'API key', value_format: 'string' };
    await mount();
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('#card-number')).toBeNull();
    setValue('textarea', 'abc');
    await submit();
    const post = mocks.calls.find(c => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ value: 'abc' });
  });
});
