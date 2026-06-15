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

  constructor(context: BrowserContext, page: Page, ownedContext: BrowserContext | null = null) {
    this.context = context;
    this.page = page;
    this.ownedContext = ownedContext;
    this.lastUsedAt = Date.now();
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

  /** Returns true if the session has been idle longer than ttlMs. */
  isExpired(ttlMs: number): boolean {
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
