/**
 * The scenario cases are written for one principal: Avery Testwell, avery.testwell@example.test
 * (51 case files name Avery; harness.ts's SCENARIO_ORG_DOMAINS is example.test). The suite
 * reads the principal from the database it runs on, so on a database whose principal is
 * someone else, the coordinator meets "Avery" as a stranger: it asks who Avery is, or treats
 * the principal's own asks as an outsider's. On the 2026-11-16 gate that turned 13 of 25
 * failing cases red that passed on an Avery database. Nothing said why, so check up front.
 *
 * Avery also has a Signal number, in the boot snapshot like any principal's, so a principal turn
 * on Signal resolves as theirs and the reply to `signal:<number>` reaches them as the principal
 * at the outbound gateway. Cases used to seed it per run with a raw insert the snapshot never
 * saw, so the gateway treated those replies as going to an outsider (scenario 47b).
 */
export const SCENARIO_PRINCIPAL = {
  displayName: 'Avery Testwell',
  email: 'avery.testwell@example.test',
  signal: '+15555550147',
} as const;

/**
 * Why this database's principal is not the cases' principal, or undefined when it is.
 * `emails` and `signals` are the principal's verified, active email and Signal identities as
 * read at boot (the snapshot the gateway and every prompt use).
 */
export function principalFixtureMismatch(
  displayName: string | undefined,
  emails: readonly string[],
  signals: readonly string[],
): string | undefined {
  const problems: string[] = [];
  if (displayName !== SCENARIO_PRINCIPAL.displayName) {
    problems.push(`the principal is ${displayName === undefined ? 'missing' : `'${displayName}'`}, not '${SCENARIO_PRINCIPAL.displayName}'`);
  }
  if (!emails.some(e => e.toLowerCase() === SCENARIO_PRINCIPAL.email)) {
    problems.push(`no verified email identity ${SCENARIO_PRINCIPAL.email}`);
  }
  if (!signals.includes(SCENARIO_PRINCIPAL.signal)) {
    problems.push(`no verified Signal identity ${SCENARIO_PRINCIPAL.signal}`);
  }
  return problems.length > 0 ? problems.join('; ') : undefined;
}

/**
 * SQL that turns a disposable copy's principal into the scenario principal. Printed with the
 * refusal so the fix is one paste; never run it against the dev database itself. psql runs a
 * multi-statement -c as one transaction, so a failure leaves the copy unchanged.
 *
 * A mirrored principal often has several email identities, and (channel, address) is unique
 * (migration 044), so only one row is renamed; the rest are marked defunct, which drops them
 * from the boot snapshot (verified and active only) without deleting rows that others reference.
 * Defunct rows still hold their address under the unique index, so the renamed row is the one
 * already holding Avery's address when there is one (a half-prepared copy), else the oldest.
 * A principal with no email identity at all (Signal-only) gets one inserted.
 * The designated primary (contacts.primary_email) becomes Avery's too: a copied primary that
 * no verified identity matches is dropped from the prompt, with a boot warning.
 *
 * Signal follows the same pattern with an exact number. Another contact already holding Avery's
 * number is refused with a named error before anything changes, rather than taken from them:
 * the rename or insert would otherwise fail on the (channel, identifier) unique index with a
 * message that does not say which contact holds it. The DO body is a single-quoted string, not
 * dollar-quoted, because the command is pasted inside a double-quoted shell argument.
 */
const PRINCIPAL_ID = "(SELECT id FROM contacts WHERE system_role='principal')";
const EMAIL = SCENARIO_PRINCIPAL.email;
const SIGNAL = SCENARIO_PRINCIPAL.signal;
export const SCENARIO_PRINCIPAL_SQL = [
  `UPDATE contacts SET display_name='${SCENARIO_PRINCIPAL.displayName}', preferred_name='Avery', primary_email='${EMAIL}' WHERE system_role='principal';`,
  `UPDATE contact_channel_identities SET status='defunct' WHERE channel='email' AND contact_id=${PRINCIPAL_ID};`,
  `UPDATE contact_channel_identities SET channel_identifier='${EMAIL}', verified=true, verified_at=now(), status='active'`
    + ` WHERE id=(SELECT id FROM contact_channel_identities WHERE channel='email' AND contact_id=${PRINCIPAL_ID}`
    + ` ORDER BY lower(channel_identifier)='${EMAIL}' DESC, created_at LIMIT 1);`,
  `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, verified, verified_at, source, status)`
    + ` SELECT id, 'email', '${EMAIL}', true, now(), 'ceo_stated', 'active' FROM contacts WHERE system_role='principal'`
    + ` AND NOT EXISTS (SELECT 1 FROM contact_channel_identities WHERE channel='email' AND contact_id=contacts.id);`,
  `DO 'BEGIN IF EXISTS (SELECT 1 FROM contact_channel_identities i JOIN contacts c ON c.id=i.contact_id`
    + ` WHERE i.channel=''signal'' AND i.channel_identifier=''${SIGNAL}'' AND c.system_role IS DISTINCT FROM ''principal'')`
    + ` THEN RAISE EXCEPTION ''Signal ${SIGNAL} belongs to a contact other than the principal; remove that identity first''; END IF; END';`,
  `UPDATE contact_channel_identities SET status='defunct' WHERE channel='signal' AND contact_id=${PRINCIPAL_ID};`,
  `UPDATE contact_channel_identities SET channel_identifier='${SIGNAL}', verified=true, verified_at=now(), status='active'`
    + ` WHERE id=(SELECT id FROM contact_channel_identities WHERE channel='signal' AND contact_id=${PRINCIPAL_ID}`
    + ` ORDER BY channel_identifier='${SIGNAL}' DESC, created_at LIMIT 1);`,
  `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, verified, verified_at, source, status)`
    + ` SELECT id, 'signal', '${SIGNAL}', true, now(), 'ceo_stated', 'active' FROM contacts WHERE system_role='principal'`
    + ` AND NOT EXISTS (SELECT 1 FROM contact_channel_identities WHERE channel='signal' AND contact_id=contacts.id);`,
].join(' ');
