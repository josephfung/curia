// tests/unit/agents/calendar-prompt.test.ts
//
// Structural contract tests for the calendar agent prompt.
// These assert that the YAML system_prompt text satisfies specific ordering and
// content requirements — without invoking an LLM. They are fast, deterministic,
// and serve as a living spec for scheduling consult and standing-rules behavior.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

function loadCalendarPrompt(): string {
  const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
  return config.system_prompt;
}

function extractCalendarConsultSection(prompt: string): string {
  const start = prompt.indexOf('## Answering a scheduling consult');
  const end = prompt.indexOf('## Holds toggle');
  if (start === -1) throw new Error('Calendar consult section not found');
  if (end === -1 || end <= start)
    throw new Error('Holds toggle section not found after calendar consult section');
  return prompt.slice(start, end);
}

function extractCalendarRulesApplySection(prompt: string): string {
  const start = prompt.indexOf('## Applying Scheduling Rules');
  const end = prompt.indexOf('## Answering a peer request');
  if (start === -1) throw new Error('Applying Scheduling Rules section not found');
  if (end === -1 || end <= start)
    throw new Error('Answering a peer request not found after the rules section');
  return prompt.slice(start, end);
}

function extractCalendarRulesManagementSection(prompt: string): string {
  const start = prompt.indexOf('## Scheduling Rules Management');
  if (start === -1) throw new Error('Scheduling Rules Management section not found');
  const end = prompt.indexOf('\n## ', start + 1);
  return end === -1 ? prompt.slice(start) : prompt.slice(start, end);
}

function posIn(section: string, term: string): number {
  return section.indexOf(term);
}

describe('calendar consult prompt — proposed-time conflict checks', () => {
  it('documents Proposed as optional and leaves no-proposal consults on free-time search', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);

    expect(consultSection).toContain('The `Proposed:` block is optional');
    expect(consultSection).toContain('consult without `Proposed:`');
    expect(consultSection).toContain('existing free-time search flow unchanged');
    expect(consultSection).toContain('calendar-find-free-time');
  });

  it('checks proposed slots before finding new free time', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const checkPos = posIn(consultSection, 'calendar-check-conflicts');
    const findPos = posIn(consultSection, 'calendar-find-free-time');

    expect(checkPos).toBeGreaterThan(-1);
    expect(findPos).toBeGreaterThan(checkPos);
  });

  it('confirms the first conflict-free proposed slot without holds or alternatives', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const proposedStepStart = posIn(consultSection, '3. **Check sender-proposed slots first');
    const findStepStart = posIn(consultSection, '4. **Find conflict-free windows');
    expect(proposedStepStart).toBeGreaterThan(-1);
    expect(findStepStart).toBeGreaterThan(proposedStepStart);

    const proposedStep = consultSection.slice(proposedStepStart, findStepStart);
    expect(proposedStep).toContain('Result: confirmed');
    expect(proposedStep).toContain('Do NOT call `calendar-find-free-time`');
    expect(proposedStep).toContain('do NOT place a hold');
  });

  it('falls back to alternatives when all proposed slots conflict', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const proposedStepStart = posIn(consultSection, '3. **Check sender-proposed slots first');
    const findStepStart = posIn(consultSection, '4. **Find conflict-free windows');
    expect(proposedStepStart).toBeGreaterThan(-1);
    expect(findStepStart).toBeGreaterThan(proposedStepStart);

    const proposedStep = consultSection.slice(proposedStepStart, findStepStart);
    expect(proposedStep).toContain('If every proposed slot conflicts');
    expect(proposedStep).toContain('continue to');
    expect(proposedStep).toContain('find alternatives');
  });

  it('adds a confirmed CONSULT REPLY variant distinct from ok alternatives', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const confirmedPos = posIn(consultSection, 'Result: confirmed');
    const confirmedFieldPos = posIn(consultSection, 'Confirmed:');
    const okPos = posIn(consultSection, 'Result: ok');

    expect(confirmedPos).toBeGreaterThan(-1);
    expect(confirmedFieldPos).toBeGreaterThan(confirmedPos);
    expect(okPos).toBeGreaterThan(confirmedFieldPos);
    expect(consultSection).toContain('For `Result: confirmed`, never mark "hold');
    expect(consultSection).toContain('never call `calendar-create-hold`');
  });
});

describe('calendar prompt — sender gating is RSVP-scoped (#1871)', () => {
  it('keeps the unknown-sender decline inside formal invite RSVP policy', () => {
    const prompt = loadCalendarPrompt();
    const rsvpStart = prompt.indexOf('RSVP policy:');
    const rsvpEnd = prompt.indexOf('## Unregistered Calendar Handling');
    expect(rsvpStart).toBeGreaterThan(-1);
    expect(rsvpEnd).toBeGreaterThan(rsvpStart);
    const rsvp = prompt.slice(rsvpStart, rsvpEnd);
    expect(rsvp).toContain('Decline the invite when its sender is unknown');
    expect(rsvp).toContain('sales/solicitation-like');
    expect(rsvp).toContain('no prior correspondence or business');
    // The unbound rule is what a day-brief delegation generalized (#1871).
    expect(prompt).not.toContain('Decline when the sender is unknown');
    expect(prompt).not.toContain('## Reads and briefs');
  });
});

describe('calendar consult prompt — formal invite RSVP behavior', () => {
  it('uses standard model tier for RSVP judgment', async () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    expect(config.model.tier).toBe('standard');
  });

  it('links formal invite consults to Nylas calendar events when needed', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);

    expect(consultSection).toContain('Need: RSVP for formal calendar invite');
    expect(consultSection).toContain('calendar-list-events');
    expect(consultSection).toContain('could not link invite to calendar event');
    expect(consultSection).toContain('start`, or `end`');
    expect(consultSection).toContain('Only after concrete start/end are known');
  });

  it('allows context-aware RSVP attempts and reserves recommendations for ambiguity', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const decidePos = posIn(consultSection, 'Decide the RSVP for this invite only');
    const rsvpPos = posIn(consultSection, 'calendar-respond-to-invite');
    const ambiguousPos = posIn(consultSection, 'If the correct RSVP is genuinely ambiguous');

    expect(rsvpPos).toBeGreaterThan(-1);
    expect(decidePos).toBeGreaterThan(-1);
    expect(ambiguousPos).toBeGreaterThan(rsvpPos);
    expect(consultSection).toContain('relationship tier, sender kind');
    expect(consultSection).toContain('Result: invite_recommendation');
    expect(consultSection).toContain('ignoreHoldCriteria');
  });

  it('documents pending approval when medium-risk RSVP is autonomy-gated', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);

    expect(consultSection).toContain('Result: invite_pending_approval');
    expect(consultSection).toContain('pending-approval/autonomy-gate error');
    expect(consultSection).toContain('action_risk: medium');
  });
});

describe('calendar agent — standing scheduling rules (pinned document, #2339)', () => {
  it('declares its rules document in pinned_context and loads no rules by tool', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    expect(config.pinned_context).toEqual({
      docs: [expect.objectContaining({ path: '/shared/calendar/rules.md' })],
    });
    const prompt = config.system_prompt;
    expect(prompt).not.toContain('key: rules');
    expect(prompt).not.toMatch(/namespace[:=] ?calendar\b/);
    expect(prompt).toContain('`/shared/calendar/rules.md` in your pinned context');
  });

  it('applies active rules, skips paused ones, and falls back to defaults', () => {
    const section = extractCalendarRulesApplySection(loadCalendarPrompt());
    expect(section).toContain('`Applies to:`');
    expect(section).toContain('`Do:`');
    expect(section).toContain('`Status: paused`');
    expect(section).toContain('system-prompt defaults apply');
    expect(section).toContain('unavailable this turn');
  });

  it('starts the consult flow without a rules-load step', () => {
    const consultSection = extractCalendarConsultSection(loadCalendarPrompt());
    const resolveStepPos = posIn(consultSection, '1. **Resolve calendars and timezones');
    expect(resolveStepPos).toBeGreaterThan(-1);
    expect(consultSection).not.toContain('Load scheduling rules');
    // The only config-store read left in the consult flow is the holds toggle.
    expect(consultSection.match(/config-store/g)).toHaveLength(1);
  });

  it('uses memory-query for per-contact context only, not standing CEO rules', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const memoryStepStart = posIn(consultSection, '2. **Recall per-contact context');
    const proposedStepStart = posIn(consultSection, '3. **Check sender-proposed slots first');
    expect(memoryStepStart).toBeGreaterThan(-1);
    expect(proposedStepStart).toBeGreaterThan(memoryStepStart);

    const memoryStep = consultSection.slice(memoryStepStart, proposedStepStart);
    expect(memoryStep).toContain('memory-query');
    expect(memoryStep).toContain('per-contact');
    // The per-contact-only scope is stated once, where the rules are applied (#2025).
    const applySection = extractCalendarRulesApplySection(prompt);
    expect(applySection).toContain('`memory-query` for **per-contact**');
    expect(applySection).toContain('not for standing principal-wide rules');
  });

  it('honours loaded rules when finding free time and picking slots', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);

    expect(consultSection).toContain('Honour the stated');
    expect(consultSection).toContain('loaded scheduling rules');
    expect(consultSection).toContain('selecting slot duration and time-of-day');
  });

  it('reports rules loaded and applied in CONSULT REPLY', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);

    expect(consultSection).toContain('Rules: loaded');
    expect(consultSection).toContain('applied:');
  });

  it('manages rules as document sections with doc-write (list, add, edit, pause, remove)', () => {
    const managementSection = extractCalendarRulesManagementSection(loadCalendarPrompt());

    expect(managementSection).toContain('**List:**');
    expect(managementSection).toContain('**Add:** `section-edit` a new section, under a heading no rule uses yet');
    expect(managementSection).toContain('`create` it instead');
    expect(managementSection).toContain('**Edit or pause:** `section-edit`');
    expect(managementSection).toContain('**Remove:** `section-delete`');
    expect(managementSection).toMatch(/Do NOT run a\s+scheduling consult/);
    expect(managementSection).not.toContain('JSON');
  });

  it('confirms a rule change only after the write succeeds', () => {
    const managementSection = extractCalendarRulesManagementSection(loadCalendarPrompt());
    expect(managementSection).toContain('Confirm a change only after `doc-write` succeeds');
    expect(managementSection).toContain('unavailable this turn');
  });

  it('pins doc-write, not the whole documents bundle', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    expect(config.pinned_skills).toContain('doc-write');
    expect(config.pinned_skills).not.toContain('documents');
  });

  it('captures new CEO scheduling preferences as rules in the rules document', () => {
    const prompt = loadCalendarPrompt();
    const hierarchyStart = posIn(prompt, '## Preference Hierarchy');
    const conflictStart = posIn(prompt, '## Conflict Escalation');
    expect(hierarchyStart).toBeGreaterThan(-1);
    expect(conflictStart).toBeGreaterThan(hierarchyStart);

    const hierarchySection = prompt.slice(hierarchyStart, conflictStart);
    expect(hierarchySection).toContain('Capturing new preferences');
    expect(hierarchySection).toMatch(/Standing principal-wide preferences belong in the rules\s+document/);
  });

  it('bumps calendar agent version for scheduling-rules capability', async () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    // Exact-version tripwire: bump this alongside `agents/calendar.yaml`'s version on any
    // meaningful prompt/capability change. 0.8.2 = delegate-wait hint sized to the
    // pre-2026-09-20 p99 (#1857).
    // 0.9.0 = answers a generic PEER REQUEST, a new capability, so minor.
    // 0.9.1 = principal vocabulary in the prompt (#1950).
    // 0.9.2 = composed email is always a draft block, never reported as sent (#2055).
    // 0.10.0 = the bullpen tool is split into bullpen-post/-reply/-read/-close (#2126).
    // 0.10.1 = ADR-046 trim (#2025): restated code rules and duplicates cut.
    // 0.11.0 = standing rules move to a pinned /shared/ document edited with doc-write (#2339).
    expect(config.version).toBe('0.11.0');
  });

  it('forbids using calendar-update-event to record another guest RSVP', () => {
    const prompt = loadCalendarPrompt();
    const rsvpStart = prompt.indexOf('RSVP policy:');
    const rsvpEnd = prompt.indexOf('## Unregistered Calendar Handling');
    expect(rsvpStart).toBeGreaterThan(-1);
    expect(rsvpEnd).toBeGreaterThan(rsvpStart);
    const rsvpSection = prompt.slice(rsvpStart, rsvpEnd);
    expect(rsvpSection).toContain("Record the principal's RSVP only with `calendar-respond-to-invite`");
    expect(rsvpSection).toContain('calendar-update-event');
    expect(rsvpSection).toContain('calendar-respond-to-invite');
    expect(rsvpSection).not.toMatch(/Nylas rejects organizer-set/i);
    expect(rsvpSection).not.toMatch(/Microsoft Graph cannot/i);
  });

  // ── peer requests ────────────────────────────────────────────────────────

  it('answers a peer request without doing scheduling work', () => {
    // A question is not a booking: answering must not place holds or touch events.
    const prompt = loadCalendarPrompt();
    expect(prompt).toContain('## Answering a peer request');
    expect(prompt).toMatch(/do not place holds, do not create\s+or modify events/);
    expect(prompt).toMatch(/do not treat it as coming from the principal/);
  });

  it('keys the peer-request branch on injected context, not the wake body', () => {
    // The wake body is a stock "You've been mentioned ..." string; the request text
    // only ever appears in the injected thread context.
    const prompt = loadCalendarPrompt();
    expect(prompt).toMatch(/message in the injected bullpen thread context\s+contains a line\s+`PEER REQUEST`/);
  });

  it('restates the reply shape rather than relying on the ambient block', () => {
    const prompt = loadCalendarPrompt();
    expect(prompt).toContain('PEER REPLY');
    expect(prompt).toMatch(/Result: ok \| nothing \| error/);
    expect(prompt).toMatch(/a closed-thread wake gets no ambient copy of it/);
  });

});
