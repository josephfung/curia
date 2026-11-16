import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { principalFixtureMismatch, SCENARIO_PRINCIPAL, SCENARIO_PRINCIPAL_SQL } from '../../scenarios/principal-fixture.js';

describe('principalFixtureMismatch', () => {
  it('accepts the scenario principal', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['avery.testwell@example.test'])).toBeUndefined();
  });

  it('matches the email case-insensitively among several identities', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['other@example.test', 'Avery.Testwell@Example.Test'])).toBeUndefined();
  });

  it('names a different principal', () => {
    expect(principalFixtureMismatch('Dana Realperson', ['avery.testwell@example.test'])).toBe(
      "the principal is 'Dana Realperson', not 'Avery Testwell'",
    );
  });

  it('names a missing email identity', () => {
    expect(principalFixtureMismatch('Avery Testwell', ['dana@example.com'])).toBe(
      'no verified email identity avery.testwell@example.test',
    );
  });

  it('reports a database with no principal at all', () => {
    expect(principalFixtureMismatch(undefined, [])).toBe(
      "the principal is missing, not 'Avery Testwell'; no verified email identity avery.testwell@example.test",
    );
  });

  it('prints SQL that sets both the name and the email', () => {
    expect(SCENARIO_PRINCIPAL_SQL).toContain(`display_name='${SCENARIO_PRINCIPAL.displayName}'`);
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

  it('matches the setup command in the scenarios README', () => {
    // The README's copy-paste command must not drift from the one the refusal prints.
    const readme = readFileSync(join(import.meta.dirname, '../../scenarios/README.md'), 'utf8');
    expect(readme).toContain(SCENARIO_PRINCIPAL_SQL);
  });
});
