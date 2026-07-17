// Risk + action tiering for sent-mail task-completion (#1424).

import { readPlanBlock } from '../../src/db/plan-progress.js';
// NOTE: `Sensitivity` is defined in memory/types.ts, not re-exported from
// memory/sensitivity.ts — import each from its actual source (matches the
// pattern in src/security/export-controls.ts).
import { isConfidentialOrAbove } from '../../src/memory/sensitivity.js';
import type { Sensitivity } from '../../src/memory/types.js';

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
