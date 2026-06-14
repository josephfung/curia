# Console UX QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four targeted UI improvements to the web console: distinct user-message bubble colour, URL auto-hyperlinking in chat, sortable columns in Agents/Skills/Channels views, and state pill filters in those same views.

**Architecture:** All changes are pure UI — no API, database, or CSS-class additions. The sort/filter pattern is lifted directly from `ContactsPage`, which already implements the full `records-toolbar` + `sort-btn` stack. URL linking is handled in two places: server-side inside `applyInline()` (agent messages, where markdown is already processed) and client-side via a new `linkifyText()` helper (user messages, which render as plain text today).

**Tech Stack:** React 19, TypeScript (strict), Vitest, CSS custom properties (`--app-teal`), `dangerouslySetInnerHTML` (safe: HTML is escaped before any markup is added).

---

## Prerequisite: Install dependencies in the worktree

The worktree does not share `node_modules` with the main checkout.

- [ ] **Install dependencies**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol install
```

Expected: pnpm links from global cache. Should complete in seconds.

---

## Task 1: User bubble colour

**Files:**
- Modify: `apps/console/src/styles/app.css`

No unit test needed — pure CSS change.

- [ ] **Step 1: Change `.msg-bubble.user` in `app.css`**

Find the existing rule (around line 1265):
```css
.msg-bubble.user {
  background: var(--app-card-elev);
  border-radius: 12px 12px 2px 12px;
}
```

Replace with:
```css
.msg-bubble.user {
  background: var(--app-teal);
  color: #fff;
  border-radius: 12px 12px 2px 12px;
}
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol add apps/console/src/styles/app.css
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol commit -m "feat: teal background + white text for user chat bubbles"
```

---

## Task 2: URL auto-linking in agent messages

**Files:**
- Create: `src/utils/markdown-to-html.test.ts`
- Modify: `src/utils/markdown-to-html.ts`

Agent messages are rendered via `markdownToHtml()`. The `applyInline()` helper already HTML-escapes all text before processing, so URL detection runs on safe, already-escaped text. URLs are added **after** bold/italic processing but **before** code-span restoration so that URLs inside code spans (`\`https://...\``) are not linkified.

- [ ] **Step 1: Create the failing test**

Create `src/utils/markdown-to-html.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown-to-html.js';

describe('markdownToHtml — URL auto-linking', () => {
  it('wraps a bare https URL in an anchor tag', () => {
    const result = markdownToHtml('Visit https://example.com for more.');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('wraps a bare http URL in an anchor tag', () => {
    const result = markdownToHtml('See http://example.com');
    expect(result).toContain('<a href="http://example.com"');
  });

  it('does not linkify URLs inside inline code spans', () => {
    const result = markdownToHtml('Run `https://example.com`');
    // URL is inside <code>, not inside an <a>
    expect(result).toContain('<code>https://example.com</code>');
    expect(result).not.toContain('<a href="https://example.com"');
  });

  it('linkifies a URL that contains query parameters', () => {
    const result = markdownToHtml('Go to https://example.com?a=1&b=2 now');
    // & is escaped to &amp; before URL detection runs
    expect(result).toContain('<a href="https://example.com?a=1&amp;b=2"');
  });

  it('linkifies URLs inside bold text', () => {
    const result = markdownToHtml('See **https://example.com**');
    expect(result).toContain('<a href="https://example.com"');
  });

  it('does not break non-URL text', () => {
    const result = markdownToHtml('Hello world');
    expect(result).toBe('<p>Hello world</p>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test src/utils/markdown-to-html.test.ts
```

Expected: FAIL — the URL tests fail because `applyInline()` does not yet link URLs.

- [ ] **Step 3: Add URL linking to `applyInline()` in `src/utils/markdown-to-html.ts`**

Find `applyInline()` (around line 58). Add the URL-linking step after the italic replacements but **before** the code-span restoration:

```typescript
function applyInline(text: string): string {
  let out = escapeHtml(text);

  // Replace code spans with stable placeholders before bold/italic processing so
  // that content like `**inside code**` is not transformed by the bold regex.
  // \x00 is safe here: escapeHtml doesn't produce it and LLM text won't contain it.
  const codePlaceholders: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, inner: string) => {
    codePlaceholders.push(`<code>${inner}</code>`);
    return `\x00CODE${codePlaceholders.length - 1}\x00`;
  });

  // Bold: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text*
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Italic: _text_ (word-boundary anchored to avoid matching underscores in identifiers)
  out = out.replace(/(?<!_)\b_(?!_)(.+?)(?<!_)_\b(?!_)/g, '<em>$1</em>');

  // Auto-link bare URLs. Runs after bold/italic so formatting inside URLs is preserved,
  // and before code-span restoration so URLs inside code spans are not linkified
  // (they exist only as \x00CODE...\x00 placeholders at this point).
  out = out.replace(
    /https?:\/\/[^\s<>"]+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );

  // Restore code spans
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, i: string) => codePlaceholders[parseInt(i, 10)]!);

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test src/utils/markdown-to-html.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol add src/utils/markdown-to-html.ts src/utils/markdown-to-html.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol commit -m "feat: auto-link URLs in agent chat messages"
```

---

## Task 3: URL auto-linking in user messages

**Files:**
- Modify: `apps/console/src/pages/chat/chat-utils.ts`
- Modify: `apps/console/src/pages/chat/chat-utils.test.ts`
- Modify: `apps/console/src/pages/chat/ChatThread.tsx`

User messages render as plain text today. We add a `linkifyText()` helper that HTML-escapes the text first, then wraps bare URLs in `<a>` tags. The chat bubble then uses `dangerouslySetInnerHTML` with this output. This is safe: escaping runs before any markup is added, so no user-supplied text can inject HTML.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/src/pages/chat/chat-utils.test.ts`, after the existing `describe` blocks:

```typescript
describe('linkifyText', () => {
  it('wraps a bare https URL in an anchor tag', () => {
    // Import linkifyText at the top of the test file (add to the import line)
    const result = linkifyText('Visit https://example.com please');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('Visit ');
    expect(result).toContain(' please');
  });

  it('wraps a bare http URL', () => {
    const result = linkifyText('http://example.com');
    expect(result).toContain('<a href="http://example.com"');
  });

  it('escapes HTML before linking so user text cannot inject markup', () => {
    const result = linkifyText('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('passes through plain text unchanged (modulo entity escaping)', () => {
    const result = linkifyText('Hello world');
    expect(result).toBe('Hello world');
  });

  it('handles text with no URLs', () => {
    const result = linkifyText('No links here.');
    expect(result).toBe('No links here.');
  });

  it('handles multiple URLs in one message', () => {
    const result = linkifyText('See https://a.com and https://b.com');
    expect(result).toContain('<a href="https://a.com"');
    expect(result).toContain('<a href="https://b.com"');
  });

  it('does not linkify javascript: URIs', () => {
    const result = linkifyText('javascript:alert(1)');
    expect(result).not.toContain('<a href="javascript:');
  });
});
```

Also update the import line at the top of the file to include `linkifyText`:
```typescript
import { parseSseEvent, makeMessage, formatTimestamp, linkifyText } from './chat-utils.js';
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test apps/console/src/pages/chat/chat-utils.test.ts
```

Expected: FAIL — `linkifyText` is not exported from `chat-utils.ts`.

- [ ] **Step 3: Add `linkifyText` to `chat-utils.ts`**

Add after the `formatTimestamp` export at the end of `apps/console/src/pages/chat/chat-utils.ts`:

```typescript
/**
 * Escapes HTML in user-supplied text and wraps bare http/https URLs in anchor tags.
 * The result is safe to pass to dangerouslySetInnerHTML: HTML escaping runs first,
 * so no user text can inject markup. The URL regex only matches http/https, blocking
 * javascript: and other non-http schemes.
 */
export function linkifyText(text: string): string {
  // Escape HTML entities first so user text cannot inject markup.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Wrap bare URLs. The exclusion set [^\s<>"] stops at whitespace and the HTML
  // characters that would break the surrounding attribute or tag context. The &
  // character is allowed so that escaped query strings (e.g. &amp;) are included.
  return escaped.replace(
    /https?:\/\/[^\s<>"]+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test apps/console/src/pages/chat/chat-utils.test.ts
```

Expected: all `linkifyText` tests PASS.

- [ ] **Step 5: Update `ChatThread.tsx` to use `linkifyText` for user bubbles**

In `apps/console/src/pages/chat/ChatThread.tsx`, add `linkifyText` to the import:
```typescript
import { formatTimestamp, linkifyText } from './chat-utils.js';
```

Then find the user-bubble render branch (around line 101–113). The current render is:
```tsx
<div key={msg.id} className={`msg-group ${msg.kind}`}>
  <div className={`msg-bubble ${msg.kind}`}>
    {msg.html ? (
      <span dangerouslySetInnerHTML={{ __html: msg.html }} />
    ) : (
      msg.text
    )}
  </div>
  {msg.timestamp && (
    <div className="msg-time">{formatTimestamp(msg.timestamp)}</div>
  )}
</div>
```

Replace with (user messages now always use `dangerouslySetInnerHTML` via `linkifyText`; agent messages use `msg.html` if present, otherwise fall back to `linkifyText` as well for safety):
```tsx
<div key={msg.id} className={`msg-group ${msg.kind}`}>
  <div className={`msg-bubble ${msg.kind}`}>
    {msg.html ? (
      // Safe: html is produced server-side by markdownToHtml(), which
      // runs escapeHtml() BEFORE inserting any markup.
      <span dangerouslySetInnerHTML={{ __html: msg.html }} />
    ) : (
      // Safe: linkifyText() escapes all HTML entities before adding anchor tags,
      // so user-supplied text cannot inject markup. Only http/https URLs are linked.
      <span dangerouslySetInnerHTML={{ __html: linkifyText(msg.text) }} />
    )}
  </div>
  {msg.timestamp && (
    <div className="msg-time">{formatTimestamp(msg.timestamp)}</div>
  )}
</div>
```

- [ ] **Step 6: Typecheck the console**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol --filter @curia/console run typecheck
```

Expected: no errors.

- [ ] **Step 7: Run the full test suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol add apps/console/src/pages/chat/chat-utils.ts apps/console/src/pages/chat/chat-utils.test.ts apps/console/src/pages/chat/ChatThread.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol commit -m "feat: auto-link URLs in user chat messages"
```

---

## Task 4: Sortable columns + state filters in `RegistrySettings.tsx`

**Files:**
- Modify: `apps/console/src/pages/RegistrySettings.tsx`

No unit tests for React component logic (no testing library in console). Relies on typecheck and visual verification. The sort/filter pattern mirrors `ContactsPage` exactly — same CSS classes (`sort-btn`, `sort-arrow`, `sortable`, `records-toolbar`, `records-filter-chip`), same state shape.

- [ ] **Step 1: Add sort and filter state + counts useMemo**

Add the `SortKey` type at module level, just above `function RegistryPage(...)` (around line 430):

```typescript
// Sort key covers columns from both kinds; kind-specific ones only appear
// in the table when the relevant kind is active.
type SortKey = 'name' | 'state' | 'version' | 'modelTier' | 'memoryScopes' | 'actionRisk' | 'sensitivity';
```

Then inside `RegistryPage`, after the existing `useState` declarations, add two new state hooks:

```typescript
const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
const [stateFilter, setStateFilter] = useState<'all' | DerivedState>('all');
```

Add a `counts` useMemo after the existing `load` callback (before the `filtered` useMemo):

```typescript
const counts = useMemo(() => ({
  all:         entries.length,
  uninstalled: entries.filter(e => e.state === 'uninstalled').length,
  installed:   entries.filter(e => e.state === 'installed').length,
  enabled:     entries.filter(e => e.state === 'enabled').length,
  ghost:       entries.filter(e => e.state === 'ghost').length,
}), [entries]);
```

- [ ] **Step 2: Add a `getSortValue` helper and extend `filtered` useMemo**

Add a `getSortValue` helper immediately before `RegistryPage` (above the component, as a module-level function):

```typescript
function getSortValue(entry: RegistryEntry, key: SortKey): string {
  switch (key) {
    case 'name':        return entry.name;
    case 'state':       return entry.state;
    case 'version':     return entry.metadata?.version ?? '';
    case 'modelTier':   return entry.metadata?.modelTier ?? '';
    case 'memoryScopes': return entry.metadata?.memoryScopes?.join(', ') ?? '';
    case 'actionRisk':  return entry.metadata?.actionRisk != null ? String(entry.metadata.actionRisk) : '';
    case 'sensitivity': return entry.metadata?.sensitivity ?? '';
    default:            return '';
  }
}
```

Replace the existing `filtered` useMemo (which only filters by search) with:

```typescript
const filtered = useMemo(() => {
  let rows = entries;
  if (stateFilter !== 'all') rows = rows.filter(e => e.state === stateFilter);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(e =>
      (e.name + ' ' + (e.metadata?.description ?? '')).toLowerCase().includes(q),
    );
  }
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = getSortValue(a, sort.key);
    const bv = getSortValue(b, sort.key);
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });
}, [entries, stateFilter, search, sort]);
```

Add a `toggleSort` helper and `sortArrow` after the `filtered` useMemo (inside the component, since they close over `sort` state):

```typescript
function toggleSort(key: SortKey) {
  setSort(s => s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' });
}
const sortArrow = (key: SortKey) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';
```

- [ ] **Step 3: Add the state filter toolbar to the JSX**

In the JSX, after the mobile search `<div className="contacts-mobile-search">` block and before `<div className="records-layout">`, insert:

```tsx
<div className="records-toolbar">
  <div className="records-toolbar-left">
    {(['all', 'enabled', 'installed', 'ghost', 'uninstalled'] as const).map(v => (
      <button
        key={v}
        className={`records-filter-chip${stateFilter === v ? ' active' : ''}`}
        onClick={() => { setStateFilter(v); setPage(1); }}
      >
        {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
          {counts[v]}
        </span>
      </button>
    ))}
  </div>
  <div className="records-toolbar-right">
    <span className="topbar-meta">{filtered.length} of {entries.length}</span>
  </div>
</div>
```

- [ ] **Step 4: Replace table headers with sortable buttons**

Find the `<thead>` block in the table and replace it:

```tsx
<thead>
  <tr>
    <th className="sortable" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort-btn" onClick={() => toggleSort('name')}>
        Name <span className="sort-arrow">{sortArrow('name')}</span>
      </button>
    </th>
    <th className="sortable" aria-sort={sort.key === 'state' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort-btn" onClick={() => toggleSort('state')}>
        State <span className="sort-arrow">{sortArrow('state')}</span>
      </button>
    </th>
    {kind === 'agent' ? (
      <>
        <th className="sortable" aria-sort={sort.key === 'modelTier' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          <button className="sort-btn" onClick={() => toggleSort('modelTier')}>
            Model tier <span className="sort-arrow">{sortArrow('modelTier')}</span>
          </button>
        </th>
        <th className="sortable" aria-sort={sort.key === 'memoryScopes' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          <button className="sort-btn" onClick={() => toggleSort('memoryScopes')}>
            Memory scopes <span className="sort-arrow">{sortArrow('memoryScopes')}</span>
          </button>
        </th>
      </>
    ) : (
      <>
        <th className="sortable" aria-sort={sort.key === 'actionRisk' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          <button className="sort-btn" onClick={() => toggleSort('actionRisk')}>
            Action risk <span className="sort-arrow">{sortArrow('actionRisk')}</span>
          </button>
        </th>
        <th className="sortable" aria-sort={sort.key === 'sensitivity' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          <button className="sort-btn" onClick={() => toggleSort('sensitivity')}>
            Sensitivity <span className="sort-arrow">{sortArrow('sensitivity')}</span>
          </button>
        </th>
      </>
    )}
    <th className="sortable" aria-sort={sort.key === 'version' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort-btn" onClick={() => toggleSort('version')}>
        Version <span className="sort-arrow">{sortArrow('version')}</span>
      </button>
    </th>
  </tr>
</thead>
```

- [ ] **Step 5: Typecheck the console**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol --filter @curia/console run typecheck
```

Expected: no errors. If TypeScript complains about `counts[v]` indexing (because `v` is `'all' | DerivedState` but `counts` keys include `'all'`), cast: `counts[v as keyof typeof counts]`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol add apps/console/src/pages/RegistrySettings.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol commit -m "feat: sortable columns and state filter pills in Agents/Skills views"
```

---

## Task 5: Sortable columns + state filters in `ChannelSettings.tsx`

**Files:**
- Modify: `apps/console/src/pages/ChannelSettings.tsx`

Same pattern as Task 4. Channels has no existing `filtered` useMemo or search state; this adds both to support sort + filter. Non-toggleable channels (http, cli) display "Always on" and are treated as `enabled` for filtering and sort comparison purposes.

- [ ] **Step 1: Add sort + filter state**

In `ChannelsPage` (around line 318), after the existing state declarations:

```typescript
type ChannelSortKey = 'name' | 'state' | 'description';

export function ChannelsPage() {
  // ... existing state ...
  const [sort, setSort] = useState<{ key: ChannelSortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [stateFilter, setStateFilter] = useState<'all' | ChannelState>('all');
```

- [ ] **Step 2: Add counts useMemo + filtered useMemo**

After the `load` callback, add:

```typescript
const counts = useMemo(() => ({
  all:         entries.length,
  enabled:     entries.filter(e => e.state === 'enabled' || !e.isToggleable).length,
  installed:   entries.filter(e => e.isToggleable && e.state === 'installed').length,
  uninstalled: entries.filter(e => e.isToggleable && e.state === 'uninstalled').length,
}), [entries]);

// For sorting, treat non-toggleable channels (http, cli) as 'enabled' since they
// are always on and display "Always on" rather than a lifecycle state.
function channelSortValue(e: ChannelEntry, key: ChannelSortKey): string {
  switch (key) {
    case 'name':        return e.name;
    case 'state':       return e.isToggleable ? e.state : 'enabled';
    case 'description': return e.description;
    default:            return '';
  }
}

const filtered = useMemo(() => {
  let rows = entries;
  if (stateFilter !== 'all') {
    if (stateFilter === 'enabled') {
      rows = rows.filter(e => e.state === 'enabled' || !e.isToggleable);
    } else {
      rows = rows.filter(e => e.isToggleable && e.state === stateFilter);
    }
  }
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = channelSortValue(a, sort.key);
    const bv = channelSortValue(b, sort.key);
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });
}, [entries, stateFilter, sort]);

function toggleSort(key: ChannelSortKey) {
  setSort(s => s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' });
}
const sortArrow = (key: ChannelSortKey) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';
```

Note: `channelSortValue` is a pure helper with no dependency on component state — define it as a `const` arrow function just above `ChannelsPage` (module level) so it doesn't get recreated on every render.

- [ ] **Step 3: Add the state filter toolbar + sortable headers to the JSX**

In the JSX return, find the `<div className="records-layout">` and add the toolbar above it. Also replace `entries.map(...)` in the table body with `filtered.map(...)`, and replace the plain `<th>` headers with sortable buttons.

The full updated JSX block (replace everything from `{loadError ? (` to the closing `)}` of the `main` section):

```tsx
{loadError ? (
  <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
) : (
  <>
    <div className="records-toolbar">
      <div className="records-toolbar-left">
        {(['all', 'enabled', 'installed', 'uninstalled'] as const).map(v => (
          <button
            key={v}
            className={`records-filter-chip${stateFilter === v ? ' active' : ''}`}
            onClick={() => setStateFilter(v)}
          >
            {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
              {counts[v]}
            </span>
          </button>
        ))}
      </div>
      <div className="records-toolbar-right">
        <span className="topbar-meta">{filtered.length} of {entries.length}</span>
      </div>
    </div>

    <div className="records-layout">
      <div className="records-main">
        <div className="records-table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th className="sortable" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="sort-btn" onClick={() => toggleSort('name')}>
                    Name <span className="sort-arrow">{sortArrow('name')}</span>
                  </button>
                </th>
                <th className="sortable" aria-sort={sort.key === 'state' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="sort-btn" onClick={() => toggleSort('state')}>
                    State <span className="sort-arrow">{sortArrow('state')}</span>
                  </button>
                </th>
                <th className="sortable" aria-sort={sort.key === 'description' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="sort-btn" onClick={() => toggleSort('description')}>
                    Description <span className="sort-arrow">{sortArrow('description')}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => (
                <tr
                  key={e.name}
                  className={selected?.name === e.name ? 'active' : undefined}
                  onClick={() => setSelected(e)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{e.name}</td>
                  <td>
                    {/* Non-toggleable channels (http, cli) are always on. */}
                    {e.isToggleable ? (
                      <span className={`status-pill ${STATE_PILL[e.state]}`}>{STATE_LABEL[e.state]}</span>
                    ) : (
                      <span className="status-pill confirmed">Always on</span>
                    )}
                  </td>
                  <td>{e.description}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                    No channels.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <ChannelDrawer
          key={selected.name}
          entry={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { void load(); }}
        />
      )}
    </div>
  </>
)}
```

- [ ] **Step 4: Typecheck the console**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol --filter @curia/console run typecheck
```

Expected: no errors. If TypeScript complains about `counts[v]` where `v` is `'all' | ChannelState`, note that `ChannelState` is `'uninstalled' | 'installed' | 'enabled'` — all of which are keys of `counts`. If needed, cast: `counts[v as keyof typeof counts]`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol add apps/console/src/pages/ChannelSettings.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol commit -m "feat: sortable columns and state filter pills in Channels view"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol test
```

Expected: all tests pass.

- [ ] **Step 2: Run the root typecheck (covers all src/ TypeScript)**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the console typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-ux-qol --filter @curia/console run typecheck
```

Expected: no errors.
