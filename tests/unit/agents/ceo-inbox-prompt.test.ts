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

// Extract the text of the Branch A section from the ceo-inbox prompt.
// Branch A runs from its header to the start of the Scheduled-wake resume
// section (the second resume mode). Note: "Branch B" appears earlier in the
// intro text ("do not fall through to Branch B") so it cannot be used as the
// delimiter here.
function extractResumePreamble(prompt: string): string {
  const start = prompt.indexOf('**Resume mode**');
  const branchAStart = prompt.indexOf('**Branch A — Calendar consult reply');
  if (start === -1) throw new Error('Resume mode section not found');
  if (branchAStart === -1 || branchAStart <= start)
    throw new Error('Branch A header not found after Resume mode');
  return prompt.slice(start, branchAStart);
}

function extractBranchASection(prompt: string): string {
  const branchAStart = prompt.indexOf('**Branch A — Calendar consult reply');
  // "**Scheduled-wake resume" marks the boundary between Branch A and Branch B.
  const scheduledWakeStart = prompt.indexOf('**Scheduled-wake resume');
  if (branchAStart === -1) throw new Error('Branch A section not found in prompt');
  if (scheduledWakeStart === -1 || scheduledWakeStart <= branchAStart)
    throw new Error(
      'Scheduled-wake resume section not found after Branch A in prompt',
    );
  return prompt.slice(branchAStart, scheduledWakeStart);
}

function extractScheduledWakeSection(prompt: string): string {
  const start = prompt.indexOf('**Scheduled-wake resume');
  const end = prompt.indexOf('**Closing a multi-turn exchange');
  if (start === -1) throw new Error('Scheduled-wake resume section not found');
  if (end === -1 || end <= start)
    throw new Error('Closing a multi-turn exchange not found after scheduled wake');
  return prompt.slice(start, end);
}

function extractSchedulingConsultSection(prompt: string): string {
  const start = prompt.indexOf('### Scheduling-specific drafting rules');
  const end = prompt.indexOf('**📌 Seen**');
  if (start === -1) throw new Error('Scheduling-specific drafting rules not found');
  if (end === -1 || end <= start)
    throw new Error('Scheduling section end not found after scheduling rules');
  return prompt.slice(start, end);
}

// Find the position of a string within a section, returning -1 if not found.
function posIn(section: string, term: string): number {
  return section.indexOf(term);
}

describe('ceo-inbox consult-timeout self-healing', () => {
  it('documents consult-timeout scheduled wake with configurable delay', () => {
    const prompt = loadCeoInboxPrompt();
    const schedulingSection = extractSchedulingConsultSection(prompt);
    const scheduledWake = extractScheduledWakeSection(prompt);

    expect(schedulingSection).toContain('consult-timeout');
    expect(schedulingSection).toContain('consult_timeout_minutes');
    expect(schedulingSection).toContain('consult_kind=scheduling');
    expect(schedulingSection).toContain('source_message_id=<id>');
    expect(schedulingSection).toContain('thread_id=<bullpen thread id');
    expect(scheduledWake).toContain('`consult-timeout` tag');
    expect(scheduledWake).toContain('pending your calendar');
    expect(scheduledWake).toContain('consult already resolved');
  });

  it('checks bullpen get_thread for a late CONSULT REPLY before blind-drafting', () => {
    const prompt = loadCeoInboxPrompt();
    const scheduledWake = extractScheduledWakeSection(prompt);
    const getThreadPos = posIn(scheduledWake, 'get_thread');
    const blindDraftPos = posIn(scheduledWake, 'pending your calendar');
    expect(getThreadPos).toBeGreaterThan(-1);
    expect(blindDraftPos).toBeGreaterThan(getThreadPos);
    expect(scheduledWake).toContain('CONSULT REPLY');
    expect(scheduledWake).toContain('run Branch A');
    expect(scheduledWake).toContain('draft-existence check');
  });

  it('cancels consult-timeout tasks when Branch A handles a CONSULT REPLY', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    expect(branchA).toContain('Cancel consult-timeout safety task');
    expect(branchA).toContain('consult-timeout');
    expect(branchA).toContain('task-complete');
  });

  it('escalates invite consult timeouts instead of blind-drafting', () => {
    const prompt = loadCeoInboxPrompt();
    const scheduledWake = extractScheduledWakeSection(prompt);
    expect(scheduledWake).toContain('consult_kind=invite');
    expect(scheduledWake).toContain('Do NOT draft a blind email reply');
  });

  it('runs idempotent no-op before timeout fallback and checks DRAFTS folder', () => {
    const prompt = loadCeoInboxPrompt();
    const scheduledWake = extractScheduledWakeSection(prompt);
    const getThreadPos = posIn(scheduledWake, 'get_thread');
    const noopPos = posIn(scheduledWake, 'Idempotent no-op');
    const fallbackPos = posIn(scheduledWake, 'Still parked');
    expect(getThreadPos).toBeGreaterThan(-1);
    expect(noopPos).toBeGreaterThan(getThreadPos);
    expect(fallbackPos).toBeGreaterThan(noopPos);
    expect(scheduledWake).toContain('ceo-inbox-list');
    expect(scheduledWake).toContain('folder: "DRAFTS"');
  });

  it('does not slide consult-timeout wake_at forward while still pending', () => {
    const prompt = loadCeoInboxPrompt();
    const schedulingSection = extractSchedulingConsultSection(prompt);
    expect(schedulingSection).toContain('next_wake_at');
    expect(schedulingSection).toContain('still in the future');
  });

  it('schedules consult-timeout on formal invite park', () => {
    const prompt = loadCeoInboxPrompt();
    const inviteStart = posIn(prompt, '### 4d-invite. Formal meeting invitation path');
    const inviteEnd = posIn(prompt, '### 4e-pre. Automated sender check');
    const inviteSection = prompt.slice(inviteStart, inviteEnd);
    expect(inviteSection).toContain('Schedule consult-timeout safety wake');
    expect(inviteSection).toContain('consult_kind=invite');
  });
});

describe('ceo-inbox closed bullpen wake routing (#1256)', () => {
  it('routes threadClosed wakes to get_thread before the Branch A content gate', () => {
    const prompt = loadCeoInboxPrompt();
    const preamble = extractResumePreamble(prompt);
    const branchA = extractBranchASection(prompt);

    expect(preamble).toContain('Closed bullpen thread wake');
    expect(preamble).toContain('threadClosed: true');
    expect(preamble).toContain('get_thread');
    expect(preamble).toMatch(/Branch A[\s\n]+sub-steps/);

    const closedGetThreadPos = posIn(preamble, 'get_thread');
    const branchAContentGatePos = posIn(
      branchA,
      'If the bullpen message body visible in injected context is a CONSULT REPLY',
    );
    expect(closedGetThreadPos).toBeGreaterThan(-1);
    expect(branchAContentGatePos).toBeGreaterThan(-1);
    // Closed-path fetch is in the preamble, which precedes the open-thread gate.
    expect(preamble.length).toBeLessThan(
      prompt.indexOf(
        'If the bullpen message body visible in injected context is a CONSULT REPLY',
      ),
    );
  });

  it('closed wake path enters full Branch A protocol (not a shortcut)', () => {
    const prompt = loadCeoInboxPrompt();
    const preamble = extractResumePreamble(prompt);
    expect(preamble).toContain('verbatim slots');
    expect(preamble).toContain('date-resolve');
    expect(preamble).toContain('no "pending your calendar" qualifier');
    expect(preamble).toContain('consult-timeout cancellation');
  });
});

describe('ceo-inbox Branch A prompt — memory-query contract', () => {
  it('loads the full bullpen thread via get_thread before acting', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const getThreadPos = posIn(branchA, 'get_thread');
    const readEmailPos = posIn(branchA, 'ceo-inbox-read');
    expect(getThreadPos).toBeGreaterThan(-1);
    expect(readEmailPos).toBeGreaterThan(getThreadPos);
    expect(branchA).toContain('closed wake path above');
  });

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
    const noSlotsStart = posIn(branchA, '7. **Result: no_slots');
    const escalateStart = posIn(branchA, '8. **Result: escalate');
    expect(noSlotsStart).toBeGreaterThan(-1);
    expect(escalateStart).toBeGreaterThan(noSlotsStart);
    const noSlotsSection = branchA.slice(noSlotsStart, escalateStart);
    // The no_slots path pulls in the voice-profile + memory-query +
    // date-resolve steps from step 2 via a cross-reference. Assert both
    // the cross-reference and that memory-query is mentioned by name in the step body.
    expect(noSlotsSection).toContain('memory-query');
    // The cross-reference must enumerate steps 2a through at least 2c (which now
    // includes the memory-query step introduced by this fix).
    expect(noSlotsSection).toContain('5a-c');
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
  it('CONSULT REQUEST bullpen.post sets participants to calendar', () => {
    const prompt = loadCeoInboxPrompt();
    const schedulingSection = extractSchedulingConsultSection(prompt);
    expect(schedulingSection).toContain("participants: ['calendar']");
    expect(schedulingSection).toContain('routing field');
  });

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
    const tapStart = posIn(schedulingSection, '1. **Tap — post a CONSULT REQUEST');
    const parkStart = posIn(schedulingSection, '2. **Park — label + mark-read');
    expect(tapStart).toBeGreaterThan(-1);
    expect(parkStart).toBeGreaterThan(tapStart);
    const tapSection = schedulingSection.slice(tapStart, parkStart);
    const proposedPos = posIn(tapSection, 'Proposed:');
    const dateResolvePos = posIn(tapSection, 'date-resolve');
    const bullpenPostPos = posIn(tapSection, 'bullpen.post');

    expect(proposedPos).toBeGreaterThan(-1);
    expect(dateResolvePos).toBeGreaterThan(proposedPos);
    expect(bullpenPostPos).toBeGreaterThan(-1);
  });

  it('Branch A accepts confirmed proposed slots instead of counter-proposing', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    const confirmedStart = posIn(branchA, '5. **Result: confirmed');
    const okStart = posIn(branchA, '6. **Result: ok');
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
    const okStart = posIn(branchA, '6. **Result: ok');
    const noSlotsStart = posIn(branchA, '7. **Result: no_slots');
    expect(okStart).toBeGreaterThan(-1);
    expect(noSlotsStart).toBeGreaterThan(okStart);

    const okSection = branchA.slice(okStart, noSlotsStart);
    expect(okSection).toContain('counter-proposal');
    expect(okSection).toMatch(/new\s+alternatives/);
    expect(okSection).toContain('hold placed');
    expect(okSection).toContain('Do NOT include any "pending your calendar"');
  });
});

describe('ceo-inbox formal invite prompt — RSVP consult contract', () => {
  it('detects formal meeting invites before generic scheduling classification', () => {
    const prompt = loadCeoInboxPrompt();
    const invitePos = posIn(prompt, '### 4d-invite. Formal meeting invitation path');
    const schedulingPos = posIn(prompt, '### Scheduling-specific drafting rules');

    expect(invitePos).toBeGreaterThan(-1);
    expect(schedulingPos).toBeGreaterThan(invitePos);
    expect(prompt).toContain('isCalendarInvite: true');
    expect(prompt).toContain('extract_as: "calendar_invite"');
  });

  it('parks formal invites for calendar consults instead of archiving as handled', () => {
    const prompt = loadCeoInboxPrompt();
    const inviteStart = posIn(prompt, '### 4d-invite. Formal meeting invitation path');
    const inviteEnd = posIn(prompt, '### 4e-pre. Automated sender check');
    expect(inviteStart).toBeGreaterThan(-1);
    expect(inviteEnd).toBeGreaterThan(inviteStart);
    const inviteSection = prompt.slice(inviteStart, inviteEnd);

    expect(inviteSection).toContain("participants: ['calendar']");
    expect(inviteSection).toContain('routing field');
    expect(inviteSection).toContain('Need: RSVP for formal calendar invite');
    expect(inviteSection).toContain('Standing: <accept|decline|tentative instruction text, or none>');
    expect(inviteSection).toContain('Do NOT archive');
    expect(inviteSection).toContain('Do NOT classify it as ✅ Handled');
    expect(inviteSection).toContain('ceo-inbox-update-folders');
    expect(inviteSection).not.toContain('ceo-inbox-label (⏳ In Progress)');
  });

  it('handles invite recommendation and pending approval replies without archiving', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    expect(branchA).toContain('Result: invite_pending_approval');
    expect(branchA).toContain('Result: invite_recommendation');
    expect(branchA).toContain('Do NOT archive');
    expect(branchA).toContain('pending approval');
  });
});
