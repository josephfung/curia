// Naming rules for smoke's throwaway database copy (#1956). The copy itself is
// exercised by every live `pnpm smoke` run.
import { describe, expect, it } from 'vitest';
import { cloneName, databaseName } from '../../smoke/clone-db.js';

describe('clone-db', () => {
  it('reads the source database name from DATABASE_URL', () => {
    expect(databaseName('postgresql://curia:secret@localhost:5432/curia')).toBe('curia');
    expect(databaseName('postgresql://u@h/curia_dev?sslmode=disable')).toBe('curia_dev');
  });

  it('refuses a name it could not quote safely', () => {
    expect(() => databaseName('postgresql://u@h/my-db')).toThrow(/letters, digits and underscores/);
  });

  it('names the clone after the source and the process', () => {
    expect(cloneName('curia', 4242)).toBe('curia_smoke_4242');
  });

  it('refuses a name Postgres would truncate', () => {
    expect(() => cloneName('x'.repeat(60), 4242)).toThrow(/63-character/);
  });
});
