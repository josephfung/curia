// handler.ts — record-outreach skill.
//
// Records outreach Curia made outside a send skill — a web form, a phone call — so a
// reply from that organization can be linked back to the task (#2312). Send skills
// record their own outreach; this is for everything else.
//
// Writes only on a task-bound turn (a bound or linked task, or the principal live):
// an outsider must not be able to plant outreach that later pulls replies into a task.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { OutreachVia } from '../../../../src/dispatch/task-outreach.js';
import { registrableDomain } from '../../../../src/verification/domain.js';

const VIA: ReadonlySet<string> = new Set(['web_form', 'phone', 'other']);
const MAX_SUMMARY = 500;
const MAX_FIELD = 300;

export const NOT_TASK_BOUND_ERROR = 'Outreach can only be recorded for work the principal or a task directed.';

type Field<T> = { value: T } | { error: string };

function optionalText(input: Record<string, unknown>, field: string): Field<string | undefined> {
  const raw = input[field];
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') return { error: `${field} must be a string` };
  const value = raw.trim();
  if (value.length > MAX_FIELD) return { error: `${field} must be ${MAX_FIELD} characters or fewer` };
  return { value: value === '' ? undefined : value };
}

/** Registrable domain of a URL or host input; an error when it has none. */
function domainOf(input: Record<string, unknown>, field: string): Field<string | undefined> {
  const text = optionalText(input, field);
  if ('error' in text || text.value === undefined) return text;
  const domain = registrableDomain(text.value);
  if (!domain) return { error: `${field} must be a web address or domain, such as acme.example` };
  return { value: domain };
}

export class RecordOutreachHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input;

    const via = input['via'];
    if (typeof via !== 'string' || !VIA.has(via)) {
      return { success: false, error: "via must be one of 'web_form', 'phone' or 'other'" };
    }
    const summaryRaw = input['summary'];
    if (typeof summaryRaw !== 'string' || summaryRaw.trim() === '') {
      return { success: false, error: 'Missing required input: summary (what the outreach asked for)' };
    }
    const summary = summaryRaw.trim();
    if (summary.length > MAX_SUMMARY) {
      return { success: false, error: `summary must be ${MAX_SUMMARY} characters or fewer` };
    }

    const orgName = optionalText(input, 'org_name');
    if ('error' in orgName) return { success: false, error: orgName.error };
    const contactGiven = optionalText(input, 'contact_given');
    if ('error' in contactGiven) return { success: false, error: contactGiven.error };
    const website = domainOf(input, 'website');
    if ('error' in website) return { success: false, error: website.error };
    const formHost = domainOf(input, 'form_url');
    if ('error' in formHost) return { success: false, error: formHost.error };

    if (!ctx.taskOutreach) {
      return { success: false, error: 'record-outreach: taskOutreach not available — check ExecutionLayer configuration.' };
    }

    // A form host (typeform.com) is kept with the website's domain: the model check can use
    // it, and the linker never treats it as the organization's own domain.
    const domains = [...new Set([website.value, formHost.value].filter((d): d is string => d !== undefined))];

    try {
      const row = await ctx.taskOutreach.recordForTurn(ctx, {
        via: via as OutreachVia,
        orgName: orgName.value ?? null,
        domains,
        givenContact: contactGiven.value ?? null,
        summary,
      });
      if (!row) return { success: false, error: NOT_TASK_BOUND_ERROR };
      // Labels only: the domains and contact details stay out of the log.
      ctx.log.info({ outreachId: row.id, taskId: row.taskId, via: row.via, domainCount: domains.length }, 'record-outreach: recorded');
      return { success: true, data: { recorded: true, outreach_id: row.id } };
    } catch (err) {
      ctx.log.error({ err, via }, 'record-outreach: write failed');
      return { success: false, error: 'Could not record the outreach. Try again shortly.' };
    }
  }
}
