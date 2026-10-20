// handler.ts — verification tool (#2017).
//
// Coordinator-only. Opens, closes and lists external verifications (a site's
// sign-in code). The model supplies the site and the browser session; the page
// domain is read from the session's live URL here, never taken from the model, so
// the "code goes only to the challenge's page" guard can't be steered.
//
// This tool never receives or returns a code value. It goes through the runtime
// passthroughs (open/close/listActive), which keep the code tracker's TTL in step
// with the table; close() already starts the tracker clock, so it is not repeated.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { Verification, VerificationDelivery } from '../../src/verification/types.js';
import { registrableDomain } from '../../src/verification/domain.js';
import { codeEntryPageUrl } from '../web/tools/web-browser/verification-detect.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { isUuid } from '../../src/util/uuid.js';

const DELIVERIES: readonly VerificationDelivery[] = ['email', 'sms', 'app'];
const ACTIONS = ['open', 'satisfy', 'abandon', 'list'] as const;

function isDelivery(value: unknown): value is VerificationDelivery {
  return typeof value === 'string' && (DELIVERIES as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toIso(date: Date, timezone: string | undefined): string {
  return toLocalIso(Math.floor(date.getTime() / 1000), timezone) ?? date.toISOString();
}

function present(v: Verification, timezone: string | undefined): Record<string, unknown> {
  return {
    verification_id: v.id,
    site: v.site,
    page_domain: v.pageDomain,
    delivery: v.delivery,
    status: v.status,
    browser_session_id: v.browserSessionId,
    task_id: v.taskId,
    requested_at: toIso(v.requestedAt, timezone),
    expires_at: toIso(v.expiresAt, timezone),
  };
}

export class VerificationToolHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const runtime = ctx.verification;
    if (!runtime) {
      return { success: false, error: 'Verification is not available in this runtime' };
    }

    const input = ctx.input as Record<string, unknown>;
    const action = input.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      return { success: false, error: `Invalid action: must be one of ${ACTIONS.join('|')}` };
    }

    const timezone = ctx.timezone;
    const displayTimezone = timezone ? formatDisplayTimezone(timezone, new Date()) : 'UTC';

    if (action === 'list') {
      const rows = await runtime.listActive();
      return {
        success: true,
        data: { verifications: rows.map((v) => present(v, timezone)), displayTimezone },
      };
    }

    if (action === 'satisfy' || action === 'abandon') {
      const id = nonEmptyString(input.verification_id);
      if (!id) {
        return { success: false, error: 'Missing required input: verification_id (string)' };
      }
      const closed = await runtime.close(id, action === 'satisfy' ? 'satisfied' : 'abandoned');
      if (!closed) {
        return { success: false, error: `Verification not found: ${id}` };
      }
      ctx.log.info({ verificationId: id, status: closed.status }, 'verification: closed');
      return { success: true, data: { ...present(closed, timezone), displayTimezone } };
    }

    // action === 'open'
    const delivery = input.delivery;
    if (!isDelivery(delivery)) {
      return { success: false, error: 'Invalid delivery: must be one of email|sms|app' };
    }
    const site = nonEmptyString(input.site);
    if (!site) {
      return { success: false, error: 'Missing required input: site (string), e.g. aircanada.com' };
    }
    if (registrableDomain(site) === null) {
      return { success: false, error: 'site must be a website or domain, e.g. aircanada.com' };
    }
    const sessionId = nonEmptyString(input.browser_session_id);
    if (!sessionId) {
      return { success: false, error: 'Missing required input: browser_session_id (string)' };
    }

    let taskId: string | undefined;
    if (input.task_id !== undefined && input.task_id !== null && input.task_id !== '') {
      if (typeof input.task_id !== 'string' || !isUuid(input.task_id)) {
        return { success: false, error: 'task_id must be a UUID' };
      }
      taskId = input.task_id;
    }

    let expiresAt: Date | undefined;
    if (input.expires_in_minutes !== undefined && input.expires_in_minutes !== null) {
      const minutes = input.expires_in_minutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
        return { success: false, error: 'expires_in_minutes must be a positive number' };
      }
      expiresAt = new Date(Date.now() + minutes * 60_000);
    }

    if (!ctx.browserService) {
      return { success: false, error: 'Browser service is not available in this runtime' };
    }
    const session = ctx.browserService.getSession(sessionId);
    if (!session) {
      return {
        success: false,
        error:
          `Browser session ${sessionId} is gone (it expired or was closed), so the sign-in page is no longer open. ` +
          'Re-navigate to the site in a fresh session before opening a verification.',
      };
    }

    // The document the code goes into: the top page, or an identity-provider frame inside
    // it when that is where the code input is. web-browser judges a typed code by the
    // field's own frame, so page_domain must name that frame's domain.
    const pageUrl = await codeEntryPageUrl(session.page, ctx.log);
    if (registrableDomain(pageUrl) === null) {
      return {
        success: false,
        error: 'The browser session is not on a website page (no domain to tie the verification to). Navigate to the sign-in page first.',
      };
    }

    let result: { verification: Verification; reused: boolean };
    try {
      result = await runtime.open({
        purpose: 'sign_in',
        kind: 'code',
        delivery,
        site,
        pageDomain: pageUrl,
        browserSessionId: sessionId,
        ...(taskId ? { taskId } : {}),
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
    } catch (err) {
      ctx.log.error({ err, sessionId }, 'verification: open failed');
      return { success: false, error: 'Could not open the verification (see logs). Try again or ask the principal directly.' };
    }

    // Pin the session warm (same mechanism as web-browser keep_warm:true) so the
    // logged-in page survives until the code arrives, possibly on a later wake.
    session.keepWarm = true;

    const { verification, reused } = result;
    ctx.log.info(
      { verificationId: verification.id, site: verification.site, delivery, reused },
      'verification: opened',
    );
    return {
      success: true,
      data: {
        ...present(verification, timezone),
        reused,
        ask_channel: runtime.askChannel(),
        email_wait_seconds: runtime.service.config.emailWaitSeconds,
        displayTimezone,
      },
    };
  }
}
