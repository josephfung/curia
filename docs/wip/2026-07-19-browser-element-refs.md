# Browser Element Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `web-browser` skill stable per-element refs so the agent can address one specific element among duplicate-labelled ones (e.g. a survey's repeated "Agree" radios).

**Architecture:** On every page serialization, the in-page extractor (`dom-extract.ts`) tags each interactable element with a `data-curia-ref` attribute and emits an "Interactable elements" list carrying those refs. The handler's `resolveLocator` (`handler.ts`) gains a fast-path: a ref-shaped selector resolves exactly via `[data-curia-ref="…"]`, bypassing the fuzzy accessible-name cascade. Label selectors keep working unchanged.

**Tech Stack:** TypeScript (ESM, Node 24+), Playwright, Vitest. New dev dependency: `happy-dom` (DOM environment for unit-testing the in-page extractor, which was previously only exercised in production).

## Global Constraints

- ESM only; `.js` extensions on all relative imports; no `any`. (curia CLAUDE.md)
- Skills return `{ success: true, data }` / `{ success: false, error }` — never throw across the handler boundary.
- No `console.log`; use the injected pino logger (`ctx.log` / passed `log`).
- Run `pnpm --prefix <worktree>` is WRONG for this repo — use `pnpm -C <worktree>` (workspace-root resolution). (user CLAUDE.md)
- Typecheck with `pnpm -C <worktree> run typecheck` (not bare `tsc`) before every `.ts` commit.
- Array element access under strict null checks is `T | undefined` — use `arr[i]!` when the element is guaranteed.
- **Ref format is frame-scoped: `f<frameIndex>e<n>` (e.g. `f0e12`).** This is deliberate — see Task 2's note. Do NOT switch to a flat `e<n>` scheme: it would require `extractFrameContent` to return a `{text, refCount}` object, breaking 20+ inline frame mocks in `handler.test.ts` that return raw strings from `evaluate`.
- **No em dashes in code output strings.** The Interactable-elements list uses `(group: "…")` and the overflow line uses `;`, not `—`. (Em dashes are fine in CHANGELOG.md, which follows the repo's `**name** — desc` convention.)
- CHANGELOG.md entry required under `## [Unreleased]`; **hard cap 15 words after the em-dash.** No version bump beyond the skill manifest's own `version` field (below).
- `skill.json` `version` bumps **minor** `1.5.0 → 1.6.0`: the `content` output's format changes (Interactable elements replaces Form fields) and the addressing contract gains refs — a public-surface behavior change.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `skills/web-browser/dom-extract.ts` | in-page extractor: bodyText + ref assignment + Interactable list | rewrite the form-fields block into ref assignment; new `opts` param |
| `skills/web-browser/dom-extract.test.ts` | **new** unit tests for the extractor against a real DOM | create (happy-dom env) |
| `skills/web-browser/handler.ts` | action dispatch + `resolveLocator` + `getCleanedContent` | ref fast-path in `resolveLocator`; pass `opts` to `frame.evaluate`; new `MAX_INTERACTABLE_REFS` const |
| `skills/web-browser/handler.test.ts` | handler unit tests (mock page) | append a `ref-based selectors` describe block |
| `skills/web-browser/skill.json` | manifest / agent-facing description | update description; bump `version` |
| `CHANGELOG.md` | release notes | add Added entry |
| `package.json` + `pnpm-lock.yaml` | deps | add `happy-dom` devDependency |

---

## Task 1: In-page extractor assigns refs and lists interactables

**Files:**
- Modify: `skills/web-browser/dom-extract.ts` (rewrite the form-fields section of `extractFrameContent`)
- Create: `skills/web-browser/dom-extract.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (add `happy-dom`)

**Interfaces:**
- Produces: `extractFrameContent(opts: { frameIndex: number; maxRefs: number }): string` — returns `bodyText` optionally followed by `\n\n--- Interactable elements ---\n` and one `[f<frameIndex>e<n>] <role> "<name>"` line per interactable (with ` (group: "<legend>")` when inside a fieldset). Assigns a matching `data-curia-ref="f<frameIndex>e<n>"` attribute to each listed element on the **live** DOM. Caps at `maxRefs`, appending `\n(<k> more interactable elements not shown; scroll or refine)` when exceeded. (Signature changes from the current no-arg `extractFrameContent(): string`.)

- [ ] **Step 1: Add the happy-dom dev dependency**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs add -D happy-dom
```

Expected: `package.json` gains `"happy-dom"` under `devDependencies`; `pnpm-lock.yaml` updates. If `pnpm-workspace.yaml` changed (e.g. `allowBuilds`), revert it — happy-dom has no build script and that file's values are already correct:
`git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs checkout -- pnpm-workspace.yaml`

- [ ] **Step 2: Write the failing tests**

Create `skills/web-browser/dom-extract.test.ts`:

```ts
// @vitest-environment happy-dom
//
// Unit tests for the in-page DOM extractor. Runs under happy-dom (not the repo's
// default node env) so `document`, querySelectorAll, setAttribute, CSS.escape, etc.
// exist — this function was previously only exercised in a real browser via
// frame.evaluate(), so these are its first direct tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { extractFrameContent } from './dom-extract.js';

const OPTS = { frameIndex: 0, maxRefs: 200 };

describe('extractFrameContent — interactable refs', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('assigns a unique ref to every interactable and lists them', () => {
    document.body.innerHTML = `
      <button>Save</button>
      <a href="/next">Next</a>
      <a href="/next">Next</a>`;
    const out = extractFrameContent(OPTS);
    expect(out).toContain('--- Interactable elements ---');
    expect(out).toContain('[f0e1] button "Save"');
    expect(out).toContain('[f0e2] link "Next"');
    expect(out).toContain('[f0e3] link "Next"');
    // The two identical "Next" links are now distinct, addressable elements.
    expect(document.querySelector('[data-curia-ref="f0e2"]')!.getAttribute('href')).toBe('/next');
  });

  it('disambiguates duplicate radio labels across question groups (the survey case)', () => {
    document.body.innerHTML = `
      <fieldset><legend>Q1 I make friends easily</legend>
        <input type="radio" name="q1" aria-label="Agree">
        <input type="radio" name="q1" aria-label="Disagree">
      </fieldset>
      <fieldset><legend>Q2 I enjoy crowds</legend>
        <input type="radio" name="q2" aria-label="Agree">
        <input type="radio" name="q2" aria-label="Disagree">
      </fieldset>`;
    const out = extractFrameContent(OPTS);
    expect(out).toContain('[f0e1] radio "Agree" (group: "Q1 I make friends easily")');
    expect(out).toContain('[f0e3] radio "Agree" (group: "Q2 I enjoy crowds")');
    // The ref maps to the exact input for Q2 — the element pickBestLocator could never reach.
    const q2Agree = document.querySelector('[data-curia-ref="f0e3"]') as HTMLInputElement;
    expect(q2Agree.getAttribute('name')).toBe('q2');
  });

  it('caps the list at maxRefs and reports the remainder', () => {
    document.body.innerHTML =
      Array.from({ length: 5 }, (_, i) => `<button>B${i}</button>`).join('');
    const out = extractFrameContent({ frameIndex: 0, maxRefs: 2 });
    expect(out).toContain('[f0e1] button "B0"');
    expect(out).toContain('[f0e2] button "B1"');
    expect(out).not.toContain('[f0e3]');
    expect(out).toContain('(3 more interactable elements not shown');
    // Only the capped elements receive refs.
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(2);
  });

  it('clears stale refs before reassigning on re-extraction', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    extractFrameContent(OPTS);
    document.querySelectorAll('button')[1]!.remove();  // element gone before next snapshot
    extractFrameContent(OPTS);
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(1);
    expect(document.querySelector('[data-curia-ref="f0e2"]')).toBeNull();
  });

  it('emits no Interactable section when the page has none', () => {
    document.body.innerHTML = '<p>Just some prose, nothing to click.</p>';
    const out = extractFrameContent(OPTS);
    expect(out).not.toContain('--- Interactable elements ---');
    expect(out).toContain('Just some prose');
  });

  it('scopes the ref prefix to the frame index (cross-frame uniqueness)', () => {
    document.body.innerHTML = '<button>Only</button>';
    const out = extractFrameContent({ frameIndex: 1, maxRefs: 200 });
    expect(out).toContain('[f1e1] button "Only"');
    expect(document.querySelector('[data-curia-ref="f1e1"]')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec vitest run skills/web-browser/dom-extract.test.ts`
Expected: FAIL — `extractFrameContent` currently emits `--- Form fields ---`, not `--- Interactable elements ---`, and assigns no `data-curia-ref`. (Also confirms happy-dom env loads.)

- [ ] **Step 4: Rewrite the extractor**

Replace the body of `extractFrameContent` in `skills/web-browser/dom-extract.ts` (keep the file's top `/// <reference lib="dom" />` block and header comment). Replace from the `export function extractFrameContent` line through the closing brace with:

```ts
/**
 * Options passed in from the handler. Type-only (erased at compile), so referencing it
 * here does not violate the "no module-scope value references" rule for a serialized fn.
 */
interface ExtractOpts {
  // Index of this frame within page.frames(); makes refs unique across frames without
  // threading a global counter back to the handler (which would force an object return
  // and break the string-returning frame mocks in handler.test.ts).
  frameIndex: number;
  // Max interactables to tag + list before truncating. Passed in because this function
  // runs in-browser and cannot import the handler's module constant.
  maxRefs: number;
}

/**
 * DOM-extraction routine run *inside the browser* for one frame. Returns cleaned,
 * LLM-friendly text (rendered DOM, not raw HTML) followed by a list of interactable
 * elements, each tagged with a stable `data-curia-ref` the agent can use as an exact
 * click/type selector. Assigning refs here (rather than resolving by fuzzy label) is
 * what lets the agent disambiguate duplicate labels — e.g. a survey's repeated "Agree"
 * radios, each of which becomes a distinct ref tied to its own question group.
 *
 * Must stay self-contained (no imports, no module-scope *value* references, no closures):
 * Playwright serializes it to source and runs it in the page. Helpers below are declared
 * inside the function so they serialize with it.
 */
export function extractFrameContent(opts: ExtractOpts): string {
  const { frameIndex, maxRefs } = opts;

  // --- bodyText: clone the body, strip noise, prefer the main content root. (unchanged) ---
  const root = document.body?.cloneNode(true) as HTMLBodyElement | null;
  if (!root) return '';
  const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
  for (const sel of noiseSelectors) {
    root.querySelectorAll(sel).forEach(el => el.remove());
  }
  const contentRoot = (document.querySelector('main, [role="main"], article, .sp-card')
    ?? root) as HTMLElement;
  const bodyText = (contentRoot.innerText ?? contentRoot.textContent ?? root.innerText ?? '').trim();

  // --- Interactable elements: tag each with a stable ref on the LIVE DOM ---
  // Clear refs from a prior extraction first, so this snapshot's refs are the only ones
  // present. A ref never outlives the snapshot that issued it: an element removed since
  // the last snapshot leaves no stale ref for the resolver to match.
  document.querySelectorAll('[data-curia-ref]').forEach(el => el.removeAttribute('data-curia-ref'));

  const INTERACTABLE_SELECTOR = [
    'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
    '[role="switch"]',
  ].join(',');

  // ARIA role for display: explicit role attribute wins, else derive from the tag.
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    return 'element';
  };

  // Accessible name, same precedence the old form-fields list used, extended to buttons/
  // links (their visible text). Empty is acceptable — ref + role still address the element.
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const id = (el as HTMLElement).id;
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const lblText = lbl?.textContent?.trim();
      if (lblText) return lblText;
    }
    const text = (el.textContent ?? '').trim();
    if (text) return text;
    return el.getAttribute('placeholder')
      ?? el.getAttribute('value')
      ?? el.getAttribute('name')
      ?? el.getAttribute('title')
      ?? '';
  };

  const interactables = Array.from(document.querySelectorAll(INTERACTABLE_SELECTOR));
  const shown = Math.min(interactables.length, maxRefs);
  const refLines: string[] = [];
  for (let i = 0; i < shown; i++) {
    const el = interactables[i]!;
    const ref = `f${frameIndex}e${i + 1}`;
    el.setAttribute('data-curia-ref', ref);
    const name = nameOf(el).replace(/\s+/g, ' ').slice(0, 100);
    const legend = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    const group = legend ? ` (group: "${legend.slice(0, 120)}")` : '';
    refLines.push(`[${ref}] ${roleOf(el)} "${name}"${group}`);
  }
  const overflow = interactables.length > maxRefs
    ? `\n(${interactables.length - maxRefs} more interactable elements not shown; scroll or refine)`
    : '';
  const refSummary = refLines.length > 0
    ? '\n\n--- Interactable elements ---\n' + refLines.join('\n') + overflow
    : '';

  return bodyText + refSummary;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec vitest run skills/web-browser/dom-extract.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs add skills/web-browser/dom-extract.ts skills/web-browser/dom-extract.test.ts package.json pnpm-lock.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs commit -s -m "feat(browser): tag interactables with stable refs in DOM extractor"
```

---

## Task 2: Handler resolves ref selectors exactly and passes extractor options

**Files:**
- Modify: `skills/web-browser/handler.ts` (new const; `resolveLocator` ref branch; `getCleanedContent` passes `opts`)
- Modify: `skills/web-browser/handler.test.ts` (append `ref-based selectors` describe block; update `makeMockPage` note only if needed)

**Interfaces:**
- Consumes: `extractFrameContent(opts)` from Task 1.
- Produces: `resolveLocator(page, selector, log)` — when `selector` matches `/^f\d+e\d+$/`, resolves `[data-curia-ref="<selector>"]` (main frame then eligible child frames) and returns `.first()`; on no match returns the non-matching main-frame ref locator (so the action throws a clean "element not found" rather than silently clicking a fuzzy match). All non-ref selectors keep the existing cascade unchanged.

**Note on ref format:** refs are frame-scoped (`f0e12`), not a flat global `e12`. Global numbering would require `extractFrameContent` to return the per-frame ref count so the handler could offset the next frame — i.e. an object return — which breaks the many `evaluate: vi.fn().mockResolvedValue('<string>')` mocks in this test file. Frame-scoping makes refs globally unique via the frame prefix with zero change to those mocks and no return-type change.

- [ ] **Step 1: Write the failing tests**

Append to `skills/web-browser/handler.test.ts` (end of file). It reuses the file's existing `makeMockPage` / `logger` / `BrowserSession` helpers:

```ts
describe('web-browser ref-based selectors', () => {
  // Build a ctx around a caller-supplied mock page so the test can assert on how the
  // page's locator methods were called (makeSkillContext hides its page).
  function ctxFor(page: ReturnType<typeof makeMockPage>, input: Record<string, unknown>) {
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return { input, log: logger, browserService } as unknown as SkillContext;
  }

  it('resolves an fNeM ref via data-curia-ref, bypassing the fuzzy cascade', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'click', selector: 'f0e3', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    // The ref resolved by attribute...
    expect(page.locator).toHaveBeenCalledWith('[data-curia-ref="f0e3"]');
    // ...and did NOT fall through to accessible-name matching (which could hit a duplicate).
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it('does not fuzzy-fall-back when a ref matches nothing (no wrong-element click)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    // Model an element removed since the snapshot: the ref attribute matches nothing.
    const zero = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
      isVisible: vi.fn().mockResolvedValue(false),
      locator: vi.fn().mockReturnThis(),
      click: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      waitFor: vi.fn().mockResolvedValue(undefined),
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      fill,
    };
    page.locator = vi.fn().mockReturnValue(zero);
    const ctx = ctxFor(page, { action: 'click', selector: 'f0e9', session_id: 'sess-1' });

    await new WebBrowserHandler().execute(ctx);

    // Resolution stayed on the ref path; it never degraded to fuzzy role/text matching.
    expect(page.locator).toHaveBeenCalledWith('[data-curia-ref="f0e9"]');
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it('still resolves a plain label selector via the existing cascade (back-compat)', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('page body', fill, 'https://example.com/');
    const ctx = ctxFor(page, { action: 'click', selector: 'Save', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(page.getByRole).toHaveBeenCalled();               // fuzzy path used
    expect(page.locator).not.toHaveBeenCalledWith('[data-curia-ref="Save"]');
  });

  it('resolves a ref that lives inside a child iframe', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    const page = makeMockPage('outer page', fill, 'https://example.com/');
    // Main frame: the ref matches nothing (the element is in the iframe).
    page.locator = vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnThis(),
    });
    // Child frame: the ref matches exactly one element there.
    const childLoc = {
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
      isVisible: vi.fn().mockResolvedValue(true),
      locator: vi.fn().mockReturnThis(),
      click: vi.fn().mockResolvedValue(undefined),
      fill,
    };
    const childFrame = {
      url: vi.fn().mockReturnValue('https://widget.example.com/'),
      name: vi.fn().mockReturnValue('widget'),
      evaluate: vi.fn().mockResolvedValue('widget body'),
      getByRole: vi.fn(), getByLabel: vi.fn(), getByText: vi.fn(),
      locator: vi.fn().mockReturnValue(childLoc),
    };
    const mainFrame = page.mainFrame();
    page.frames = vi.fn().mockReturnValue([mainFrame, childFrame]);
    const ctx = ctxFor(page, { action: 'click', selector: 'f1e2', session_id: 'sess-1' });

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(childFrame.locator).toHaveBeenCalledWith('[data-curia-ref="f1e2"]');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec vitest run skills/web-browser/handler.test.ts -t "ref-based selectors"`
Expected: FAIL — `resolveLocator` has no ref branch yet, so `selector: 'f0e3'` falls into `getByRole`, and `page.locator` is never called with the `data-curia-ref` attribute selector.

- [ ] **Step 3: Add the `MAX_INTERACTABLE_REFS` constant**

In `skills/web-browser/handler.ts`, immediately after the `MAX_CONTENT_LENGTH` const (around line 21), add:

```ts
// Max interactable elements to tag with a ref and list per frame before truncating.
// A module constant (not config) to match MAX_CONTENT_LENGTH above; both are halves of
// one content budget. Passed into the in-browser extractor since it can't import this.
const MAX_INTERACTABLE_REFS = 200;
```

- [ ] **Step 4: Add the ref fast-path to `resolveLocator`**

In `skills/web-browser/handler.ts`, at the very top of the `resolveLocator` function body (immediately after the `async function resolveLocator(...)` signature and before the `// Main frame first` comment / `const top = await resolveInScope(...)` line), insert:

```ts
  // Ref fast-path: a data-curia-ref token (f<frame>e<n>, emitted by extractFrameContent)
  // identifies exactly one element in the last snapshot. Resolve it by attribute and skip
  // the fuzzy accessible-name cascade entirely — this is how the agent disambiguates
  // duplicate labels. If it matches nothing (element gone since the snapshot), return the
  // non-matching ref locator so the action throws a clean "element not found" rather than
  // degrading to fuzzy matching and clicking the WRONG element.
  if (/^f\d+e\d+$/.test(selector)) {
    const attrSelector = `[data-curia-ref="${selector}"]`;
    const mainRef = page.locator(attrSelector);
    if ((await mainRef.count()) > 0) return mainRef.first();
    const refMainFrame = page.mainFrame();
    const refChildFrames = page.frames().filter(
      (frame) => frame !== refMainFrame && !isBlockedFrameUrl(frame.url()),
    );
    for (const frame of refChildFrames) {
      try {
        const inFrame = frame.locator(attrSelector);
        if ((await inFrame.count()) > 0) return inFrame.first();
      } catch (err) {
        log.debug({ err, frameUrl: frame.url() }, 'Skipping frame during ref resolution (detached/error)');
      }
    }
    return mainRef;
  }

```

- [ ] **Step 5: Pass extractor options in `getCleanedContent`**

In `skills/web-browser/handler.ts`, `getCleanedContent`, change the frame loop so each `frame.evaluate` receives the options object and frames are indexed. Replace:

```ts
  for (const frame of page.frames()) {
```
with:
```ts
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex]!;
```

and replace:

```ts
      raw = await frame.evaluate(extractFrameContent);
```
with:
```ts
      raw = await frame.evaluate(extractFrameContent, { frameIndex, maxRefs: MAX_INTERACTABLE_REFS });
```

(The rest of the loop body — SSRF skip, try/catch, `extracted`/`failed` counters, main-vs-child labelling — is unchanged. The `frame === mainFrame` check still works.)

- [ ] **Step 6: Run the handler tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec vitest run skills/web-browser/handler.test.ts`
Expected: PASS — the new `ref-based selectors` block passes AND all pre-existing handler tests still pass (they return strings from `evaluate`; passing an extra arg to the mock is ignored, and the return type is unchanged).

- [ ] **Step 7: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs run typecheck`
Expected: no errors. (Watch for `interactables[i]` needing `!` — already applied in Task 1.)

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs add skills/web-browser/handler.ts skills/web-browser/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs commit -s -m "feat(browser): resolve data-curia-ref selectors exactly in handler"
```

---

## Task 3: Update the skill manifest, changelog, and run the full suite

**Files:**
- Modify: `skills/web-browser/skill.json` (description + `version`)
- Modify: `CHANGELOG.md`

**Interfaces:** none (agent-facing docs + release notes).

- [ ] **Step 1: Update the skill description and version**

In `skills/web-browser/skill.json`:

Bump `"version": "1.5.0"` → `"version": "1.6.0"`.

In the `description` string, replace the sentence:

```
Selectors resolve by accessible role/label/text, aria-label, and reach into iframes automatically. When the form-fields section lists options for a control, use those accessible names as click selectors — custom-styled widgets often hide the native input, and nearby visible caption text is frequently decorative rather than the clickable target.
```

with:

```
The page state lists interactable elements as '[fNeM] role \"name\"' under '--- Interactable elements ---'; prefer that [fNeM] ref as your selector — it targets exactly one element, so it is the reliable way to pick one option among duplicates (e.g. a survey row's repeated 'Agree'). Selectors that are not a ref still resolve by accessible role/label/text and aria-label and reach into iframes automatically; fall back to describing the element only when no ref fits (e.g. an element that appeared after the last snapshot). Custom-styled widgets often hide the native input, and nearby visible caption text is frequently decorative rather than the clickable target.
```

(Keep the surrounding sentences about `secret_ref`, `block_ads`, `incognito`, blocked sites, etc. unchanged. Ensure the JSON stays valid — the embedded quotes around `name`, `Agree`, and the section header must be backslash-escaped as shown.)

- [ ] **Step 2: Validate the JSON parses**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec node -e "JSON.parse(require('fs').readFileSync('skills/web-browser/skill.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added` (create the `### Added` subsection if absent), add:

```
- **web-browser** — stable per-element refs let the agent disambiguate duplicate labels (e.g. survey radios). (#<issue>)
```

Replace `#<issue>` with the tracking issue number if one exists; otherwise drop the ` (#<issue>)` suffix. (After the em-dash: 12 words — within the 15-word cap.)

- [ ] **Step 4: Run the full skill test suite**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs exec vitest run skills/web-browser/`
Expected: PASS — all `dom-extract.test.ts` and `handler.test.ts` tests green.

- [ ] **Step 5: Full typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs add skills/web-browser/skill.json CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-browser-refs commit -s -m "docs(browser): document element refs in skill manifest and changelog"
```

---

## Verification (end-to-end, after all tasks)

1. `pnpm -C <worktree> run typecheck` — clean.
2. `pnpm -C <worktree> exec vitest run skills/web-browser/` — all green (extractor + handler).
3. Manual read-through: a survey page's page-state now shows each radio as a distinct `[fNeM] radio "Agree" (group: "…")`, and `click fNeM` resolves that exact input.
4. Pre-PR auto-review (per user CLAUDE.md): `pr-review-toolkit:code-reviewer` + `silent-failure-hunter` in parallel; address high-priority findings before opening the PR.

## Out of scope (flagged, not built)

- Coordinate / computer-vision clicking.
- Promoting `MAX_INTERACTABLE_REFS` (or the bodyText char cap) to config — deliberately a constant; see the design doc.
- Reworking `bodyText` into a full accessibility tree.
