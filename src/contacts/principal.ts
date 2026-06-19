// src/contacts/principal.ts
//
// Helper functions for principal (CEO) identity checks.
// Centralizes all principal-related queries so authorization logic
// lives in one place without over-abstracting into a service class.
//
// See docs/wip/2026-05-10-principal-identity-design.md

import type { ContactTier, TaskOriginator } from './types.js';

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
 * Returns null (fail-open) when:
 *  - There is no task metadata or no originator
 *  - The originator is system- or agent-originated (no external contact involved)
 *  - The originator predates #950 and carries no tier field
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
