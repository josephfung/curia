import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { principalFixtureMismatch, SCENARIO_PRINCIPAL, SCENARIO_PRINCIPAL_SQL } from '../../scenarios/principal-fixture.js';

const AVERY_SIGNAL = SCENARIO_PRINCIPAL.signal;

describe('principalFixtureMismatch', () => {
  it('accepts the scenario principal', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['avery.testwell@example.test'], [AVERY_SIGNAL])).toBeUndefined();
  });

  it('matches the email case-insensitively among several identities', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['other@example.test', 'Avery.Testwell@Example.Test'], [AVERY_SIGNAL])).toBeUndefined();
  });

  it('names a different principal', () => {
    expect(principalFixtureMismatch('Dana Realperson', ['avery.testwell@example.test'], [AVERY_SIGNAL])).toBe(
      "the principal is 'Dana Realperson', not 'Avery Testwell'",
    );
  });

  it('names a missing email identity', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['dana@example.com'], [AVERY_SIGNAL])).toBe(
      'no verified email identity avery.testwell@example.test',
    );
  });

  it('reports a database with no principal at all', () => {
    expect(principalFixtureMismatch(undefined, [], [])).toBe(
      "the principal is missing, not 'Avery Testwell'; no verified email identity avery.testwell@example.test; "
        + 'no verified Signal identity +15555550147',
    );
  });

  it('names a missing Signal identity, or one with another number', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['avery.testwell@example.test'], [])).toBe(
      'no verified Signal identity +15555550147',
    );
    expect(principalFixtureMismatch('Avery Testwell', ['avery.testwell@example.test'], ['+15555550199'])).toBe(
      'no verified Signal identity +15555550147',
    );
  });

  it('prints SQL that sets both the name and the email', () => {
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`display_name='${SCENARIO_PRINCIPAL.displayName}'`);
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`primary_email='${SCENARIO_PRINCIPAL.email}'`);
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`channel_identifier='${SCENARIO_PRINCIPAL.email}', verified=true`);
    // Several email identities would collide on the unique address index if all were renamed.
    expect(SCENARIO_PRINCIPAL_SQL).toContain("SET status='defunct'");
    // Defunct rows keep their address, so a row already holding Avery's is the one renamed.
    expect(SCENARIO_PRINCIPAL_SQL).toContain(
      `ORDER BY lower(channel_identifier)='${SCENARIO_PRINCIPAL.email}' DESC, created_at LIMIT 1`,
    );
    // A principal with no email identity (Signal-only) gets one.
    expect(SCENARIO_PRINCIPAL_SQL).toMatch(/INSERT INTO contact_channel_identities .* AND NOT EXISTS \(/);
  });

  it('prints SQL that gives the principal one active Signal identity, never taking another contact\'s', () => {
    const sig = SCENARIO_PRINCIPAL.signal;
    // Refused by name, before any change, when someone else holds the number.
    expect(SCENARIO_PRINCIPAL_SQL).toContain("system_role IS DISTINCT FROM ''principal'') THEN RAISE EXCEPTION");
    expect(SCENARIO_PRINCIPAL_SQL.indexOf('RAISE EXCEPTION')).toBeLessThan(SCENARIO_PRINCIPAL_SQL.indexOf("channel='signal'"));
    expect(SCENARIO_PRINCIPAL_SQL).toContain("UPDATE contact_channel_identities SET status='defunct' WHERE channel='signal'");
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`ORDER BY channel_identifier='${sig}' DESC, created_at LIMIT 1`);
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`SELECT id, 'signal', '${sig}', true, now(), 'ceo_stated', 'active'`);
    // Pasted inside a double-quoted shell argument: no dollar quoting, no history expansion.
    expect(SCENARIO_PRINCIPAL_SQL).not.toContain('$');
    expect(SCENARIO_PRINCIPAL_SQL).not.toContain('!');
    expect(SCENARIO_PRINCIPAL_SQL).not.toContain('"');
  });

  // A row an interrupted run of the retired per-case seeds left carries 'scenario-fixture (#2017)',
  // which the start-up sweep deletes; the adopted email and Signal rows must lose that label.
  it('clears the label on both identity rows it adopts, so the start-up sweep cannot delete them', () => {
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`SET channel_identifier='${SCENARIO_PRINCIPAL.email}', verified=true, verified_at=now(), status='active', label=NULL`);
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`SET channel_identifier='${SCENARIO_PRINCIPAL.signal}', verified=true, verified_at=now(), status='active', label=NULL`);
  });

  it('matches the setup command in the scenarios README', () => {
    // The README's copy-paste command must not drift from the one the refusal prints.
    const readme = readFileSync(join(import.meta.dirname, '../../scenarios/README.md'), 'utf8');
    expect(readme).toContain(SCENARIO_PRINCIPAL_SQL);
  });
});
