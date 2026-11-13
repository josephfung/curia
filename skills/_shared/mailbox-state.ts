// Per-mailbox sent-observe and learning state keys (#2475, D8, R60).
//
// Every key that holds grant-scoped ids or a mailbox's own watermark lives under
// `sent_observe.<mailbox>.<name>` in the `ceo_inbox` config namespace. Keys that are not
// grant-scoped (`sent_observe.completion_digest`, `…completion_digest_high_water`, `voice_learn.*`)
// stay global. Before `migrateLearningKeys` has moved the pre-#2475 global keys, the MIGRATED
// mailbox (the live registry row with no triage start) still reads them as a fallback, so an
// install does not re-backfill or re-ask between boot steps. Nothing else falls back.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import {
  STATE_NAMESPACE,
  PER_MAILBOX_STATE_NAMES,
  globalStateKey,
  mailboxStateKey,
  GLOBAL_STATE_PREFIX as GLOBAL_PREFIX,
  FALLBACK_MAILBOX_ID,
  type MailboxStateName,
} from '../../src/principal-mailboxes/state-keys.js';
import type { ConfigStore } from '../../src/memory/config-store.js';

export { STATE_NAMESPACE, PER_MAILBOX_STATE_NAMES, globalStateKey, mailboxStateKey, type MailboxStateName };

/**
 * Where one mailbox's state lives. `id: null` is the global scope: the deferred-migration fallback
 * (no registry rows yet; `migrateLearningKeys` does nothing then) and contexts with no registry.
 * `legacy` marks the migrated mailbox, which falls back to the global keys until they are moved.
 */
export interface MailboxStateScope {
  id: string | null;
  legacy: boolean;
}

export const GLOBAL_SCOPE: MailboxStateScope = { id: null, legacy: false };

function nameOfGlobalKey(key: string): MailboxStateName | null {
  const name = key.startsWith(GLOBAL_PREFIX) ? key.slice(GLOBAL_PREFIX.length) : '';
  return (PER_MAILBOX_STATE_NAMES as readonly string[]).includes(name) ? (name as MailboxStateName) : null;
}

/** The key a scope uses for a global key name. A key that is not per-mailbox is returned as is. */
export function scopedKey(scope: MailboxStateScope | undefined, globalKey: string): string {
  const name = nameOfGlobalKey(globalKey);
  if (!scope || scope.id === null || name === null) return globalKey;
  return mailboxStateKey(scope.id, name);
}

/** A tombstoned (migrated) global key reads as '' because the config store has no delete. */
function present(raw: string | null): string | null {
  return raw === null || raw === '' ? null : raw;
}

/** Read a scoped value; the migrated mailbox falls back to the global key while it is unmigrated. */
export async function readScoped(
  store: Pick<ConfigStore, 'get'>,
  scope: MailboxStateScope | undefined,
  globalKey: string,
): Promise<string | null> {
  const own = present(await store.get(STATE_NAMESPACE, scopedKey(scope, globalKey)));
  if (own !== null || !scope || scope.id === null || !scope.legacy || nameOfGlobalKey(globalKey) === null) return own;
  return present(await store.get(STATE_NAMESPACE, globalKey));
}

/** Write a scoped value (always to the scope's own key, never the global one for a mailbox). */
export async function writeScoped(
  store: Pick<ConfigStore, 'set'>,
  scope: MailboxStateScope | undefined,
  globalKey: string,
  value: string,
): Promise<{ stored: boolean }> {
  return store.set(STATE_NAMESPACE, scopedKey(scope, globalKey), value);
}

/**
 * The mailboxes whose state a job walks: every live mailbox with its scope, the migrated one marked
 * `legacy`. While the deferred fallback is served, its one mailbox gets the global scope
 * (`migrateLearningKeys` does nothing then, so nothing may be written under the fallback's id).
 * With no registry (unit tests) there are no mailboxes and one global scope. Registry errors propagate.
 */
export async function liveMailboxScopes(ctx: ToolContext): Promise<Array<{ mailbox: PrincipalMailboxView; scope: MailboxStateScope }>> {
  const svc = ctx.principalMailboxes;
  if (!svc) return [];
  const live = await svc.list();
  if (await svc.isFallbackActive()) return live.map((mailbox) => ({ mailbox, scope: GLOBAL_SCOPE }));
  const migrated = live.find((m) => m.triageStartAt === null);
  return live.map((mailbox) => ({ mailbox, scope: { id: mailbox.id, legacy: mailbox === migrated } }));
}

/** The scopes alone; a context with no registry has the one global scope. */
export async function resolveStateScopes(ctx: ToolContext): Promise<MailboxStateScope[]> {
  if (!ctx.principalMailboxes) return [GLOBAL_SCOPE];
  return (await liveMailboxScopes(ctx)).map((x) => x.scope);
}

/** True when a record's `mailbox` belongs to the scope. A record with none, or with the deferred-fallback id (R61), belongs to the migrated mailbox. */
export function recordBelongsTo(scope: MailboxStateScope, recordMailbox: string | undefined): boolean {
  if (scope.id === null) return true;
  if (recordMailbox === undefined || recordMailbox === FALLBACK_MAILBOX_ID) return scope.legacy || recordMailbox === scope.id;
  return recordMailbox === scope.id;
}
