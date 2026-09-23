/**
 * Parse `scheduler:<jobUuid>:<runId>` conversation IDs used for runnable scheduled
 * job turns. The middle segment must be UUID-shaped — 2-part IDs
 * (`scheduler:<jobId>`) are coordinator notification events (drift, suspension),
 * not runnable tasks, and non-UUID middles are rejected.
 *
 * Shared by scheduler-report (derive job_id) and bullpen (detect job-UUID-as-thread_id).
 * See #1828.
 */

import { UUID_PATTERN } from '../util/uuid.js';

// Composes the shared pattern rather than matching a bare id, so this file imports
// UUID_PATTERN instead of isUuid() (as src/contacts/dedup-pair-key.ts does).
//
// No /i flag: it would case-fold the `scheduler:` literal too, so `SCHEDULER:<id>`
// would parse where the original case-sensitive regex rejected it. UUID_PATTERN
// spells both hex cases itself, so uppercase hex in the id still matches.
//
// This used to require RFC v1-v5 with a [89ab] variant nibble. It was loosened to
// the shared shape-only form (#1879) because the strictness bought nothing and the
// failure mode was silent: a non-RFC job id makes this return undefined, which every
// caller reads as "not a scheduled run" rather than "malformed id" — scheduler-report
// would stop deriving job_id and bullpen would stop detecting job-UUID-as-thread_id,
// with no error logged anywhere. The middle segment is always gen_random_uuid()
// output today; loosening keeps that true if job ids ever become v7.
const SCHEDULER_RUN_CONVERSATION = new RegExp(`^scheduler:(${UUID_PATTERN}):[^:]+$`);

/** Extract the job UUID from a scheduled-run conversation id, or undefined. */
export function parseSchedulerRunJobId(conversationId: string | undefined): string | undefined {
  if (!conversationId) return undefined;
  return SCHEDULER_RUN_CONVERSATION.exec(conversationId)?.[1];
}
