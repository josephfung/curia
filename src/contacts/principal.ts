// src/contacts/principal.ts
//
// Helper functions for principal (CEO) identity checks.
// Centralizes all principal-related queries so authorization logic
// lives in one place without over-abstracting into a service class.
//
// See docs/wip/2026-05-10-principal-identity-design.md

import type { ContactTier, SystemRole, TaskOriginator } from './types.js';

// Standing rank for lineage capping — higher = more authority. Used ONLY to ensure a child
// task is never stamped with lineage above its parent's (the inheritance ceiling, #1125). This
// is a coarse audit-time cap, distinct from the runtime bypass ladder in effective-standing.ts.
const STANDING_RANK: Record<NonNullable<SystemRole>, number> = { principal: 3, system: 2, agent: 1 };

function originatorRank(o: TaskOriginator | null | undefined): number {
  if (!o || o.systemRole == null) return 0;
  return STANDING_RANK[o.systemRole] ?? 0;
}

/**
 * Cap a new task's lineage to its parent's. Returns whichever of (child, parent) has the LOWER
 * standing rank, so a child task can never carry standing above its parent — the design's
 * "child tasks copy the parent's lineage, never upgraded above the parent" (#1125). null-safe:
 * a null/absent originator on either side floors the result to that null (no standing). Equal
 * rank prefers the child so its own audit fields (contactId/channel) are preserved.
 */
export function capOriginatorToParent(
  child: TaskOriginator | null | undefined,
  parent: TaskOriginator | null | undefined,
): TaskOriginator | null {
  return originatorRank(child) <= originatorRank(parent) ? (child ?? null) : (parent ?? null);
}

/**
 * Check whether a task was originated by the principal (the human Curia serves).
 * Used by CEO-authorized skill handlers and the autonomy gate's principal-bypass.
 *
 * NOTE: this checks LINEAGE (who started the task chain), which is satisfied by a woken
 * principal-lineage task too. It is the correct notion for the autonomy principal-bypass
 * (acting *within* CEO-authorized work, inheritable at high trust via the ladder), but it is
 * NOT sufficient for the `elevated` gate — that requires a LIVE principal turn. Use
 * isLivePrincipalTurn() for "the CEO is exercising authority right now". See ADR-017 and
 * docs/wip/2026-06-22-woken-task-authorization-design.md §4.
 *
 * @param metadata  Task metadata (from ctx.taskMetadata or agent.task payload)
 */
export function isPrincipalOriginated(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const originator = metadata.originator as TaskOriginator | undefined;
  return originator?.systemRole === 'principal';
}

/**
 * True when THIS execution context is a live principal turn — the current turn originated from a
 * fresh principal inbound (directly, or via a SYNCHRONOUS delegation that forwarded the signal).
 * This is the sole satisfier of the `elevated` skill gate (#1126): system, agent, scheduled, and
 * woken/inherited principal-*lineage* contexts all return false, because lineage is not a live
 * turn. This closes the self-approval hole with zero per-skill exceptions (a woken principal-
 * lineage task can never approve its own pending action).
 *
 * `liveTurn` is a DISTINCT field (agent.task.payload.liveTurn → InvokeOptions.liveTurn), never a
 * key in the task-metadata bag — so a skill that forwards `metadata` to a persisted row (jobs,
 * tasks, bullpen) can never sweep it into wakeable state. The dispatcher stamps it only on a
 * fresh principal inbound; `delegate` forwards it across a synchronous delegation; nothing else
 * sets it, so wakes/scheduler fires/persisted tasks structurally lack it.
 *
 * Defence in depth: requires BOTH the live-turn flag AND principal lineage on the (effective)
 * metadata. The flag is only ever set alongside a principal originator, but pairing the checks
 * means a stray flag without principal standing — or one on metadata whose effective originator
 * the ladder has downgraded — still fails closed.
 *
 * @param liveTurn   The distinct live-turn flag from InvokeOptions (agent.task.payload.liveTurn)
 * @param metadata   Task metadata (the EFFECTIVE standing the execution layer feeds the gate)
 */
export function isLivePrincipalTurn(
  liveTurn: boolean | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return liveTurn === true && isPrincipalOriginated(metadata);
}

/**
 * Check whether a task was originated by the agent (Curia itself).
 * Used when the coordinator needs to know "did I start this myself?"
 *
 * @param metadata  Task metadata (from ctx.taskMetadata or agent.task payload)
 */
export function isAgentOriginated(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const originator = metadata.originator as TaskOriginator | undefined;
  return originator?.systemRole === 'agent';
}

/**
 * Check whether a task was originated by the system (operator-configured,
 * platform-executed — e.g. declarative YAML jobs loaded at startup).
 *
 * @param metadata  Task metadata (from ctx.taskMetadata or agent.task payload)
 */
export function isSystemOriginated(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  // Runtime-validated in callers; cast through unknown per repo policy.
  const originator = metadata.originator as unknown as TaskOriginator | undefined;
  return originator?.systemRole === 'system';
}

/**
 * Create a TaskOriginator representing operator-configured, platform-executed work.
 * Used by upsertDeclarativeJob() to stamp YAML-defined scheduled jobs.
 * A factory (not a constant) so `initiatedAt` reflects the actual upsert time.
 */
export function makeSystemOriginator(): TaskOriginator {
  return {
    contactId: 'system',
    systemRole: 'system',
    channel: 'declarative',
    initiatedAt: new Date().toISOString(),
    tier: null,
  };
}

/**
 * Create a TaskOriginator representing principal-initiated work from a principal-only
 * surface (the console / dashboard) — issue #1127. The console's bootstrap secret is
 * CEO-only, so any authenticated console request is unambiguously the principal; the
 * durable `tasks` / `scheduled_jobs` rows it creates must carry principal **lineage** so
 * they don't default to the conservative agent / no-bypass standing when later woken.
 *
 * This stamps lineage only. It deliberately does NOT confer a live principal turn — the
 * `liveTurn` signal is computed by the dispatcher on the live inbound chat path and is
 * never persisted on a wakeable row (see the woken-task-authorization design note §4).
 *
 * A factory (not a constant) so `initiatedAt` reflects the actual creation time. Tier is
 * always 'principal' — the platform guarantees the principal contact's tier via
 * repairPrincipalMetadata() at startup.
 *
 * @param contactId  The principal contact's id (resolve via findContactBySystemRole('principal')).
 * @param channel    Where the work was initiated from (e.g. 'console').
 */
export function makePrincipalOriginator(contactId: string, channel: string): TaskOriginator {
  return {
    contactId,
    systemRole: 'principal',
    channel,
    initiatedAt: new Date().toISOString(),
    tier: 'principal',
  };
}

/**
 * Extract the initiating contact's tier for the execution-layer action gate (issue #950).
 *
 * Returns null when:
 *  - There is no task metadata or no originator — structurally not externally initiated → skip
 *  - The originator is system- or agent-originated (no external contact involved) → skip
 *  - The originator is external but carries no tier field (pre-#950 in flight or a stamping
 *    defect). This null must NOT be read as "skip": the caller pairs it with
 *    isExternalOriginatorMissingTier() to fail closed instead (#1059).
 *
 * Returns the tier for external-contact-originated tasks. The caller should apply
 * applyActionPolicy() from escalation-policy.ts using the returned tier.
 */
export function getInitiatingTier(
  metadata: Record<string, unknown> | undefined,
): ContactTier | null {
  if (!metadata) return null;
  // Runtime-validated in callers; cast through unknown per repo policy.
  const originator = metadata.originator as unknown as TaskOriginator | undefined;
  if (!originator) return null;
  // System and agent tasks are not externally initiated — skip the tier gate.
  if (originator.systemRole === 'system' || originator.systemRole === 'agent') return null;
  return originator.tier ?? null;
}

/**
 * True when a task was initiated by an EXTERNAL contact (not system- or agent-originated)
 * that carries no resolved tier — the Gate C fail-closed trigger tracked in #1059.
 *
 * getInitiatingTier() collapses three cases into null (system, agent, and external-with-no-tier);
 * this predicate isolates the third so the execution layer can fail it closed (escalate) rather
 * than skip the gate. A totally absent originator returns false here — that case is structurally
 * internal (e.g. the checkpoint processor) and is intentionally skipped, not escalated.
 */
export function isExternalOriginatorMissingTier(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  // Runtime-validated in callers; cast through unknown per repo policy.
  const originator = metadata.originator as unknown as TaskOriginator | undefined;
  if (!originator) return false;
  // System and agent tasks are not externally initiated — not a fail-open concern.
  if (originator.systemRole === 'system' || originator.systemRole === 'agent') return false;
  return originator.tier == null;
}
