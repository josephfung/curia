import { describe, it, expect } from 'vitest';
import { extractCreatedObjects, stripSqlComments } from '../../../src/db/migration-sql.js';

describe('stripSqlComments', () => {
  it('drops line and block comments but keeps comment markers inside strings', () => {
    const sql = "SELECT 1; -- gone\n/* also\ngone */ SELECT '-- kept', 'it''s /* kept */';";
    expect(stripSqlComments(sql)).toBe("SELECT 1; \n  SELECT '-- kept', 'it''s /* kept */';");
  });
});

describe('extractCreatedObjects', () => {
  it('finds tables, indexes and added columns, normalised', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public."Books" (id uuid PRIMARY KEY, title text);
      CREATE UNLOGGED TABLE batches (id int);
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS books_title_idx ON books (title);
      ALTER TABLE ONLY scheduled_jobs ADD COLUMN IF NOT EXISTS name text, ADD COLUMN "Label" text,
        ADD CONSTRAINT scheduled_jobs_name_chk CHECK (name <> '');
      ALTER TABLE sessions ADD device text;
      ALTER TABLE sessions ALTER COLUMN device SET DEFAULT 'add nothing';
      -- CREATE TABLE commented (id int);
    `;
    expect(extractCreatedObjects(sql)).toEqual([
      { kind: 'table', name: 'Books' },
      { kind: 'table', name: 'batches' },
      { kind: 'index', name: 'books_title_idx' },
      { kind: 'column', name: 'scheduled_jobs.name' },
      { kind: 'column', name: 'scheduled_jobs.Label' },
      { kind: 'column', name: 'sessions.device' },
    ]);
  });

  it('reads DDL inside DO blocks and JS migrations', () => {
    const js = "export const up = pgm => { pgm.sql(`CREATE INDEX IF NOT EXISTS audit_idx ON audit_log (ts)`); };";
    const doBlock = `DO $$ BEGIN ALTER TABLE scheduled_jobs ADD COLUMN name TEXT; END $$;`;
    expect(extractCreatedObjects(js)).toEqual([{ kind: 'index', name: 'audit_idx' }]);
    expect(extractCreatedObjects(doBlock)).toEqual([{ kind: 'column', name: 'scheduled_jobs.name' }]);
  });

  it('reports each object once', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS t (id int); CREATE TABLE IF NOT EXISTS t (id int);';
    expect(extractCreatedObjects(sql)).toEqual([{ kind: 'table', name: 't' }]);
  });
});
