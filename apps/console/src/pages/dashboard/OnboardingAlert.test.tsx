// @vitest-environment happy-dom
// The dashboard's onboarding alert (#2360): shown only when GET /api/onboarding/status asks.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OnboardingAlert } from './OnboardingAlert.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(showDashboardAlert: boolean) {
  return {
    started: false, taskId: null, showDashboardAlert, workingPrincipalSignals: [],
    route: 'app', setupFor: 'other', principalName: 'Dana Example', triageHeld: false,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(showDashboardAlert: boolean): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path !== '/api/onboarding/status') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(status(showDashboardAlert)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<OnboardingAlert />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('OnboardingAlert', () => {
  it('stays hidden when the status says not to show it', async () => {
    await render(false);
    expect(host!.textContent).toBe('');
  });

  it('shows Start onboarding while onboarding hasn’t started', async () => {
    await render(true);
    expect(host!.textContent).toContain('Onboarding hasn’t started.');
    expect(host!.textContent).toContain('Start when Dana is ready.');
    expect(host!.querySelector('button')!.textContent).toBe('Start onboarding');
  });
});
