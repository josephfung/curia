# Browser element refs: stable addressing for the web-browser skill

**Status:** design approved, pre-implementation
**Date:** 2026-07-19
**Scope:** core `curia` only (`skills/web-browser/`), one PR, no deploy-repo change

## Problem

The `web-browser` skill could not complete a 16personalities survey. Each page held
~6 questions, every question a row of five identical radios (Strongly Agree, Agree,
Neutral, Disagree, Strongly Disagree), so a page carried ~30 radios sharing five
accessible names repeated across rows.

The agent addresses elements with a single natural-language `selector` string. When that
string matches more than one element, `pickBestLocator` (`handler.ts:594-606`) silently
collapses to **the first visible element in DOM order**. There is no index, no
"the second one", no container scoping. So when the agent asked to click "Agree" for
question 3, it could only ever reach question 1's "Agree". The agent has no lever to
disambiguate duplicate labels.

This is an **addressing** limitation, not a perception one. The DOM already models the 30
radios as 30 distinct elements in distinct fieldsets; the agent simply cannot name one
specific instance. Computer vision was considered and rejected: the existing screenshot
path carries no coordinates or element identifiers (`handler.ts:378`) and cannot drive a
click, so "add CV" would mean building an entire vision-to-coordinate-click pipeline and
then clicking tiny radio targets by pixel to solve a problem the DOM structure already
answers. Wrong, expensive tool.

## Goal

Give the agent a way to name one specific element unambiguously, generalizing beyond
surveys to every duplicate-label shape on real sites (repeated nav links, table
Edit/Delete, "Add to cart" grids). Do it without breaking the existing label-selector
contract.

## Approach: stable refs on interactable elements

Mirror the model Playwright's own MCP uses (`browser_snapshot` → act by `ref`), scaled to
Curia's existing text-serialization model. Every time the page is serialized, tag each
interactable element with a stable ref (`e1`, `e2`, …), surface those refs in what the
agent sees, and resolve actions against a ref exactly. Label selectors remain a fallback,
so existing flows are untouched and the agent can adopt refs incrementally.

Two alternatives were considered and rejected in favor of this:

- **Occurrence index** (a `selector_index` param → `loc.nth(i)`): smallest change, but the
  agent must *count* duplicates correctly from a flat list, and an off-by-one silently
  mis-answers a survey question. Fragile, and doesn't generalize.
- **Scoped selection** ("Agree within question 3"): well-matched to the survey via the
  existing fieldset grouping, but only fixes form controls — duplicate links/buttons in
  nav and tables stay unaddressable. A partial version of the generality we want.

Refs fix the general case for the same effort once the alternatives' edge cases are
accounted for, and remove the fuzzy `exact: false` guesswork that can mis-target even
non-duplicate elements.

## Design

### 1. Ref assignment (`dom-extract.ts`)

`extractFrameContent` runs in-page via `frame.evaluate`. For each **interactable**
element it assigns `data-curia-ref="e<n>"` from a monotonic counter:

Interactable = `button`, `a[href]`, `input` (non-hidden), `select`, `textarea`, and
`[role]` in `{button, link, checkbox, radio, tab, menuitem, option, combobox, switch}`.

- **Clear before assign.** At the start of each extraction, remove every existing
  `data-curia-ref` attribute in the frame, then reassign from the current DOM. A
  snapshot's refs therefore always match its own element list; a ref never outlives the
  snapshot that issued it, so a stale ref can't silently resolve to a different element.
- **Globally unique across frames.** `handler.ts` already loops main + child frames for
  extraction (`handler.ts:623-651`). The counter is threaded through: each
  `extractFrameContent` call receives the current base and returns how many refs it
  assigned, so the next frame continues numbering. Refs are `e1..eN` across the whole page.

### 2. Serialized output (`dom-extract.ts` + `handler.ts`)

`bodyText` is unchanged — the agent still reads page prose the same way. The current flat
"Form fields" list is replaced by an **Interactable elements** list, ordered by DOM
position, each line carrying ref + role + accessible name, plus the fieldset/legend group
for grouped form controls:

```
Interactable elements:
[e12] radio "Agree"    — group: "I make new friends easily"
[e13] radio "Disagree" — group: "I make new friends easily"
[e44] link   "Next"
[e45] button "Submit"
```

Accessible name resolves as today: `aria-label ?? <label for> ?? placeholder ?? name ??
text ?? type`. The survey's 30 identical "Agree" radios become 30 distinct refs, each
tied to its question group.

**Token budget.** The list is capped at `MAX_REFS` (≈200, tunable) in DOM order. On
overflow, append a single explicit line — `(N more interactable elements not shown —
scroll or refine)` — so truncation is visible and never reads as full coverage. `bodyText`
keeps its ~15k-char budget; the ref list gets its own allocation so a large page body
cannot starve it. (Exact split tuned during implementation; both are constants at the top
of `handler.ts`.)

`MAX_REFS` is a **module constant, not config** — deliberately, to match the sibling
`bodyText` char cap which is also hardcoded. Making only the ref cap deployment-configurable
would asymmetrically split one content budget across a config field and a constant. If a
deployment on a tighter-context model ever needs to tune it, promote both budgets to
`browser.*` config together (via the same pattern as `browser.proxy`) — a small, isolated
follow-up. Not doing it now (YAGNI: no deployment has needed it).

### 3. Resolution (`handler.ts`, `resolveLocator`)

Add a ref branch at the top of `resolveLocator`:

- If `selector` matches `/^e\d+$/`, resolve via `[data-curia-ref="<selector>"]` across the
  main frame then each child frame (mirroring the existing frame cascade). Exactly one
  match expected; not found → the existing clean "element not found" path.
- Otherwise, fall through to the **existing** `getByRole` / `getByLabel` / aria-label /
  `getByText` cascade, completely unchanged.

So `click e12` is exact and unambiguous; `click "Submit"` still works exactly as before.

### 4. Skill prompt (`skill.json`)

Update the tool description: prefer the `[eN]` ref from the Interactable elements list as
the `selector`; fall back to describing the element in natural language only when no ref
fits (e.g. an element that appears after a dynamic change and isn't in the last snapshot).

### 5. Screenshots

Unchanged. Still opt-in via `screenshot: true`, still a debug aid, explicitly **not** the
addressing mechanism.

## Testing (TDD — tests written first)

Fixture: a survey-shaped HTML page with multiple `<fieldset>`s, each an identical
Agree/Disagree radio pair, plus a couple of duplicate-labelled links/buttons.

1. Extraction assigns unique, contiguous refs to every interactable; non-interactable
   elements get none.
2. Clicking the 3rd group's "Agree" ref checks **that** radio (`:checked` asserts on the
   correct `<input>`, not group 1's).
3. A plain label selector ("Submit") still resolves (back-compat).
4. A ref whose element was removed since the snapshot yields a clean not-found error, not
   a wrong-element click.
5. Refs resolve for an element inside an iframe (cross-frame numbering + resolution).
6. Overflow past `MAX_REFS` emits the "N more … not shown" line.

## Out of scope (flagged, not built)

- Coordinate / computer-vision clicking.
- Reworking `bodyText` into a full accessibility tree (refs on interactables is the
  targeted fix; the reading surface stays text).

## Files

| File | Change |
|---|---|
| `skills/web-browser/dom-extract.ts` | assign `data-curia-ref`; emit Interactable elements list; clear-before-assign; return ref count |
| `skills/web-browser/handler.ts` | thread ref counter across frames; ref branch in `resolveLocator`; ref-list budget + overflow line |
| `skills/web-browser/skill.json` | description: prefer `[eN]` refs |
| `skills/web-browser/*.test.ts` (+ fixture) | the six tests above, written first |
| `CHANGELOG.md` | Added entry (no version bump) |
