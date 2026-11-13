// Types and constants for the principal mailbox registry (#2475).

import { FALLBACK_MAILBOX_ID } from './state-keys.js';

export interface PrincipalMailboxRecord {
  id: string;
  label: string;
  address: string;
  provider: 'google';
  isDefault: boolean;
  triageStartAt: Date | null;
  removedAt: Date | null;
  addedIdentityId: string | null;
}

/** Mailbox ids are short immutable slugs; mirrors the CHECK constraint in migration 123. */
export const MAILBOX_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Ids no mailbox may take. `primary` and `default` are also refused by migration 123's CHECK.
 * The deferred-fallback id is reserved in code only (R63): records written under it belong to
 * the migrated mailbox (R61), so a real mailbox with that id would claim them.
 */
export const RESERVED_MAILBOX_IDS = new Set(['primary', 'default', FALLBACK_MAILBOX_ID]);
export const MAX_LIVE_MAILBOXES = 1; // lifted in Task 33

/** The id names no mailbox, live or removed. Never a reason to fall back to the default. */
export class UnknownMailboxError extends Error {
  constructor(readonly mailboxId: string) {
    super(`Unknown mailbox "${mailboxId}"`);
    this.name = 'UnknownMailboxError';
  }
}

/** The id names a mailbox that has been removed. */
export class RemovedMailboxError extends Error {
  constructor(
    readonly mailboxId: string,
    readonly label: string,
  ) {
    super(`Mailbox "${mailboxId}" (${label}) has been removed`);
    this.name = 'RemovedMailboxError';
  }
}

/** The Nylas API key (channel.email.nylas_api_key) is not configured. */
export class MissingNylasApiKeyError extends Error {
  constructor() {
    super('Nylas API key is not configured');
    this.name = 'MissingNylasApiKeyError';
  }
}
