// The Nylas hosted-auth callback (#2361): turn `?state=&code=` (or `?state=&error=`) into a
// connected mailbox, Curia's own or the principal's. Framework-free; the route only redirects.
//
// Order of operations (binding, see the plan's Task 6):
//   1. Claim the single-use state token. Unknown or spent → failed; lapsed → expired. Nothing is
//      exchanged in either case.
//   2. A provider error is mapped (admin block, org-internal, cancel) without an exchange.
//   3-5. Exchange the code, read the grant, and check provider, scopes and (for the principal) the
//      address the link was pinned to.
//   6. A grant that ends up stored nowhere is revoked, but only when no principal mailbox and no
//      Curia account holds it in the vault (Nylas hands back the same grant id for an account that
//      already has one, so a "stray" grant may be a live mailbox's).
//   7-8. Write through the existing registries: PrincipalMailboxAdmin for the principal (live at
//      once), email_accounts plus a controlled restart for Curia.
//   9. Publish mailbox_signin.finished with the token's origin, so the agent that sent the link
//      can continue.
//
// Secrets: the auth code, the raw state, the grant id and the API key never reach a log line, an
// event payload or the result. Nylas errors are logged with grantSafeErrorFields only.

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import {
  createMailboxSignInFinished,
  createPrincipalMailboxChanged,
  createPrincipalMailboxConnected,
  createSecretChanged,
} from '../bus/events.js';
import type { NylasAppClient } from './app-client.js';
import { nylasApiUri, type NylasRegion } from './region.js';
import {
  MAILBOX_SIGNIN_SCOPES,
  mailboxSignInCallbackUrl,
  nylasRestartRequired,
  type NylasBootConfig,
} from './signin-readiness.js';
import type { MailboxSignInOutcome } from './signin-outcome.js';
import type { MailboxSignInService, SignInTarget, SignInTokenRow } from './mailbox-signin-service.js';
import type { PrincipalMailboxAdmin } from '../principal-mailboxes/admin.js';
import type { PrincipalMailboxStore } from '../principal-mailboxes/store.js';
import { FLAT_EMAIL_KEY, FLAT_GRANT_KEY, principalMailboxGrantSecretName } from '../principal-mailboxes/secrets.js';
import { mailboxIdFromAddress } from '../principal-mailboxes/migrate-flat-mailbox.js';
import { MAILBOX_ID_RE, RESERVED_MAILBOX_IDS } from '../principal-mailboxes/types.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';
import type { EmailAccountsRepo } from '../channels/email/email-accounts-repo.js';
import { emailAccountGrantSecretName } from '../channels/email/email-account-secrets.js';

export interface MailboxSignInCallbackQuery {
  state?: string;
  code?: string;
  error?: string;
  error_description?: string;
}

export interface MailboxSignInCallbackResult {
  outcome: MailboxSignInOutcome;
  /** Absent when the state named no claimable link (unknown or already spent). */
  target?: SignInTarget;
  /** The principal mailbox id, when the sign-in resolved one. */
  mailboxId?: string;
  restartScheduled: boolean;
}

type CallbackClient = Pick<NylasAppClient, 'getApplication' | 'exchangeCode' | 'getGrant' | 'deleteGrant'>;

export interface MailboxSignInCallbackDeps {
  signIn: Pick<MailboxSignInService, 'claim'>;
  /** Live read of the Nylas API key (the token endpoint's client_secret). */
  readApiKey: () => Promise<string | undefined>;
  /** Live read of the Nylas region. */
  readRegion: () => Promise<NylasRegion>;
  /** The key and region the process booted with: a sign-in waits for a restart after either
   *  changes (R11), since the mailbox it connects would be served with the boot values. */
  boot: NylasBootConfig;
  appOrigin: string | undefined;
  makeClient: (apiKey: string, apiUri: string) => CallbackClient;
  principalStore: Pick<PrincipalMailboxStore, 'listLive' | 'hasAnyRow' | 'getAny'>;
  /** Absent in setup-required mode (no principal contact yet): a principal sign-in is refused. */
  principalAdmin?: Pick<PrincipalMailboxAdmin, 'add' | 'replaceGrant'>;
  emailAccounts: Pick<EmailAccountsRepo, 'list' | 'findBySelfEmail' | 'createForAddress' | 'update' | 'delete'>;
  secrets: { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void> };
  bus: Pick<EventBus, 'publish'>;
  /** Exits the process after the delay so the supervisor restarts it (as the setup route does). */
  scheduleProcessExit: (delayMs: number) => void;
  logger: Logger;
}

/** How long after a Curia-mailbox sign-in the process exits, so the done page can render first. */
export const CURIA_MAILBOX_RESTART_DELAY_MS = 3000;

/** The account name the first Curia mailbox takes: only the 'curia' adapter delivers notifications. */
const PRIMARY_CURIA_ACCOUNT = 'curia';
const CREATED_BY = 'mailbox-signin';
const DEFAULT_LABEL = 'Primary';
const MAX_LABEL = 80;
const MAX_ID_SUFFIX = 50;

type Settled = Omit<MailboxSignInCallbackResult, 'target'>;

const lower = (s: string): string => s.trim().toLowerCase();
const done = (outcome: MailboxSignInOutcome, extra: Partial<Settled> = {}): Settled => ({
  outcome,
  restartScheduled: false,
  ...extra,
});

/**
 * Map an OAuth error redirect to an outcome. Nylas does not document which field carries
 * Google's reason, so both are read; the admin block is checked first because it can arrive as
 * `error=access_denied` with the reason in the description. These are the provider's own wire
 * codes, so matching their text is the only way to read them.
 */
export function mapSignInError(error: string | undefined, description: string | undefined): MailboxSignInOutcome {
  const text = `${error ?? ''} ${description ?? ''}`.toLowerCase();
  if (text.includes('admin_policy_enforced')) return 'admin_blocked';
  if (text.includes('org_internal')) return 'org_internal';
  if (text.includes('access_denied')) return 'cancelled';
  return 'failed';
}

export async function handleMailboxSignInCallback(
  query: MailboxSignInCallbackQuery,
  deps: MailboxSignInCallbackDeps,
): Promise<MailboxSignInCallbackResult> {
  const log = deps.logger.child({ component: 'mailbox-signin-callback' });
  const state = typeof query.state === 'string' ? query.state : '';
  if (state === '') {
    log.warn('mailbox sign-in callback without a state');
    return { outcome: 'failed', restartScheduled: false };
  }

  // 1. Claim the token. Its value is never logged.
  let claim: Awaited<ReturnType<MailboxSignInCallbackDeps['signIn']['claim']>>;
  try {
    claim = await deps.signIn.claim(state);
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err) }, 'mailbox sign-in callback: could not claim the state token');
    return { outcome: 'failed', restartScheduled: false };
  }
  if (claim.status === 'not_found' || claim.status === 'used') {
    // No finished event: an unknown state has no origin to resume, and a spent one already
    // published its own (a second would resume the agent twice). The endpoint is public, so a
    // garbage state must not reach the bus either.
    log.warn({ tokenStatus: claim.status }, 'mailbox sign-in callback refused: the state names no live link');
    return { outcome: 'failed', restartScheduled: false };
  }
  const row = claim.row;

  let settled: Settled;
  if (claim.status === 'expired') {
    // Review Focus 2: a lapsed link exchanges nothing, even with a valid code in hand.
    log.info({ target: row.target }, 'mailbox sign-in callback: the link had expired');
    settled = done('expired');
  } else {
    const held: Held = {};
    try {
      settled = await settle(query, row, deps, log, held);
    } catch (err) {
      log.error({ ...grantSafeErrorFields(err), target: row.target }, 'mailbox sign-in callback failed unexpectedly');
      settled = done('failed');
    }
    // Never on `refused`: the account was the right kind, so its grant is likely held somewhere
    // (a registry this scan cannot see, or the flat fallback) and revoking it would cut it off.
    if (!isSuccess(settled.outcome) && settled.outcome !== 'refused' && held.grantId !== undefined && held.client !== undefined) {
      await revokeIfUnused(held.grantId, held.client, deps, log);
    }
  }

  // 9. One finished event per claimed link, whatever the outcome.
  try {
    await deps.bus.publish('system', createMailboxSignInFinished({
      target: row.target,
      outcome: settled.outcome,
      ...(settled.mailboxId !== undefined ? { mailboxId: settled.mailboxId } : {}),
      ...(settled.restartScheduled ? { restartScheduled: true } : {}),
      ...originOf(row),
    }, row.task_event_id ?? undefined));
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err), outcome: settled.outcome }, 'mailbox sign-in callback: could not publish mailbox_signin.finished');
  }
  log.info({ target: row.target, outcome: settled.outcome, mailboxId: settled.mailboxId, restartScheduled: settled.restartScheduled }, 'mailbox sign-in finished');
  return { ...settled, target: row.target };
}

/** The grant this callback obtained, kept for the revoke step if anything after it fails. */
interface Held {
  grantId?: string;
  client?: CallbackClient;
}

function isSuccess(o: MailboxSignInOutcome): boolean {
  return o === 'connected' || o === 'reconnected';
}

function originOf(row: SignInTokenRow) {
  return {
    ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
    ...(row.channel_id !== null ? { channelId: row.channel_id } : {}),
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    ...(row.task_event_id !== null ? { taskEventId: row.task_event_id } : {}),
    ...(row.originator !== null ? { originator: row.originator } : {}),
    ...(row.resume_token !== null ? { resumeToken: row.resume_token } : {}),
  };
}

/** Steps 2-8 for a live, claimed link. Throws only on the unexpected; the caller maps that to failed. */
async function settle(
  query: MailboxSignInCallbackQuery,
  row: SignInTokenRow,
  deps: MailboxSignInCallbackDeps,
  log: Logger,
  held: Held,
): Promise<Settled> {
  // 2. A provider error: nothing to exchange.
  if (query.error || query.error_description) {
    const outcome = mapSignInError(query.error, query.error_description);
    log.info({ target: row.target, outcome }, 'mailbox sign-in returned an error from the provider');
    return done(outcome);
  }

  if (row.target === 'principal') {
    // R4, fail closed: every principal link is pinned to an address (mint and the console both
    // set one). A link without one would let any Google account become the principal's mailbox,
    // so it is refused before the code is even exchanged.
    if (row.expected_email === null) {
      log.warn('mailbox sign-in refused: a principal link carried no expected address');
      return done('refused');
    }
    if (deps.principalAdmin === undefined) {
      log.warn('mailbox sign-in refused: there is no principal yet (setup-required mode)');
      return done('refused');
    }
  }

  const code = typeof query.code === 'string' ? query.code : '';
  if (code === '') {
    log.warn({ target: row.target }, 'mailbox sign-in callback carried neither a code nor an error');
    return done('failed');
  }
  // Only the application id (the hosted-auth client_id) and region are needed here, not full
  // readiness: a blip listing connectors must not throw away a valid code (L).
  const apiKey = (await deps.readApiKey())?.trim();
  if (apiKey === undefined || apiKey === '' || deps.appOrigin === undefined) {
    log.warn({ reason: 'no_api_key_or_origin' }, 'mailbox sign-in callback: sign-in is not ready');
    return done('failed');
  }
  const region = await deps.readRegion();
  if (nylasRestartRequired(apiKey, region, deps.boot)) {
    log.warn({ reason: 'restart_required' }, 'mailbox sign-in callback: the Nylas key or region changed since boot; restart Curia');
    return done('failed');
  }
  const client = deps.makeClient(apiKey, nylasApiUri(region));

  let applicationId: string;
  try {
    ({ applicationId } = await client.getApplication());
  } catch (err) {
    log.warn({ ...grantSafeErrorFields(err), step: 'lookup_application', target: row.target }, 'mailbox sign-in: the Nylas application could not be read');
    return done('failed');
  }

  // 3. Exchange the code, then read the grant.
  let grantId: string;
  try {
    ({ grantId } = await client.exchangeCode({
      clientId: applicationId,
      code,
      redirectUri: mailboxSignInCallbackUrl(deps.appOrigin),
    }));
  } catch (err) {
    log.warn({ ...grantSafeErrorFields(err), step: 'exchange', target: row.target }, 'mailbox sign-in: the code exchange failed');
    return done('failed');
  }
  held.grantId = grantId;
  held.client = client;

  let grant: Awaited<ReturnType<CallbackClient['getGrant']>>;
  try {
    grant = await client.getGrant(grantId);
  } catch (err) {
    log.warn({ ...grantSafeErrorFields(err), step: 'get_grant', target: row.target }, 'mailbox sign-in: the new grant could not be read');
    return done('failed');
  }
  if (grant.provider !== 'google') {
    log.info({ target: row.target, provider: grant.provider }, 'mailbox sign-in refused: not a Google account');
    return done('not_google');
  }

  // 4. Every required scope.
  const granted = new Set(grant.scopes);
  const missing = MAILBOX_SIGNIN_SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    log.info({ target: row.target, missing }, 'mailbox sign-in: required scopes were not granted');
    return done('missing_scopes');
  }
  if (grant.status !== 'valid') {
    log.warn({ target: row.target }, 'mailbox sign-in: Nylas reports the new grant as invalid');
    return done('failed');
  }

  // 5. The account must be the one the link was pinned to. Principal links always are (above);
  // a Curia link may be pinned by the operator.
  const email = lower(grant.email);
  if (row.expected_email !== null && lower(row.expected_email) !== email) {
    log.info({ target: row.target }, 'mailbox sign-in: a different account signed in than the link was for');
    return done('wrong_account');
  }

  return row.target === 'principal'
    ? writePrincipal(email, grantId, row, client, deps, log)
    : writeCuria(email, grantId, client, deps, log);
}

/** 7. The principal's mailbox, through PrincipalMailboxAdmin (the console's own path). */
async function writePrincipal(
  email: string,
  grantId: string,
  row: SignInTokenRow,
  client: CallbackClient,
  deps: MailboxSignInCallbackDeps,
  log: Logger,
): Promise<Settled> {
  const admin = deps.principalAdmin!;
  const live = await deps.principalStore.listLive();
  const existing = live.find((m) => lower(m.address) === email);

  if (existing) {
    // Nylas returns the same grant id when the account already has one: already connected.
    const stored = (await deps.secrets.get(principalMailboxGrantSecretName(existing.id)))?.trim();
    if (stored === grantId) return done('reconnected', { mailboxId: existing.id });

    if (!(await auditRequested(deps, log, existing.id, 'replace_grant'))) return done('failed');
    const replaced = await admin.replaceGrant(existing.id, grantId);
    if (!replaced.ok) {
      log.warn({ mailboxId: existing.id, refusal: replaced.refusal }, 'mailbox sign-in: replacing the mailbox grant was refused');
      return done('refused', { mailboxId: existing.id });
    }
    await auditCompleted(deps, log, existing.id, 'replace_grant');
    // The grant it replaced is now held by nothing (unless another registry holds it).
    if (stored) await revokeIfUnused(stored, client, deps, log, 'previous');
    return done('reconnected', { mailboxId: existing.id });
  }

  const firstEver = !(await deps.principalStore.hasAnyRow());
  const noLiveDefault = !live.some((m) => m.isDefault);
  const id = await uniqueMailboxId(email, deps.principalStore);
  const label = validLabel(row.mailbox_label) ?? DEFAULT_LABEL;

  if (!(await auditRequested(deps, log, id, 'add'))) return done('failed');
  const added = await admin.add({ id, label, grantId, makeDefault: firstEver || noLiveDefault });
  if (!added.ok) {
    log.warn({ mailboxId: id, refusal: added.refusal }, 'mailbox sign-in: adding the principal mailbox was refused');
    return done('refused');
  }
  await auditCompleted(deps, log, id, 'add', added.warning !== undefined);

  if (firstEver) {
    try {
      await deps.bus.publish('system', createPrincipalMailboxConnected({ mailboxId: id }));
    } catch (err) {
      // The mailbox is connected; only the one-time notice is lost. Logged, never undone.
      log.error({ ...grantSafeErrorFields(err), mailboxId: id }, 'mailbox sign-in: could not publish principal_mailbox.connected');
    }
  }
  return done('connected', { mailboxId: id });
}

/** 8. Curia's own mailbox: upsert email_accounts by address, write the vault grant, restart. */
async function writeCuria(
  email: string,
  grantId: string,
  client: CallbackClient,
  deps: MailboxSignInCallbackDeps,
  log: Logger,
): Promise<Settled> {
  // The flat fallback's address (R9) is the principal's too, while the deferred migration has not
  // moved it into the registry; the key is deleted once it has.
  const flatAddress = (await deps.secrets.get(FLAT_EMAIL_KEY))?.trim().toLowerCase();
  if (flatAddress === email || (await deps.principalStore.listLive()).some((m) => lower(m.address) === email)) {
    log.warn({ reason: 'principal_mailbox_address' }, "mailbox sign-in refused: that address is one of the principal's mailboxes");
    return done('refused');
  }

  let outcome: MailboxSignInOutcome;
  const existing = await deps.emailAccounts.findBySelfEmail(email);
  if (existing) {
    const secretName = emailAccountGrantSecretName(existing.name);
    const stored = (await deps.secrets.get(secretName))?.trim();
    // Nylas returns the same grant id for an account that already has one: nothing to change,
    // so no write, no audit and no restart.
    if (stored === grantId && existing.enabled) return done('reconnected');
    if (stored !== grantId) {
      // Grant first, then enable: a failed vault write leaves the account as it was.
      if (!(await auditSecretRequested(deps, log, secretName))) return done('failed');
      await deps.secrets.set(secretName, grantId);
      await auditSecretCompleted(deps, log, secretName);
    }
    if (!existing.enabled) await deps.emailAccounts.update(existing.name, { enabled: true });
    log.info({ account: existing.name }, "Curia's email account re-connected by hosted sign-in");
    if (stored && stored !== grantId) await revokeIfUnused(stored, client, deps, log, 'previous');
    outcome = 'reconnected';
  } else {
    // The row first: its name (and so the vault key) is only known once the insert wins one.
    const created = await deps.emailAccounts.createForAddress(email, { createdBy: CREATED_BY, preferName: PRIMARY_CURIA_ACCOUNT });
    const secretName = emailAccountGrantSecretName(created.name);
    if (!(await auditSecretRequested(deps, log, secretName))) {
      await undoCreate(created.name, deps, log);
      return done('failed');
    }
    try {
      await deps.secrets.set(secretName, grantId);
    } catch (err) {
      // Never leave an account without its grant (as the console's POST route compensates).
      await undoCreate(created.name, deps, log);
      throw err;
    }
    await auditSecretCompleted(deps, log, secretName);
    log.info({ account: created.name }, "Curia's email account connected by hosted sign-in");
    outcome = 'connected';
  }

  // The email adapters are wired at boot, so the new grant is picked up by a restart.
  try {
    deps.scheduleProcessExit(CURIA_MAILBOX_RESTART_DELAY_MS);
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err) }, 'mailbox sign-in: could not schedule the restart; restart Curia to use the mailbox');
    return done(outcome);
  }
  return done(outcome, { restartScheduled: true });
}

/** Remove an account created by this sign-in whose grant could not be saved. Never throws. */
async function undoCreate(name: string, deps: MailboxSignInCallbackDeps, log: Logger): Promise<void> {
  try {
    await deps.emailAccounts.delete(name);
  } catch (undoErr) {
    log.error({ ...grantSafeErrorFields(undoErr), account: name }, 'mailbox sign-in: could not remove the account whose grant failed to save; delete it in the console');
  }
}

/** The label stored on the token, if it meets the registry's rule (1-80 chars, no control chars). */
function validLabel(label: string | null): string | null {
  if (label === null) return null;
  const t = label.trim();
  return t !== '' && t.length <= MAX_LABEL && !/\p{Cc}/u.test(t) ? t : null;
}

/** `mailboxIdFromAddress`, suffixed -2, -3, … until it is valid, unreserved and never used (ids are never reused). */
async function uniqueMailboxId(
  email: string,
  store: Pick<PrincipalMailboxStore, 'getAny'>,
): Promise<string> {
  const base = mailboxIdFromAddress(email);
  for (let n = 1; n <= MAX_ID_SUFFIX; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!MAILBOX_ID_RE.test(id) || RESERVED_MAILBOX_IDS.has(id)) continue;
    if ((await store.getAny(id)) === null) return id;
  }
  throw new Error('No free principal mailbox id for the signed-in address');
}

/**
 * 6. Revoke a grant only when nothing holds it: no live principal mailbox, no Curia account and
 * not the flat fallback grant stores it in the vault. A failed read means "unknown", and an unknown grant is kept.
 * The ids compared here are never logged.
 */
async function revokeIfUnused(
  grantId: string,
  client: CallbackClient,
  deps: MailboxSignInCallbackDeps,
  log: Logger,
  which: 'new' | 'previous' = 'new',
): Promise<void> {
  try {
    const names = [
      // The flat grant the deferred-migration fallback serves (R9).
      FLAT_GRANT_KEY,
      ...(await deps.principalStore.listLive()).map((m) => principalMailboxGrantSecretName(m.id)),
      ...(await deps.emailAccounts.list()).map((a) => emailAccountGrantSecretName(a.name)),
    ];
    for (const name of names) {
      if ((await deps.secrets.get(name))?.trim() === grantId) {
        log.info({ grant: which }, 'mailbox sign-in: the grant belongs to a connected mailbox; not revoking it');
        return;
      }
    }
  } catch (err) {
    log.warn({ ...grantSafeErrorFields(err), grant: which }, 'mailbox sign-in: could not check whether the grant is in use; leaving it in Nylas');
    return;
  }
  try {
    await client.deleteGrant(grantId);
    log.info({ grant: which }, 'mailbox sign-in: revoked the unused grant');
  } catch (err) {
    log.warn({ ...grantSafeErrorFields(err), grant: which }, 'mailbox sign-in: could not revoke the unused grant; remove it in the Nylas dashboard');
  }
}

/** secret.changed `requested` for Curia's grant key (name only, never the value); refused if unrecordable. */
async function auditSecretRequested(deps: MailboxSignInCallbackDeps, log: Logger, secretName: string): Promise<boolean> {
  try {
    await deps.bus.publish('system', createSecretChanged({ secretName, action: 'set', stage: 'requested', initiatedBy: 'signin_callback' }));
    return true;
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err), secretName }, 'mailbox sign-in: the grant write could not be audited, so it was not made');
    return false;
  }
}

/** secret.changed `completed`: the write happened, so a miss is only logged. */
async function auditSecretCompleted(deps: MailboxSignInCallbackDeps, log: Logger, secretName: string): Promise<void> {
  try {
    await deps.bus.publish('system', createSecretChanged({ secretName, action: 'set', stage: 'completed', initiatedBy: 'signin_callback' }));
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err), secretName }, 'mailbox sign-in: the completed grant write could not be audited');
  }
}

type AuditAction = 'add' | 'replace_grant';

/** principal_mailbox.changed `requested`, as the console route does: an unrecordable change is not made. */
async function auditRequested(deps: MailboxSignInCallbackDeps, log: Logger, mailboxId: string, action: AuditAction): Promise<boolean> {
  try {
    await deps.bus.publish('system', createPrincipalMailboxChanged({ mailboxId, action, stage: 'requested', initiatedBy: 'signin_callback' }));
    return true;
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err), mailboxId, action }, 'mailbox sign-in: the change could not be audited, so it was not made');
    return false;
  }
}

/** principal_mailbox.changed `completed`: the change happened, so a miss is only logged. */
async function auditCompleted(deps: MailboxSignInCallbackDeps, log: Logger, mailboxId: string, action: AuditAction, warning = false): Promise<void> {
  try {
    await deps.bus.publish('system', createPrincipalMailboxChanged({
      mailboxId, action, stage: 'completed', initiatedBy: 'signin_callback', ...(warning ? { warning: true } : {}),
    }));
  } catch (err) {
    log.error({ ...grantSafeErrorFields(err), mailboxId, action }, 'mailbox sign-in: the completed change could not be audited');
  }
}
