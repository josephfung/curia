// src/browser/browser-session.ts — wraps a Playwright BrowserContext + Page with TTL tracking.
//
// Each BrowserSession is an isolated browser context (separate cookies, storage, cache)
// with a single active page. The TTL is refreshed on every use; sessions expire
// automatically via the BrowserService sweep interval.

import type { BrowserContext, Page } from 'playwright';

export class BrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Epoch ms of last access — updated by BrowserService.getOrCreateSession() on reuse. */
  lastUsedAt: number;

  constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
    this.lastUsedAt = Date.now();
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
