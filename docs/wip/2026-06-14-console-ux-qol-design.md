# Console UX QoL — Design

**Date:** 2026-06-14
**Scope:** Four small UI improvements to the web console: chat bubble colour, URL hyperlinking in chat, sortable columns, and state pill filters.

---

## 1. User Chat Bubble Colour

**File:** `apps/console/src/styles/app.css`

`.msg-bubble.user` currently uses `--app-card-elev` (a neutral elevated surface). Change to `--app-teal` with white text so user messages are visually distinct from agent messages.

```css
.msg-bubble.user {
  background: var(--app-teal);
  color: #fff;
  border-radius: 12px 12px 2px 12px;
}
```

Dark-mode `--app-teal` is `#478189`. White on `#478189` clears WCAG AA (4.5:1 for small text). Light-mode `--app-teal` is `#1A6B5E`, which also passes.

---

## 2. URL Auto-Hyperlinking in Chat

### 2a. Agent messages — server-side (`src/utils/markdown-to-html.ts`)

Add URL detection to `applyInline()`, after code-span restoration. The existing `escapeHtml()` runs at the top of `applyInline()`, so by the time URL matching runs the text is already safe: `&`, `<`, `>` are entities, so no injection path exists through the URL.

Pattern: match `https?://[^\s<>"]+` after inline-formatting passes. Wrap in `<a href="..." target="_blank" rel="noopener noreferrer">...</a>`.

**Scope:** only `src/utils/markdown-to-html.ts` (chat path). The email copy at `src/channels/email/markdown-to-html.ts` is untouched.

### 2b. User messages — client-side (`apps/console/src/pages/chat/ChatThread.tsx`)

User bubbles currently render `msg.text` as a plain text node, so no URL is ever clickable. Add a `linkifyText(text: string): string` helper that:

1. Escapes HTML entities (same four replacements as server-side `escapeHtml`: `&`, `<`, `>`)
2. Detects `https?://[^\s<>"]+` with a regex
3. Wraps each match in `<a href="..." target="_blank" rel="noopener noreferrer">...</a>`

The helper is pure (no I/O) and lives at the top of `ChatThread.tsx`. User bubbles switch from `{msg.text}` to `dangerouslySetInnerHTML={{ __html: linkifyText(msg.text) }}`. This is safe: step 1 ensures no raw HTML from the user ever reaches the DOM.

URLs in user messages preserve surrounding whitespace because `.msg-bubble` already has `white-space: pre-wrap`.

---

## 3. Sortable Columns — Agents & Skills (`RegistrySettings.tsx`)

`ContactsPage` already implements the full sort pattern; this mirrors it exactly.

**State added to `RegistryPage`:**
```ts
type SortKey = 'name' | 'state' | 'version' | 'actionRisk' | 'sensitivity' | 'modelTier' | 'memoryScopes';
const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
```

**`filtered` useMemo** — extends existing search filter to also sort. String comparison on the resolved display value for each key.

**Table headers** — each `<th>` gains `className="sortable"` and `aria-sort`. Inside, a `<button className="sort-btn">` with a `<span className="sort-arrow">` (↑/↓/empty). Same CSS classes ContactsPage already uses — no new CSS needed.

Sortable columns:
- **Both kinds:** Name, State, Version
- **Skills only:** Action risk, Sensitivity
- **Agents only:** Model tier, Memory scopes

Default sort: Name ascending.

---

## 4. Sortable Columns — Channels (`ChannelSettings.tsx`)

Same pattern. Sortable columns: Name, State, Description. Default sort: Name ascending.

Since Channels has no search/pagination today, this change also adds the `useMemo` pattern for sorting (sort applied to the full `entries` array; output replaces `entries.map(...)` in the table body).

---

## 5. State Pill Filters — Agents & Skills (`RegistrySettings.tsx`)

Mirror `ContactsPage`'s `records-toolbar` pattern.

**State added:**
```ts
const [stateFilter, setStateFilter] = useState<'all' | DerivedState>('all');
```

**`counts` useMemo:**
```ts
const counts = useMemo(() => ({
  all:         entries.length,
  uninstalled: entries.filter(e => e.state === 'uninstalled').length,
  installed:   entries.filter(e => e.state === 'installed').length,
  enabled:     entries.filter(e => e.state === 'enabled').length,
  ghost:       entries.filter(e => e.state === 'ghost').length,
}), [entries]);
```

**Filter integration:** `stateFilter` applied in `filtered` useMemo before search, resets `page` to 1 on change.

**Toolbar markup:** `<div className="records-toolbar">` with `records-filter-chip` buttons, count badges — identical HTML structure to ContactsPage. No new CSS.

Filter labels: All, Enabled, Installed, Ghost, Uninstalled.

---

## 6. State Pill Filters — Channels (`ChannelSettings.tsx`)

Same pattern. States: All, Enabled, Installed, Uninstalled. (No "ghost" state for channels.)

Since Channels currently has no filtered/pagination useMemo, this change introduces one to support filter + sort together.

---

## Files Changed

| File | Change |
|---|---|
| `apps/console/src/styles/app.css` | User bubble colour |
| `apps/console/src/pages/chat/ChatThread.tsx` | `linkifyText` helper + user bubble `dangerouslySetInnerHTML` |
| `src/utils/markdown-to-html.ts` | URL auto-link in `applyInline()` |
| `apps/console/src/pages/RegistrySettings.tsx` | Sort state + sortable headers + state filter toolbar |
| `apps/console/src/pages/ChannelSettings.tsx` | Sort state + sortable headers + state filter toolbar |

No new dependencies. No database changes. No API changes. No new CSS classes (all classes already exist in `app.css` from the ContactsPage implementation).
