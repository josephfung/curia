// tests/scenarios/grading.ts — human grades for choosing a judge (#2556 §4).
//
// The finesse judge is chosen by how well it agrees with people, not with another judge.
// This module turns a scenario run into a grading sheet (a CSV a person fills in, blind to
// the judge's rating), reads the grades back, and measures a judge's agreement with them.
// grading-cli.ts drives it; nothing here calls a model.
import type { BehaviorRating, ExpectedBehavior, RunRating, ScenarioCase, ScenarioRun, SuiteResult } from './types.js';
import { JUDGE_ERROR_PREFIX } from './gate.js';
import { seededShuffle } from './blind-id.js';

/** One rating a person is asked to give. */
export interface GradingItem {
  /** `<case>#<run, 1-based>#<behavior id>`: how a grade finds its rating again. */
  id: string;
  caseName: string;
  /** The casebook task, `51` for `finesse 51c …`; `''` when the name has none. */
  task: string;
  runIndex: number;
  behaviorId: string;
  /** Who the message is for, from the case's contrast block; `''` when it has none. */
  recipient: string;
  /** The case description: the situation and the right call. */
  situation: string;
  /** The behavior to grade, as the judge reads it. */
  whatToGrade: string;
  /** Every message Curia wrote in the run, labelled with where it went. */
  messages: string;
}

const SEND_TEXT: Readonly<Record<string, { arg: string; label: (input: Record<string, unknown>, who: (v: unknown) => string) => string }>> = {
  'email-send': { arg: 'body', label: (i, who) => `Email to ${who(i['to'])}${i['cc'] ? ` (cc ${who(i['cc'])})` : ''}${typeof i['subject'] === 'string' ? `, subject "${i['subject']}"` : ''}` },
  'email-reply': { arg: 'body', label: (i, who) => `Email reply on the sender's thread${i['cc'] ? ` (cc ${who(i['cc'])})` : ''}` },
  'sms-send': { arg: 'message', label: (i, who) => `Text to ${who(i['recipient'])}` },
  'signal-send': { arg: 'message', label: (i, who) => `Signal message to ${who(i['recipient'])}` },
  'ceo-inbox-draft-compose': { arg: 'body', label: (i, who) => `Draft in Avery's mailbox, to ${who(i['to'] ?? i['to_addresses'])}` },
  'ceo-inbox-draft-reply': { arg: 'body', label: () => `Draft reply in Avery's mailbox` },
  'ceo-inbox-draft-edit': { arg: 'body', label: () => `Edited draft in Avery's mailbox` },
};

/** Who a recipient value names: a seeded contact's name, Avery, or the value as written. */
function whoFor(scenario: ScenarioCase, run: ScenarioRun): (v: unknown) => string {
  const byId = new Map<string, string>();
  for (const c of scenario.seed.contacts) {
    const id = run.refs[`contact:${c.key}`];
    if (id) byId.set(id, c.displayName);
  }
  const one = (s: string): string => (s.trim() === 'principal' ? 'Avery' : byId.get(s.trim()) ?? s.trim());
  return v => (Array.isArray(v) ? v.map(x => one(String(x))).join(', ') : typeof v === 'string' ? v.split(',').map(one).join(', ') : String(v));
}

/** Every message Curia wrote in a run, oldest first, each under a label saying where it went. */
export function runMessages(scenario: ScenarioCase, run: ScenarioRun): string {
  const who = whoFor(scenario, run);
  const sender = scenario.inbound.from === 'principal' ? 'Avery' : scenario.seed.contacts.find(c => c.key === scenario.inbound.from)?.displayName ?? scenario.inbound.from;
  // What started the turn, so a grader reads the messages in context.
  const parts: string[] = [`=== What came in (from ${sender})\n${run.inboundContent.trim()}`];
  for (const call of run.toolCalls) {
    const send = SEND_TEXT[call.name];
    const text = send ? call.input[send.arg] : undefined;
    if (!send || typeof text !== 'string' || text.trim() === '') continue;
    const refused = call.result && !call.result.success ? ' [not sent: the tool refused it]' : '';
    parts.push(`--- ${send.label(call.input, who)}${refused}\n${text.trim()}`);
  }
  const silent = (r: string | null | undefined): boolean => r === null || r === undefined || r.trim() === '' || r.trim() === 'NO_REPLY';
  if (!silent(run.reply)) parts.push(`--- Reply to ${sender}\n${run.reply!.trim()}`);
  if (run.principalNote) parts.push(`--- Note for Avery\n${run.principalNote.trim()}`);
  if (scenario.inbound.then) {
    parts.push(`--- Avery then wrote\n${scenario.inbound.then.content.trim()}`);
    if (!silent(run.then?.reply)) parts.push(`--- Reply to Avery\n${run.then!.reply!.trim()}`);
  }
  // Nothing after the inbound: Curia wrote nothing. (With a then-turn, Avery's own words follow,
  // and the labels make plain that none of the rest is Curia's.)
  if (parts.length === 1) parts.push('(Curia wrote nothing in this run)');
  return parts.join('\n\n');
}

/**
 * Pick `n` judged voice ratings to grade, spread across tasks and recipients: one per case
 * in turn, tasks interleaved, so a sample of 25 from 45 cases does not land on one task.
 * Ratings the judge failed to give, and runs that errored, are left out (nothing to compare).
 * Deterministic for a seed, so a sheet can be rebuilt.
 */
export function sampleGradingItems(
  suite: SuiteResult,
  cases: readonly ScenarioCase[],
  options: { n: number; seed: string; layer?: 'voice' | 'decision' | 'all' },
): GradingItem[] {
  const layer = options.layer ?? 'voice';
  const byName = new Map(cases.map(c => [c.name, c]));
  // Candidates per case, in a seeded order.
  const perCase = new Map<string, GradingItem[]>();
  for (const result of suite.cases) {
    const scenario = byName.get(result.name);
    if (!scenario) continue;
    const items: GradingItem[] = [];
    for (const b of result.behaviors) {
      if (b.behavior.check) continue;
      if (layer !== 'all' && b.behavior.layer !== layer) continue;
      b.ratings.forEach((rating, i) => {
        const run = result.runs[i];
        if (!run || run.error || rating.justification.startsWith(JUDGE_ERROR_PREFIX)) return;
        items.push(itemFor(scenario, run, i, b.behavior));
      });
    }
    if (items.length > 0) perCase.set(result.name, seededShuffle(items, `${options.seed}:${result.name}`));
  }
  // Round-robin: tasks in a seeded order, a case per task in turn, an item per case in turn.
  const tasks = new Map<string, string[]>();
  for (const name of perCase.keys()) {
    const task = taskOf(name);
    tasks.set(task, [...(tasks.get(task) ?? []), name]);
  }
  const taskOrder = seededShuffle([...tasks.keys()].sort(), `${options.seed}:tasks`);
  for (const t of taskOrder) tasks.set(t, seededShuffle(tasks.get(t)!, `${options.seed}:${t}`));
  const picked: GradingItem[] = [];
  const cursor = new Map<string, number>();
  let progressed = true;
  while (picked.length < options.n && progressed) {
    progressed = false;
    for (const t of taskOrder) {
      if (picked.length >= options.n) break;
      const names = tasks.get(t)!;
      const k = cursor.get(t) ?? 0;
      // The next case in this task that still has an item.
      for (let step = 0; step < names.length; step++) {
        const name = names[(k + step) % names.length]!;
        const item = perCase.get(name)!.shift();
        if (item) {
          picked.push(item);
          cursor.set(t, k + step + 1);
          progressed = true;
          break;
        }
      }
    }
  }
  return picked;
}

function taskOf(caseName: string): string {
  return /\b(5\d)[a-z]\b/.exec(caseName)?.[1] ?? '';
}

function itemFor(scenario: ScenarioCase, run: ScenarioRun, runIndex: number, behavior: ExpectedBehavior): GradingItem {
  return {
    id: `${scenario.name}#${runIndex + 1}#${behavior.id}`,
    caseName: scenario.name,
    task: taskOf(scenario.name),
    runIndex,
    behaviorId: behavior.id,
    recipient: scenario.contrast?.recipient ?? '',
    situation: scenario.description.trim(),
    whatToGrade: behavior.description.trim(),
    messages: runMessages(scenario, run),
  };
}

// ── The sheet ────────────────────────────────────────────────────────────

export const SHEET_COLUMNS = ['item_id', 'task', 'recipient', 'situation', 'what_to_grade', 'messages', 'grade', 'notes'] as const;

/** RFC 4180 CSV: every field quoted, quotes doubled, CRLF between records. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(r => r.map(f => `"${f.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
}

/** Parse RFC 4180 CSV (quoted fields may hold commas, quotes and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('unterminated quoted field');
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

/** The sheet a grader fills in: one row per item, `grade` and `notes` blank. */
export function gradingSheet(items: readonly GradingItem[]): string {
  return toCsv([
    [...SHEET_COLUMNS],
    ...items.map(i => [i.id, i.task, i.recipient, i.situation, i.whatToGrade, i.messages, '', '']),
  ]);
}

export interface HumanGrade {
  rating: BehaviorRating;
  notes: string;
}

const GRADES: Readonly<Record<string, BehaviorRating>> = { PASS: 'PASS', PARTIAL: 'PARTIAL', MISS: 'MISS' };

/**
 * A filled sheet's grades by item id. A blank grade is skipped (not graded yet); anything
 * else that is not PASS / PARTIAL / MISS is an error naming the row, never a silent skip.
 */
export function parseGrades(csv: string): Map<string, HumanGrade> {
  const rows = parseCsv(csv);
  const header = rows[0]?.map(h => h.trim().toLowerCase()) ?? [];
  const idCol = header.indexOf('item_id');
  const gradeCol = header.indexOf('grade');
  const notesCol = header.indexOf('notes');
  if (idCol === -1 || gradeCol === -1) throw new Error(`the sheet needs item_id and grade columns (found: ${header.join(', ')})`);
  const grades = new Map<string, HumanGrade>();
  rows.slice(1).forEach((r, i) => {
    const id = r[idCol]?.trim() ?? '';
    const raw = (r[gradeCol] ?? '').trim().toUpperCase();
    if (id === '' || raw === '') return;
    const rating = GRADES[raw];
    if (!rating) throw new Error(`row ${i + 2} (${id}): grade '${r[gradeCol]}' is not PASS, PARTIAL or MISS`);
    if (grades.has(id)) throw new Error(`row ${i + 2}: ${id} is graded twice`);
    grades.set(id, { rating, notes: notesCol === -1 ? '' : (r[notesCol] ?? '').trim() });
  });
  return grades;
}

// ── Agreement ────────────────────────────────────────────────────────────

export interface Agreement {
  judge: string;
  /** Items both the person and the judge rated. */
  n: number;
  /** Same rating, PASS / PARTIAL / MISS. */
  exact: number;
  /** Same full-PASS-or-not call: what the critical gate counts. */
  passFail: number;
  /** Cohen's kappa over the three ratings: agreement beyond chance (1 perfect, 0 chance). */
  kappa: number | null;
  /** Items the judge failed to rate; left out of every figure above. */
  judgeErrors: number;
  disagreements: Array<{ id: string; human: BehaviorRating; judge: BehaviorRating; justification: string }>;
}

const LEVELS: readonly BehaviorRating[] = ['PASS', 'PARTIAL', 'MISS'];

/** How far `judged` agrees with `human`, over the items both rated. */
export function agreementWith(judge: string, human: ReadonlyMap<string, HumanGrade>, judged: ReadonlyMap<string, RunRating>): Agreement {
  let n = 0, exact = 0, passFail = 0, judgeErrors = 0;
  const disagreements: Agreement['disagreements'] = [];
  const counts = new Map<string, number>();
  for (const [id, h] of human) {
    const j = judged.get(id);
    if (!j) continue;
    if (j.justification.startsWith(JUDGE_ERROR_PREFIX)) { judgeErrors++; continue; }
    n++;
    if (j.rating === h.rating) exact++;
    else disagreements.push({ id, human: h.rating, judge: j.rating, justification: j.justification });
    if ((j.rating === 'PASS') === (h.rating === 'PASS')) passFail++;
    counts.set(`${h.rating}|${j.rating}`, (counts.get(`${h.rating}|${j.rating}`) ?? 0) + 1);
  }
  let kappa: number | null = null;
  if (n > 0) {
    const po = exact / n;
    const pe = LEVELS.reduce((sum, a) => {
      const human = LEVELS.reduce((s, b) => s + (counts.get(`${a}|${b}`) ?? 0), 0) / n;
      const judgeMarginal = LEVELS.reduce((s, b) => s + (counts.get(`${b}|${a}`) ?? 0), 0) / n;
      return sum + human * judgeMarginal;
    }, 0);
    kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  }
  return { judge, n, exact, passFail, kappa, judgeErrors, disagreements };
}

/** "openai/gpt-4o: 18/24 exact (75%), 21/24 pass/fail (88%), κ 0.61" */
export function formatAgreementLine(a: Agreement): string {
  const pct = (x: number): string => (a.n === 0 ? 'n/a' : `${Math.round((x / a.n) * 100)}%`);
  return `${a.judge}: ${a.exact}/${a.n} exact (${pct(a.exact)}), ${a.passFail}/${a.n} pass/fail (${pct(a.passFail)}), κ ${a.kappa === null ? 'n/a' : a.kappa.toFixed(2)}` +
    `${a.judgeErrors > 0 ? `; ${a.judgeErrors} judge error(s) left out` : ''}`;
}
