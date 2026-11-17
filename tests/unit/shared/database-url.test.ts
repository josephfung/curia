// Database-name helpers for test tooling that creates throwaway databases.
import { describe, expect, it } from 'vitest';
import { databaseName, isLocalDatabase, likePrefix } from '../../shared/database-url.js';

describe('databaseName', () => {
  it('reads the database name from DATABASE_URL', () => {
    expect(databaseName('postgresql://curia:secret@localhost:5432/curia')).toBe('curia');
    expect(databaseName('postgresql://u@h/curia_dev?sslmode=disable')).toBe('curia_dev');
  });

  it('refuses a name it could not quote safely', () => {
    expect(() => databaseName('postgresql://u@h/my-db')).toThrow(/letters, digits and underscores/);
  });
});

describe('isLocalDatabase', () => {
  it('accepts only local database hosts', () => {
    expect(isLocalDatabase('postgresql://u:p@localhost:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@127.0.0.1:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@[::1]:5432/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u@%2Fvar%2Frun%2Fpostgresql/curia')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@db.example.net:5432/curia')).toBe(false);
  });
});

describe('likePrefix', () => {
  it('escapes LIKE wildcards and the escape character itself', () => {
    expect(likePrefix('postgres_wizard_')).toBe('postgres\\_wizard\\_%');
    expect(likePrefix('50%')).toBe('50\\%%');
    // A backslash left unescaped would turn the next character into a literal.
    expect(likePrefix('a\\_b')).toBe('a\\\\\\_b%');
  });
});
