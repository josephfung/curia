// src/contacts/principal.ts
//
// Helper functions for principal (CEO) identity checks.
// Centralizes all principal-related queries so authorization logic
// lives in one place without over-abstracting into a service class.
//
// See docs/wip/2026-05-10-principal-identity-design.md

import type { TaskOriginator } from './types.js';

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
  };
}
