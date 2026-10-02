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

describe('clone ownership and safety', () => {
  it('sweeps only names cloneName() produces', async () => {
    const { isCloneOf } = await import('../../smoke/clone-db.js');
    expect(isCloneOf('curia_smoke_4242', 'curia')).toBe(true);
    expect(isCloneOf('curia_smoke_baseline', 'curia')).toBe(false);
    expect(isCloneOf('curia_smoke_', 'curia')).toBe(false);
    expect(isCloneOf('curia_dev_smoke_1', 'curia')).toBe(false);
  });

  it('accepts only local database hosts', async () => {
    const { isLocalDatabase } = await import('../../smoke/clone-db.js');
    expect(isLocalDatabase('postgresql://u:p@localhost:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@127.0.0.1:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@[::1]:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u@%2Fvar%2Frun%2Fpostgresql/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@db.example.net:5432/curia')).toBe(false);
  });
});
