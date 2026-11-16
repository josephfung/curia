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
    expect(SCENARIO_PRINCIPAL_SQL).toContain('ORDER BY created_at LIMIT 1');
  });
});
