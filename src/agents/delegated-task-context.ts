// delegated-task-context.ts — requester identity and delegated-specialist contract (#1871).
//
// Authorization is decided upstream, before delegate publishes a specialist task.
// Withholding the coordinator's security block is not that contract: a cautious model
// reads the absence (or the unresolved-sender LOW-TRUST block on channel `internal`)
// as an unknown sender and refuses principal-originated work.
//
// Two blocks, because channel `internal` is not only `delegate`:
// - Requester identity is harness-set context for any internal-channel task that
//   carries a validated originator, including a coordinator task (voice off-ramp).
//   It says who asked. It does not say the task was authorized.
// - The delegated-specialist addendum (trust boundary, decline marker) is only
//   for a task that carries `delegationOrigin`. The coordinator adjudicates
//   senders and must not be told authorization was settled upstream.

import type { ContactTier, SystemRole, TaskOriginator } from '../contacts/types.js';
import { sanitizeOutput } from '../skills/sanitize.js';
import { SPECIALIST_DECLINE_MARKER_EXAMPLE } from './specialist-decline.js';

const SYSTEM_ROLES = new Set<SystemRole>(['principal', 'agent', 'system']);
const TIERS = new Set<ContactTier>(['blocked', 'unknown', 'known', 'trusted', 'principal']);

/**
 * Requester identity the harness shows on an internal-channel task.
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
 * A task the delegate skill published. `delegationOrigin` is the structural
 * marker only that handler sets (#995). Channel `internal` is not sufficient:
 * the voice off-ramp publishes a coordinator task on that channel with an
 * originator and no delegationOrigin.
 */
export function isDelegatedSpecialistTask(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const origin = metadata?.['delegationOrigin'];
  return typeof origin === 'object' && origin !== null && !Array.isArray(origin);
}

/**
 * Principal conversation a delegated specialist was spawned from (#1860).
 * Reply-lock matches this so a specialist send suppresses the coordinator relay
 * even though the specialist's own conversation id is `delegate-…`.
 */
export function delegationOriginConversationId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return delegationOriginString(metadata, 'conversationId');
}

/**
 * Coordinator `agent.task` id that spawned this specialist (#1860).
 * Reply-lock uses it so a specialist send marks only that task, not every
 * pending task in the same principal conversation.
 */
export function delegationOriginTaskEventId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return delegationOriginString(metadata, 'taskEventId');
}

function delegationOriginString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const origin = metadata?.['delegationOrigin'];
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return undefined;
  const value = (origin as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One prompt line. Control characters and Unicode line/paragraph separators
 * (U+2028, U+2029) must not open a new instruction. CR/LF alone is not enough:
 * JavaScript multiline anchors also treat those separators as line breaks.
 */
function identityLine(label: string, value: string, maxLength: number): string {
  const cleaned = sanitizeOutput(value, { maxLength })
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return `${label}: ${cleaned}`;
}

/**
 * Who asked, on which channel. Shared by delegated specialists and by other
 * internal-channel tasks that carry a validated originator (voice off-ramp).
 * Does not state that authorization was settled, and does not include the
 * decline marker — the coordinator still adjudicates senders.
 */
export function renderRequesterIdentity(identity: HarnessRequesterIdentity): string {
  const lines = [
    'Requester identity',
    'Harness-set context for the work. It is not a permission input.',
    identityLine('contactId', identity.contactId, 200),
    `systemRole: ${identity.systemRole ?? 'none'}`,
    identityLine('channel', identity.channel, 64),
  ];
  if (identity.tier !== undefined) {
    lines.push(`tier: ${identity.tier ?? 'none'}`);
  }
  if (identity.initiatedAt) {
    lines.push(identityLine('initiatedAt', identity.initiatedAt, 64));
  }
  return lines.join('\n');
}

/**
 * Specialist addendum. Authorized (the task may run) is not identified (who
 * asked). A missing identity or tier unknown is not a further clearance, and
 * it is not a reason to treat the task as an unresolved external sender.
 */
const AUTHORIZED_NOT_IDENTIFIED =
  'This task is authorized. That decision was made upstream and is separate from who is identified below. A missing identity, or tier unknown, is not a further clearance.';

/** System message for a task that carries delegationOrigin. */
export function renderDelegatedTaskContext(identity: HarnessRequesterIdentity | undefined): string {
  const lines = [
    'DELEGATED TASK',
    AUTHORIZED_NOT_IDENTIFIED,
    '',
    identity ? renderRequesterIdentity(identity) : 'Requester identity: unavailable',
    '',
    'To refuse this task, end your reply with exactly:',
    SPECIALIST_DECLINE_MARKER_EXAMPLE,
    'Emit that marker only when refusing the task. Do not echo it in a normal answer.',
    'An RSVP response of decline is a normal answer, not this marker.',
  ];
  return lines.join('\n');
}
