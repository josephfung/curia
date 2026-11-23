// @vitest-environment happy-dom
// "Who it's for", the first Setup step (#2358, #2710).
//
// Two things this file pins, both from the #2710 review:
//   - The principal and their profile are saved on the first press whatever happens to the
//     operator's confirmation notice. A notice that cannot be sent must never leave step 1
//     without the principal's name, email, timezone, title and pronouns.
//   - An undeliverable notice is not framed as a mistake. On a fresh install the notice is
//     owed (Curia has no email account yet), the step says so plainly, and one more press
//     moves on.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveSetupFieldsResult, SetupFields } from './setup-api.js';

const saveSetupFields = vi.fn();
const postJson = vi.fn();

vi.mock('./setup-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./setup-api.js')>();
  return {
    ...actual,
    saveSetupFields: (...args: unknown[]) => saveSetupFields(...args),
    postJson: (...args: unknown[]) => postJson(...args),
  };
});

const { WhoStep } = await import('./WhoStep.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: SetupFields = {
  setupFor: 'self',
  operatorName: null,
  operatorEmail: null,
  messagingRoute: null,
  voiceRoute: null,
};

interface Page { host: HTMLDivElement; root: Root | null }
const pages: Page[] = [];

function newPage(): Page {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const page = { host, root: null };
  pages.push(page);
  return page;
}

afterEach(() => {
  for (const page of pages) {
    act(() => page.root?.unmount());
    page.host.remove();
  }
  pages.length = 0;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function field(page: Page, label: string): HTMLInputElement {
  const match = Array.from(page.host.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
  if (!match) throw new Error(`no field labelled ${label}`);
  return match.querySelector('input') as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(page: Page): Promise<void> {
  const form = page.host.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}

/** "Someone else" chosen, with the operator and the principal filled in. */
async function mountOtherStep(
  onContinue: () => void,
  confirmation: SaveSetupFieldsResult['operatorConfirmation'],
): Promise<Page> {
  const page = newPage();
  await act(async () => {
    page.root = createRoot(page.host);
    page.root.render(createElement(WhoStep, {
      fields: { ...FIELDS, setupFor: 'other' },
      principal: null,
      onSaved: async () => {},
      onContinue,
    }));
  });
  await settle();

  type(field(page, 'Your name'), 'Sam Rivera');
  type(field(page, 'Your email'), 'sam@example.com');
  type(field(page, 'Full name'), 'Avery Example');
  type(field(page, 'Email'), 'avery@example.com');

  saveSetupFields.mockResolvedValue({ setup: FIELDS, operatorConfirmation: confirmation });
  postJson.mockResolvedValue({});
  return page;
}

beforeEach(() => {
  saveSetupFields.mockReset();
  postJson.mockReset();
});

describe('WhoStep — the operator confirmation never costs the principal their profile (#2710)', () => {
  it('saves the principal and the profile even when the notice cannot be sent yet', async () => {
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'pending', email: 'sam@example.com' });

    await submit(page);

    // The whole step is saved: the principal's name, then their profile.
    expect(postJson).toHaveBeenCalledWith('/api/setup/principal', expect.objectContaining({ name: 'Avery Example' }));
    expect(postJson).toHaveBeenCalledWith('/api/setup/principal/profile', expect.objectContaining({
      email: 'avery@example.com',
      timezone: expect.any(String),
    }));
    // The owed notice is stated plainly, not as a problem with the address.
    expect(page.host.textContent).toContain("We'll email sam@example.com to confirm once Curia's own email is set up.");
    expect(page.host.textContent).not.toContain('Check the address');
    // …and the step does not move on yet: one press more, after the notice is read.
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('moves on with one more press, saving nothing again', async () => {
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'pending', email: 'sam@example.com' });
    await submit(page);
    expect(postJson).toHaveBeenCalledTimes(2);

    await submit(page);

    expect(onContinue).toHaveBeenCalledOnce();
    // Nothing was written twice: the second press only continues.
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(saveSetupFields).toHaveBeenCalledOnce();
  });

  it('saves the principal too when the notice was sent, and continues straight away', async () => {
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'sent', email: 'sam@example.com' });

    await submit(page);

    expect(postJson).toHaveBeenCalledWith('/api/setup/principal', expect.anything());
    expect(postJson).toHaveBeenCalledWith('/api/setup/principal/profile', expect.anything());
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('saves an edit made after the notice, rather than continuing with the old values', async () => {
    // The pending notice is shown on every fresh "Someone else" install, so this path is the
    // normal one. A timezone changed after the first press must reach the profile (#2710 review).
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'pending', email: 'sam@example.com' });
    await submit(page);
    expect(onContinue).not.toHaveBeenCalled();

    const zone = page.host.querySelector('select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(zone, 'Europe/London');
      zone.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The edit clears the notice, so the next press saves instead of moving on.
    expect(page.host.textContent).not.toContain("We'll email sam@example.com");

    await submit(page);

    expect(postJson).toHaveBeenLastCalledWith('/api/setup/principal/profile', expect.objectContaining({
      timezone: 'Europe/London',
    }));
    // The notice is owed again for the re-save, so one more press moves on — and it does not
    // touch the profile a second time.
    saveSetupFields.mockResolvedValue({ setup: FIELDS, operatorConfirmation: { state: 'sent', email: 'sam@example.com' } });
    await submit(page);
    expect(postJson).toHaveBeenCalledTimes(4); // principal + profile, twice: once per save
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('switching to Myself after the notice saves that, rather than continuing as Someone else', async () => {
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'pending', email: 'sam@example.com' });
    await submit(page);
    expect(onContinue).not.toHaveBeenCalled();

    const myself = Array.from(page.host.querySelectorAll('[role="radio"]'))
      .find((r) => r.textContent?.startsWith('Myself')) as HTMLElement;
    act(() => { myself.click(); });
    // No operator, so no confirmation is owed and the step moves on after saving.
    saveSetupFields.mockResolvedValue({ setup: FIELDS, operatorConfirmation: { state: 'none' } });

    await submit(page);

    // The operator is cleared, and the step did not just move on with the old choice.
    expect(saveSetupFields).toHaveBeenLastCalledWith(expect.objectContaining({
      setupFor: 'self',
      operatorName: null,
      operatorEmail: null,
    }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('re-saves a corrected address instead of continuing with the one that failed', async () => {
    const onContinue = vi.fn();
    const page = await mountOtherStep(onContinue, { state: 'failed', email: 'sam@example.com' });
    await submit(page);

    type(field(page, 'Your email'), 'sam.rivera@example.com');
    saveSetupFields.mockResolvedValue({ setup: FIELDS, operatorConfirmation: { state: 'sent', email: 'sam.rivera@example.com' } });
    await submit(page);

    expect(saveSetupFields).toHaveBeenLastCalledWith(expect.objectContaining({ operatorEmail: 'sam.rivera@example.com' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
