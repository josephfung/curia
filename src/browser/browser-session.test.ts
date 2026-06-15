// browser-session.test.ts — unit tests for BrowserSession's injected-secret
// redaction set (#973).
//
// When a secret value is injected into a form by reference, the session records
// that value so any page content read back during the same session can be scrubbed
// of it — the backstop against a hostile page reflecting the value into LLM context.

import { describe, it, expect, vi } from 'vitest';
import { BrowserSession } from './browser-session.js';
import type { BrowserContext, Page } from 'playwright';

/** A BrowserSession needs only a context + page; neither is touched by these tests. */
function makeSession(): BrowserSession {
  const fakeContext = {} as unknown as BrowserContext;
  const fakePage = {} as unknown as Page;
  return new BrowserSession(fakeContext, fakePage);
}

/** A session backed by vi.fn() page/context so close() behavior can be asserted. */
function makeClosableSession(opts: { incognito: boolean }) {
  const page = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
  const ownedContext = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
  const sharedContext = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
  const session = opts.incognito
    ? new BrowserSession(ownedContext, page, ownedContext)
    : new BrowserSession(sharedContext, page, null);
  return { session, page, ownedContext, sharedContext };
}

describe('BrowserSession close lifecycle', () => {
  it('persistent session closes only its page, not the shared context', async () => {
    const { session, page, sharedContext } = makeClosableSession({ incognito: false });
    await session.close();
    expect((page as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
    expect((sharedContext as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('incognito session closes its owned context (which closes the page)', async () => {
    const { session, page, ownedContext } = makeClosableSession({ incognito: true });
    await session.close();
    expect((ownedContext as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
    // We do NOT also call page.close() — context.close() tears the page down.
    expect((page as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
});

describe('BrowserSession injected-secret redaction', () => {
  it('redacts a registered secret value from text', () => {
    const session = makeSession();
    session.registerInjectedSecret('hunter2');

    const out = session.redactInjectedSecrets('balance page shows hunter2 in a hidden field');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves text untouched when nothing has been injected', () => {
    const session = makeSession();
    expect(session.redactInjectedSecrets('no secrets here')).toBe('no secrets here');
  });

  it('redacts every registered value', () => {
    const session = makeSession();
    session.registerInjectedSecret('alice');
    session.registerInjectedSecret('s3cr3t');

    const out = session.redactInjectedSecrets('user alice / pw s3cr3t');
    expect(out).toBe('user [REDACTED] / pw [REDACTED]');
  });

  it('ignores empty values (does not destroy text)', () => {
    const session = makeSession();
    session.registerInjectedSecret('');
    expect(session.redactInjectedSecrets('intact')).toBe('intact');
  });

  it('redacts a URL-encoded reflection of a registered value', () => {
    const session = makeSession();
    const secret = 'p@ss w&rd';
    session.registerInjectedSecret(secret);

    // A GET-form submit re-emits the value URL-encoded in the query string.
    const encoded = encodeURIComponent(secret); // p%40ss%20w%26rd
    const out = session.redactInjectedSecrets(`https://site.test/login?pw=${encoded}`);
    expect(out).not.toContain(encoded);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts an HTML-entity-encoded reflection of a registered value', () => {
    const session = makeSession();
    const secret = 'a&b<c>';
    session.registerInjectedSecret(secret);

    // A page that echoes the value into the DOM escapes HTML metacharacters.
    const out = session.redactInjectedSecrets('reflected: a&amp;b&lt;c&gt;');
    expect(out).not.toContain('a&amp;b&lt;c&gt;');
    expect(out).toContain('[REDACTED]');
  });

  it('keeps redaction sets isolated per session', () => {
    const a = makeSession();
    const b = makeSession();
    a.registerInjectedSecret('only-in-a');

    // b never saw the value — it must not redact it.
    expect(b.redactInjectedSecrets('only-in-a appears here')).toBe('only-in-a appears here');
  });
});
