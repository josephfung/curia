# Wizard Console Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the onboarding wizard from the legacy KG web app to the new React console app at `/setup`, with a first-run redirect when `configured: false`.

**Architecture:** Single `WizardPage.tsx` component at the top-level `/setup` route (standalone — no sidebar/topbar). Business logic extracted into pure-function `wizard-utils.ts` for testability. The TanStack Router auth guard extended to redirect first-time users to `/setup`.

**Tech Stack:** React 19, TanStack Router v1, TypeScript 6, Vite 8, Vitest

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console`
**Branch:** `feat/wizard-console`
**Design spec:** `docs/wip/2026-05-28-wizard-console-port-design.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `apps/console/src/pages/WizardPage.tsx` | Full-screen wizard component (4 steps) |
| Create | `apps/console/src/pages/wizard-utils.ts` | Pure functions: toggleTone, validate, buildPayload, preview bands |
| Create | `apps/console/src/pages/wizard-utils.test.ts` | Unit tests for wizard-utils |
| Modify | `apps/console/src/api.ts` | Add `getSessionInfo()`, refactor `checkSession()` to use it |
| Modify | `apps/console/src/router.tsx` | Add `/setup` route + first-run redirect in guard |
| Modify | `apps/console/src/styles/app.css` | Add wizard CSS classes |
| Modify | `src/channels/http/routes/kg.ts` | Remove wizard HTML, CSS, JS |
| Modify | `vitest.config.ts` | Add `apps/**/*.test.ts` to include list |
| Modify | `CHANGELOG.md` | Add Unreleased entry |

---

## Task 1: Extend vitest config to cover console app tests

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add console app glob to vitest include**

Open `vitest.config.ts` (currently 12 lines). Add `'apps/**/*.test.ts'` to the `include` array:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'src/**/*.test.ts',
      'skills/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test 2>&1 | tail -6
```

Expected: same pass count as baseline (2765 passed, 2 infrastructure failures unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add vitest.config.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "chore: include apps/**/*.test.ts in vitest"
```

---

## Task 2: Add `getSessionInfo()` to api.ts

**Files:**
- Modify: `apps/console/src/api.ts`
- Create: `apps/console/src/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/console/src/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSessionInfo, checkSession } from './api.js';

// Builds a minimal fetch mock that returns the given status + JSON body.
function mockFetch(status: number, body: unknown, ct = 'application/json') {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === 'content-type' ? ct : null) },
    json: () => Promise.resolve(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('getSessionInfo', () => {
  it('returns valid=true configured=true when identity is configured', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { identity: {}, configured: true }));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: true });
  });

  it('returns valid=true configured=false when not yet configured', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { identity: {}, configured: false }));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: false });
  });

  it('returns valid=false on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('returns valid=false on 403', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('treats non-auth server errors as valid (transient)', async () => {
    vi.stubGlobal('fetch', mockFetch(500, {}));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: true });
  });

  it('returns valid=false when response is HTML (SPA fallback)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '', 'text/html'));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('returns valid=false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });
});

describe('checkSession', () => {
  it('returns true when session is valid', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { configured: true }));
    expect(await checkSession()).toBe(true);
  });

  it('returns false when session is invalid', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));
    expect(await checkSession()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test -- --reporter=verbose 2>&1 | grep -E "getSessionInfo|checkSession|FAIL|PASS" | head -20
```

Expected: FAIL — `getSessionInfo` is not exported from api.ts yet.

- [ ] **Step 3: Implement getSessionInfo and refactor checkSession**

Replace the contents of `apps/console/src/api.ts` with:

```ts
// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export interface SessionInfo {
  valid: boolean;
  configured: boolean;
}

// Returns full session status including whether the instance is configured.
// Treats non-auth errors (5xx, network) as "valid but unknown configured state"
// to avoid forced logouts on transient backend hiccups.
export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await apiFetch('/api/identity');
    if (res.status === 401 || res.status === 403) return { valid: false, configured: false };
    if (!res.ok) return { valid: true, configured: true };
    // Guard against the SPA fallback: /api/identity can return index.html (200, text/html)
    // when identity routes are not registered. Treat that as unauthenticated.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { valid: false, configured: false };
    const data = await res.json() as { configured?: boolean };
    return { valid: true, configured: data.configured !== false };
  } catch (err) {
    console.error('[getSessionInfo] fetch failed, treating as unauthenticated:', err);
    return { valid: false, configured: false };
  }
}

export async function checkSession(): Promise<boolean> {
  return (await getSessionInfo()).valid;
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test -- --reporter=verbose 2>&1 | grep -E "getSessionInfo|checkSession|✓|×" | head -20
```

Expected: all 9 tests in `api.test.ts` pass.

- [ ] **Step 5: Typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console/apps/console run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add apps/console/src/api.ts apps/console/src/api.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "feat: add getSessionInfo() to api.ts with configured flag"
```

---

## Task 3: Update router.tsx — add `/setup` route + first-run redirect

**Files:**
- Modify: `apps/console/src/router.tsx`

No new tests for this task — the guard logic is covered by the integration test in Task 5. The goal here is to wire the route and guard correctly.

- [ ] **Step 1: Add the `/setup` route and update the auth guard**

Replace the full contents of `apps/console/src/router.tsx` with:

```ts
import { lazy, Suspense } from 'react';
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import LoginPage from './pages/LoginPage';
import { getSessionInfo } from './api';

// Route components are lazy-loaded so Vite produces separate chunks per route.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AutonomyPage = lazy(() =>
  import('./pages/SettingsPage').then(m => ({ default: m.AutonomyPage })),
);
const WorkspacePage = lazy(() =>
  import('./pages/SettingsPage').then(m => ({ default: m.WorkspacePage })),
);
const WizardPage = lazy(() => import('./pages/WizardPage'));

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  ),
});

// Layout route that guards all protected pages.
// Checks auth and first-run state in one shot to avoid a double-fetch.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ location }) => {
    const session = await getSessionInfo();
    if (!session.valid) throw redirect({ to: '/login' });
    // First-run redirect: push to /setup if not yet configured, unless already
    // heading there (avoids a redirect loop).
    if (!session.configured && location.pathname !== '/setup') {
      throw redirect({ to: '/setup', search: { step: 1 } });
    }
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: DashboardPage,
});

// Setup wizard — full-screen, no sidebar/topbar.
const setupRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/setup',
  validateSearch: (search: Record<string, unknown>) => ({
    step: typeof search['step'] === 'number'
      ? Math.max(1, Math.min(4, Math.round(search['step'] as number)))
      : 1,
  }),
  component: WizardPage,
});

// Settings layout route — bare /settings redirects to the default section.
const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  beforeLoad: ({ location }) => {
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: '/settings/autonomy' });
    }
  },
  component: () => (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  ),
});

const autonomyRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/autonomy',
  component: AutonomyPage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/workspace',
  component: WorkspacePage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    dashboardRoute,
    setupRoute,
    settingsRoute.addChildren([autonomyRoute, workspaceRoute]),
  ]),
  loginRoute,
]);

export const router = createRouter({ routeTree });

// Register router type for full type-safety on useNavigate, Link, etc.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console/apps/console run typecheck
```

Expected: no errors. (WizardPage.tsx doesn't exist yet so lazy() will type-error — that's expected. Confirm the router.tsx-specific types resolve cleanly by looking at errors: only the `Cannot find module './pages/WizardPage'` error is expected.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add apps/console/src/router.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "feat: add /setup route and first-run redirect to router"
```

---

## Task 4: Create wizard-utils.ts with TDD

**Files:**
- Create: `apps/console/src/pages/wizard-utils.ts`
- Create: `apps/console/src/pages/wizard-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/console/src/pages/wizard-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  toggleToneSelection,
  verbosityBand,
  directnessBand,
  tonePreviewText,
  verbosityReviewDesc,
  directnessReviewDesc,
  postureReviewDesc,
  validateStep1,
  buildIdentityPayload,
  type WizardState,
  type LocalIdentity,
} from './wizard-utils.js';

// ── toggleToneSelection ───────────────────────────────────────────────────────

describe('toggleToneSelection', () => {
  it('adds a word when under the max', () => {
    expect(toggleToneSelection(['warm'], 'direct')).toEqual(['warm', 'direct']);
  });

  it('removes a word when it is already selected', () => {
    expect(toggleToneSelection(['warm', 'direct'], 'warm')).toEqual(['direct']);
  });

  it('prevents removing the last word (min 1)', () => {
    expect(toggleToneSelection(['warm'], 'warm')).toEqual(['warm']);
  });

  it('prevents adding a 4th word (max 3)', () => {
    const current = ['warm', 'direct', 'calm'];
    expect(toggleToneSelection(current, 'witty')).toEqual(current);
  });

  it('allows toggling when exactly 3 are selected — remove one', () => {
    expect(toggleToneSelection(['warm', 'direct', 'calm'], 'calm'))
      .toEqual(['warm', 'direct']);
  });
});

// ── verbosityBand ─────────────────────────────────────────────────────────────

describe('verbosityBand', () => {
  it('returns brief copy at 0', () => {
    expect(verbosityBand(0)).toBe('"Here\'s the short answer."');
  });

  it('returns brief copy at 25', () => {
    expect(verbosityBand(25)).toBe('"Here\'s the short answer."');
  });

  it('returns concise copy at 26', () => {
    expect(verbosityBand(26)).toBe(
      '"Happy to help — let me know if you\'d like more detail."',
    );
  });

  it('returns thorough copy at 100', () => {
    expect(verbosityBand(100)).toBe('"Let me walk you through this thoroughly."');
  });
});

// ── directnessBand ────────────────────────────────────────────────────────────

describe('directnessBand', () => {
  it('returns hedged copy at 0', () => {
    expect(directnessBand(0)).toBe(
      '"There are a few things worth considering here — it\'s hard to say definitively."',
    );
  });

  it('returns direct copy at 100', () => {
    expect(directnessBand(100)).toBe('"Do it. The risk is low and the upside is clear."');
  });
});

// ── tonePreviewText ───────────────────────────────────────────────────────────

describe('tonePreviewText', () => {
  it('formats single word', () => {
    expect(tonePreviewText(['warm'])).toBe('Your tone is warm.');
  });

  it('formats two words with "and"', () => {
    expect(tonePreviewText(['warm', 'direct'])).toBe('Your tone is warm and direct.');
  });

  it('formats three words with Oxford comma + note', () => {
    expect(tonePreviewText(['warm', 'direct', 'calm'])).toBe(
      'Your tone is warm, direct and calm. (Pick up to 3)',
    );
  });

  it('returns empty string for empty array', () => {
    expect(tonePreviewText([])).toBe('');
  });
});

// ── verbosityReviewDesc / directnessReviewDesc / postureReviewDesc ────────────

describe('verbosityReviewDesc', () => {
  it('returns concise description at 50', () => {
    expect(verbosityReviewDesc(50)).toBe('Concise responses by default.');
  });
});

describe('directnessReviewDesc', () => {
  it('returns direct description at 75', () => {
    expect(directnessReviewDesc(75)).toBe('Direct — minimal unnecessary hedging.');
  });
});

describe('postureReviewDesc', () => {
  it('maps conservative', () => {
    expect(postureReviewDesc('conservative')).toBe(
      'Verifies before acting on external requests.',
    );
  });
  it('maps balanced', () => {
    expect(postureReviewDesc('balanced')).toBe('Acts when confident; flags when uncertain.');
  });
  it('maps proactive', () => {
    expect(postureReviewDesc('proactive')).toBe('Biases toward action with less checking in.');
  });
});

// ── validateStep1 ─────────────────────────────────────────────────────────────

describe('validateStep1', () => {
  it('returns true for a non-empty name', () => {
    expect(validateStep1('Alex')).toBe(true);
  });

  it('returns false for an empty name', () => {
    expect(validateStep1('')).toBe(false);
  });

  it('returns false for whitespace-only name', () => {
    expect(validateStep1('   ')).toBe(false);
  });
});

// ── buildIdentityPayload ──────────────────────────────────────────────────────

describe('buildIdentityPayload', () => {
  const existingIdentity: LocalIdentity = {
    assistant: { name: 'Old', title: 'Old Title', emailSignature: '' },
    tone: { baseline: ['warm'], verbosity: 50, directness: 75 },
    behavioralPreferences: ['existing pref'],
    decisionStyle: { externalActions: 'balanced', internalAnalysis: 'proactive' },
    constraints: ['no spam'],
  };

  const state: WizardState = {
    name: 'Alex Curia',
    title: 'Executive Assistant to the CEO',
    signature: 'Best, Alex',
    toneBaseline: ['warm', 'direct'],
    verbosity: 60,
    directness: 80,
    posture: 'conservative',
    preferences: 'Flag investor emails',
  };

  it('maps WizardState onto identity correctly', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.assistant.name).toBe('Alex Curia');
    expect(identity.assistant.title).toBe('Executive Assistant to the CEO');
    expect(identity.assistant.emailSignature).toBe('Best, Alex');
    expect(identity.tone.baseline).toEqual(['warm', 'direct']);
    expect(identity.tone.verbosity).toBe(60);
    expect(identity.tone.directness).toBe(80);
    expect(identity.decisionStyle.externalActions).toBe('conservative');
  });

  it('appends preferences to existing behavioralPreferences', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.behavioralPreferences).toEqual([
      'existing pref',
      'Flag investor emails',
    ]);
  });

  it('does not append when preferences is empty', () => {
    const { identity } = buildIdentityPayload(
      { ...state, preferences: '' },
      existingIdentity,
    );
    expect(identity.behavioralPreferences).toEqual(['existing pref']);
  });

  it('preserves internalAnalysis from existing identity', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.decisionStyle.internalAnalysis).toBe('proactive');
  });

  it('preserves constraints from existing identity', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.constraints).toEqual(['no spam']);
  });

  it('sets note to "Saved via onboarding wizard"', () => {
    const { note } = buildIdentityPayload(state, existingIdentity);
    expect(note).toBe('Saved via onboarding wizard');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test -- --reporter=verbose 2>&1 | grep -E "wizard-utils|FAIL|Cannot find" | head -10
```

Expected: FAIL — `wizard-utils.ts` doesn't exist yet.

- [ ] **Step 3: Implement wizard-utils.ts**

Create `apps/console/src/pages/wizard-utils.ts`:

```ts
// Pure helper functions for the wizard — no React, no DOM, fully testable.

export interface WizardState {
  name: string;
  title: string;
  signature: string;
  toneBaseline: string[];
  verbosity: number;   // 0–100
  directness: number;  // 0–100
  posture: 'conservative' | 'balanced' | 'proactive';
  preferences: string;
}

// Local mirror of the OfficeIdentity shape from the backend identity API.
// Kept in-app to avoid importing from src/ (different package).
export interface LocalIdentity {
  assistant: { name: string; title: string; emailSignature: string };
  tone: { baseline: string[]; verbosity: number; directness: number };
  behavioralPreferences: string[];
  decisionStyle: {
    externalActions: 'conservative' | 'balanced' | 'proactive';
    internalAnalysis: 'conservative' | 'balanced' | 'proactive';
  };
  constraints: string[];
}

export const DEFAULT_WIZARD_STATE: WizardState = {
  name: 'Alex Curia',
  title: 'Executive Assistant to the CEO',
  signature: '',
  toneBaseline: ['warm', 'direct'],
  verbosity: 50,
  directness: 75,
  posture: 'conservative',
  preferences: '',
};

// All valid tone words — mirrors BASELINE_TONE_OPTIONS in src/identity/types.ts.
// @TODO: consider exposing this via the API so both sides stay in sync automatically.
export const TONE_OPTIONS: readonly string[] = [
  'warm', 'friendly', 'approachable', 'personable', 'empathetic', 'encouraging', 'gracious', 'caring',
  'direct', 'blunt', 'candid', 'frank', 'matter-of-fact', 'no-nonsense',
  'energetic', 'calm', 'composed', 'enthusiastic', 'steady', 'measured',
  'playful', 'witty', 'dry', 'charming', 'diplomatic', 'tactful', 'thoughtful', 'curious',
  'confident', 'assured', 'polished', 'authoritative', 'professional',
];

// Toggles a tone word in the selection. Enforces min=1 (can't remove last) and max=3.
export function toggleToneSelection(current: string[], word: string): string[] {
  const idx = current.indexOf(word);
  if (idx !== -1) {
    if (current.length <= 1) return current; // min 1 — no-op
    return current.filter(w => w !== word);
  }
  if (current.length >= 3) return current; // max 3 — no-op
  return [...current, word];
}

// Live preview sentence shown under the verbosity slider.
export function verbosityBand(v: number): string {
  if (v <= 25) return '"Here\'s the short answer."';
  if (v <= 50) return '"Happy to help — let me know if you\'d like more detail."';
  if (v <= 75) return '"Here\'s what you need to know, plus a bit of context."';
  return '"Let me walk you through this thoroughly."';
}

// Live preview sentence shown under the directness slider.
export function directnessBand(v: number): string {
  if (v <= 25) return '"There are a few things worth considering here — it\'s hard to say definitively."';
  if (v <= 50) return '"I\'d lean toward option A, though it depends on your priorities."';
  if (v <= 75) return '"Thursday works. I\'ll send the invite."';
  return '"Do it. The risk is low and the upside is clear."';
}

// Prose sentence shown in the tone pill preview area.
export function tonePreviewText(words: string[]): string {
  if (words.length === 0) return '';
  const phrase =
    words.length === 1
      ? words[0]!
      : words.length === 2
        ? `${words[0]} and ${words[1]}`
        : `${words[0]}, ${words[1]} and ${words[2]}`;
  const suffix = words.length >= 3 ? ' (Pick up to 3)' : '';
  return `Your tone is ${phrase}.${suffix}`;
}

// Short descriptions used in the review card (step 4).
export function verbosityReviewDesc(v: number): string {
  if (v <= 25) return 'Very brief responses — just the essentials.';
  if (v <= 50) return 'Concise responses by default.';
  if (v <= 75) return 'Adapts length to the situation.';
  return 'Thorough by default — full context included.';
}

export function directnessReviewDesc(d: number): string {
  if (d <= 25) return 'Measured — acknowledges uncertainty carefully.';
  if (d <= 50) return 'Leans direct but hedges where uncertain.';
  if (d <= 75) return 'Direct — minimal unnecessary hedging.';
  return 'States positions plainly; no softening.';
}

export function postureReviewDesc(posture: WizardState['posture']): string {
  const map: Record<WizardState['posture'], string> = {
    conservative: 'Verifies before acting on external requests.',
    balanced:     'Acts when confident; flags when uncertain.',
    proactive:    'Biases toward action with less checking in.',
  };
  return map[posture];
}

// Returns true if the user can advance past step 1 (name is required).
export function validateStep1(name: string): boolean {
  return name.trim().length > 0;
}

// Maps WizardState onto an existing LocalIdentity, appending preferences.
// The internalAnalysis and constraints fields are always preserved from the
// existing identity since the wizard does not expose them.
export function buildIdentityPayload(
  state: WizardState,
  existing: LocalIdentity,
): { identity: LocalIdentity; note: string } {
  const prefs = state.preferences.trim()
    ? [...existing.behavioralPreferences, state.preferences.trim()]
    : [...existing.behavioralPreferences];

  const identity: LocalIdentity = {
    assistant: {
      name: state.name.trim(),
      title: state.title.trim(),
      emailSignature: state.signature.trim(),
    },
    tone: {
      baseline: state.toneBaseline,
      verbosity: state.verbosity,
      directness: state.directness,
    },
    behavioralPreferences: prefs,
    decisionStyle: {
      externalActions: state.posture,
      internalAnalysis: existing.decisionStyle.internalAnalysis,
    },
    constraints: existing.constraints,
  };

  return { identity, note: 'Saved via onboarding wizard' };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test -- --reporter=verbose 2>&1 | grep -E "wizard-utils|✓|×|PASS|FAIL" | head -30
```

Expected: all wizard-utils tests pass (approximately 20 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add apps/console/src/pages/wizard-utils.ts apps/console/src/pages/wizard-utils.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "feat: add wizard utility functions with tests"
```

---

## Task 5: Create WizardPage.tsx

**Files:**
- Create: `apps/console/src/pages/WizardPage.tsx`
- Modify: `apps/console/src/styles/app.css`

- [ ] **Step 1: Add wizard CSS to app.css**

Append the following to the end of `apps/console/src/styles/app.css`:

```css
/* ── Wizard page ─────────────────────────────────────────────────── */

.wizard-page {
  position: fixed;
  inset: 0;
  background: var(--app-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 60;
}

.wizard-topbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--app-border);
}

.wizard-progress {
  display: flex;
  gap: 6px;
  align-items: center;
}

.wizard-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--app-accent-bg);
  transition: background 0.15s;
}

.wizard-dot.done {
  background: var(--app-primary);
}

.wizard-step-label {
  font-size: 0.75rem;
  color: var(--app-fg-muted);
}

.wizard-body {
  flex: 1;
  overflow-y: auto;
  padding: 32px 24px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.wizard-content {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
}

.wizard-heading {
  font-family: 'Lora', Georgia, serif;
  font-size: 1.375rem;
  font-weight: 600;
  color: var(--app-fg);
  margin-bottom: 8px;
}

.wizard-subheading {
  font-size: 0.9375rem;
  color: var(--app-fg-muted);
  margin-bottom: 24px;
}

.wizard-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--app-fg-muted);
  margin-bottom: 8px;
  margin-top: 20px;
}

.wizard-field {
  margin-bottom: 20px;
}

.wizard-field label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--app-fg-muted);
  margin-bottom: 6px;
}

.wizard-field input,
.wizard-field textarea {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--app-input-bd);
  border-radius: 6px;
  background: var(--app-card);
  color: var(--app-fg);
  font-size: 0.9375rem;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}

.wizard-field input:focus,
.wizard-field textarea:focus {
  border-color: var(--app-teal);
}

.wizard-field textarea {
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
}

.tone-pill-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 10px;
}

.tone-pill {
  padding: 5px 12px;
  border-radius: 20px;
  border: 1px solid var(--app-border);
  background: var(--app-card);
  color: var(--app-fg-muted);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s;
}

.tone-pill:hover:not(:disabled) {
  border-color: var(--app-teal);
  color: var(--app-fg);
}

.tone-pill.selected {
  background: var(--app-teal-soft);
  border-color: var(--app-teal);
  color: var(--app-teal);
}

.tone-pill:disabled {
  opacity: 0.35;
  cursor: default;
}

.wizard-preview {
  font-size: 0.875rem;
  color: var(--app-fg-muted);
  margin-bottom: 16px;
  min-height: 1.3em;
}

.wizard-sample {
  font-size: 0.875rem;
  font-style: italic;
  color: var(--app-fg-muted);
  margin-bottom: 16px;
  min-height: 1.3em;
}

.slider-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--app-fg-subtle);
  margin-bottom: 8px;
  margin-top: -2px;
}

.posture-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}

@media (max-width: 480px) {
  .posture-grid {
    grid-template-columns: 1fr;
  }
}

.posture-card {
  padding: 14px 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-card);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s, background 0.12s;
}

.posture-card:hover {
  border-color: var(--app-teal);
}

.posture-card.selected {
  border-color: var(--app-teal);
  background: var(--app-teal-soft);
}

.posture-card-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--app-fg);
  margin-bottom: 4px;
}

.posture-card-desc {
  font-size: 0.75rem;
  color: var(--app-fg-muted);
  line-height: 1.4;
}

.review-card {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 20px;
}

.review-row {
  display: flex;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border-soft);
}

.review-row:last-child {
  border-bottom: none;
}

.review-row-label {
  flex: none;
  width: 80px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--app-fg-subtle);
  padding-top: 1px;
}

.review-row-value {
  flex: 1;
  font-size: 0.875rem;
  color: var(--app-fg);
  line-height: 1.5;
}

.wizard-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 24px;
  gap: 12px;
}

.btn-wizard-back {
  padding: 9px 20px;
  border-radius: 6px;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-fg-muted);
  font-size: 0.9375rem;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}

.btn-wizard-back:hover {
  border-color: var(--app-fg-muted);
  color: var(--app-fg);
}

.btn-wizard-next {
  padding: 9px 24px;
  border-radius: 6px;
  border: none;
  background: var(--app-primary);
  color: var(--app-primary-fg);
  font-size: 0.9375rem;
  cursor: pointer;
  transition: opacity 0.12s;
}

.btn-wizard-next:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-wizard-next:disabled {
  opacity: 0.5;
  cursor: default;
}

.wizard-step1-error {
  color: var(--app-destructive);
  font-size: 0.8125rem;
  margin-bottom: 8px;
  min-height: 1.2em;
}

.wizard-submit-error {
  color: var(--app-destructive);
  font-size: 0.8125rem;
  margin-bottom: 12px;
}
```

- [ ] **Step 2: Create WizardPage.tsx**

Create `apps/console/src/pages/WizardPage.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Icons } from '../components/Icons';
import { apiFetch } from '../api';
import {
  DEFAULT_WIZARD_STATE,
  TONE_OPTIONS,
  toggleToneSelection,
  verbosityBand,
  directnessBand,
  tonePreviewText,
  verbosityReviewDesc,
  directnessReviewDesc,
  postureReviewDesc,
  validateStep1,
  buildIdentityPayload,
  type WizardState,
  type LocalIdentity,
} from './wizard-utils.js';

const TOTAL_STEPS = 4;

// ── Identity API types ────────────────────────────────────────────────────────

interface IdentityResponse {
  identity: LocalIdentity;
  configured: boolean;
}

// ── Safe error extraction ─────────────────────────────────────────────────────

async function extractError(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (_) { /* fall through */ }
  }
  return `HTTP ${res.status}`;
}

// ── WizardPage ────────────────────────────────────────────────────────────────

export default function WizardPage() {
  const navigate = useNavigate();
  // Read step from URL search params. strict:false avoids circular import with router.tsx.
  const search = useSearch({ strict: false }) as { step?: number };
  const currentStep = Math.max(1, Math.min(TOTAL_STEPS, search.step ?? 1));

  const [state, setState] = useState<WizardState>(DEFAULT_WIZARD_STATE);
  const [existingIdentity, setExistingIdentity] = useState<LocalIdentity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step1Error, setStep1Error] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-populate form from current identity on mount.
  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/identity');
        if (!res.ok) throw new Error(await extractError(res));
        const data = await res.json() as IdentityResponse;
        const id = data.identity;
        setExistingIdentity(id);
        setState({
          name: id.assistant.name || DEFAULT_WIZARD_STATE.name,
          title: id.assistant.title || DEFAULT_WIZARD_STATE.title,
          signature: id.assistant.emailSignature || '',
          toneBaseline:
            id.tone.baseline.length > 0
              ? id.tone.baseline
              : DEFAULT_WIZARD_STATE.toneBaseline,
          verbosity: id.tone.verbosity ?? DEFAULT_WIZARD_STATE.verbosity,
          directness: id.tone.directness ?? DEFAULT_WIZARD_STATE.directness,
          posture: id.decisionStyle.externalActions || DEFAULT_WIZARD_STATE.posture,
          preferences: '', // always blank on entry — append mode
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load identity');
      }
    }
    void load();
  }, []);

  function goTo(step: number) {
    navigate({ to: '/setup', search: { step } }).catch(err => {
      console.error('[WizardPage] navigation failed:', err);
    });
  }

  function handleContinue() {
    if (currentStep === 1) {
      if (!validateStep1(state.name)) {
        setStep1Error('Assistant name is required.');
        return;
      }
      setStep1Error('');
    }
    if (currentStep < TOTAL_STEPS) goTo(currentStep + 1);
  }

  function handleBack() {
    if (currentStep > 1) goTo(currentStep - 1);
  }

  async function handleSubmit() {
    if (!existingIdentity) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const { identity, note } = buildIdentityPayload(state, existingIdentity);
      const putRes = await apiFetch('/api/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, note }),
      });
      if (!putRes.ok) throw new Error(await extractError(putRes));
      const reloadRes = await apiFetch('/api/identity/reload', { method: 'POST' });
      if (!reloadRes.ok) throw new Error(await extractError(reloadRes));
      navigate({ to: '/' }).catch(err => {
        console.error('[WizardPage] post-submit navigation failed:', err);
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Save failed');
      setSubmitting(false);
    }
  }

  // ── Progress dots ───────────────────────────────────────────────────────────

  const progressDots = Array.from({ length: TOTAL_STEPS }, (_, i) => (
    <div
      key={i}
      className={`wizard-dot${i < currentStep ? ' done' : ''}`}
    />
  ));

  // ── Header ──────────────────────────────────────────────────────────────────

  const header = (
    <div className="wizard-topbar">
      <Icons.Wordmark style={{ height: '1.125rem', width: 'auto', color: 'var(--app-fg)' }} />
      <div className="wizard-progress">{progressDots}</div>
      <span className="wizard-step-label">Step {currentStep} of {TOTAL_STEPS}</span>
    </div>
  );

  // ── Loading / error states ───────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="wizard-page">
        {header}
        <div className="wizard-body">
          <div className="wizard-content">
            <p style={{ color: 'var(--app-destructive)' }}>{loadError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!existingIdentity) {
    return (
      <div className="wizard-page">
        {header}
        <div className="wizard-body">
          <div className="wizard-content" style={{ color: 'var(--app-fg-muted)' }}>
            Loading…
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: Identity ─────────────────────────────────────────────────────────

  const step1 = (
    <div className="wizard-content">
      <div className="wizard-heading">What should your assistant be called?</div>
      <div className="wizard-subheading">
        Give your assistant a name and role. You can change these at any time.
      </div>
      <div className="wizard-field">
        <label htmlFor="w-name">Assistant name *</label>
        <input
          id="w-name"
          type="text"
          value={state.name}
          placeholder="Alex Curia"
          onChange={e => {
            setState(s => ({ ...s, name: e.target.value }));
            if (step1Error) setStep1Error('');
          }}
        />
        {step1Error && <div className="wizard-step1-error">{step1Error}</div>}
      </div>
      <div className="wizard-field">
        <label htmlFor="w-title">Title</label>
        <input
          id="w-title"
          type="text"
          value={state.title}
          placeholder="Executive Assistant to the CEO"
          onChange={e => setState(s => ({ ...s, title: e.target.value }))}
        />
      </div>
      <div className="wizard-field">
        <label htmlFor="w-signature">Email signature <span style={{ fontWeight: 400 }}>(Optional)</span></label>
        <textarea
          id="w-signature"
          value={state.signature}
          placeholder="Best regards, Alex"
          onChange={e => setState(s => ({ ...s, signature: e.target.value }))}
        />
      </div>
      <div className="wizard-nav">
        <span />
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Next →
        </button>
      </div>
    </div>
  );

  // ── Step 2: Tone ─────────────────────────────────────────────────────────────

  const atToneMax = state.toneBaseline.length >= 3;

  const step2 = (
    <div className="wizard-content">
      <div className="wizard-heading">How should your assistant communicate?</div>
      <div className="wizard-subheading">Pick 1–3 words that describe the tone you want.</div>
      <div className="wizard-label">
        Tone <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          (pick up to 3)
        </span>
      </div>
      <div className="tone-pill-grid">
        {TONE_OPTIONS.map(word => {
          const selected = state.toneBaseline.includes(word);
          const disabled = atToneMax && !selected;
          return (
            <button
              key={word}
              type="button"
              className={`tone-pill${selected ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() =>
                setState(s => ({
                  ...s,
                  toneBaseline: toggleToneSelection(s.toneBaseline, word),
                }))
              }
            >
              {word}
            </button>
          );
        })}
      </div>
      <div className="wizard-preview">{tonePreviewText(state.toneBaseline)}</div>
      <div className="wizard-label">Detail level</div>
      <input
        type="range"
        min={0}
        max={100}
        value={state.verbosity}
        style={{ width: '100%', accentColor: 'var(--app-teal)', marginBottom: 6 }}
        onChange={e => setState(s => ({ ...s, verbosity: Number(e.target.value) }))}
      />
      <div className="slider-labels"><span>Brief</span><span>Thorough</span></div>
      <div className="wizard-sample">{verbosityBand(state.verbosity)}</div>
      <div className="wizard-label">Directness</div>
      <input
        type="range"
        min={0}
        max={100}
        value={state.directness}
        style={{ width: '100%', accentColor: 'var(--app-teal)', marginBottom: 6 }}
        onChange={e => setState(s => ({ ...s, directness: Number(e.target.value) }))}
      />
      <div className="slider-labels"><span>Measured</span><span>Direct</span></div>
      <div className="wizard-sample">{directnessBand(state.directness)}</div>
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack}>
          ← Back
        </button>
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Next →
        </button>
      </div>
    </div>
  );

  // ── Step 3: Posture & preferences ────────────────────────────────────────────

  const POSTURE_OPTIONS: Array<{
    value: WizardState['posture'];
    title: string;
    desc: string;
  }> = [
    { value: 'conservative', title: 'Conservative', desc: 'Verify before acting; flag ambiguity' },
    { value: 'balanced',     title: 'Balanced',     desc: 'Act when confident, flag when uncertain' },
    { value: 'proactive',    title: 'Proactive',    desc: 'Bias toward action; less checking in' },
  ];

  const step3 = (
    <div className="wizard-content">
      <div className="wizard-heading">How should your assistant decide?</div>
      <div className="wizard-subheading">
        Choose a default posture for external actions. You can adjust this later via Autonomy settings.
      </div>
      <div className="wizard-label">
        Decision posture{' '}
        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--app-fg-muted)' }}>
          (for external actions)
        </span>
      </div>
      <div className="posture-grid">
        {POSTURE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`posture-card${state.posture === opt.value ? ' selected' : ''}`}
            onClick={() => setState(s => ({ ...s, posture: opt.value }))}
          >
            <div className="posture-card-title">{opt.title}</div>
            <div className="posture-card-desc">{opt.desc}</div>
          </button>
        ))}
      </div>
      <div className="wizard-label" style={{ marginTop: 4 }}>
        Anything else? <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Optional)</span>
      </div>
      <div className="wizard-field">
        <textarea
          id="w-preferences"
          value={state.preferences}
          style={{ minHeight: 140 }}
          placeholder="E.g., 'Always include agenda items in meeting requests' or 'Flag emails from investors as high priority'"
          onChange={e => setState(s => ({ ...s, preferences: e.target.value }))}
        />
      </div>
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack}>
          ← Back
        </button>
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Review →
        </button>
      </div>
    </div>
  );

  // ── Step 4: Review ───────────────────────────────────────────────────────────

  const words = state.toneBaseline;
  const tonePhrase =
    words.length === 1
      ? words[0]!
      : words.length === 2
        ? `${words[0]} and ${words[1]}`
        : `${words[0]}, ${words[1]} and ${words[2]}`;

  const reviewRows: Array<{ label: string; value: string }> = [
    {
      label: 'Assistant',
      value: state.name.trim() + (state.title.trim() ? ` — ${state.title.trim()}` : ''),
    },
    { label: 'Tone',       value: `Your tone is ${tonePhrase}.` },
    { label: 'Detail',     value: verbosityReviewDesc(state.verbosity) },
    { label: 'Directness', value: directnessReviewDesc(state.directness) },
    { label: 'Posture',    value: postureReviewDesc(state.posture) },
  ];
  if (state.preferences.trim()) {
    reviewRows.push({ label: 'Preference', value: `"${state.preferences.trim()}"` });
  }

  const step4 = (
    <div className="wizard-content">
      <div className="wizard-heading">Does everything look right?</div>
      <div className="wizard-subheading">Go back to change anything, or save to get started.</div>
      <div className="review-card">
        {reviewRows.map(row => (
          <div key={row.label} className="review-row">
            <div className="review-row-label">{row.label}</div>
            <div className="review-row-value">{row.value}</div>
          </div>
        ))}
      </div>
      {submitError && <div className="wizard-submit-error">{submitError}</div>}
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack} disabled={submitting}>
          ← Back
        </button>
        <button
          type="button"
          className="btn-wizard-next"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Confirm & save'}
        </button>
      </div>
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  const steps: Record<number, JSX.Element> = { 1: step1, 2: step2, 3: step3, 4: step4 };

  return (
    <div className="wizard-page">
      {header}
      <div className="wizard-body">
        {steps[currentStep] ?? step1}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Check the Icons component exports a Wordmark**

```bash
grep -n "Wordmark\|wordmark" /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console/apps/console/src/components/Icons.tsx | head -5
```

If `Icons.Wordmark` doesn't exist, replace `<Icons.Wordmark ... />` in WizardPage.tsx with the inline SVG path from `kg.ts` lines 1353–1359:

```tsx
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3024 690" fill="currentColor" aria-label="Curia" role="img" style={{ height: '1.125rem', width: 'auto', color: 'var(--app-fg)' }}>
  <path d="M353.581 10.0006C163.722 10.0004 9.81112 163.911 9.81112 353.77C9.81106 498.564 99.4541 622.21 226.165 672.864L239.837 659.126L309.763 589.2C309.784 589.204 309.807 589.197 309.828 589.2L353.581 545.383L397.398 589.2L461.074 652.876L480.997 672.864C607.707 622.211 697.351 498.564 697.351 353.77C697.351 163.912 543.44 10.0007 353.581 10.0006ZM353.581 114.173C485.907 114.173 593.178 221.445 593.178 353.77C593.178 431.275 556.255 499.947 499.162 543.69L427.218 471.746L454.042 444.921L453.782 444.661C475.604 420.619 489.005 388.796 489.005 353.77C489.005 278.977 428.374 218.346 353.581 218.346C278.788 218.346 218.156 278.977 218.156 353.77C218.156 390.521 232.805 423.842 256.57 448.242L256.505 448.307L279.944 471.746L208 543.625C150.925 499.881 113.984 431.261 113.984 353.77C113.984 221.445 221.255 114.173 353.581 114.173ZM353.581 322.519C370.841 322.519 384.833 336.511 384.833 353.77C384.833 362.451 381.237 370.244 375.522 375.907L375.652 376.037L353.581 398.109L331.509 376.037L331.639 375.907C325.925 370.244 322.329 362.451 322.329 353.77C322.329 336.51 336.321 322.519 353.581 322.519Z" fillRule="nonzero"/>
  <path d="M973.772 355.789C973.772 488.115 1081.04 595.386 1213.37 595.386C1291.91 595.386 1361.35 557.422 1405.05 499.026L1330.11 424.087C1306.6 464.19 1263.21 491.214 1213.37 491.213C1138.58 491.213 1077.95 430.582 1077.95 355.789C1077.95 280.996 1138.58 220.364 1213.37 220.365C1262.78 220.365 1305.8 246.93 1329.46 286.449L1404.33 211.575C1360.59 153.731 1291.48 116.192 1213.37 116.192C1081.04 116.192 973.772 223.463 973.772 355.789Z" fillRule="nonzero"/>
  <path d="M1670.51 594.763C1627.62 594.763 1591.42 586.709 1561.89 570.602C1532.37 554.494 1509.92 531.731 1494.54 502.312C1479.15 472.893 1471.46 438.191 1471.46 398.207L1471.46 128.932L1573.39 128.932L1573.39 401.936C1573.39 421.617 1577.17 438.839 1584.74 453.6C1592.3 468.361 1603.28 479.73 1617.68 487.706C1632.07 495.682 1649.68 499.67 1670.51 499.67C1691.33 499.67 1708.91 495.708 1723.26 487.784C1737.6 479.859 1748.48 468.594 1755.89 453.988C1763.29 439.383 1767 422.032 1767 401.936L1767 128.932L1868.93 128.932L1868.93 398.207C1868.93 438.191 1861.34 472.893 1846.16 502.312C1830.99 531.731 1808.66 554.494 1779.19 570.602C1749.72 586.709 1713.49 594.763 1670.51 594.763Z" fillRule="nonzero"/>
  <path d="M1951.74 582.644L1951.74 125.514L2053.67 125.514L2053.67 582.644L1951.74 582.644ZM2226.92 582.644L2093.76 387.641L2205.79 387.641L2345.16 582.644L2226.92 582.644ZM2026.01 437.207L2026.01 357.031L2138.04 357.031C2153.06 357.031 2166.01 354.027 2176.88 348.019C2187.76 342.011 2196.23 333.542 2202.29 322.614C2208.35 311.686 2211.38 299.022 2211.38 284.623C2211.38 269.914 2208.35 257.095 2202.29 246.167C2196.23 235.238 2187.76 226.744 2176.88 220.684C2166.01 214.624 2153.06 211.594 2138.04 211.594L2026.01 211.594L2026.01 125.514L2130.11 125.514C2167.92 125.514 2200.66 131.185 2228.32 142.528C2255.97 153.871 2277.26 170.755 2292.18 193.182C2307.09 215.608 2314.55 243.655 2314.55 277.321L2314.55 287.265C2314.55 320.931 2306.99 348.822 2291.87 370.937C2276.74 393.053 2255.46 409.627 2228 420.659C2200.55 431.691 2167.92 437.207 2130.11 437.207L2026.01 437.207Z" fillRule="nonzero"/>
  <path d="M2396.28 582.644L2396.28 128.932L2500.45 128.932L2500.45 582.644L2396.28 582.644Z" fillRule="nonzero"/>
  <path d="M2548.08 582.644L2698.02 128.932L2862.72 128.932L3017.64 582.644L2912.44 582.644L2786.74 199.475L2818.9 212.527L2739.04 212.527L2772.13 199.475L2650.01 582.644L2548.08 582.644ZM2661.5 469.993L2692.73 385.465L2870.8 385.465L2902.03 469.993L2661.5 469.993Z" fillRule="nonzero"/>
</svg>
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console/apps/console run typecheck
```

Expected: no errors. Common issues to watch for:
- `JSX.Element` → import `JSX` from `react` or use `React.JSX.Element`
- Array non-null access on `words[0]` / `words[1]` / `words[2]` — add `!` non-null assertions as needed (per CLAUDE.md strict pattern)
- `strict: false` on `useSearch` — if types complain, cast the result: `const search = useSearch({ strict: false }) as { step?: number }`

- [ ] **Step 5: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test 2>&1 | tail -6
```

Expected: 2765+ tests pass, same 2 infrastructure failures.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add apps/console/src/pages/WizardPage.tsx apps/console/src/styles/app.css
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "feat: add WizardPage and wizard CSS"
```

---

## Task 6: Remove wizard from kg.ts

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

The wizard code is spread across three regions. Remove each one.

- [ ] **Step 1: Remove wizard CSS (lines ~692–895 area)**

In `kg.ts`, find and remove all CSS blocks whose selector starts with `.wizard-`, `#view-wizard`, `.tone-pill`, `.posture-`, `.review-`, `.btn-wizard-`, `.slider-labels`. Use the Read tool with offset/limit to read the exact ranges, then use Edit to remove them.

Hint: the wizard CSS begins at the `#view-wizard {` rule (around line 692) and ends before `.slider-labels` or a non-wizard rule. Read lines 690–900 to identify exact boundaries, then delete the wizard-only blocks.

- [ ] **Step 2: Remove wizard HTML (lines ~1345–1460)**

In `kg.ts`, remove the HTML comment block starting at line ~1345:
```
<!-- ============================================================
     WIZARD OVERLAY — full-screen, z-index 60.
```
through the closing `</div><!-- /#view-wizard -->` at line ~1460.

The `<div id="chat-success-banner">` element on line ~1333 is part of Chat, not the wizard — do not remove it.

- [ ] **Step 3: Remove wizard JS state and variable references**

In `kg.ts`, remove:
- `var wizardState = { ... }` (lines ~1477–1487)
- `var TONE_OPTIONS = [ ... ]` (lines ~1490–1496)
- `var wstep1El`, `wstep2El`, `wstep3El`, `wstep4El` (lines ~1598–1601)
- `var wNameInput`, `wTitleInput`, `wSignatureInput`, `wVerbosityInput`, `wDirectnessInput` (lines ~1609–1613)
- `var wstep1Error`, `var wizardError`, `var wizardSaveBtn` (lines ~1615–1617)
- `var wPrefsInput`, `var wizardStepLabel` (search for these nearby)
- Remove the null-checks for these vars in the element-ref validation block (lines ~1638–1643)

- [ ] **Step 4: Remove the first-run check in showMain()**

In `showMain()` (around line 1651), remove the block that checks `data.configured === false` and calls `showWizard()`. The function should just show the main app shell unconditionally after auth succeeds.

Also remove the settings nav entry that triggers `showWizard` (search for `showWizard(data.identity)` — lines ~1865–1868 in the settings nav click handler).

- [ ] **Step 5: Remove wizard functions**

Remove these functions entirely from kg.ts:
- `function navigateWizardStep(n)` (line ~1942)
- `function showWizard(identity)` (line ~1960)
- `function hideWizard()` (line ~1991)
- `function wizardNext()` (line ~2022)
- `function wizardBack()` (line ~2027)
- `function buildTonePills()` (line ~2033)
- `function syncPillSelections()` (line ~2053)
- `function toggleTonePill(btn, word)` (line ~2065)
- `function updateTonePreview()` (line ~2079)
- `function verbosityBand(v)` (line ~2091)
- `function directnessBand(v)` (line ~2098)
- `function updateVerbosityPreview()` (line ~2105)
- `function updateDirectnessPreview()` (line ~2109)
- `function selectPosture(value)` (line ~2115)
- `function syncPostureSelection()` (line ~2122)
- `function renderReview()` (line ~2128)
- `function submitWizard()` (line ~2183)

Search for `hideWizard()` calls elsewhere (e.g., line ~2247) and remove those call sites too.

Also remove `var viewWizard = document.getElementById('view-wizard')` (line ~1845) and its usages in `showWizard`/`hideWizard`.

- [ ] **Step 6: Run the test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run test 2>&1 | tail -6
```

Expected: same pass count as before. No regressions.

- [ ] **Step 7: Typecheck root project**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console run typecheck
```

Expected: no errors (kg.ts is JS-in-HTML strings, not TypeScript — this step checks the rest of the project is clean).

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add src/channels/http/routes/kg.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "feat: remove wizard from legacy KG app"
```

---

## Task 7: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under [Unreleased]**

Open `CHANGELOG.md` and add the following line under `## [Unreleased]` → `### Added` (create the section if it doesn't exist):

```markdown
- **Wizard console port** — onboarding wizard ported to the new React console app at `/setup`; first-time users are redirected there automatically on login. Removes the legacy KG app wizard overlay. (#751)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-wizard-console commit -m "chore: update CHANGELOG for wizard console port"
```

---

## Completion Checklist

Before opening the PR, verify all acceptance criteria from issue #751:

- [ ] Wizard accessible at `/setup` on the new console app
- [ ] All four steps (identity, tone, posture, review) functional
- [ ] Form state preserved across step navigation (URL step param)
- [ ] Refresh lands on the correct step (step-only URL persistence)
- [ ] Submit → `PUT /api/identity` + `POST /api/identity/reload` → navigate to `/`
- [ ] First login with `configured: false` auto-redirects to `/setup`
- [ ] Old wizard HTML/JS/CSS removed from `kg.ts`
- [ ] All tests passing (npm run test)
- [ ] Typecheck clean (pnpm --prefix apps/console run typecheck)
