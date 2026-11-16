/**
 * The scenario cases are written for one principal: Avery Testwell, avery.testwell@example.test
 * (51 case files name Avery; harness.ts's SCENARIO_ORG_DOMAINS is example.test). The suite
 * reads the principal from the database it runs on, so on a database whose principal is
 * someone else, the coordinator meets "Avery" as a stranger: it asks who Avery is, or treats
 * the principal's own asks as an outsider's. On the 2026-11-16 gate that turned 13 of 25
 * failing cases red that passed on an Avery database. Nothing said why, so check up front.
 */
export const SCENARIO_PRINCIPAL = {
  displayName: 'Avery Testwell',
  email: 'avery.testwell@example.test',
} as const;

/**
 * Why this database's principal is not the cases' principal, or undefined when it is.
 * `emails` are the principal's verified email identities as read at boot.
 */
export function principalFixtureMismatch(
  displayName: string | undefined,
  emails: readonly string[],
): string | undefined {
  const problems: string[] = [];
  if (displayName !== SCENARIO_PRINCIPAL.displayName) {
    problems.push(`the principal is ${displayName === undefined ? 'missing' : `'${displayName}'`}, not '${SCENARIO_PRINCIPAL.displayName}'`);
  }
  if (!emails.some(e => e.toLowerCase() === SCENARIO_PRINCIPAL.email)) {
    problems.push(`no verified email identity ${SCENARIO_PRINCIPAL.email}`);
  }
  return problems.length > 0 ? problems.join('; ') : undefined;
}

/**
 * SQL that turns a disposable copy's principal into the scenario principal. Printed with the
 * refusal so the fix is one paste; never run against the dev database itself.
 */
export const SCENARIO_PRINCIPAL_SQL =
  `UPDATE contacts SET display_name='${SCENARIO_PRINCIPAL.displayName}', preferred_name='Avery' WHERE system_role='principal'; `
  + `UPDATE contact_channel_identities SET channel_identifier='${SCENARIO_PRINCIPAL.email}' `
  + `WHERE channel='email' AND contact_id=(SELECT id FROM contacts WHERE system_role='principal');`;
