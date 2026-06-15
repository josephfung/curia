# Harden browser sessions against bot detection — design

**Issue:** #987
**Date:** 2026-06-15
**Status:** Approved (brainstorming)

## Goal

Authorized, user-initiated automation (the principal asking Curia to log into
*their own* accounts or make *their own* reservations) is being blocked by
anti-bot systems. Confirmed failures: x.com login, OpenTable reservation, an
online personality test (form fill).

The browser already runs headed (`headless: false` + Xvfb) with
`--disable-blink-features=AutomationControlled`, which strips
`navigator.webdriver`. Headedness is **not** the gap. The blockers are:

1. The ad blocker injecting cosmetic filters / request interception that sites
   fingerprint as a privacy extension (x.com explicitly refuses).
2. A stale, generic fingerprint (hardcoded `Chrome/122` UA, bundled Chromium,
   no locale/timezone/colorScheme, residual CDP automation signals).
3. No persistent profile — every session is a brand-new incognito context, so
   every visit looks like a first-time visitor and re-triggers login / 2FA.

Out of scope (per issue): proxy / residential-IP work. Some strict sites may
still resist automation from the server IP; that is an accepted limitation.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persistence model | **Persistent context** (`launchPersistentContext`), single shared profile | Curia is single-principal per instance, so per-principal ≡ shared. Most realistic "returning user" fingerprint; matches the issue's explicit ask. |
| Stealth layer | **`playwright-extra` + `puppeteer-extra-plugin-stealth`** | Broadest out-of-the-box evasion coverage for residual CDP/automation signals. |
| Ad blocking | **Opt-in** via `block_ads` input, default `false` | Off by default for login/auth/form-fill; normal browsing can still enable it. Handler can't auto-classify flow type (LLM drives navigation), so opt-in is the clean mechanism. |
| Blocklist fetch | **Lazy, first-use** | No wasted startup download now that blocking is off by default. |
| Deploy changes | **Drafted alongside** (separate curia-deploy PR) | `channel: 'chrome'` and cross-restart persistence need a real-Chrome image + a mounted profile volume. Code degrades gracefully without them. |
| User agent | **Stop overriding it** | Real Chrome channel + stealth's UA-override evasion sends the genuine, current UA — "never goes stale" by construction; sidesteps the chicken-and-egg of reading `browser.version()` before context creation. |

## Architecture change: persistent context replaces Browser + per-session contexts

### Before

```
chromium.launch()  →  one warm Browser (kept across sessions)
  └─ browser.newContext()  →  isolated context per session (cookies wiped each time)
       └─ context.newPage()  →  one page
BrowserSession.close()  →  context.close()
stop()  →  close each session, then browser.close()
```

### After

```
chromium.use(stealth())
chromium.launchPersistentContext(profileDir, {...})  →  one persistent context = the warm browser
  └─ context.newPage()  →  one page PER SESSION (shared cookies/localStorage/history)
BrowserSession.close()  →  page.close()        // NOT context.close()
stop()  →  close each page, then context.close()
```

Key consequences:

- **A session is now a `Page`, not a `BrowserContext`.** `BrowserSession` keeps a
  reference to the shared context (for the API surface) but `close()` closes only
  its `page`. The injected-secret redaction stays per-session (per-page) and is
  unaffected.
- **Isolation between sessions is intentionally dropped.** Sessions share cookies
  and storage — that is the persistence. This is correct for a single principal
  and is documented in the file header (the old "separate cookies/storage per
  session" comment is replaced).
- **Crash/disconnect recovery** re-attaches to the persistent context's underlying
  browser via `context.browser()?.on('disconnected')`. On disconnect: clear the
  page map and relaunch the persistent context, then re-attach the handler (same
  recover-more-than-once pattern as today).
- **TTL sweep** closes idle pages, not contexts. `getOrCreateSession` /
  `closeSession` / `sweep` semantics are otherwise unchanged — they operate on the
  `Map<SessionId, BrowserSession>` exactly as before.
- **Single profile, single owner.** A profile dir can be opened by only one
  process. Fine for one instance; tests use temp dirs.

### Factory abstraction (testability)

The current `browserFactory: () => Promise<Browser>` injection becomes
`contextFactory: () => Promise<BrowserContext>` returning a persistent context.
Default implementation launches the stealth-wrapped persistent context; tests
inject a mock context exposing `newPage`, `close`, `browser()`.

## Ad blocker → opt-in, off by default

- New skill input `block_ads` (boolean, default `false`).
- `enableBlockingInPage(page)` runs only when `block_ads: true`.
- Blocklist is fetched lazily on first opt-in and cached:
  `this.blocker ??= await (this.blockerPromise ??= PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch))`.
  Fetch failure logs a warning and proceeds without blocking (current behavior).
- The eager startup fetch in `start()` is removed.
- Skill description updated so the LLM enables `block_ads` only for plain content
  browsing — never for login / authenticated / form-fill flows.

**First validation step when implementing:** blocker off, re-test x.com renders.

## Fingerprint hardening

Applied at `launchPersistentContext` time:

- `channel: 'chrome'` when `browser.channel` config is set and Chrome is present;
  graceful fallback to bundled Chromium otherwise (catch launch error, retry
  without `channel`, log a warning).
- No `userAgent` override (see decision above). Log `context.browser()?.version()`
  after launch for observability.
- `locale` (default `'en-US'`, config `browser.locale`).
- `timezoneId` from `config.timezone` (already wired through to the service).
- `colorScheme: 'light'`.
- `viewport: { width: 1280, height: 720 }` (matches the Xvfb screen size).
- Launch args unchanged (`--disable-blink-features=AutomationControlled`,
  `--no-sandbox`, `--disable-dev-shm-usage`).
- Stealth: `chromium.use(stealth())` before launch.

## Persistent profile

- New config `browser.profileDir` (default `${HOME}/.curia/browser-profile`).
- In prod this directory must live on a mounted volume so cookies/session survive
  container restarts (curia-deploy follow-up — see below).
- Single shared profile dir for the instance.

## Config & wiring

`config/default.yaml` gains a `browser` section (the cast in `index.ts` is
replaced by a typed read):

```yaml
browser:
  sessionTtlMs: 600000
  sweepIntervalMs: 120000
  profileDir: ""        # empty → default ${HOME}/.curia/browser-profile
  channel: ""           # empty → bundled Chromium; "chrome" → real Chrome
  locale: "en-US"
```

`BrowserService` constructor gains `profileDir`, `channel`, `locale`, `timezone`.
`index.ts` passes `timezone: config.timezone` and the new browser config through.

## Dependencies

Add to `package.json`:

- `playwright-extra`
- `puppeteer-extra-plugin-stealth`

Run `pnpm install`, commit lockfile. If pnpm flags new build scripts, set the
`allowBuilds` entry explicitly to `true`/`false` (never placeholder text) per
repo convention.

## Deploy changes (curia-deploy — separate PR)

Drafted alongside this work:

- Install `google-chrome-stable` in the image (so `channel: 'chrome'` resolves).
- Mount a persistent volume at the configured `browser.profileDir`.
- Set `browser.channel: chrome` and `browser.profileDir` in the deployment config.

## Test plan

- **Unit (mocked):** rework mocks to the persistent-context shape. Keep all
  existing behaviors green (create / reuse / expire / sweep / stop) with
  sessions-as-pages. New cases:
  - `block_ads` gating — blocker attaches only when `true`; lazy fetch happens
    once and is cached.
  - `session.close()` closes the page, not the shared context.
  - disconnect → relaunch re-attaches the handler and clears sessions.
- **Integration (`RUN_BROWSER_TESTS=1`, temp profile dir):**
  - persistence across restart: set a cookie / localStorage value, `stop()`,
    `start()` against the same profile dir, assert it survived.
  - existing navigate / content / close flows still pass.
- **Manual re-test (PR checklist):** x.com login renders + accepts creds (no
  "privacy related extensions" error); OpenTable reservation reaches + submits;
  personality-test form fill reaches + submits.

## Acceptance criteria mapping

| Criterion | Covered by |
|---|---|
| Ad blocking off by default, opt-out per session; x.com renders | `block_ads` opt-in (default false), lazy blocklist |
| UA matches current real Chrome, not hardcoded | `channel: 'chrome'` + stealth UA-override, no override, version logged |
| locale + timezoneId + viewport + stealth active | context options + `chromium.use(stealth())` |
| Persistent profile retains cookies across restarts | `launchPersistentContext(profileDir)` on a volume |
| OpenTable + form fill reach/submit | manual re-test checklist |

## Risks & notes

- **Single-profile concurrency:** all sessions are tabs in one browser. The
  current model is already single-browser, so no regression; concurrency stays
  bounded by one process.
- **Stealth plugin is puppeteer-oriented** (compat shims via playwright-extra)
  and lightly maintained. Acceptable for now; revisit if it breaks on a
  Playwright upgrade.
- **Lost isolation** is deliberate. If a future need for per-principal isolation
  arises (multi-principal), it would mean per-principal profile dirs + multiple
  browser processes — out of scope here.
- **Profile corruption** (e.g. unclean shutdown) could wedge the browser. Launch
  failure already triggers graceful degradation (web-browser skill unavailable);
  a corrupt-profile recovery (wipe + relaunch) can be a follow-up if observed.
