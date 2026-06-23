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
 * Used by the execution layer's elevated skill gate and CEO-authorized skill handlers.
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
