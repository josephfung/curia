// src/browser/browser-session.ts — wraps a Playwright BrowserContext + Page with TTL tracking.
//
// Each BrowserSession is an isolated browser context (separate cookies, storage, cache)
// with a single active page. The TTL is refreshed on every use; sessions expire
// automatically via the BrowserService sweep interval.

import type { BrowserContext, Page } from 'playwright';
import { redactValues } from '../skills/sanitize.js';

/** HTML-entity-escape the characters a browser escapes when reflecting input into DOM text.
 *  `&` must be replaced first so the entity ampersands it introduces aren't re-escaped. */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export class BrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Epoch ms of last access — updated by BrowserService.getOrCreateSession() on reuse. */
  lastUsedAt: number;
  /** Epoch ms the session was created — the anchor for the absolute-age cap that bounds
   *  even a keep-warm session's lifetime, so a forgotten pinned tab can't leak forever. */
  readonly createdAt: number;

  /**
   * Keep-warm pin (opt-in, per task). A parked long-running browser task sets this so its
   * session survives the idle TTL between wakes that may be far apart — the woken task
   * reattaches to the same live, logged-in page instead of a cold tab. Pinning only exempts
   * the session from the *idle* TTL; the absolute-age cap (see isExpired) still applies, and
   * a process restart still loses the live page (the persistent PROFILE — cookies/history —
   * survives on disk, so re-navigation resumes). Concurrent tasks each pin their own session
   * (a separate page in the shared profile), so they never clobber one another. Default false
   * (throwaway-per-flow, as before). See ADR-030.
   */
  keepWarm = false;

  /**
   * Literal secret VALUES injected into this session by reference (#973), e.g. a
   * password typed into a login form via `type {secret_ref}`. Held in memory only,
   * never logged, and discarded with the session when it closes/expires. Page content
   * read back during the session is scrubbed of these before reaching the LLM, so a
   * hostile page that reflects an injected value can't exfiltrate it through get_content.
   */
  private readonly injectedSecretValues = new Set<string>();

  /**
   * For INCOGNITO sessions: the ephemeral BrowserContext this session OWNS and must
   * tear down on close. Null for PERSISTENT sessions, whose page lives in the shared
   * persistent profile context — closing that context would kill the whole browser, so
   * a persistent session closes only its page instead. This single switch distinguishes
   * the two session lifecycles (see #987 design).
   */
  private readonly ownedContext: BrowserContext | null;

  /**
   * Count of consecutive FAILED interaction actions (click/type/select/hover/wait_for) on this
   * session, for the handler's circuit-breaker. A stale-ref or occluded click still costs
   * seconds, so a stuck agent that keeps retrying would otherwise drain its whole budget into a
   * futile loop (the 16personalities incident). The handler increments this only on a failed
   * gated interaction, and resets it to 0 on ANY success — so re-reading the page (a successful
   * get_content) re-enables interaction. This curbs, but does not hard-bound, an agent that
   * oscillates trip→re-read→trip; fail-fast on stale refs does most of the budget savings.
   */
  consecutiveFailures = 0;

  /** Record a failed action (circuit-breaker input). */
  recordFailure(): void {
    this.consecutiveFailures++;
  }

  /** Record a successful action — clears the failure streak. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** True once consecutive failures reach `threshold` (circuit-breaker tripped). */
  isTripped(threshold: number): boolean {
    return this.consecutiveFailures >= threshold;
  }

  constructor(context: BrowserContext, page: Page, ownedContext: BrowserContext | null = null) {
    this.context = context;
    this.page = page;
    this.ownedContext = ownedContext;
    const now = Date.now();
    this.lastUsedAt = now;
    this.createdAt = now;
  }

  /**
   * Record a secret value that was injected into this session so it can be redacted
   * from any text returned to the agent. Empty/whitespace-only values are ignored
   * (redactValues would otherwise be a no-op on them anyway). The value is never logged.
   */
  registerInjectedSecret(value: string): void {
    if (typeof value === 'string' && value.trim().length > 0) {
      this.injectedSecretValues.add(value);
    }
  }

  /**
   * Scrub every injected secret value from `text`, replacing exact occurrences with
   * `[REDACTED]`. Returns `text` unchanged when nothing has been injected.
   *
   * redactValues matches literals only, so a page that reflects a value *transformed*
   * (URL-encoded into a query string after a GET submit, or HTML-entity-encoded into the
   * DOM) would slip past a raw-only match. We therefore redact each value AND its common
   * browser encodings — the two surfaces that actually carry reflected input back to us.
   */
  redactInjectedSecrets(text: string): string {
    if (this.injectedSecretValues.size === 0) return text;
    const variants = new Set<string>();
    for (const value of this.injectedSecretValues) {
      variants.add(value);
      // URL encodings — query strings / form-GET reflections in page.url().
      // encodeURIComponent covers query params; encodeURI covers full-URL reflection.
      // Wrapped in try/catch: these throw on lone surrogate halves, which we ignore.
      try { variants.add(encodeURIComponent(value)); } catch { /* malformed input — skip */ }
      try { variants.add(encodeURI(value)); } catch { /* malformed input — skip */ }
      // HTML-entity encoding — DOM text reflection via get_content.
      variants.add(htmlEscape(value));
    }
    return redactValues(text, variants);
  }

  /**
   * Returns true if the session should be evicted.
   *
   * - `maxAgeMs` (absolute-age cap) ALWAYS applies when provided: a session older than this
   *   since creation is expired regardless of keep-warm, so a pinned tab can't leak forever.
   * - A keep-warm session is otherwise exempt from the idle TTL (a parked task can resume it
   *   after a long gap between wakes).
   * - Otherwise the session expires after being idle longer than `ttlMs`.
   */
  isExpired(ttlMs: number, maxAgeMs?: number): boolean {
    if (maxAgeMs !== undefined && Date.now() - this.createdAt > maxAgeMs) return true;
    if (this.keepWarm) return false;
    return Date.now() - this.lastUsedAt > ttlMs;
  }

  /**
   * Release this session's browser resources.
   * - Incognito: close the owned ephemeral context (also closes its page).
   * - Persistent: close only the page; the shared profile context stays alive for
   *   other sessions and to keep the profile warm.
   */
  async close(): Promise<void> {
    if (this.ownedContext) {
      await this.ownedContext.close();
    } else {
      await this.page.close();
    }
  }
}
