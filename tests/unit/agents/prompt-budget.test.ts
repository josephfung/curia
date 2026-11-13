// Always-on context budget per agent (#1961, ADR-046).
//
// The coordinator prompt was cut to ~32KB in June (#957) and had grown back to 56KB
// by October, because each incident fix appended a paragraph and nothing pushed back.
// This test is the push-back: it fails when an agent's fixed per-call payload grows
// past its budget, and the failure names the placement rule a fix should follow.
//
// Two numbers per agent, measured over the real agents/, skills/ and config/ by
// src/agents/prompt-budget.ts (which says what each counts): the always-on prompt (YAML
// system_prompt plus pinned SKILL.md bodies) and the local tool-definition bytes. A
// deployment measures its own agents with the same function (curia-deploy#276).
//
// To opt another agent in, add a row to AGENT_BUDGETS. Set each budget from the
// agent's measured numbers with small headroom, and raise one only in a PR that says
// why the addition could not go higher up the ladder in ADR-046.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { formatBudgetFailure } from '../../../src/agents/budget-report.js';
import { CHARS_PER_TOKEN, mcpServerNames, measureAgentContext } from '../../../src/agents/prompt-budget.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SOURCES = {
  agentsDir: resolve(REPO_ROOT, 'agents'),
  skillsDir: resolve(REPO_ROOT, 'skills'),
  configDir: resolve(REPO_ROOT, 'config'),
};
const ADR = 'docs/adr/046-agent-behavior-fix-placement.md';

interface AgentBudget {
  agent: string;
  /** YAML system_prompt + pinned SKILL.md bodies, in estimated tokens. */
  alwaysOnPromptTokens: number;
  /** JSON bytes of the local tool definitions (MCP excluded). */
  localToolDefinitionBytes: number;
  /**
   * The `## Available Specialists` roster over the core agents, in estimated tokens. Each
   * line is the agent's YAML `delegate_when` (or its description), so routing text moved
   * out of the prompt lands here and is held to a budget too. Coordinator only.
   */
  rosterTokens?: number;
  /**
   * Whether the agent may pin an MCP server. Its tools cannot be measured here (they
   * come from the upstream server), so an agent under budget must not pin one: the
   * coordinator activates google-workspace on demand instead (#2024). Default true.
   */
  allowMcpPins?: boolean;
}

// Coordinator, measured 2026-10-06 after #1958, #1959 and #1960: ~6,777 tokens
// (YAML 20,951 chars + SKILL.md 6,157) and 74,856 bytes over 66 local tools. After
// #2024 (google-workspace unpinned, its prompt section rewritten): YAML 20,532 chars.
// Prompt trim PR 1 (#1954): YAML 18,561 chars,
// ~6,180 tokens with SKILL.md 6,157; 74,651 bytes over 65 local tools.
// Prompt trim PR 2 (one section each for voice and contact resolution): YAML 15,709
// chars (~3,927 tokens, under #1954's 4k target), ~5,467 tokens with SKILL.md.
// Prompt trim PR 3 (second person, positive phrasing, tighter direct-capability
// sections): YAML 13,439 chars, ~4,899 tokens with SKILL.md; 76,898 bytes over 66 local
// tools, after task-create's owner values moved into its description. The scheduling
// and delegation-acknowledgment paragraphs kept their old wording: the tighter drafts
// measured worse (baseline log).
// Prompt trim PR 4 (audience in code: the sender line, non-principal turn guidance, the
// reply rule in outbound-context guidance, provenance in the security block): YAML 9,494
// chars, ~3,913 tokens with SKILL.md.
// Prompt trim PR 6 (prose-only rules into code: the principal-mailbox draft refusal, the
// Google URL refusal, delegate failure next steps, the email signature): YAML 9,065
// chars, ~3,806 tokens with SKILL.md; 76,982 bytes over 66 local tools.
// Prompt trim PR 7 (the backlog line on principal turns replaces What you proactively
// surface): YAML 8,652 chars, ~3,703 tokens with SKILL.md.
// Prompt trim PR 8 (delegate_when roster lines for diagnostics, meeting-debrief and
// setup-wizard; the calendar and inbox routing stayed in the YAML, which is unchanged): the
// roster went from 2,719 chars of descriptions to 1,883 (~471 tokens).
// Prompt trim PR 9 (wake-only text out of the tasks and documents SKILL.md: resuming rides
// on the wake instruction, the rest was already in code or tool descriptions): SKILL.md
// 6,157 → 3,715 chars, ~3,092 tokens always-on.
// Bullpen split (#2126): the polymorphic bullpen tool became bullpen-post, -reply, -read
// and -close; 76,983 bytes over 69 local tools.
// Report queue (#2159): report-to-principal pinned as a tool (the reports bundle stays
// unpinned; digest jobs activate it): 77,637 bytes over 70 local tools.
// deliver-approval added to the pinned autonomy bundle (#2159): approvals go out on one
// channel the coordinator chooses, replacing code fan-out: 78,226 bytes over 71 local tools.
// #2159 Phase 3 numbering: resolve-learning-digest takes `number` and list-learning-digest returns
// `n`, so the principal replies "confirm 2" instead of quoting a task id: +119 bytes, 78,345 over 71 local tools.
// #2159 Phase 3 approval numbers: approve-, deny- and dismiss-action's short_ref takes the
// approval number ("approve 3"), and list-pending-actions returns `number` and says to pass it:
// +124 bytes, 78,469 over 71 local tools.
// #2159 Phase 3 review fix F3: approve-, deny- and dismiss-action say they answer approvals
// ('Approval N') only, not learning items ('task N'), and resolve-learning-digest's `number` names
// the 'confirm/undo/dismiss task N' it comes from: +202 bytes, 78,671 over 71 local tools. The
// budget rises by exactly that delta (78,543 + 202).
// verification pinned as a tool (#2017): delegated sign-in opens and closes code verifications:
// 79,530 bytes over 72 local tools, measured after merging #2159's numbering changes.
// #2201 sign-in follow-ups: secret-capture-request takes login_url, username and details_only,
// list-user-secrets returns details, verification open returns next_step (the guidance itself
// rides in the tool results, not the descriptions): +263 bytes, 79,793 over 72 local tools. The
// budget rises by exactly that delta.
// archive-extract pinned, and file-parse's description now covers XML, text, Markdown and the
// filename argument (#2208): +1,831 bytes, 81,624 over 73 local tools. The budget rises by
// exactly that delta.
// web-browser adaptive settle (#2244): the waiting is enforced in code; the manifest gains only
// the clear_site_data action, its domain input, the settled/redirect_chain/console_errors/cleared
// outputs, and one line on what settled:false means (the existing challenge sentence was folded
// into it): +238 bytes, 81,862 over 73 local tools. The budget rises by exactly that delta.
// #2328 optional task ids say to omit a placeholder: task-create's three id inputs and
// task-update's blocker input (+132 bytes). The coordinator had 109 bytes of slack, so its
// budget rises by 23 to 81,885. ceo-inbox was exact, so its budget rises by 132 to 45,471.
// record-outreach pinned as a standalone tool (#2312): web forms and calls leave a task_outreach
// row so the organization's reply can find its task (sends record theirs in code): +677 bytes,
// 82,671 over 74 local tools. The budget rises by exactly that delta.
// web-send pinned, and deliver-approval names the phone app (#2341): +613 bytes,
// 83,284 over 75 local tools. The budget rises by exactly that delta.
// scheduler-get added to the scheduler bundle (#2399): the coordinator can read a job's full task
// text, which scheduler-list cuts at 160 characters; scheduler-list and scheduler-update point at it:
// 84,003 over 76 local tools (main's tree measured 83,267, under its 83,284). The budget is set
// to that measurement.
// ceo-inbox's YAML `limits` (#2496: drafts only; no draft to an ungrounded address) ride on
// its roster line as "Cannot: …", so the coordinator routes around them instead of learning
// them from a decline: roster ~457 → ~498 tokens, inside the 500 budget.
// web-send takes context_bridge again (#2440): a phone-app delivery registered no outbound
// context, so a clarification or debrief answered in the app could not route back: +155 bytes,
// 84,158 over 76 local tools. The budget rises by exactly that delta.
// card-use-request arrives with the web bundle (#1358): +1,125 bytes, 85,283 over 77 local tools.
// card-use-confirm is system-only and never offered. The budget rises by exactly that delta.
// web-browser fills saved-card fields into selects and text boxes (#1358): the secret_ref sentence
// names the field to pick per option label and says a card needs card-use-request: +255 bytes,
// 85,538 over 77 local tools. The budget rises by exactly that delta.
// secret-capture-request takes the card templates and the card details_only fields (#1358):
// one description sentence and six inputs, +742 bytes, 86,280 over 77 local tools. The budget
// rises by exactly that delta. +20 for #1358 final-review fixes (billing_zip clear hint, card-use-request risk).
const AGENT_BUDGETS: AgentBudget[] = [
  { agent: 'coordinator', alwaysOnPromptTokens: 3_200, localToolDefinitionBytes: 86_300, allowMcpPins: false, rosterTokens: 500 },
  // Specialists, trimmed per ADR-046 in #2025 (baseline log, final phase).
  // calendar: YAML 28,727 → 23,897 chars (~7,187 → ~5,984 tokens always-on); 24,370 bytes over 19 local tools.
  // Standing rules moved to a pinned document (#2339): the config-store JSON-array steps came
  // out (YAML 23,890 → 21,918 chars, ~5,983 → ~5,490 tokens) and doc-write was pinned to edit
  // the document (+2,100 bytes, 26,729 over 23 local tools). The prompt budget drops by the
  // cut and the tool budget rises by exactly doc-write's definition, so the total holds.
  // #2475 the optional `mailbox` input on all 11 calendar tools (net +1,355 bytes after shortening
  // respond-to-invite's account note), covered by the maintainer's mailbox-input approval (2026-11-12):
  // 28,447 over 23 local tools.
  // #2475 Task 32: the `mailbox` inputs of create-event, create-hold, respond-to-invite and
  // holds-sweep say when an account is required and how to choose it (D5), and respond-to-invite
  // drops `account` (net +271 bytes, same approval): 28,718 over 23 local tools. Fix round 1:
  // respond-to-invite's `mailbox` says it is required and found by iCal UID (+37): 28,755.
  // #2475 Task 33: find-free-time and check-conflicts read every account's calendar and return
  // what blocks (description lines, find-free-time's `treat_as_free` input, both `mailbox`
  // inputs reworded since someone else's free/busy no longer needs one), +610 bytes under the
  // same pre-approval: 29,365 over 23 local tools.
  // #2475 Part 4 final fixes: needs_mailbox is an error (create-event/create-hold `mailbox`), the
  // 20-calendar cap on both availability tools and the 30-day RSVP hold window, +88 bytes under the
  // same pre-approval: 29,453 over 23 local tools.
  // #2475 review I1: create-event's optional topic_matches_account (D5: topic AND evidence), +109
  // bytes under the coordinator's pre-approval of multi-mailbox wording: 29,562 over 23 local tools.
  { agent: 'calendar', alwaysOnPromptTokens: 5_700, localToolDefinitionBytes: 29_562, allowMcpPins: false },
  // ceo-inbox: YAML 60,090 → 49,037 chars (~16,416 → ~13,653 tokens always-on with its SKILL.md bodies),
  // its task-wake steps now riding on the wake; 43,469 bytes over 41 local tools.
  // archive-extract plus the longer file-parse description (#2208) is +1,831 bytes, the same
  // delta as the coordinator. Measured 45,301 bytes over 45 local tools; the prior total sat
  // under the 44,800 ceiling.
  // contact-update accepts contact_id "principal" (#2226): +38 bytes, 45,339 over 45 local tools.
  // The budget rises by exactly that delta.
  // #2328 optional id hints (+132 bytes, the same delta as the coordinator's schema growth):
  // 45,471 over 45 local tools.
  // #2474 ceo-inbox-send-draft (+450 bytes after trims), approved by the maintainer: 45,921 over 46 local tools.
  // #2474 ceo-inbox-list/search DRAFTS modified_since + created_by_curia/date_local (+370 bytes): 46,291 over 46 local tools.
  // #2474 PR 2 ceo-inbox-send-draft describes triage sends (+236 bytes), approved by the maintainer: 46,527 over 46 local tools.
  // #2475 the optional `mailbox` input on all 15 ceo-inbox tools (+1,900 bytes, the description fixed by the
  // design): 48,427 over 46 local tools. approved by the maintainer (2026-11-12).
  // #2475 D5 account-choice guidance on draft-compose (+521 bytes), approved by the maintainer (2026-11-12).
  // #2475 move_to_mailbox on draft-edit (+139 bytes), approved by the maintainer: 49,087 over 46 local tools.
  // #2475 D6 which-draft guidance on send-draft (+329 bytes), approved by the maintainer: 49,416 over 46 local tools.
  // #2475 review I1: draft-compose's optional topic_matches_account (D5: topic AND evidence), +100
  // bytes under the coordinator's pre-approval of multi-mailbox wording: 49,516 over 46 local tools.
  { agent: 'ceo-inbox', alwaysOnPromptTokens: 14_100, localToolDefinitionBytes: 49_516, allowMcpPins: false },
  // contacts: YAML 15,595 → 11,423 chars (~4,831 → ~3,788 tokens always-on with its SKILL.md bodies);
  // 35,311 bytes over its local tools.
  // #2475 the optional `mailbox` input on calendar-list-events (+136 bytes), covered by the same
  // approval: 36,512 over its local tools.
  { agent: 'contacts', alwaysOnPromptTokens: 3_900, localToolDefinitionBytes: 36_520, allowMcpPins: false },
  // meeting-debrief: YAML 18,627 → 14,682 chars (~4,670 → ~3,681 tokens always-on); 22,685 bytes over 17 local tools.
  { agent: 'meeting-debrief', alwaysOnPromptTokens: 3_800, localToolDefinitionBytes: 23_200, allowMcpPins: false },
];

describe.each(AGENT_BUDGETS)('always-on context budget: $agent', (budget) => {
  const m = measureAgentContext(budget.agent, SOURCES);
  // A failure names measured against limit, the overage, the largest contributors and
  // this command (src/agents/budget-report.ts). The budgets above are the only limits.
  const command = `pnpm report:budget --agent ${budget.agent}`;

  it('measures the whole local pin set', () => {
    // A pin that silently failed to load would shrink both numbers and pass the
    // budget for the wrong reason. Only MCP servers may be absent here, and only for
    // an agent allowed to pin them.
    const mcp = budget.allowMcpPins === false ? new Set<string>() : mcpServerNames(SOURCES.configDir);
    expect(m.unresolvedPins.filter(p => !mcp.has(p))).toEqual([]);
    expect(m.localToolCount).toBeGreaterThan(0);
    // Discovery tools are not pins, so a missing one is only logged by assembleAgent.
    if (m.allowDiscovery) {
      expect(m.localToolNames).toEqual(expect.arrayContaining(['tool-registry', 'skill-activate']));
    }
  });

  it('always-on prompt (YAML system_prompt + pinned SKILL.md) is within budget', () => {
    expect(
      m.alwaysOnPromptTokens,
      formatBudgetFailure({
        agent: budget.agent,
        what: 'the always-on prompt',
        unit: 'tokens',
        measured: m.alwaysOnPromptTokens,
        limit: budget.alwaysOnPromptTokens,
        contributors: m.contributors.prompt,
        command,
        advice:
          'Before raising the budget, place the rule on the highest rung that works: code enforcement, ' +
          `injection with its trigger, tool description, lazy playbook, and only then the always-on prompt. See ${ADR}.`,
      }),
    ).toBeLessThanOrEqual(budget.alwaysOnPromptTokens);
  });

  it('local tool definitions are within budget', () => {
    expect(
      m.localToolDefinitionBytes,
      formatBudgetFailure({
        agent: budget.agent,
        what: 'the local tool-definition size',
        unit: 'bytes',
        measured: m.localToolDefinitionBytes,
        limit: budget.localToolDefinitionBytes,
        contributors: m.contributors.tools,
        command,
        advice:
          "Every pinned tool's description and schema is sent on every call. Unpin tools the agent does not call, " +
          `move rare procedures to a lazy playbook, and keep descriptions to how to call the tool. See ${ADR}.`,
      }),
    ).toBeLessThanOrEqual(budget.localToolDefinitionBytes);
  });

  it.runIf(budget.rosterTokens !== undefined)('specialist roster is within budget', () => {
    const rosterTokens = Math.ceil(m.rosterChars / CHARS_PER_TOKEN);
    expect(
      rosterTokens,
      formatBudgetFailure({
        agent: budget.agent,
        what: 'the specialist roster',
        unit: 'tokens',
        measured: rosterTokens,
        limit: budget.rosterTokens ?? 0,
        contributors: m.contributors.roster,
        command,
        advice:
          "Each line is an agent's delegate_when: say when to delegate there, and leave how the agent works " +
          `to its own prompt. See ${ADR}.`,
      }),
    ).toBeLessThanOrEqual(budget.rosterTokens ?? 0);
  });
});
