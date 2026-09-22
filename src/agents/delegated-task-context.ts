// delegated-task-context.ts — trust-elevated contract for a delegated specialist (#1871).
//
// Authorization is decided upstream, before delegate publishes the specialist task.
// Withholding the coordinator's security block is not that contract: a cautious model
// reads the absence (or the unresolved-sender LOW-TRUST block on channel `internal`)
// as an unknown sender and refuses principal-originated work. This module renders the
// contract from the validated originator. The identity is context for the work, not
// a permission input.

import type { ContactTier, SystemRole, TaskOriginator } from '../contacts/types.js';
import { sanitizeOutput } from '../skills/sanitize.js';
import { SPECIALIST_DECLINE_MARKER_EXAMPLE } from './specialist-decline.js';

const SYSTEM_ROLES = new Set<SystemRole>(['principal', 'agent', 'system']);
const TIERS = new Set<ContactTier>(['blocked', 'unknown', 'known', 'trusted', 'principal']);

/**
 * Requester identity the harness shows a delegated specialist.
 * Projected from a validated TaskOriginator — never from the raw metadata bag.
 */
export interface HarnessRequesterIdentity {
  contactId: string;
  channel: string;
  systemRole: SystemRole | null;
  /** Absent when the originator predates tier stamping. Null when explicitly unset. */
  tier?: ContactTier | null;
  initiatedAt: string | null;
}

/**
 * The same shape check the runtime uses before synthesizing ctx.caller (#710).
 * contactId and channel must be strings; other fields are projected separately
 * before they reach a prompt.
 */
export function parseTaskOriginator(raw: unknown): TaskOriginator | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record['contactId'] !== 'string' || typeof record['channel'] !== 'string') {
    return undefined;
  }
  // Cast through unknown: the two required strings are checked above. Remaining
  // fields stay on the object for harnessRequesterIdentity to allowlist.
  return raw as unknown as TaskOriginator;
}

/** Allowlist originator fields before they are interpolated into a system message. */
export function harnessRequesterIdentity(originator: TaskOriginator): HarnessRequesterIdentity {
  const systemRole = SYSTEM_ROLES.has(originator.systemRole as SystemRole)
    ? originator.systemRole
    : null;
  const identity: HarnessRequesterIdentity = {
    contactId: originator.contactId,
    channel: originator.channel,
    systemRole,
    initiatedAt: typeof originator.initiatedAt === 'string' ? originator.initiatedAt : null,
  };
  if (originator.tier === null) {
    identity.tier = null;
  } else if (originator.tier !== undefined && TIERS.has(originator.tier)) {
    identity.tier = originator.tier;
  }
  return identity;
}

/**
 * A task the delegate skill published. `channelId: internal` is that path today;
 * `delegationOrigin` is the structural marker the handler also sets (#995).
 */
export function isDelegatedSpecialistTask(
  channelId: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (channelId === 'internal') return true;
  const origin = metadata?.['delegationOrigin'];
  return typeof origin === 'object' && origin !== null && !Array.isArray(origin);
}

/** One prompt line. Newlines in an originator field must not open a new instruction. */
function identityLine(label: string, value: string, maxLength: number): string {
  const cleaned = sanitizeOutput(value, { maxLength }).replace(/[\r\n]+/g, ' ').trim();
  return `${label}: ${cleaned}`;
}

/** System message that replaces the unresolved-sender vacuum on a delegated task. */
export function renderDelegatedTaskContext(identity: HarnessRequesterIdentity | undefined): string {
  const lines = [
    'DELEGATED TASK',
    'Authorization for this task was decided upstream. You are in a trust-elevated context.',
    'Requester identity is harness-set context for the work. It is not a permission input.',
    '',
  ];
  if (!identity) {
    lines.push('Requester identity: unavailable');
  } else {
    lines.push(identityLine('contactId', identity.contactId, 200));
    lines.push(`systemRole: ${identity.systemRole ?? 'none'}`);
    lines.push(identityLine('channel', identity.channel, 64));
    if (identity.tier !== undefined) {
      lines.push(`tier: ${identity.tier ?? 'none'}`);
    }
    if (identity.initiatedAt) {
      lines.push(identityLine('initiatedAt', identity.initiatedAt, 64));
    }
  }
  lines.push(
    '',
    'To refuse this task, end your reply with exactly:',
    SPECIALIST_DECLINE_MARKER_EXAMPLE,
    'Emit that marker only when refusing the task. Do not echo it in a normal answer.',
    'An RSVP response of decline is a normal answer, not this marker.',
  );
  return lines.join('\n');
}
