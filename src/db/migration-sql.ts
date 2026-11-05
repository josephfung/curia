// Text analysis of migration files, for the two-track migration rules (#2465, ADR-061).
//
// This is pattern matching over SQL text, not a parser. It is used in two places where a
// best-effort answer is the right one:
//   - the reconciliation dry run lists the tables, columns and indexes each track creates
//     and warns where both create the same one (a fork that reimplemented an upstream
//     migration under its own name);
//   - the CI lint (tests/unit/db/migration-guards.test.ts) flags DDL in new upstream
//     migrations that would fail, or silently accept a different shape, on a fork that
//     already has the object.

export type SchemaObjectKind = 'table' | 'column' | 'index';

export interface SchemaObject {
  kind: SchemaObjectKind;
  /** Lower-case, unquoted, without a `public.` prefix. Columns are `table.column`. */
  name: string;
}

export interface UnguardedDdl {
  statement: 'CREATE TABLE' | 'CREATE INDEX' | 'ADD COLUMN' | 'ADD CONSTRAINT';
  /** The first line of the offending statement, trimmed, for the failure message. */
  excerpt: string;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
// Keywords that may follow ADD in ALTER TABLE without naming a column.
const ADD_NON_COLUMN = /^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i;

/**
 * Removes `--` and `/* *\/` comments, leaving string literals and dollar-quoted bodies in
 * place. Comment markers inside a single-quoted string are kept as text.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function normalizeIdent(raw: string): string {
  const parts = raw.split('.').map(part => {
    const trimmed = part.trim();
    return trimmed.startsWith('"') ? trimmed.slice(1, -1) : trimmed.toLowerCase();
  });
  if (parts.length === 2 && parts[0] === 'public') return parts[1]!;
  return parts.join('.');
}

/** Splits on top-level semicolons, keeping dollar-quoted bodies (`DO $$ … $$`) whole. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        continue;
      }
    }
    if (ch === ';') {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  statements.push(sql.slice(start));
  return statements.map(s => s.trim()).filter(s => s.length > 0);
}

/** The column names an `ALTER TABLE … ADD …` statement adds, in order. */
function addedColumns(alterBody: string): Array<{ column: string; guarded: boolean }> {
  const columns: Array<{ column: string; guarded: boolean }> = [];
  // Empty the string literals first, so `SET DEFAULT 'add x'` is not read as adding x.
  const body = alterBody.replace(/'(?:[^']|'')*'/g, "''");
  const addRe = /\bADD\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = addRe.exec(body)) !== null) {
    let rest = body.slice(match.index + match[0].length);
    if (ADD_NON_COLUMN.test(rest)) continue;
    rest = rest.replace(/^COLUMN\s+/i, '');
    const guarded = /^IF\s+NOT\s+EXISTS\s+/i.test(rest);
    rest = rest.replace(/^IF\s+NOT\s+EXISTS\s+/i, '');
    const name = new RegExp(`^(${IDENT})`).exec(rest);
    if (name) columns.push({ column: normalizeIdent(name[1]!), guarded });
  }
  return columns;
}

/**
 * The tables, columns and indexes a migration creates, wherever they appear (including
 * inside `DO` blocks and JS migrations' SQL strings). Columns are those added by
 * `ALTER TABLE … ADD`; a table's own columns are covered by the table entry.
 */
export function extractCreatedObjects(sql: string): SchemaObject[] {
  const text = stripSqlComments(sql);
  const objects: SchemaObject[] = [];

  const tableRe = new RegExp(
    String.raw`\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
    'gi',
  );
  for (const m of text.matchAll(tableRe)) objects.push({ kind: 'table', name: normalizeIdent(m[1]!) });

  const indexRe = new RegExp(
    String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\b`,
    'gi',
  );
  for (const m of text.matchAll(indexRe)) objects.push({ kind: 'index', name: normalizeIdent(m[1]!) });

  const alterRe = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})([^;]*)`,
    'gi',
  );
  for (const m of text.matchAll(alterRe)) {
    const table = normalizeIdent(m[1]!);
    for (const { column } of addedColumns(m[2]!)) objects.push({ kind: 'column', name: `${table}.${column}` });
  }

  const seen = new Set<string>();
  return objects.filter(o => {
    const key = `${o.kind}:${o.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function excerpt(statement: string): string {
  return statement.split('\n')[0]!.trim().slice(0, 120);
}

/**
 * DDL in an upstream migration that is not safe on a fork that already has the object.
 *
 * Outside a `DO` block, `CREATE TABLE` and `CREATE INDEX` need `IF NOT EXISTS`, and
 * `ADD COLUMN` and `ADD CONSTRAINT` are not allowed at all: a bare `ADD COLUMN IF NOT
 * EXISTS` would accept a fork's column of a different type without a word. They belong in
 * a `DO` block that compares the existing shape and raises on a mismatch, so a `DO` block
 * that adds a column or constraint must contain `RAISE EXCEPTION`.
 */
export function findUnguardedDdl(sql: string): UnguardedDdl[] {
  const found: UnguardedDdl[] = [];
  for (const statement of splitStatements(stripSqlComments(sql))) {
    if (/\bDO\s+\$[A-Za-z_]*\$/i.test(statement)) {
      const addsColumn = /\bALTER\s+TABLE\b/i.test(statement)
        && /\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)/i.test(statement);
      const addsConstraint = /\bADD\s+CONSTRAINT\b/i.test(statement);
      if ((addsColumn || addsConstraint) && !/\bRAISE\s+EXCEPTION\b/i.test(statement)) {
        found.push({ statement: addsColumn ? 'ADD COLUMN' : 'ADD CONSTRAINT', excerpt: excerpt(statement) });
      }
      continue;
    }
    // Temporary tables do not outlive the migration, so only permanent ones need a guard.
    if (/\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(statement)) {
      found.push({ statement: 'CREATE TABLE', excerpt: excerpt(statement) });
    }
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b)/i.test(statement)) {
      found.push({ statement: 'CREATE INDEX', excerpt: excerpt(statement) });
    }
    const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}([\s\S]*)$`, 'i').exec(statement);
    if (alter) {
      if (addedColumns(alter[1]!).length > 0) found.push({ statement: 'ADD COLUMN', excerpt: excerpt(statement) });
      if (/\bADD\s+CONSTRAINT\b/i.test(alter[1]!)) found.push({ statement: 'ADD CONSTRAINT', excerpt: excerpt(statement) });
    }
  }
  return found;
}
