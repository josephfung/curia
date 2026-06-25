// tests/unit/agents/ceo-inbox-prompt.test.ts
//
// Structural contract tests for the ceo-inbox agent prompt.
// These assert that the YAML system_prompt text satisfies specific ordering and
// content requirements — without invoking an LLM. They are fast, deterministic,
// and serve as a living spec for the Branch A resume section.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

function loadCeoInboxPrompt(): string {
  const config = loadAgentConfig(path.join(agentsDir, 'ceo-inbox.yaml'));
  return config.system_prompt;
}

function loadCalendarPrompt(): string {
  const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
  return config.system_prompt;
}

// Extract the text of the Branch A section from the ceo-inbox prompt.
// Branch A runs from its header to the start of the Scheduled-wake resume
// section (the second resume mode). Note: "Branch B" appears earlier in the
// intro text ("do not fall through to Branch B") so it cannot be used as the
// delimiter here.
function extractBranchASection(prompt: string): string {
  const branchAStart = prompt.indexOf('Branch A');
  // "**Scheduled-wake resume" marks the boundary between Branch A and Branch B.
  const scheduledWakeStart = prompt.indexOf('**Scheduled-wake resume');
  if (branchAStart === -1) throw new Error('Branch A section not found in prompt');
  if (scheduledWakeStart === -1 || scheduledWakeStart <= branchAStart)
    throw new Error(
      'Scheduled-wake resume section not found after Branch A in prompt',
    );
  return prompt.slice(branchAStart, scheduledWakeStart);
}

function extractSchedulingConsultSection(prompt: string): string {
  const start = prompt.indexOf('### Scheduling-specific drafting rules');
  const end = prompt.indexOf('**📌 Seen**');
  if (start === -1) throw new Error('Scheduling-specific drafting rules not found');
  if (end === -1 || end <= start)
    throw new Error('Scheduling section end not found after scheduling rules');
  return prompt.slice(start, end);
}

function extractCalendarConsultSection(prompt: string): string {
  const start = prompt.indexOf('## Answering a scheduling consult');
  const end = prompt.indexOf('## Holds toggle');
  if (start === -1) throw new Error('Calendar consult section not found');
  if (end === -1 || end <= start)
    throw new Error('Holds toggle section not found after calendar consult section');
  return prompt.slice(start, end);
}

// Find the position of a string within a section, returning -1 if not found.
function posIn(section: string, term: string): number {
  return section.indexOf(term);
}

describe('ceo-inbox Branch A prompt — memory-query contract', () => {
  it('Branch A section contains a memory-query call', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    expect(branchA).toContain('memory-query');
  });

  it('memory-query appears before ceo-inbox-draft-reply in Branch A', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const memoryQueryPos = posIn(branchA, 'memory-query');
    const draftReplyPos = posIn(branchA, 'ceo-inbox-draft-reply');
    expect(memoryQueryPos).toBeGreaterThan(-1);
    expect(draftReplyPos).toBeGreaterThan(-1);
    expect(memoryQueryPos).toBeLessThan(draftReplyPos);
  });

  it('Branch A memory-query is anchored on sender and subject context', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    // The recall query must reference both the sender and email subject so it
    // surfaces relevant stored facts (Calendly links, venue preferences, etc.).
    const memoryQueryPos = posIn(branchA, 'memory-query');
    const nearbyText = branchA.slice(memoryQueryPos, memoryQueryPos + 600);
    const mentionsSender =
      nearbyText.toLowerCase().includes('sender') ||
      nearbyText.toLowerCase().includes('contact');
    const mentionsSubject =
      nearbyText.toLowerCase().includes('subject') ||
      nearbyText.toLowerCase().includes('email');
    expect(mentionsSender).toBe(true);
    expect(mentionsSubject).toBe(true);
  });

  it('Result: no_slots step references memory-query (via cross-reference to confirmed-path steps)', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    // Anchor on the no_slots header to avoid matching the Branch A intro sentence
    // which also mentions "no_slots" but is not the step body.
    const noSlotsStart = posIn(branchA, '4. **Result: no_slots');
    const escalateStart = posIn(branchA, '5. **Result: escalate');
    expect(noSlotsStart).toBeGreaterThan(-1);
    expect(escalateStart).toBeGreaterThan(noSlotsStart);
    const noSlotsSection = branchA.slice(noSlotsStart, escalateStart);
    // The no_slots path pulls in the voice-profile + memory-query +
    // date-resolve steps from step 2 via a cross-reference. Assert both
    // the cross-reference and that memory-query is mentioned by name in the step body.
    expect(noSlotsSection).toContain('memory-query');
    // The cross-reference must enumerate steps 2a through at least 2c (which now
    // includes the memory-query step introduced by this fix).
    expect(noSlotsSection).toContain('2a-c');
  });

  it('memory-query failure in Branch A is non-blocking (proceed-normally instruction)', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const memoryQueryPos = posIn(branchA, 'memory-query');
    // Look for language indicating a no-match is gracefully handled.
    const nearbyText = branchA.slice(memoryQueryPos, memoryQueryPos + 800);
    const hasNoMatchGuidance =
      nearbyText.toLowerCase().includes('no match') ||
      nearbyText.toLowerCase().includes('no result') ||
      nearbyText.toLowerCase().includes('proceed normally') ||
      nearbyText.toLowerCase().includes('if nothing') ||
      nearbyText.toLowerCase().includes('not found');
    expect(hasNoMatchGuidance).toBe(true);
  });
});

describe('ceo-inbox scheduling consult prompt — proposed-time protocol', () => {
  it('CONSULT REQUEST includes an optional Proposed block for sender-suggested times', () => {
    const prompt = loadCeoInboxPrompt();
    const schedulingSection = extractSchedulingConsultSection(prompt);

    expect(schedulingSection).toContain('Proposed:');
    expect(schedulingSection).toContain('start=<resolved timestamp>');
    expect(schedulingSection).toContain('end=<resolved timestamp>');
    expect(schedulingSection).toContain('source="<original phrase>"');
    expect(schedulingSection).toContain('Include the optional `Proposed:` block only when');
    expect(schedulingSection).toContain('specific times');
    expect(schedulingSection).toContain('Do NOT include');
    expect(schedulingSection).toContain('vague windows');
  });

  it('requires date-resolve when posting relative proposed times', () => {
    const prompt = loadCeoInboxPrompt();
    const schedulingSection = extractSchedulingConsultSection(prompt);
    const proposedPos = posIn(schedulingSection, 'Proposed:');
    const dateResolvePos = posIn(schedulingSection, 'date-resolve');
    const bullpenPostPos = posIn(schedulingSection, 'bullpen.post');

    expect(proposedPos).toBeGreaterThan(-1);
    expect(dateResolvePos).toBeGreaterThan(proposedPos);
    expect(bullpenPostPos).toBeGreaterThan(-1);
  });

  it('Branch A accepts confirmed proposed slots instead of counter-proposing', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const confirmedStart = posIn(branchA, '2. **Result: confirmed');
    const okStart = posIn(branchA, '3. **Result: ok');
    expect(confirmedStart).toBeGreaterThan(-1);
    expect(okStart).toBeGreaterThan(confirmedStart);

    const confirmedSection = branchA.slice(confirmedStart, okStart);
    expect(confirmedSection).toContain('`Confirmed:` slot display string VERBATIM');
    expect(confirmedSection).toContain('clean confirmation');
    expect(confirmedSection).toContain('rather than offering alternatives');
    expect(confirmedSection).toContain('Do NOT mention holds');
  });

  it('Branch A still counter-proposes for Result: ok alternatives', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const okStart = posIn(branchA, '3. **Result: ok');
    const noSlotsStart = posIn(branchA, '4. **Result: no_slots');
    expect(okStart).toBeGreaterThan(-1);
    expect(noSlotsStart).toBeGreaterThan(okStart);

    const okSection = branchA.slice(okStart, noSlotsStart);
    expect(okSection).toContain('counter-proposal');
    expect(okSection).toMatch(/new\s+alternatives/);
    expect(okSection).toContain('hold placed');
  });
});

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
