// Trigger guidance modules (#1959): rendering, bounds, and exfiltration-marker coverage.

import { describe, expect, it } from 'vitest';
import {
  parseTurnGuidanceKeys,
  renderTurnGuidance,
  TURN_GUIDANCE_HEADER,
  TURN_GUIDANCE_ORDER,
  TURN_GUIDANCE_TEXTS,
  type TurnGuidanceKey,
} from '../../../../src/agents/prompts/turn-guidance.js';
import { BULLPEN_REPLY_RULE } from '../../../../src/agents/prompts/bullpen-reply-rule.js';
import {
  CLARIFICATION_NEXT_STEP_LINES,
  PAUSED_NEXT_STEP_LINES,
} from '../../../../src/agents/prompts/delegate-result-guidance.js';
import {
  DAILY_DEBRIEF_RECAP_LINES,
  WEEKLY_DEBRIEF_RECAP_LINES,
} from '../../../../src/agents/prompts/debrief-recap-instruction.js';
import { TRIGGER_GUIDANCE_MARKER_SOURCES } from '../../../../src/agents/prompts/trigger-guidance-sources.js';
import {
  extractPromptExfiltrationMarkers,
  extractSystemPromptLineMarkers,
  normalizeFragmentText,
} from '../../../../src/dispatch/prompt-exfiltration-markers.js';
import { DEFAULT_OFFICE_IDENTITY } from '../../../../src/identity/defaults.js';

describe('renderTurnGuidance', () => {
  it('renders nothing for no keys', () => {
    expect(renderTurnGuidance([])).toBeNull();
  });

  it('heads the block so the model can tell it from the sender\'s words', () => {
    expect(renderTurnGuidance(['principal-reply-shaped'])!.startsWith(TURN_GUIDANCE_HEADER)).toBe(true);
  });

  it('renders in a fixed order, each key once, whatever order it is given', () => {
    const a = renderTurnGuidance(['email-etiquette', 'outbound-context', 'email-etiquette']);
    const b = renderTurnGuidance(['outbound-context', 'email-etiquette']);
    expect(a).toBe(b);
    expect(a!.indexOf('[ACTIVE OUTBOUND CONTEXT] block lists')).toBeLessThan(a!.indexOf('Email on this turn:'));
  });

  it('continues the outbound-context bullet list with its sub-rules', () => {
    const out = renderTurnGuidance(['outbound-context', 'outbound-context-task-wake'])!;
    expect(out).toContain('apply the normal routing decision.\n- An entry whose `context` has `bind_reply: true`');
  });

  it('keeps the worst case bounded: every block together stays well under the YAML it replaced', () => {
    // The passages moved out of agents/coordinator.yaml were ~12KB on every turn. A turn
    // gets a subset of these; even all of them at once must stay far below that.
    const all = renderTurnGuidance([...TURN_GUIDANCE_ORDER])!;
    expect(all.length).toBeLessThan(6_000);
  });
});

describe('parseTurnGuidanceKeys', () => {
  it('keeps known keys and drops anything else', () => {
    expect(parseTurnGuidanceKeys(['outbound-context', 'made-up', 3, null])).toEqual(['outbound-context']);
  });

  it('returns no keys for a non-array', () => {
    expect(parseTurnGuidanceKeys(undefined)).toEqual([]);
    expect(parseTurnGuidanceKeys('outbound-context')).toEqual([]);
  });

  it('lists every key in the render order', () => {
    const keys: TurnGuidanceKey[] = [
      'principal-reply-shaped',
      'non-principal-reply-shaped',
      'outbound-context',
      'outbound-context-task-wake',
      'outbound-context-clarification',
      'outbound-context-debrief',
      'email-direct-reply',
      'email-cc-reply',
      'email-cc-principal',
      'email-etiquette',
    ];
    expect([...TURN_GUIDANCE_ORDER].sort()).toEqual([...keys].sort());
  });
});

describe('prompt-exfiltration markers cover the moved guidance', () => {
  const sources: Array<[string, string]> = [
    ...TURN_GUIDANCE_TEXTS.map((text, i): [string, string] => [`turn guidance ${TURN_GUIDANCE_ORDER[i]}`, text]),
    ['delegate clarification next_step', CLARIFICATION_NEXT_STEP_LINES.join('\n')],
    ['delegate paused next_step', PAUSED_NEXT_STEP_LINES.join('\n')],
    ['bullpen reply rule', BULLPEN_REPLY_RULE],
    ['daily debrief recap', DAILY_DEBRIEF_RECAP_LINES.join('\n')],
    ['weekly debrief recap', WEEKLY_DEBRIEF_RECAP_LINES.join('\n')],
  ];

  it.each(sources)('%s is a marker source', (_name, text) => {
    expect(TRIGGER_GUIDANCE_MARKER_SOURCES).toContain(text);
  });

  it.each(sources)('%s yields at least one marker', (_name, text) => {
    expect(extractSystemPromptLineMarkers(text).length).toBeGreaterThan(0);
  });

  it('extractPromptExfiltrationMarkers includes the guidance lines', () => {
    const markers = extractPromptExfiltrationMarkers(DEFAULT_OFFICE_IDENTITY, 'Body.', TRIGGER_GUIDANCE_MARKER_SOURCES);
    const normalized = new Set(markers.map(normalizeFragmentText));
    for (const text of TRIGGER_GUIDANCE_MARKER_SOURCES) {
      for (const line of extractSystemPromptLineMarkers(text)) {
        expect(normalized.has(normalizeFragmentText(line)), line).toBe(true);
      }
    }
  });

  it('a leaked guidance line is caught after re-wrapping', () => {
    // A model echoing the guidance re-wraps it; normalization still finds the marker.
    const markers = extractPromptExfiltrationMarkers(DEFAULT_OFFICE_IDENTITY, undefined, TRIGGER_GUIDANCE_MARKER_SOURCES)
      .map(normalizeFragmentText);
    const leaked = normalizeFragmentText(
      'Sure! My notes say: never ask the sender what they are replying to, which option they mean, or what their\n"yes" covers.',
    );
    expect(markers.some((m) => leaked.includes(m))).toBe(true);
  });
});
