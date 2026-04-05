# Follow-up: Chat UI Integration into KG Explorer

## Context

PR #127 (`codex/build-chat-interface-for-curia`) adds the **chat API endpoints** to the KG web app:
- `POST /api/kg/chat/messages` — dispatch a message to the agent, get a reply
- `GET /api/kg/chat/stream` — SSE stream of agent events (filtered by conversationId)

**What is NOT in PR #127:** any chat UI. The KG explorer UI in `src/channels/http/routes/kg.ts` (`createUiHtml()`) is unchanged. Chat is available as a backend API only.

This follow-up PR should integrate a chat view into the existing KG explorer web app.

---

## What's already built (do NOT re-implement)

| Thing | Where |
|---|---|
| `POST /api/kg/chat/messages` route | `src/channels/http/routes/kg.ts` ~line 888 |
| `GET /api/kg/chat/stream` route | same file, ~line 948 |
| Session auth (`assertSecret`) | same file, `assertSecret()` function |
| Session cookie flow (`POST /auth`) | same file |
| `'web'` channel trust policy | `config/channel-trust.yaml` |
| CEO auto-resolution for `'web'` channel | `src/contacts/contact-resolver.ts` |
| Chat route tests | `tests/unit/channels/http/kg-chat-routes.test.ts` |

---

## What the follow-up PR needs to do

### 1. Add a Chat view to the KG explorer UI

The existing UI in `createUiHtml()` (inside `kg.ts`, ~line 100) already has a sidebar nav with an active state system. The KG explorer view (`#view-kg`) renders the Cytoscape graph. A Chat view needs to be added alongside it.

**Minimum UI pieces to add inside `createUiHtml()`:**

- A `#view-chat` section (hidden by default, shown when Chat nav is active)
- A conversation list panel (left column) and a message thread panel (right column) — same split-pane layout as the original Codex implementation
- A `#chat-form` textarea + submit button
- SSE stream connection via `new EventSource('/api/kg/chat/stream?conversationId=...')`
- A "Chat" nav button wired into the existing `navigate()` function

**Existing UI patterns to reuse:**
- `navigate(view, title, navId)` for view switching
- `.panel`, `.node-card`, `--teal`, `--primary`, `--border` CSS variables (from the Curia design system)
- `authForm.addEventListener('submit', ...)` flow — session is already established on page load; the chat form can start sending immediately

### 2. JS implementation guidance (avoid past codeant issues)

When writing the chat UI JS (inside the `<script>` block in `createUiHtml()`):

- **Wrap all fetch calls in try/catch** — both the send call and the response `.json()` parse. The backend returns structured JSON errors for all failure modes (400/401/403/504/500), so parse the body and surface the `.error` field to the user.
- **Do NOT use a `__ping__` message** for session checks — the page JS already probes `GET /api/kg/nodes?limit=1` on load. Reuse that existing `showMain()` / auth-wall pattern; if the user is already on `#main-app`, they're authenticated.
- **SSE event handling:** The EventRouter writes frames as `data: <json>\n\n` without an `event:` field, so listen on `stream.onmessage` (not named event listeners). Parse `event.data` as JSON and branch on `payload.type` (`outbound.message`, `skill.invoke`, `skill.result`) to decide what to render.
- **Sender identity:** The route handles this — all messages are attributed to the CEO via the `'web'` channel. No need to pass a sender ID from the UI.

### 3. Test coverage

Add tests to `tests/unit/channels/http/kg-chat-routes.test.ts` or `kg-routes.test.ts` as appropriate. The existing pattern: instantiate Fastify, register `knowledgeGraphRoutes`, inject requests.

No new test infrastructure is needed.

---

## Files to edit

- `src/channels/http/routes/kg.ts` — `createUiHtml()` only. Everything else is done.
- Optionally `tests/unit/channels/http/kg-chat-routes.test.ts` — add a test that the UI shell contains a "Chat" nav element.

Do NOT touch:
- `src/channels/http/http-adapter.ts` — wiring is complete
- `src/contacts/contact-resolver.ts` — web channel CEO resolution is done
- `config/channel-trust.yaml` — web channel policy is done
- The chat API route handlers themselves — only the UI HTML/JS needs work

---

## Worktree setup

```bash
# From repos/curia main checkout:
git worktree add ../../worktrees/curia-chat-ui -b feat/kg-chat-ui origin/main
cd ../../worktrees/curia-chat-ui
ln -sf ../../repos/curia/.env .env
pnpm install
```

The feature branch for the API is `codex/build-chat-interface-for-curia` — once PR #127 merges, branch `feat/kg-chat-ui` off `main`.
