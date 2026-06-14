// src/browser/browser-session.ts — wraps a Playwright BrowserContext + Page with TTL tracking.
//
// Each BrowserSession is an isolated browser context (separate cookies, storage, cache)
// with a single active page. The TTL is refreshed on every use; sessions expire
// automatically via the BrowserService sweep interval.

import type { BrowserContext, Page } from 'playwright';
import { redactValues } from '../skills/sanitize.js';

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

  constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
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
   */
  redactInjectedSecrets(text: string): string {
    if (this.injectedSecretValues.size === 0) return text;
    return redactValues(text, this.injectedSecretValues);
  }

  /** Returns true if the session has been idle longer than ttlMs. */
  isExpired(ttlMs: number): boolean {
    return Date.now() - this.lastUsedAt > ttlMs;
  }

  /** Close the underlying browser context, releasing all associated resources. */
  async close(): Promise<void> {
    await this.context.close();
  }
}
