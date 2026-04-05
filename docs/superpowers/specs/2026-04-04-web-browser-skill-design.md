# Web Browser Skill — Design Spec

**Date:** 2026-04-04
**Spec:** 13
**Status:** Draft
**Closes:** josephfung/curia#124

---

## Overview

A new `web-browser` skill that gives Curia a real, JS-capable browser for interacting with
dynamic websites, multi-step forms, login flows, and any app that has no API. Built on
Playwright with a persistent warm browser process and explicit session management.

`web-fetch` is unchanged — it remains the fast path for static pages. The LLM is steered
to `web-browser` via the skill description when JS rendering or user interaction is needed.

---

## Background

`web-fetch` performs a plain HTTP GET and parses static HTML. Sites that render content
via JavaScript return a shell page with placeholder content. Discovered during smoke
testing: Curia fetched the Landmark Cinemas showtimes page and reported May 2026 dates
baked into the static HTML; actual showtimes are injected by JS after load.

Beyond read-only retrieval, Curia needs to handle multi-step interactions: event
registration, form submission, and serving as a fallback browser when a service has no API.

---

## Design Decisions

### New skill, not an extension of web-fetch

`web-fetch` has a clean read-only HTTP contract. Adding JS rendering and session state
would pollute both its manifest semantics and the LLM's understanding of when to use it.
Two skills with clear descriptions is simpler for the LLM to reason about.

### headless: false + Xvfb, not headless: true

Cloudflare and similar bot-detection systems fingerprint headless browsers via the
rendering pipeline, missing APIs, and `navigator.webdriver` flags. Running Chromium in
headed mode (`headless: false`) against an Xvfb virtual display produces a full browser
indistinguishable from a real user session. Xvfb is only spawned if no `DISPLAY` env var
is already set (e.g., dev environments with a real display are unaffected).

### LLM as navigator, skill as primitives

The skill exposes a small set of general-purpose browser actions. Each call performs one
action and returns the updated page state. The LLM uses its normal tool-use loop to
reason about what to do next — the skill provides the hands, not the intelligence.

### Explicit session_id (Option C over conversation-scoped Option B)

Browser contexts are keyed by an opaque `session_id` UUID returned on first call. The LLM
carries the session_id forward in its context window. This is simpler to implement
correctly than conversation-scoped sessions (no need to track conversation lifecycle),
more transparent in logs, and the LLM can intentionally abandon a broken session and start
fresh. It also makes future cross-channel session continuity possible since the session_id
is explicit in conversation history.

### Injected BrowserService (Option 2)

`BrowserService` follows the same pattern as `NylasCalendarClient`, `ContactService`, etc.
— instantiated at bootstrap in `src/index.ts`, injected into `SkillContext`. Lifecycle
(graceful shutdown, crash recovery, TTL cleanup) is managed centrally. The warm browser
process is shared across all sessions; each session gets its own isolated `BrowserContext`.

---

## Architecture

### New files

```
src/browser/
  browser-service.ts       # BrowserService — warm browser process + session map
  browser-session.ts       # BrowserSession — wraps a BrowserContext + Page + TTL handle
  types.ts                 # BrowserActionResult, SessionId, shared types

skills/web-browser/
  skill.json               # Skill manifest
  handler.ts               # Action dispatcher — uses ctx.browserService
  handler.test.ts          # Unit tests (mocked BrowserService)

src/browser/
  browser-service.test.ts  # Integration tests (real browser, gated behind RUN_BROWSER_TESTS=1)
  tests/fixtures/          # Static HTML/JS test pages for integration tests
```

### Modified files

```
src/skills/types.ts        # Add browserService?: BrowserService to SkillContext
src/index.ts               # Instantiate BrowserService, wire into ExecutionLayer
config/default.yaml        # Add browser.sessionTtlMs, browser.sweepIntervalMs
```

### Component relationships

```
src/index.ts (bootstrap)
  └─ new BrowserService()
       ├─ spawns Xvfb :99 (if no DISPLAY set)
       ├─ launches Playwright Chromium (headless: false, DISPLAY=:99)
       ├─ initialises @ghostery/adblocker-playwright (downloads/caches filter lists)
       └─ holds Map<sessionId, BrowserSession>

ExecutionLayer
  └─ injects BrowserService → ctx.browserService

skills/web-browser/handler.ts
  └─ dispatches action → ctx.browserService.getOrCreateSession(session_id?)
       └─ BrowserSession: BrowserContext + Page + TTL timestamp
```

---

## Skill Manifest

```json
{
  "name": "web-browser",
  "description": "Control a real web browser to interact with JS-rendered pages, fill forms, navigate multi-step flows, and interact with sites that have no API. Use this instead of web-fetch when a page requires JavaScript, login, or user interaction. Each call performs one action and returns the updated page state. Pass session_id back on subsequent calls to maintain browser context across actions.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "autonomy_floor": "spot-check",
  "inputs": {
    "action": "string",
    "url": "string?",
    "selector": "string?",
    "text": "string?",
    "value": "string?",
    "session_id": "string?",
    "screenshot": "boolean?"
  },
  "outputs": {
    "content": "string",
    "session_id": "string",
    "url": "string",
    "screenshot_base64": "string?"
  },
  "permissions": ["network:https"],
  "secrets": [],
  "timeout": 30000
}
```

`autonomy_floor: "spot-check"` — the browser can submit forms and trigger real-world side
effects, so it must not run at `"full"` autonomy. Actions are logged and reviewable.

---

## Action Model

| `action` | Required inputs | What it does |
|---|---|---|
| `navigate` | `url` | Go to URL, wait for load, return page content |
| `click` | `selector` | Click element, return updated content |
| `type` | `selector`, `text` | Focus + clear + type into input, return updated content |
| `select` | `selector`, `value` | Choose dropdown option, return updated content |
| `get_content` | — | Re-read current page state |
| `screenshot` | — | Capture current view, return base64 image |
| `close_session` | — | Explicitly close browser context |

`selector` is natural language, not CSS. The handler uses Playwright's `getByText()`,
`getByRole()`, `getByLabel()` locators, falling back to CSS only if needed. This is more
robust across sites and easier for the LLM to reason about.

`screenshot: true` can be added to any action to return a base64 image alongside content.

Every action except `close_session` returns `content`, `session_id`, and current `url`.

---

## BrowserService Internals

### Session lifecycle

```
getOrCreateSession(sessionId?)
  ├─ sessionId provided + exists + not expired → refresh TTL, return existing session
  ├─ sessionId provided + expired → close old context, create fresh, return new session_id
  └─ no sessionId → create fresh BrowserContext + Page, return new session_id
```

New sessions get a UUID `session_id`. The handler returns it in every response so the LLM
carries it forward as a normal value in its context window.

### TTL and cleanup

- Default TTL: 10 minutes from last use (configurable: `browser.sessionTtlMs`)
- Sweep interval: every 2 minutes (configurable: `browser.sweepIntervalMs`)
- Expired contexts are closed and removed from the map on each sweep
- `close_session` action allows explicit cleanup when the LLM is done

### Xvfb management

`BrowserService.start()` checks for an existing `DISPLAY` env var. If absent, it spawns
`Xvfb :99 -screen 0 1280x720x24` as a child process and sets `DISPLAY=:99` before
launching Chromium. On graceful shutdown, Xvfb is killed after the browser closes.

### Ad blocking

`@ghostery/adblocker-playwright` is initialised once at `BrowserService.start()` — it
downloads and caches EasyList/EasyPrivacy filter lists. Each new `BrowserContext` gets the
blocker applied via `adBlocker.addEventListeners(page)` at context creation time. This
reduces page load time, DOM noise, and token cost from the cleaned content output.

### Chromium launch flags

```ts
args: [
  '--disable-blink-features=AutomationControlled', // removes navigator.webdriver flag
  '--no-sandbox',                                   // required in container environments
  '--disable-dev-shm-usage',                        // prevents /dev/shm OOM in Docker
]
```

### DOM cleaning

After each action, before returning `content`, the handler:
1. Strips `<script>`, `<style>`, `<noscript>`, `<svg>`, `<iframe>` content
2. Collapses whitespace
3. Extracts form inputs with their labels (so the LLM knows what fields exist and what they're called)
4. Caps output at 15KB (configurable) — prevents token blowout on content-heavy pages

### SCALABILITY @TODO

```
// SCALABILITY @TODO: This implementation runs a single Playwright browser in-process.
// To scale to higher concurrency or add crash isolation:
//
// 1. Browser pool: run N browsers, round-robin sessions across them.
//    Add a pool size config and a simple round-robin or least-loaded assignment strategy.
//
// 2. Sidecar process: move BrowserService behind a local HTTP/WebSocket interface.
//    The skill calls it over localhost. Crash isolation: a browser crash can't take
//    down Curia. playwright-server is a reference implementation.
//
// 3. Managed service: connect to Browserless.io or ScrapingBee via WebSocket.
//    They handle Xvfb, stealth fingerprinting, CAPTCHA solving, and scaling externally.
//    Browserless.io is a drop-in replacement — only the launch/connect call changes.
//    Drop the Xvfb management entirely when using a managed service.
//
// For options 2 and 3, only browser-service.ts needs to change — the handler,
// session model, and SkillContext interface are unaffected.
```

---

## Error Handling

The handler never throws — all failures return `{ success: false, error: string }`.

| Failure | Behaviour |
|---|---|
| Invalid `action` value | Return error immediately, no browser interaction |
| `session_id` provided but expired | Return error: `"Session expired — start a new session with navigate"` |
| Navigation timeout | Return error with URL and timeout duration |
| Selector not found | Return error with selector string — LLM retries with different description or takes screenshot to reassess |
| Page crash | `BrowserService` listens on `page.on('crash')`, closes the session, returns error. LLM starts a fresh session. |
| Browser process crash | `BrowserService` detects via Playwright's disconnect event, restarts the browser, clears all sessions, returns error on the triggering call |
| Xvfb fails to start | Thrown in `BrowserService.start()`, caught in `src/index.ts` bootstrap — Curia logs and continues without `web-browser` available. All other skills unaffected. |

Selector-not-found returns an explicit error rather than empty content so the LLM knows
to reassess — take a screenshot, try a different description, or report back. Silent empty
returns would cause the LLM to retry blindly.

---

## Testing

### Unit tests (`handler.test.ts`)

Mock `ctx.browserService`. Test:
- Action dispatch routing (each action value calls the correct service method)
- Input validation (missing required fields per action)
- All error paths return correct `{ success: false, error }` shapes
- `session_id` is threaded through correctly

### Integration tests (`src/browser/browser-service.test.ts`)

Real Playwright browser against local test fixtures in `src/browser/tests/fixtures/`. Gated behind
`RUN_BROWSER_TESTS=1` env var (requires display, slower than unit suite).

Test coverage:
- Session creation, reuse, and TTL expiry
- Each action type end-to-end
- DOM cleaning output shape
- Ad blocker initialisation (verify ad requests are blocked)
- Browser crash recovery
- Graceful shutdown (all contexts closed, Xvfb killed)

---

## Acceptance Criteria

- `web-browser` can retrieve live showtime data from `https://www.landmarkcinemas.com/showtimes/waterloo` (josephfung/curia#124)
- LLM can complete a multi-step form flow (navigate → type → click → submit) across multiple skill calls using a persistent session_id
- Sessions expire after 10 minutes of inactivity and are cleaned up without manual intervention
- Browser process crash is recovered automatically without restarting Curia
- `web-fetch` is unchanged and all existing web-fetch tests pass
