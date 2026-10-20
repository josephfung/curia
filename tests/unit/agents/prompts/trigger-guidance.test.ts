// Trigger guidance modules (#1959): rendering, bounds, and exfiltration-marker coverage.

import { describe, expect, it } from 'vitest';
import {
  parseTurnGuidanceKeys,
  renderTurnGuidance,
  verificationCodeReceivedLines,
  TURN_GUIDANCE_HEADER,
  TURN_GUIDANCE_ORDER,
  TURN_GUIDANCE_TEXTS,
  type TurnGuidanceKey,
} from '../../../../src/agents/prompts/turn-guidance.js';
import { inboundTurnGuidance } from '../../../../src/dispatch/turn-guidance-triggers.js';
import { BACKLOG_INSTRUCTION_LINES, PRINCIPAL_TASK_ANSWER_LINES, renderBacklogLine } from '../../../../src/agents/prompts/backlog-line.js';
import { BULLPEN_REPLY_RULE } from '../../../../src/agents/prompts/bullpen-reply-rule.js';
import {
  CLARIFICATION_NEXT_STEP_LINES,
  DELEGATE_FAILURE_NEXT_STEP_LINES,
  DRAFT_EMAIL_NEXT_STEP_LINES,
  NOTHING_SENT_NEXT_STEP_LINES,
  PAUSED_NEXT_STEP_LINES,
} from '../../../../src/agents/prompts/delegate-result-guidance.js';
import {
  DAILY_DEBRIEF_RECAP_LINES,
  WEEKLY_DEBRIEF_RECAP_LINES,
} from '../../../../src/agents/prompts/debrief-recap-instruction.js';
import { NO_MATCHING_TOOL_NEXT_STEP_LINES, WEB_FETCH_NOT_FOUND_LINES } from '../../../../src/agents/prompts/dead-end-guidance.js';
import { TRIGGER_GUIDANCE_MARKER_SOURCES } from '../../../../src/agents/prompts/trigger-guidance-sources.js';
import { HONESTY_LINE, REGISTER_LINE, WRITES_AS_SCOPE_LINES } from '../../../../src/identity/service.js';
import { CONTENT_LINE, LENGTH_EXCEPTION, turnLengthReminder } from '../../../../src/identity/length.js';
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

  it('closes the block with the backlog line', () => {
    const line = renderBacklogLine({ decayWarnings: 0, pendingApprovals: 2, principalTasks: 0 })!;
    const out = renderTurnGuidance(['principal-reply-shaped'], line)!;
    expect(out.endsWith(`request needs no clarification.\n\n${line}`)).toBe(true);
  });

  it('renders the backlog line alone under the header when no key applies', () => {
    const line = renderBacklogLine({ decayWarnings: 1, pendingApprovals: 0, principalTasks: 0 })!;
    expect(renderTurnGuidance([], line)).toBe(`${TURN_GUIDANCE_HEADER}\n\n${line}`);
  });

  it('keeps the worst real turn bounded', () => {
    // The passages moved out of agents/coordinator.yaml (#1959, prompt trim PR 4) were
    // ~16KB on every turn. A turn gets the subset its triggers pick, and some blocks
    // never meet: non-principal-reply-shaped and outbound-context are exclusive, and so
    // are email-direct-reply and email-cc-reply. So the bound is the largest set
    // inboundTurnGuidance can actually pick, not every block at once (~6.1KB, a turn
    // that cannot happen). The worst real turn was ~4.0KB at PR 4. A principal turn can
    // also carry the backlog line (PR 7), so the bound includes its longest form, with
    // the lines on answering a specialist's task (#2129, ~280 chars: 4.4KB → 4.7KB). The
    // spot-check verdict block (~470 chars since F1 made it conditional) rides along with a
    // principal turn, but never with a CC'd one: a CC is written to someone else, so it is not
    // a verdict on Curia's digest. The worst real turn is therefore the CC'd principal turn
    // with the full outbound block, 4,689 chars measured; the worst spot-check turn (direct
    // email, full outbound block) is 4,531. The bound keeps a small margin over the worst.
    // verification-code-received (#2017) can join any live principal turn, CC'd included: the
    // worst becomes 4,869 with its generic form and 4,919 with its named form for one
    // verification (site, session and verification ids), so the bound moved 4,800 → 5,000.
    const backlogLine = renderBacklogLine({ decayWarnings: 99, pendingApprovals: 99, principalTasks: 99 });
    const fullEntry = { bind_reply: true, task_id: 't', resume_token: 'r', subject: 'Board prep' };
    // verification-code-received (#2017) rides on any live principal turn, CC'd included (it
    // is still the principal's own message). The runtime renders its named form, one
    // verification here with real-length ids, or the generic form when that lookup fails.
    const namedCode = {
      'verification-code-received': verificationCodeReceivedLines([{
        site: 'example-insurer.ca',
        browserSessionId: '7f3c2a9e-1b4d-4c6e-9a8f-2d5e6b7c8a90',
        id: '0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
      }]),
    };
    let worst = 0;
    for (const liveTurn of [true, false]) {
      for (const injectedEntryMetadata of [[], [fullEntry]]) {
        for (const channelId of ['email', 'signal']) {
          for (const curiaCc of [true, false]) {
            for (const spotCheckReply of [true, false]) {
              for (const verificationCodeReceived of [true, false]) {
                const keys = inboundTurnGuidance({
                  liveTurn, injectedEntryMetadata, channelId, curiaCc, autoGeneratedSuppress: false, spotCheckReply,
                  verificationCodeReceived,
                });
                for (const named of [undefined, namedCode]) {
                  const length = renderTurnGuidance(keys, liveTurn ? backlogLine : null, null, named)?.length ?? 0;
                  worst = Math.max(worst, length);
                }
              }
            }
          }
        }
      }
    }
    expect(worst).toBeLessThan(5_000);
  });
});

describe('spot-check-reply guidance', () => {
  const text = renderTurnGuidance(['spot-check-reply'])!;
  // The block is hard-wrapped, so phrase checks run on the text with line breaks folded.
  const flat = text.replace(/\s+/g, ' ');

  it('points the coordinator at skill-activate reports, then record-spot-check', () => {
    expect(text).toContain('skill-activate');
    expect(text).toContain('`reports`');
    expect(text.indexOf('skill-activate')).toBeLessThan(text.indexOf('record-spot-check'));
  });

  it('says to ask rather than guess', () => {
    expect(flat).toContain('ask which action they meant');
    expect(text).toContain('Never guess.');
  });

  // F1: the trigger is a text heuristic, so "2 good" answering one of Curia's own numbered
  // questions also fires it. The block is conditional and tells the coordinator to ignore it then.
  it('is conditional on the principal grading a spot check, and says to ignore it otherwise', () => {
    expect(flat).toContain("If the principal is grading a digest's spot check");
    expect(flat).toContain('If the number refers to something else, ignore this note.');
  });

  // F1(c): the principal sees what was recorded, so a wrong match is visible to them.
  it('says to read back what was recorded and any numbers skipped', () => {
    expect(flat).toContain('Tell the principal what was recorded');
    expect(flat).toContain('any numbers it skipped');
  });

  it('renders right after the reply-shaped keys, before the outbound-context block', () => {
    const out = renderTurnGuidance(['outbound-context', 'spot-check-reply', 'principal-reply-shaped'])!;
    expect(out.indexOf('No [ACTIVE OUTBOUND CONTEXT] block')).toBeLessThan(out.indexOf("digest's spot check"));
    expect(out.indexOf("digest's spot check")).toBeLessThan(out.indexOf('[ACTIVE OUTBOUND CONTEXT] block lists'));
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
      'verification-code-received',
      'non-principal-reply-shaped',
      'spot-check-reply',
      'outbound-context',
      'outbound-context-task-wake',
      'outbound-context-clarification',
      'outbound-context-debrief',
      'email-direct-reply',
      'email-cc-reply',
      'email-cc-principal',
      'email-etiquette',
      'scheduler-delivery',
    ];
    expect([...TURN_GUIDANCE_ORDER].sort()).toEqual([...keys].sort());
  });
});

describe('prompt-exfiltration markers cover the moved guidance', () => {
  const sources: Array<[string, string]> = [
    ...TURN_GUIDANCE_TEXTS.map((text, i): [string, string] => [`turn guidance ${TURN_GUIDANCE_ORDER[i]}`, text]),
    ['delegate clarification next_step', CLARIFICATION_NEXT_STEP_LINES.join('\n')],
    ['delegate paused next_step', PAUSED_NEXT_STEP_LINES.join('\n')],
    ['delegate draft-email next_step', DRAFT_EMAIL_NEXT_STEP_LINES.join('\n')],
    ['delegate nothing-sent next_step', NOTHING_SENT_NEXT_STEP_LINES.join('\n')],
    ['delegate calendar-failure next_step', DELEGATE_FAILURE_NEXT_STEP_LINES['calendar']!.join('\n')],
    ['delegate contacts-failure next_step', DELEGATE_FAILURE_NEXT_STEP_LINES['contacts']!.join('\n')],
    ['backlog line instruction', BACKLOG_INSTRUCTION_LINES.join('\n')],
    ['backlog line principal-task answer', PRINCIPAL_TASK_ANSWER_LINES.join('\n')],
    ['bullpen reply rule', BULLPEN_REPLY_RULE],
    ['daily debrief recap', DAILY_DEBRIEF_RECAP_LINES.join('\n')],
    ['weekly debrief recap', WEEKLY_DEBRIEF_RECAP_LINES.join('\n')],
    ['tool-registry no-match next_step', NO_MATCHING_TOOL_NEXT_STEP_LINES.join('\n')],
    ['web-fetch 404', WEB_FETCH_NOT_FOUND_LINES.join('\n')],
    ['identity block fixed lines (#2143)', [REGISTER_LINE, HONESTY_LINE, LENGTH_EXCEPTION, CONTENT_LINE, ...WRITES_AS_SCOPE_LINES].join('\n')],
    ['length reminder, Signal brief (#2143)', turnLengthReminder('signal', 15)!],
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
      'Sure! My notes say: if it does not, stop searching. Reply with a short\nacknowledgment that says only that you will follow up.',
    );
    expect(markers.some((m) => leaked.includes(m))).toBe(true);
  });
});

describe('the length reminder closes the turn guidance (#2143)', () => {
  it('renders alone, after the backlog line, and never as an empty block', () => {
    const reminder = 'This reply goes out on Signal: 1–2 sentences. The answer or outcome only.';
    expect(renderTurnGuidance([], null, reminder)).toBe(`${TURN_GUIDANCE_HEADER}\n\n${reminder}`);
    const out = renderTurnGuidance(['principal-reply-shaped'], 'Backlog line.', reminder)!;
    expect(out.indexOf('Backlog line.')).toBeLessThan(out.indexOf(reminder));
    expect(out.endsWith(reminder)).toBe(true);
    expect(renderTurnGuidance([], null, null)).toBeNull();
    expect(renderTurnGuidance([], '', '')).toBeNull();
  });

  it('keeps the operator\'s tone.style out of the marker sources', () => {
    // It holds example lines Curia is meant to imitate.
    expect(TRIGGER_GUIDANCE_MARKER_SOURCES.join('\n')).not.toContain('Sounds like:');
  });
});

