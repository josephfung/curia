// Risk + action tiering for sent-mail task-completion (#1424).

import { readPlanBlock } from '../../src/db/plan-progress.js';

export type TaskRisk = 'low' | 'high';
export type MatchConfidence = 'high' | 'low';
export type CompletionAction = 'auto_complete' | 'confirm';

const SENSITIVE_TAGS = new Set([
  'board',
  'legal',
  'investor',
  'investors',
  'spouse',
  'agm',
  'confidential',
]);

/** High priority threshold — matches common "high" band usage (lower number = higher priority in some systems; here higher number = higher priority per TaskRow default 50). */
export const HIGH_PRIORITY_FLOOR = 70;

export interface RiskTaskLike {
  id: string;
  title: string;
  priority: number;
  tags: string[];
  progress: Record<string, unknown>;
  /** True when the task has child subtasks. */
  hasSubtasks?: boolean;
}

export function classifyTaskRisk(task: RiskTaskLike): TaskRisk {
  const plan = readPlanBlock(task.progress);
  if (plan) return 'high';
  if (task.hasSubtasks) return 'high';
  if (task.priority >= HIGH_PRIORITY_FLOOR) return 'high';
  for (const tag of task.tags) {
    if (SENSITIVE_TAGS.has(tag.toLowerCase())) return 'high';
  }
  // Title heuristic for classic high-risk examples ("Plan AGM"). Note: bare "plan"
  // is intentionally excluded — it swept up "Plan lunch" / "Plan the offsite"; "agm"
  // already captures the AGM case.
  if (/\b(agm|board|legal|investors?)\b/i.test(task.title)) return 'high';
  return 'low';
}

export function decideCompletionAction(
  risk: TaskRisk,
  confidence: MatchConfidence,
): CompletionAction {
  if (risk === 'low' && confidence === 'high') return 'auto_complete';
  return 'confirm';
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
  risk: TaskRisk;
}): string {
  return [
    '',
    `## Confirm — task ${params.taskId}`,
    '',
    `- status: pending_confirm`,
    `- risk: ${params.risk}`,
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
