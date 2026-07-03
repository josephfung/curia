// tests/unit/agents/calendar-prompt.test.ts
//
// Structural contract tests for the calendar agent prompt.
// These assert that the YAML system_prompt text satisfies specific ordering and
// content requirements — without invoking an LLM. They are fast, deterministic,
// and serve as a living spec for scheduling consult and rules-loading behavior.

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

function extractCalendarRulesLoadSection(prompt: string): string {
  const start = prompt.indexOf('## Task Start — Load Scheduling Rules');
  const end = prompt.indexOf('## Answering a scheduling consult');
  if (start === -1) throw new Error('Task Start — Load Scheduling Rules section not found');
  if (end === -1 || end <= start)
    throw new Error('Answering a scheduling consult not found after rules load section');
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
    const decidePos = posIn(consultSection, 'Decide the RSVP response from all available context');
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

describe('calendar agent — key-loaded scheduling rules (ceo-inbox parity)', () => {
  it('loads scheduling rules from config-store calendar/rules by key at task start', () => {
    const prompt = loadCalendarPrompt();
    const loadSection = extractCalendarRulesLoadSection(prompt);

    expect(loadSection).toContain('config-store');
    expect(loadSection).toContain('namespace: calendar');
    expect(loadSection).toContain('key: rules');
    expect(loadSection).toContain('empty array');
    expect(loadSection).toContain('system-prompt defaults apply unchanged');
  });

  it('documents lightly structured rule shape (applies_to, instruction, active)', () => {
    const prompt = loadCalendarPrompt();
    const loadSection = extractCalendarRulesLoadSection(prompt);

    expect(loadSection).toContain('applies_to');
    expect(loadSection).toContain('instruction');
    expect(loadSection).toContain('active');
  });

  it('loads rules before proposing times in the consult flow', () => {
    const prompt = loadCalendarPrompt();
    const consultSection = extractCalendarConsultSection(prompt);
    const loadStepPos = posIn(consultSection, '0. **Load scheduling rules');
    const resolveStepPos = posIn(consultSection, '1. **Resolve calendars and timezones');
    const memoryStepPos = posIn(consultSection, '2. **Recall per-contact context');

    expect(loadStepPos).toBeGreaterThan(-1);
    expect(resolveStepPos).toBeGreaterThan(loadStepPos);
    expect(memoryStepPos).toBeGreaterThan(resolveStepPos);
    expect(consultSection.slice(loadStepPos, resolveStepPos)).toContain('config-store');
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
    expect(memoryStep).toContain('Do not use `memory-query` for standing CEO-wide rules');
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

  it('documents rules-management delegation flow (add, edit, list, pause, remove)', () => {
    const prompt = loadCalendarPrompt();
    const managementSection = extractCalendarRulesManagementSection(prompt);

    expect(managementSection).toContain('**Add a rule:**');
    expect(managementSection).toContain('**Edit a rule:**');
    expect(managementSection).toContain('**List rules:**');
    expect(managementSection).toContain('**Pause a rule:**');
    expect(managementSection).toContain('**Remove a rule:**');
    expect(managementSection).toContain('namespace=calendar, key=rules');
    expect(managementSection).toContain('run a scheduling consult');
  });

  it('fails closed on rules-management retrieve, parse, and store errors', () => {
    const prompt = loadCalendarPrompt();
    const managementSection = extractCalendarRulesManagementSection(prompt);

    expect(managementSection).toContain('**Failure policy:**');
    expect(managementSection).toContain('found: false');
    expect(managementSection).toContain('do not overwrite');
    expect(managementSection).toContain('only after store succeeds');
    expect(managementSection).toContain('add, list, pause, edit, and remove');
  });

  it('captures new CEO scheduling preferences as config-store rules', () => {
    const prompt = loadCalendarPrompt();
    const hierarchyStart = posIn(prompt, '## Preference Hierarchy');
    const conflictStart = posIn(prompt, '## Conflict Escalation');
    expect(hierarchyStart).toBeGreaterThan(-1);
    expect(conflictStart).toBeGreaterThan(hierarchyStart);

    const hierarchySection = prompt.slice(hierarchyStart, conflictStart);
    expect(hierarchySection).toContain('Capturing new preferences');
    expect(hierarchySection).toContain('config-store');
    expect(hierarchySection).toContain('Do not store standing CEO-wide prefs via `memory-store`');
  });

  it('bumps calendar agent version for scheduling-rules capability', async () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    // Exact-version tripwire: bump this alongside `agents/calendar.yaml`'s version on any
    // meaningful prompt/capability change. 0.6.1 = collapse to single CEO-calendar identity (#1217).
    expect(config.version).toBe('0.6.1');
  });
});
