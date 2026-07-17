// Risk + action tiering for sent-mail task-completion (#1424).

import { readPlanBlock } from '../../src/db/plan-progress.js';
// NOTE: `Sensitivity` is defined in memory/types.ts, not re-exported from
// memory/sensitivity.ts — import each from its actual source (matches the
// pattern in src/security/export-controls.ts).
import { isConfidentialOrAbove } from '../../src/memory/sensitivity.js';
import type { Sensitivity } from '../../src/memory/types.js';
import type { MatchConfidence } from './sent-observe-match.js';

export type TaskRisk = 'low' | 'high';
export type CompletionAction = 'auto_complete' | 'confirm';

/** Priority at/above which a task is treated as high-risk (TaskRow priority default is 50). */
export const HIGH_PRIORITY_FLOOR = 70;

export interface RiskTaskLike {
  id: string;
  title: string;
  /** Task body. A generically titled task can hold confidential detail only here, so it
   *  must be classified too — otherwise the task reads as low-risk and auto-completes.
   *  Accepts null to match TaskRow.description straight from the repo. */
  description?: string | null;
  priority: number;
  tags: string[];
  progress: Record<string, unknown>;
  /** True when the task has child subtasks. */
  hasSubtasks?: boolean;
}

/**
 * Determine completion risk for a task. `classify` is the shared
 * SensitivityClassifier's classify function (or an equivalent test double) —
 * title + description + tags are concatenated and run through it in place of the
 * old hardcoded SENSITIVE_TAGS set / title regex (#1419).
 */
export function classifyTaskRisk(
  task: RiskTaskLike,
  classify: (text: string) => Sensitivity,
): TaskRisk {
  const plan = readPlanBlock(task.progress);
  if (plan) return 'high';
  if (task.hasSubtasks) return 'high';
  if (task.priority >= HIGH_PRIORITY_FLOOR) return 'high';
  // Include the description: confidential detail often lives only in the body of an
  // otherwise generic-looking task, and classifying title+tags alone would miss it.
  const sensitivity = classify(
    `${task.title}\n${task.description ?? ''}\n${task.tags.join(' ')}`,
  );
  if (isConfidentialOrAbove(sensitivity)) return 'high';
  return 'low';
}

/**
 * Decide auto-complete vs confirm from risk alone. Confidence no longer factors in here: the
 * caller only reaches this for HIGH-confidence candidates (low-confidence ones short-circuit
 * straight to confirm), so the whole decision collapses to "auto-complete iff low risk" (T3.1).
 */
export function decideCompletionAction(risk: TaskRisk): CompletionAction {
  return risk === 'low' ? 'auto_complete' : 'confirm';
}

export interface ParsedCompletionCandidate {
  taskId: string;
  messageId: string;
  confidence: MatchConfidence;
  reason: string;
  sentAt: string;
  subject: string;
  recipients: string[];
  taskTitle: string;
  status: string;
}

/** Parse pending-completions.md candidate blocks. */
export function parseCompletionCandidates(body: string): ParsedCompletionCandidate[] {
  const out: ParsedCompletionCandidate[] = [];
  const sections = body.split(/^## Candidate — task\s+/m).slice(1);
  for (const section of sections) {
    const taskId = (section.split('\n')[0] ?? '').trim();
    if (!taskId) continue;
    const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
    if (status !== 'pending') continue;
    if (/completion_asked:/i.test(section)) continue;
    const confidenceRaw = (section.match(/- confidence:\s*(\S+)/)?.[1] ?? 'low').trim();
    const confidence: MatchConfidence = confidenceRaw === 'high' ? 'high' : 'low';
    out.push({
      taskId,
      messageId: (section.match(/- message_id:\s*(\S+)/)?.[1] ?? '').trim(),
      confidence,
      reason: (section.match(/- reason:\s*(.+)/)?.[1] ?? '').trim(),
      sentAt: (section.match(/- sent_at:\s*(.+)/)?.[1] ?? '').trim(),
      subject: (section.match(/- subject:\s*(.+)/)?.[1] ?? '').trim(),
      recipients: ((section.match(/- recipients:\s*(.+)/)?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)),
      taskTitle: (section.match(/- task_title:\s*(.+)/)?.[1] ?? '').trim(),
      status,
    });
  }
  return out;
}

export function formatUndoNote(params: {
  taskId: string;
  taskTitle: string;
  recipient: string;
  sentAt: string;
}): string {
  const when = params.sentAt ? ` (${params.sentAt.slice(0, 10)})` : '';
  return [
    '',
    `## Undo — task ${params.taskId}`,
    '',
    `- status: undo_available`,
    `- task_title: ${params.taskTitle}`,
    `- note: Marked *${params.taskTitle}* done — you emailed ${params.recipient}${when}. Undo?`,
    '',
    '---',
    '',
  ].join('\n');
}

export function formatConfirmNote(params: {
  taskId: string;
  taskTitle: string;
  recipient: string;
  sentAt: string;
  confidence: MatchConfidence;
  // Undefined for low-confidence candidates, whose risk is never classified (T3.1).
  risk?: TaskRisk;
}): string {
  return [
    '',
    `## Confirm — task ${params.taskId}`,
    '',
    `- status: pending_confirm`,
    `- risk: ${params.risk ?? 'unassessed'}`,
    `- confidence: ${params.confidence}`,
    `- task_title: ${params.taskTitle}`,
    `- note: Did emailing ${params.recipient} complete *${params.taskTitle}*?`,
    `- sent_at: ${params.sentAt}`,
    `- completion_asked: {${new Date().toISOString().slice(0, 10)}}`,
    '',
    '---',
    '',
  ].join('\n');
}
