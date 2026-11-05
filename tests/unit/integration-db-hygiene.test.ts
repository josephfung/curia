// integration-db-hygiene.test.ts — two rules for test suites that write to Postgres.
//
// 1. Guard: a suite that runs write or DDL SQL calls `requireCuriaTestDatabase(pool)`
//    (tests/integration/require-test-db.ts) or imports a helper that does. A
//    mispointed DATABASE_URL must fail before the first write, not after it.
// 2. No table-wide wipes: a suite does not `TRUNCATE` or `DELETE FROM <table>` with no
//    WHERE. Integration suites share one database and run in parallel files, so a
//    table-wide wipe deletes rows another suite is using (the local suite's random
//    failures), and a database-wide count asserts on rows this suite does not own.
//
// Both were review-only rules. A 2026-08..11 mining of CodeRabbit findings
// (docs/dev/review-checklist.md) found the missing guard on 17 PRs and the
// cleanup-scope finding on 10; each cost a review round.
//
// Existing offenders (57 unguarded suites, 12 with table-wide wipes, as of
// 2026-11-04) are listed below so the rules hold for every new suite now. The
// lists only shrink: a listed file that complies, or no longer exists, fails the
// test until it is removed from its list. Only tests/integration/ is scanned;
// that is where the suites that run SQL against a real database live.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '../..');

/** Pre-existing suites that write without the guard. Remove a line when you add the guard. */
const UNGUARDED_ALLOWLIST = new Set([
  'tests/integration/activity-feed.test.ts',
  'tests/integration/activity-log.test.ts',
  'tests/integration/agent-bootstrap.test.ts',
  'tests/integration/antfarm-routes.test.ts',
  'tests/integration/audit-log-timeline.test.ts',
  'tests/integration/audit-log.test.ts',
  'tests/integration/autonomy-routes.test.ts',
  'tests/integration/backlog-heartbeat.test.ts',
  'tests/integration/bullpen.test.ts',
  'tests/integration/calendar-holds-collaboration.test.ts',
  'tests/integration/ceo-bootstrap.test.ts',
  'tests/integration/ceo-inbox-bullpen-escalation.test.ts',
  'tests/integration/channel-registry-repo.test.ts',
  'tests/integration/checkpoint.test.ts',
  'tests/integration/console-sessions.test.ts',
  'tests/integration/contacts.test.ts',
  'tests/integration/debrief-clear-by-subject.test.ts',
  'tests/integration/dedup-contacts-merge.test.ts',
  'tests/integration/dream-engine.test.ts',
  'tests/integration/email-accounts-repo.test.ts',
  'tests/integration/email-adapter-persistence.test.ts',
  'tests/integration/enqueue-task-wake.test.ts',
  'tests/integration/ensure-principal.test.ts',
  'tests/integration/escalation-ux.test.ts',
  'tests/integration/extract-facts.test.ts',
  'tests/integration/extract-relationships.test.ts',
  'tests/integration/health-canary-boot.test.ts',
  'tests/integration/heartbeat-selection.test.ts',
  'tests/integration/kg-semantic-search-filters.test.ts',
  'tests/integration/knowledge-graph.test.ts',
  'tests/integration/migrate-signal-phone-consolidation.test.ts',
  'tests/integration/outbound-context-keep-open.test.ts',
  'tests/integration/pairing-codes.test.ts',
  'tests/integration/plan-completion-reconciliation.test.ts',
  'tests/integration/plan-frontier.test.ts',
  'tests/integration/plan-lifecycle-e2e.test.ts',
  'tests/integration/registry-repo.test.ts',
  'tests/integration/registry-routes.test.ts',
  'tests/integration/resumable-circuit-breaker.test.ts',
  'tests/integration/resumable-continuation.test.ts',
  'tests/integration/scheduler-claim-idempotency.test.ts',
  'tests/integration/scheduler-lifecycle-mutations.test.ts',
  'tests/integration/scheduler-terminal-task-wake.test.ts',
  'tests/integration/secrets-service.test.ts',
  'tests/integration/seed-vault.test.ts',
  'tests/integration/setup-routes.test.ts',
  'tests/integration/task-plan-progress.test.ts',
  'tests/integration/task-repo-list-pagination.test.ts',
  'tests/integration/task-repo-originator.test.ts',
  'tests/integration/task-resumable-progress.test.ts',
  'tests/integration/task-update-running-wake.test.ts',
  'tests/integration/task-update-wake-reuse.test.ts',
  'tests/integration/task-wake-reply-bind.test.ts',
  'tests/integration/voice-session-store.test.ts',
  'tests/integration/web-push-subscriptions.test.ts',
  'tests/integration/woken-task-authorization.test.ts',
  'tests/integration/working-docs-repo.test.ts',
]);

/** Pre-existing table-wide wipes. Scope the cleanup to this suite's rows, then remove the line. */
const WIPE_ALLOWLIST = new Set([
  'tests/integration/action-log-competence-window.test.ts',
  'tests/integration/autonomy-routes.test.ts',
  'tests/integration/channel-registry-repo.test.ts',
  'tests/integration/documents-bundle-routes.test.ts',
  'tests/integration/documents-edit-routes.test.ts',
  'tests/integration/email-accounts-repo.test.ts',
  'tests/integration/pairing-invitations.test.ts',
  'tests/integration/reembed-kg.test.ts',
  'tests/integration/registry-repo.test.ts',
  'tests/integration/registry-routes.test.ts',
  'tests/integration/web-push-subscriptions.test.ts',
  'tests/integration/working-docs-repo.test.ts',
]);

/** Write or DDL SQL, as written in this repo's tests (upper-case keywords). */
const WRITE_SQL = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\w."]+\s+SET|TRUNCATE|DROP\s+(?:TABLE|SCHEMA|INDEX|DATABASE)|ALTER\s+TABLE|CREATE\s+(?:TABLE|SCHEMA|DATABASE|(?:UNIQUE\s+)?INDEX))\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The suites that talk to a real database. Unit tests are out of scope: their SQL
 * is mock data or the input to a read-only check, not a statement that runs.
 */
function dbSuites(): string[] {
  return walk(join(ROOT, 'tests/integration')).filter((file) => file.endsWith('.test.ts'));
}

/** Non-test helpers under tests/ that call the guard; importing one counts as guarded. */
function guardedHelpers(): string[] {
  return walk(join(ROOT, 'tests'))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => !file.endsWith('/require-test-db.ts'))
    .filter((file) => readFileSync(file, 'utf8').includes('requireCuriaTestDatabase('))
    .map((file) => basename(file, '.ts'));
}

function isGuarded(source: string, helpers: string[]): boolean {
  if (source.includes('requireCuriaTestDatabase(')) return true;
  return helpers.some((helper) => new RegExp(`from '[^']*/${helper}\\.js'`).test(source));
}

/**
 * Table-wide wipes in the file's string and template literals: a TRUNCATE, or a
 * DELETE FROM whose literal has no WHERE. Parsed, not grepped, so a multi-line
 * template counts as one statement.
 */
function wipes(file: string): string[] {
  return wipesIn(readFileSync(file, 'utf8'), file);
}

function wipesIn(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(source);
      const deleteAll = /\bDELETE\s+FROM\b/.test(text) && !/\bWHERE\b/.test(text);
      if (deleteAll || /\bTRUNCATE\b/.test(text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push(`${relative(ROOT, file)}:${line + 1}: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('integration suites that write to Postgres', () => {
  const suites = dbSuites();
  const helpers = guardedHelpers();

  it('finds the suites and the guarded helpers', () => {
    // A path change that empties either list would pass the rules below vacuously.
    expect(suites.length).toBeGreaterThan(50);
    expect(helpers).toContain('scratch-database');
  });

  it('check the database name before writing', () => {
    const missing = suites
      .filter((file) => WRITE_SQL.test(readFileSync(file, 'utf8')))
      .filter((file) => !isGuarded(readFileSync(file, 'utf8'), helpers))
      .map((file) => relative(ROOT, file))
      .filter((file) => !UNGUARDED_ALLOWLIST.has(file));
    // Fix: `await requireCuriaTestDatabase(pool)` in beforeAll, before the first write.
    expect(missing).toEqual([]);
  });

  it('do not wipe whole tables', () => {
    const hits = suites
      .filter((file) => !WIPE_ALLOWLIST.has(relative(ROOT, file)))
      .flatMap((file) => wipes(file));
    // Fix: delete only the rows this suite created (track their ids, or scope by a run-unique prefix).
    expect(hits).toEqual([]);
  });

  it('allowlists only shrink', () => {
    const stale: string[] = [];
    for (const file of UNGUARDED_ALLOWLIST) {
      const full = join(ROOT, file);
      if (!existsSync(full)) stale.push(`${file}: no longer exists`);
      else if (isGuarded(readFileSync(full, 'utf8'), helpers)) stale.push(`${file}: now guarded`);
    }
    for (const file of WIPE_ALLOWLIST) {
      const full = join(ROOT, file);
      if (!existsSync(full)) stale.push(`${file}: no longer exists`);
      else if (wipes(full).length === 0) stale.push(`${file}: no longer wipes a table`);
    }
    // Remove these entries from their allowlist.
    expect(stale).toEqual([]);
  });

  it('reads each literal as one statement', () => {
    const probe = (code: string) => wipesIn(code, join(ROOT, 'probe.ts')).length;
    expect(probe('q(`DELETE FROM contacts\n  WHERE id = ANY($1)`);')).toBe(0);
    expect(probe('q(`DELETE FROM ${table} WHERE id = $1`);')).toBe(0);
    expect(probe("q('DELETE FROM contacts');")).toBe(1);
    expect(probe('q(`DELETE FROM ${table}`);')).toBe(1);
    expect(probe("q('TRUNCATE audit_log');")).toBe(1);
    expect(probe("q('SELECT 1'); // DELETE FROM contacts")).toBe(0);
  });
});
