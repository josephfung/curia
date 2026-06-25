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

  it('Result: no_slots step references memory-query (via cross-reference to ok-path steps)', () => {
    const prompt = loadCeoInboxPrompt();
    const branchA = extractBranchASection(prompt);
    // Anchor on the step 3 header to avoid matching the Branch A intro sentence
    // which also mentions "no_slots" but is not the step body.
    const step3Start = posIn(branchA, '3. **Result: no_slots');
    const step4Start = posIn(branchA, '4. **Result: escalate');
    expect(step3Start).toBeGreaterThan(-1);
    expect(step4Start).toBeGreaterThan(step3Start);
    const step3Section = branchA.slice(step3Start, step4Start);
    // Step 3 pulls in the voice-profile + memory-query + date-resolve steps from step 2
    // via a cross-reference rather than repeating the skill name literally. Assert both
    // the cross-reference and that memory-query is mentioned by name in the step body.
    expect(step3Section).toContain('memory-query');
    // The cross-reference must enumerate steps 2a through at least 2c (which now
    // includes the memory-query step introduced by this fix).
    expect(step3Section).toContain('2a-c');
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
