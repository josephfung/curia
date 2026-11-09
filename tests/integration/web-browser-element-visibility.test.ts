// Which elements web-browser offers the agent, measured with real layout (#2546).
//
// Drives WebBrowserHandler against a real Chromium (launched through Patchright, headless, the
// way BrowserService launches it) on a fixture page served by context.route(), so no network is
// touched. happy-dom has no layout, so only a real browser can show that "hidden" means "not
// rendered" and has nothing to do with the viewport: an element far below the fold must stay
// listed and clickable while a closed drawer's button is left out.
//
// This test needs a browser and does NOT skip without one: CI installs Chromium for Patchright
// before `pnpm test` (.github/workflows/ci.yml), and locally run
// `pnpm exec patchright install chromium`. A missing browser fails beforeAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { BrowserContext } from 'playwright';
import { BrowserService } from '../../src/browser/browser-service.js';
import { createSilentLogger } from '../../src/logger.js';
import type { ToolContext } from '../../src/skills/types.js';
import { WebBrowserHandler } from '../../skills/web/tools/web-browser/handler.js';

const SHOP = 'https://shop.example.test';

const FIXTURE = `<!doctype html><html><head><title>Shop</title></head><body>
  <button id="open" onclick="document.getElementById('drawer').style.visibility='visible'">Open drawer</button>
  <aside id="drawer" style="visibility:hidden"><button>Drawer checkout</button></aside>
  <button style="display:none">Display none button</button>
  <button style="width:0;height:0;padding:0;border:0" aria-label="Zero size button"></button>
  <button style="opacity:0" onclick="document.title='opacity clicked'">Transparent button</button>
  <label>Agree <input type="radio" name="a" aria-label="Styled radio" style="display:none"></label>
  <div style="height:6000px">Long content</div>
  <button onclick="document.title='far clicked'">Far below the fold</button>
</body></html>`;

let tmpProfile: string;
let savedDisplay: string | undefined;
let context: BrowserContext;
let service: BrowserService;

interface BrowserData { content: string; session_id: string; url: string; action_error?: string }

async function run(input: Record<string, unknown>): Promise<BrowserData> {
  const ctx = { input, log: createSilentLogger(), browserService: service } as unknown as ToolContext;
  const result = await new WebBrowserHandler().execute(ctx);
  expect(result.success ? '' : result.error).toBe(''); // shows the refusal text on failure
  return (result as { success: true; data: BrowserData }).data;
}

/** The ref of the listed button with this name; fails if it isn't listed. */
function refOf(content: string, name: string): string {
  const line = content.split('\n').find((l) => l.endsWith(`button "${name}"`));
  if (!line) throw new Error(`"${name}" is not listed`);
  return line.slice(1, line.indexOf(']'));
}

beforeAll(async () => {
  tmpProfile = mkdtempSync(join(tmpdir(), 'curia-element-visibility-'));
  // BrowserService.start() spawns Xvfb on Linux without a DISPLAY. This browser is headless,
  // so give it a placeholder display and skip that.
  savedDisplay = process.env.DISPLAY;
  if (process.platform === 'linux') process.env.DISPLAY ??= ':99';
  service = new BrowserService({
    logger: createSilentLogger(),
    sessionTtlMs: 600_000,
    // Headless and unsandboxed: CI's Ubuntu 24.04 runners block the user namespaces bundled
    // Chromium's sandbox needs (#2521), and this browser only ever loads the routed fixture.
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
    await route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
  });
}, 60_000);

afterAll(async () => {
  await service?.stop();
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
  rmSync(tmpProfile, { recursive: true, force: true });
});

describe('web-browser element list on a real page', { timeout: 60_000 }, () => {
  it('leaves out elements that are not rendered', async () => {
    const { content } = await run({ action: 'navigate', url: `${SHOP}/page` });
    // Only the element list is filtered; the page's body text may still mention hidden words.
    const list = content.split('--- Interactable elements ---')[1] ?? '';
    expect(list).toContain('Open drawer');
    expect(list).not.toContain('Drawer checkout');
    expect(list).not.toContain('Display none button');
    expect(list).not.toContain('Zero size button');
  });

  it('keeps an element far below the fold, and can click it', async () => {
    const opened = await run({ action: 'navigate', url: `${SHOP}/page` });
    const ref = refOf(opened.content, 'Far below the fold');
    const clicked = await run({ action: 'click', selector: `[${ref}]`, session_id: opened.session_id });
    expect(clicked.action_error).toBeUndefined();
    await expect(service.getSession(opened.session_id)?.page.title()).resolves.toBe('far clicked');
  });

  it('keeps opacity:0 elements, untagged', async () => {
    const { content } = await run({ action: 'navigate', url: `${SHOP}/page` });
    expect(content).toContain('button "Transparent button"');
    expect(content).not.toContain('Transparent button" (hidden)');
  });

  it('keeps a hidden native radio, tagged (hidden)', async () => {
    const { content } = await run({ action: 'navigate', url: `${SHOP}/page` });
    expect(content).toContain('radio "Styled radio" (hidden)');
  });

  it('lists a drawer button once the drawer opens', async () => {
    const opened = await run({ action: 'navigate', url: `${SHOP}/page` });
    const after = await run({ action: 'click', selector: `[${refOf(opened.content, 'Open drawer')}]`, session_id: opened.session_id });
    expect(after.content).toContain('button "Drawer checkout"');
  });
});
