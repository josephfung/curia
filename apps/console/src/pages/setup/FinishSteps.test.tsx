// @vitest-environment happy-dom
// The last Setup step (#2360): "Not right now" asks first, in words that depend on who Curia
// is set up for (design §3).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StartStep } from './FinishSteps.js';
import type { Checklist } from './setup-steps.js';
import type { SetupFor } from './setup-api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READY: Checklist = { setupFor: null, tasks: [], setupComplete: true, missing: [] };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(setupFor: SetupFor): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StartStep checklist={{ ...READY, setupFor }} principal="Dana" setupFor={setupFor} route="app" onRefresh={async () => {}} />);
  });
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)!;
  await act(async () => { button.click(); });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('StartStep — Not right now', () => {
  it('asks first, in the words for someone setting Curia up for themselves', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await render('self');
    await clickButton('Not right now');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Onboarding is where Curia learns how you like to work. It’s required before Curia acts for you. You can start it any time from the dashboard.');
    // Nothing is finished until the confirmation.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks first, in the words for someone setting Curia up for their principal', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await render('other');
    await clickButton('Not right now');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Onboarding is Dana’s first conversation with Curia. It’s required before Curia acts for them. Start it from the dashboard when they’re ready. Curia won’t contact them until you do.',
    );
  });
});
