// skills/web-browser/handler.ts — web-browser skill implementation.
//
// Dispatches browser actions to BrowserService, which holds the warm Playwright
// browser. Each action performs one browser operation and returns the current
// page state (cleaned DOM text + optional screenshot).
//
// The LLM drives navigation logic via its tool-use loop. This handler is the
// hands — it executes what the LLM decides, not the reverse.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { BrowserAction } from '../../src/browser/types.js';
import type { Page, Locator } from 'playwright';

// Maximum cleaned DOM content length before truncation.
// Prevents token blowout on content-heavy pages.
const MAX_CONTENT_LENGTH = 15_000;

export class WebBrowserHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.browserService) {
      return { success: false, error: 'browserService is not available — BrowserService failed to start or is not wired into ExecutionLayer' };
    }

    const { action, url, selector, text, value, session_id, screenshot } = ctx.input as {
      action?: string;
      url?: string;
      selector?: string;
      text?: string;
      value?: string;
      session_id?: string;
      screenshot?: boolean;
    };

    if (!action || typeof action !== 'string') {
      return { success: false, error: 'Missing required input: action (string)' };
    }

    const validActions: BrowserAction[] = ['navigate', 'click', 'type', 'select', 'get_content', 'screenshot', 'close_session'];
    if (!validActions.includes(action as BrowserAction)) {
      return { success: false, error: `Unknown action: "${action}". Valid actions: ${validActions.join(', ')}` };
    }

    // --- close_session: no page interaction needed ---
    if (action === 'close_session') {
      if (!session_id || typeof session_id !== 'string') {
        return { success: false, error: 'close_session requires session_id' };
      }
      // screenshot: true is intentionally ignored for close_session — the browser
      // context is being destroyed, so capturing a screenshot would be meaningless
      // and could race with the context teardown. The spec's "any action" clause
      // applies to actions that maintain session state; close_session is terminal.
      await ctx.browserService.closeSession(session_id);
      ctx.log.info({ session_id }, 'Browser session closed');
      return { success: true, data: { content: '', session_id, url: '' } };
    }

    // --- All other actions: acquire session ---
    let sessionId: string;
    let page: Page;
    try {
      const result = await ctx.browserService.getOrCreateSession(session_id ?? undefined);
      sessionId = result.sessionId;
      page = result.session.page as Page;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, session_id }, 'Failed to acquire browser session');
      return { success: false, error: `Failed to acquire browser session: ${message}` };
    }

    ctx.log.info({ action, sessionId, url, selector }, 'Executing browser action');

    try {
      // --- Dispatch action ---
      switch (action as BrowserAction) {
        case 'navigate': {
          if (!url || typeof url !== 'string') {
            return { success: false, error: 'navigate requires url (string)' };
          }
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          break;
        }

        case 'click': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'click requires selector (string — describe the element in natural language)' };
          }
          const clickTarget = await resolveLocator(page, selector);
          await clickTarget.click();
          // Brief wait for any triggered navigation or DOM update to settle
          await page.waitForTimeout(500);
          break;
        }

        case 'type': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'type requires selector (string)' };
          }
          if (text === undefined || text === null || typeof text !== 'string') {
            return { success: false, error: 'type requires text (string)' };
          }
          const typeTarget = await resolveLocator(page, selector);
          await typeTarget.fill(text);
          break;
        }

        case 'select': {
          if (!selector || typeof selector !== 'string') {
            return { success: false, error: 'select requires selector (string)' };
          }
          if (!value || typeof value !== 'string') {
            return { success: false, error: 'select requires value (string)' };
          }
          // Playwright's selectOption works on <select> elements
          await page.locator(selector).selectOption(value);
          break;
        }

        case 'get_content':
          // No navigation — just re-read current state below
          break;

        case 'screenshot':
          // Screenshot-only action — falls through to screenshot capture below
          break;
      }

      // --- Gather result ---
      const currentUrl = page.url();
      const content = action === 'screenshot'
        ? ''   // screenshot action doesn't need DOM text
        : await getCleanedContent(page);

      const result: Record<string, unknown> = { content, session_id: sessionId, url: currentUrl };

      // Capture screenshot if explicitly requested or if action === 'screenshot'
      if (screenshot || action === 'screenshot') {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        result.screenshot_base64 = buf.toString('base64');
      }

      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, action, sessionId }, 'Browser action failed');
      return { success: false, error: `Browser action "${action}" failed: ${message}` };
    }
  }
}

/**
 * Resolve a natural language selector to a Playwright locator.
 * Priority order:
 *   1. getByRole (most semantic — "submit button", "Email field")
 *   2. getByLabel (form inputs described by their label)
 *   3. getByText (any visible text match)
 *   4. locator() fallback (CSS/XPath for when natural language fails)
 */
async function resolveLocator(page: Page, selector: string): Promise<Locator> {
  // Try getByRole first — covers the full range of interactive elements by accessible name.
  // Ordered roughly by likelihood to avoid unnecessary DOM queries.
  const rolesToTry: Parameters<Page['getByRole']>[0][] = [
    'button', 'link', 'textbox', 'checkbox', 'radio',
    'combobox', 'menuitem', 'tab', 'option',
  ];
  for (const role of rolesToTry) {
    const loc = page.getByRole(role, { name: selector, exact: false });
    if (await loc.count() > 0) return loc;
  }

  // Try getByLabel for form inputs described by their label text
  const labelLocator = page.getByLabel(selector, { exact: false });
  if (await labelLocator.count() > 0) return labelLocator;

  // Try getByText for any visible element containing the text
  const textLocator = page.getByText(selector, { exact: false });
  if (await textLocator.count() > 0) return textLocator;

  // CSS/XPath fallback — the LLM can pass a CSS selector directly if natural language fails
  return page.locator(selector);
}

/**
 * Extract cleaned, LLM-friendly text content from the current page.
 * Runs inside the browser via page.evaluate() so we get the rendered DOM,
 * not raw HTML, and can use DOM APIs to strip noise and extract form fields.
 */
async function getCleanedContent(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    // Clone the body before stripping noise elements — mutating the live DOM would
    // destroy scripts/styles/etc. for subsequent actions in the same session.
    const root = document.body?.cloneNode(true) as HTMLBodyElement | null;
    if (!root) return '';

    // Remove noise elements from the clone — we want content, not chrome
    const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
    for (const sel of noiseSelectors) {
      root.querySelectorAll(sel).forEach(el => el.remove());
    }

    // Extract form fields with their labels — the LLM needs to know what
    // fields exist and what they're called to fill them correctly.
    // Query the live DOM for form fields so we can look up labels by ID.
    const formFields: string[] = [];
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden') return;
      const id = input.id;
      const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const label = labelEl?.textContent?.trim()
        ?? input.getAttribute('placeholder')
        ?? input.getAttribute('name')
        ?? input.type;
      formFields.push(`[${input.type ?? 'field'}: ${label}]`);
    });

    const bodyText = (root.innerText ?? root.textContent ?? '').trim();
    const formSummary = formFields.length > 0
      ? '\n\n--- Form fields ---\n' + formFields.join('\n')
      : '';

    return bodyText + formSummary;
  });

  // Collapse excess whitespace and truncate
  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > MAX_CONTENT_LENGTH) {
    return cleaned.slice(0, MAX_CONTENT_LENGTH) + '\n[content truncated]';
  }
  return cleaned;
}
