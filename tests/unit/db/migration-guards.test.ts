// CI lint for upstream migrations (#2465, ADR-061).
//
// From GUARDED_FROM on, every upstream migration must be safe on a fork that already has
// the objects it creates: CREATE TABLE / CREATE INDEX use IF NOT EXISTS, and ADD COLUMN /
// ADD CONSTRAINT sit in a DO block that compares the existing shape and raises on a
// mismatch. Earlier migrations are exempt and are not rewritten.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findUnguardedDdl } from '../../../src/db/migration-sql.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../src/db/migrations');
const LOCAL_DIR = path.resolve(import.meta.dirname, '../../../src/db/migrations-local');

/** The first upstream migration number the guard rule applies to. 117 was the last exempt one. */
const GUARDED_FROM = 118;

const files = readdirSync(MIGRATIONS_DIR).filter(name => !name.startsWith('.')).sort();

describe('upstream migration files', () => {
  it('all have a numeric prefix', () => {
    expect(files.filter(name => !/^\d+_/.test(name))).toEqual([]);
  });

  it('never share a numeric prefix', () => {
    const byPrefix = new Map<number, string[]>();
    for (const name of files) {
      const prefix = Number.parseInt(name, 10);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }
    const duplicates = [...byPrefix.values()].filter(names => names.length > 1);
    expect(duplicates).toEqual([]);
  });

  it(`guard their DDL from ${GUARDED_FROM} on`, () => {
    const violations = files
      .filter(name => Number.parseInt(name, 10) >= GUARDED_FROM)
      .flatMap(name => findUnguardedDdl(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
        .map(v => `${name}: ${v.statement} — ${v.excerpt}`));
    // See ADR-061 and src/db/migrations-local/README.md for the guarded, shape-checked pattern.
    expect(violations).toEqual([]);
  });
});

describe('src/db/migrations-local', () => {
  it('ships no migrations upstream, only its README', () => {
    expect(readdirSync(LOCAL_DIR)).toEqual(['README.md']);
  });
});

describe('findUnguardedDdl', () => {
  it('accepts guarded creates and a shape-checked DO block', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS fork_things (id uuid PRIMARY KEY);
      CREATE UNIQUE INDEX IF NOT EXISTS fork_things_idx ON fork_things (id);
      CREATE INDEX CONCURRENTLY IF NOT EXISTS fork_things_c ON fork_things (id);
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'scheduled_jobs' AND column_name = 'name') THEN
          IF (SELECT data_type <> 'text' FROM information_schema.columns
              WHERE table_name = 'scheduled_jobs' AND column_name = 'name') THEN
            RAISE EXCEPTION 'scheduled_jobs.name has an incompatible shape';
          END IF;
        ELSE
          ALTER TABLE scheduled_jobs ADD COLUMN name TEXT;
        END IF;
      END $$;
      CREATE TEMP TABLE scratch (id int);
      DROP TABLE IF EXISTS old_things;
    `;
    expect(findUnguardedDdl(sql)).toEqual([]);
  });

  it('flags bare CREATE TABLE and CREATE INDEX', () => {
    const sql = `
      CREATE TABLE things (id uuid);
      CREATE INDEX things_idx ON things (id);
      CREATE UNIQUE INDEX CONCURRENTLY things_u ON things (id);
    `;
    expect(findUnguardedDdl(sql).map(v => v.statement)).toEqual(['CREATE TABLE', 'CREATE INDEX', 'CREATE INDEX']);
  });

  it('flags ADD COLUMN outside a DO block, even with IF NOT EXISTS', () => {
    const sql = `
      ALTER TABLE things ADD COLUMN name text;
      ALTER TABLE things ADD COLUMN IF NOT EXISTS label text;
      ALTER TABLE things ADD other int;
    `;
    expect(findUnguardedDdl(sql).map(v => v.statement)).toEqual(['ADD COLUMN', 'ADD COLUMN', 'ADD COLUMN']);
  });

  it('flags ADD CONSTRAINT outside a DO block and in a DO block with no shape check', () => {
    const sql = `
      ALTER TABLE things ADD CONSTRAINT things_fk FOREIGN KEY (id) REFERENCES other (id);
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'things_chk') THEN
          ALTER TABLE things ADD CONSTRAINT things_chk CHECK (id IS NOT NULL);
        END IF;
      END $$;
    `;
    expect(findUnguardedDdl(sql).map(v => v.statement)).toEqual(['ADD CONSTRAINT', 'ADD CONSTRAINT']);
  });

  it('ignores DDL in comments and leaves other ALTERs alone', () => {
    const sql = `
      -- CREATE TABLE commented_out (id int);
      /* ALTER TABLE things ADD COLUMN x int; */
      ALTER TABLE things RENAME COLUMN a TO b;
      ALTER TABLE things ALTER COLUMN b SET DEFAULT 'add x';
      ALTER TABLE things DROP COLUMN IF EXISTS c;
    `;
    expect(findUnguardedDdl(sql)).toEqual([]);
  });
});
