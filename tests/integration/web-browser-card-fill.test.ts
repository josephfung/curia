// Saved-card fills into real dropdowns and text boxes (#1358, Task 8).
//
// Drives WebBrowserHandler against a real Chromium (launched through Patchright, headless,
// the way BrowserService launches it) with the real BrowserService, on fixture checkout pages
// served by context.route(), so no network is touched. The resolver is a stub backed by
// projectCardField over a fixed card (expiry 12/2027) that checks the siteUrl the handler
// passes is the top-level shop page.
//
// This test needs a browser and does NOT skip without one: CI installs Chromium for Patchright
// before `pnpm test` (.github/workflows/ci.yml), and locally run
// `pnpm exec patchright install chromium`. A missing browser fails beforeAll.
//
// The principal asked for expiry dropdowns labelled with month names and years, not only
// two-digit text entry; each case asserts the selected option's VALUE (which differs from its
// label) and that nothing in the result carries the filled value.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { BrowserContext, Page } from 'playwright';
import { BrowserService } from '../../src/browser/browser-service.js';
import { createSilentLogger } from '../../src/logger.js';
import type { ToolContext } from '../../src/skills/types.js';
import {
  projectCardField,
  type CreditCardPublicFields,
  type CreditCardSecretDoc,
} from '../../src/secrets/structured-secret-schema.js';
import { WebBrowserHandler } from '../../skills/web/tools/web-browser/handler.js';

const SHOP = 'https://shop.example.test';
const PAY_FRAME = 'https://js.pay.example.test';

const PUBLIC_FIELDS: CreditCardPublicFields = {
  brand: 'visa',
  last4: '4242',
  expiry_month: '12',
  expiry_year: '2027',
  cardholder_name: 'Pat Doe',
};
const SECRET_DOC: CreditCardSecretDoc = { _schema: 'credit_card', number: '4242424242424242', cvv: '123' };

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));
const pad = (n: number): string => String(n).padStart(2, '0');

function options(rows: Array<[value: string, label: string]>): string {
  return ['<option value="">Select</option>', ...rows.map(([v, l]) => `<option value="${v}">${l}</option>`)].join('');
}

function page(body: string): string {
  return `<!doctype html><html><head><title>Checkout</title></head><body><form>${body}</form></body></html>`;
}

const YEARS = [2026, 2027, 2028, 2029];

const FIXTURES: Record<string, string> = {
  '/month-name': page(`<label for="m">Expiry month</label><select id="m">${
    options(MONTHS_LONG.map((label, i) => [`m${pad(i + 1)}`, label]))}</select>`),
  '/month-short': page(`<label for="m">Expiry month</label><select id="m">${
    options(MONTHS_SHORT.map((label, i) => [`s${pad(i + 1)}`, label]))}</select>`),
  '/month-mm': page(`<label for="m">Expiry month</label><select id="m">${
    options(MONTHS_LONG.map((_, i) => [`v${pad(i + 1)}`, pad(i + 1)]))}</select>`),
  '/year-yyyy': page(`<label for="y">Expiry year</label><select id="y">${
    options(YEARS.map((y) => [String(y).slice(2), String(y)]))}</select>`),
  '/mm-yy': page('<label for="e">Expiry (MM/YY)</label><input id="e" type="text">'),
  '/split-boxes': page('<label for="em">Expiry month</label><input id="em" type="text"><label for="ey">Expiry year</label><input id="ey" type="text">'),
  '/iframe': page(`<h1>Pay for your order</h1><p>Enter your payment details below to complete the purchase of your order.</p><iframe id="pay" title="Card number" src="${PAY_FRAME}/card"></iframe>`),
  '/card': page('<label for="number">Card number</label><input id="number" type="text">'),
};

let tmpProfile: string;
let savedDisplay: string | undefined;
let context: BrowserContext;
let service: BrowserService;
const siteUrls: string[] = [];

/** The stub resolver: `user.<card>#<field>` projected over the fixed card. */
async function resolveSecretRef(ref: string, opts?: { siteUrl?: string }): Promise<string> {
  const siteUrl = opts?.siteUrl ?? '';
  siteUrls.push(siteUrl);
  // The handler must pass the TOP-LEVEL shop URL, even for a field in the payment iframe.
  if (!siteUrl.startsWith(`${SHOP}/`)) throw new Error(`unexpected siteUrl: ${siteUrl}`);
  const field = ref.split('#')[1];
  if (!field) throw new Error(`no card field in ref: ${ref}`);
  return projectCardField(field, PUBLIC_FIELDS, SECRET_DOC);
}

async function run(input: Record<string, unknown>) {
  const ctx = {
    input,
    log: createSilentLogger(),
    browserService: service,
    resolveSecretRef,
  } as unknown as ToolContext;
  return new WebBrowserHandler().execute(ctx);
}

/** Open a fixture page and return its session id. */
async function open(path: string): Promise<string> {
  const result = await run({ action: 'navigate', url: `${SHOP}${path}` });
  expect(result.success ? '' : result.error).toBe(''); // shows the refusal text on failure
  return (result as { success: true; data: { session_id: string } }).data.session_id;
}

function livePage(path: string): Page {
  const found = context.pages().find((p) => p.url().startsWith(`${SHOP}${path}`));
  if (!found) throw new Error(`no open page for ${path}`);
  return found;
}

/** Assert the result carries none of the filled values (they are redacted from page text). */
function expectNoValue(result: unknown, ...values: string[]): void {
  const json = JSON.stringify(result);
  for (const v of values) expect(json).not.toContain(v);
}

beforeAll(async () => {
  tmpProfile = mkdtempSync(join(tmpdir(), 'curia-card-fill-'));
  // BrowserService.start() spawns Xvfb on Linux without a DISPLAY. This browser is headless,
  // so give it a placeholder display and skip that.
  savedDisplay = process.env.DISPLAY;
  if (process.platform === 'linux') process.env.DISPLAY ??= ':99';
  service = new BrowserService({
    logger: createSilentLogger(),
    sessionTtlMs: 600_000,
    // Same Patchright launch as BrowserService.launchPersistentContext, but headless.
    contextFactory: async () => {
      context = await chromium.launchPersistentContext(tmpProfile, {
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      }) as unknown as BrowserContext;
      return context;
    },
  });
  // No try/catch and no skip: a missing browser must fail this suite.
  await service.start();

  await context.route(`${SHOP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = FIXTURES[path];
    await route.fulfill(body === undefined
      ? { status: 404, contentType: 'text/plain', body: 'not found' }
      : { status: 200, contentType: 'text/html', body });
  });
  await context.route(`${PAY_FRAME}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = FIXTURES[path];
    await route.fulfill(body === undefined
      ? { status: 404, contentType: 'text/plain', body: 'not found' }
      : { status: 200, contentType: 'text/html', body });
  });
}, 60_000);

afterAll(async () => {
  await service?.stop();
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
  if (tmpProfile) rmSync(tmpProfile, { recursive: true, force: true });
});

describe('saved-card fills in a real browser (#1358)', () => {
  it('month select, full-name labels, opaque values', async () => {
    const sessionId = await open('/month-name');
    const result = await run({ session_id: sessionId, action: 'select', selector: '#m', secret_ref: 'user.visa#expiry_month_name' });
    expect(result.success).toBe(true);
    expect(await livePage('/month-name').$eval('#m', (el) => (el as HTMLSelectElement).value)).toBe('m12');
  }, 60_000);

  it('month select, short-name labels', async () => {
    const sessionId = await open('/month-short');
    const result = await run({ session_id: sessionId, action: 'select', selector: '#m', secret_ref: 'user.visa#expiry_month_short' });
    expect(result.success).toBe(true);
    expect(await livePage('/month-short').$eval('#m', (el) => (el as HTMLSelectElement).value)).toBe('s12');
  }, 60_000);

  it('month select, 01-12 labels', async () => {
    const sessionId = await open('/month-mm');
    const result = await run({ session_id: sessionId, action: 'select', selector: '#m', secret_ref: 'user.visa#expiry_mm' });
    expect(result.success).toBe(true);
    expect(await livePage('/month-mm').$eval('#m', (el) => (el as HTMLSelectElement).value)).toBe('v12');
    // Expiry is a public field: it must not be scrubbed from the page text, or a total like
    // "CA$412.30" would read back corrupted. The page text renders the options run together
    // ("...101112"), so there is no word boundary to match on.
    expect((result as { data: { content: string } }).data.content).toContain('101112');
  }, 60_000);

  it('year select, 2027 labels with two-digit values', async () => {
    const sessionId = await open('/year-yyyy');
    const result = await run({ session_id: sessionId, action: 'select', selector: '#y', secret_ref: 'user.visa#expiry_yyyy' });
    expect(result.success).toBe(true);
    expect(await livePage('/year-yyyy').$eval('#y', (el) => (el as HTMLSelectElement).value)).toBe('27');
  }, 60_000);

  it('MM/YY text box', async () => {
    const sessionId = await open('/mm-yy');
    const result = await run({ session_id: sessionId, action: 'type', selector: '#e', secret_ref: 'user.visa#expiry_mm_yy' });
    expect(result.success).toBe(true);
    expect(await livePage('/mm-yy').$eval('#e', (el) => (el as HTMLInputElement).value)).toBe('12/27');
  }, 60_000);

  it('separate MM and YYYY boxes, filled as one batch', async () => {
    const sessionId = await open('/split-boxes');
    const result = await run({
      session_id: sessionId,
      screenshot: true,
      actions: [
        { action: 'type', selector: '#em', secret_ref: 'user.visa#expiry_mm' },
        { action: 'type', selector: '#ey', secret_ref: 'user.visa#expiry_yyyy' },
      ],
    });
    expect(result.success).toBe(true);
    const shop = livePage('/split-boxes');
    expect(await shop.$eval('#em', (el) => (el as HTMLInputElement).value)).toBe('12');
    expect(await shop.$eval('#ey', (el) => (el as HTMLInputElement).value)).toBe('2027');
    // Public fields only: the batch screenshot is not suppressed (that latch is for number/cvv).
  }, 60_000);

  it('dropdowns in one batch, via select steps', async () => {
    const sessionId = await open('/month-name');
    const result = await run({
      session_id: sessionId,
      actions: [{ action: 'select', selector: '#m', secret_ref: 'user.visa#expiry_month_name' }],
    });
    expect(result.success).toBe(true);
    expect(await livePage('/month-name').$eval('#m', (el) => (el as HTMLSelectElement).value)).toBe('m12');
  }, 60_000);

  it('card number inside a cross-origin iframe on the page', async () => {
    const sessionId = await open('/iframe');
    siteUrls.length = 0;
    const result = await run({ session_id: sessionId, action: 'type', selector: '#number', secret_ref: 'user.visa#number' });
    expect(result.success).toBe(true);
    const frame = livePage('/iframe').frames().find((f) => f.url().startsWith(PAY_FRAME));
    expect(frame).toBeDefined();
    expect(await frame!.$eval('#number', (el) => (el as HTMLInputElement).value)).toBe(SECRET_DOC.number);
    // The resolver was asked on behalf of the top-level shop page, not the payment frame.
    expect(siteUrls.length).toBeGreaterThan(0);
    for (const url of siteUrls) expect(url.startsWith(`${SHOP}/iframe`)).toBe(true);
    expectNoValue(result, SECRET_DOC.number);
  }, 60_000);
});
