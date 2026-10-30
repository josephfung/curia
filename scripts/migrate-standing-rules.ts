// scripts/migrate-standing-rules.ts
//
// One-off migration (#2339): ceo-inbox's and calendar's standing rules move from a
// JSON array in config-store to a /shared/ document the agents read through
// pinned_context and edit one `##` section at a time.
//
//   ceo_inbox/rules  →  /shared/inbox/rules.md     ({condition, instruction, active})
//   calendar/rules   →  /shared/calendar/rules.md  ({applies_to, instruction, active})
//
// Every rule is kept, in order, paused ones included (`active: false` → `Status: paused`).
// Each rule's heading comes from its scope (condition or applies_to), cut at a word near
// 60 characters and made unique; a rule's text is folded onto one line.
//
// Safe to re-run: a document that already exists at the path, live or archived, is
// skipped and reported. Both values are parsed before anything is written, and a value
// that is not a JSON array of rules fails the whole run, so no partial document is ever
// written. The old config-store keys are left in place (config-store has no delete);
// nothing reads them after #2339.
//
// Dry-run (default): report only. Pass --apply to write.
//
// Run:  pnpm run migrate:standing-rules
//       pnpm run migrate:standing-rules -- --apply

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createLogger, type Logger } from '../src/logger.js';
import { WorkingDocsRepo } from '../src/db/working-docs-repo.js';
import { appendDirectoryLogEntry } from '../src/agents/document-workspace.js';
import { EmbeddingService } from '../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../src/memory/knowledge-graph.js';
import { MemoryValidator } from '../src/memory/validation.js';
import { EntityMemory } from '../src/memory/entity-memory.js';
import { ConfigStore } from '../src/memory/config-store.js';

export interface RuleSetSpec {
  agentId: string;
  namespace: string;
  key: string;
  path: string;
  title: string;
  /** The JSON field holding the rule's scope, and the line label it becomes. */
  scopeField: 'condition' | 'applies_to';
  scopeLabel: string;
}

export const RULE_SETS: readonly RuleSetSpec[] = [
  {
    agentId: 'ceo-inbox',
    namespace: 'ceo_inbox',
    key: 'rules',
    path: '/shared/inbox/rules.md',
    title: 'Inbox standing rules',
    scopeField: 'condition',
    scopeLabel: 'When',
  },
  {
    agentId: 'calendar',
    namespace: 'calendar',
    key: 'rules',
    path: '/shared/calendar/rules.md',
    title: 'Scheduling rules',
    scopeField: 'applies_to',
    scopeLabel: 'Applies to',
  },
];

export interface StandingRule {
  scope: string;
  instruction: string;
  active: boolean;
}

/** What the script needs from config-store and the document workspace. */
export interface MigrationDeps {
  readConfig(namespace: string, key: string): Promise<string | null>;
  docs: Pick<WorkingDocsRepo, 'existsAtPath' | 'create' | 'read' | 'append'>;
  logger: Logger;
}

export type RuleSetOutcome =
  | { spec: RuleSetSpec; status: 'exists' }
  | { spec: RuleSetSpec; status: 'not_set' }
  | { spec: RuleSetSpec; status: 'invalid'; error: string }
  | { spec: RuleSetSpec; status: 'ready' | 'written'; rules: StandingRule[]; body: string };

export interface MigrationResult {
  dryRun: boolean;
  outcomes: RuleSetOutcome[];
  /** True when any value failed to parse; nothing was written in that case. */
  failed: boolean;
}

const MAX_HEADING_CHARS = 60;

/** Fold a value onto one line, so it cannot open a new `##` section or list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a stored rules value. Throws on anything but a JSON array of rules, each with
 * non-empty string scope and instruction and an optional boolean `active`.
 */
export function parseRules(raw: string, spec: RuleSetSpec): StandingRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  return parsed.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`rule ${i + 1} is not an object`);
    }
    const rule = item as Record<string, unknown>;
    const scope = rule[spec.scopeField];
    const instruction = rule['instruction'];
    const active = rule['active'];
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new Error(`rule ${i + 1} has no '${spec.scopeField}' text`);
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      throw new Error(`rule ${i + 1} has no 'instruction' text`);
    }
    if (active !== undefined && typeof active !== 'boolean') {
      throw new Error(`rule ${i + 1} has a non-boolean 'active'`);
    }
    // The agents skipped only `active: false`, so a rule without the field was live.
    return { scope: oneLine(scope), instruction: oneLine(instruction), active: active !== false };
  });
}

/** A short heading from the rule's scope: cut near 60 characters at a word, no `#`. */
export function headingFor(scope: string, index: number): string {
  const clean = scope.replace(/#/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return `Rule ${index + 1}`;
  if (clean.length <= MAX_HEADING_CHARS) return clean.replace(/[.,;:]+$/, '');
  const cut = clean.slice(0, MAX_HEADING_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]+$/, '')}…`;
}

/** The document body: a one-line guide, then one `##` section per rule, in order. */
export function renderRulesBody(rules: readonly StandingRule[], spec: RuleSetSpec): string {
  const seen = new Map<string, number>();
  const sections = rules.map((rule, i) => {
    let heading = headingFor(rule.scope, i);
    const count = (seen.get(heading.toLowerCase()) ?? 0) + 1;
    seen.set(heading.toLowerCase(), count);
    if (count > 1) heading = `${heading} (${count})`;
    return [
      `## ${heading}`,
      '',
      `- ${spec.scopeLabel}: ${rule.scope}`,
      `- Do: ${rule.instruction}`,
      `- Status: ${rule.active ? 'active' : 'paused'}`,
    ].join('\n');
  });
  const guide = `Each rule is a \`##\` section with ${spec.scopeLabel} / Do / Status lines. Status is active or paused.`;
  return `${[guide, ...sections].join('\n\n')}\n`;
}

export async function runMigration(
  deps: MigrationDeps,
  options: { apply: boolean; specs?: readonly RuleSetSpec[] },
): Promise<MigrationResult> {
  const specs = options.specs ?? RULE_SETS;
  const outcomes: RuleSetOutcome[] = [];

  // Plan everything first: a bad value stops the run before any write.
  for (const spec of specs) {
    if (await deps.docs.existsAtPath(spec.path)) {
      outcomes.push({ spec, status: 'exists' });
      continue;
    }
    const raw = await deps.readConfig(spec.namespace, spec.key);
    if (raw === null) {
      outcomes.push({ spec, status: 'not_set' });
      continue;
    }
    try {
      const rules = parseRules(raw, spec);
      outcomes.push({ spec, status: 'ready', rules, body: renderRulesBody(rules, spec) });
    } catch (err) {
      outcomes.push({ spec, status: 'invalid', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const failed = outcomes.some((o) => o.status === 'invalid');
  if (!options.apply || failed) return { dryRun: !options.apply, outcomes, failed };

  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.status !== 'ready') continue;
    const { spec } = outcome;
    await deps.docs.create({
      path: spec.path,
      type: 'agent-settings',
      frontmatter: { title: spec.title },
      body: outcome.body,
      taskId: null,
      agentId: spec.agentId,
    });
    outcomes[i] = { ...outcome, status: 'written' };
    await appendDirectoryLogEntry(deps.docs, deps.logger, {
      documentPath: spec.path,
      operation: 'create',
      summary: `Migrated ${outcome.rules.length} rules from config-store ${spec.namespace}/${spec.key} (#2339)`,
      agentId: spec.agentId,
      source: 'migrate-standing-rules',
    });
  }
  return { dryRun: false, outcomes, failed: false };
}

export function formatMigrationReport(result: MigrationResult): string {
  const mode = result.dryRun ? 'DRY-RUN' : 'APPLY';
  const lines = [`standing rules → /shared/ documents (#2339) — ${mode}`, ''];
  for (const outcome of result.outcomes) {
    const { spec } = outcome;
    const from = `${spec.namespace}/${spec.key} → ${spec.path}`;
    switch (outcome.status) {
      case 'exists':
        lines.push(`  ${from}: skipped, the document already exists (live or archived)`);
        break;
      case 'not_set':
        lines.push(`  ${from}: skipped, no stored rules`);
        break;
      case 'invalid':
        lines.push(`  ${from}: INVALID, ${outcome.error}`);
        break;
      case 'ready':
      case 'written': {
        const paused = outcome.rules.filter((r) => !r.active).length;
        const verb = outcome.status === 'written' ? 'written' : 'would write';
        lines.push(`  ${from}: ${verb}, ${outcome.rules.length} rules (${paused} paused)`);
        if (result.dryRun) {
          lines.push(...outcome.body.trimEnd().split('\n').map((l) => `      ${l}`));
        }
        break;
      }
    }
  }
  lines.push('');
  if (result.failed) {
    lines.push('  Nothing was written: fix or remove the invalid value, then re-run.');
  } else if (result.dryRun) {
    lines.push('  Re-run with --apply to write the documents.');
  }
  return lines.join('\n');
}

// CLI entry — pathToFileURL handles '#', '?', '%' in the checkout path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = createLogger('info');
  const main = async (): Promise<void> => {
    const apply = process.argv.includes('--apply');
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      logger.error('migrate-standing-rules: DATABASE_URL is not set');
      process.exitCode = 1;
      return;
    }
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      // Reads only: config-store finds its anchors by label, so no embedding is needed.
      const embeddingService = EmbeddingService.createForTesting();
      const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
      const entityMemory = new EntityMemory(kgStore, new MemoryValidator(kgStore, embeddingService), embeddingService, logger);
      const configStore = new ConfigStore(entityMemory, logger);
      const result = await runMigration(
        {
          readConfig: (namespace, key) => configStore.get(namespace, key),
          docs: new WorkingDocsRepo(pool, logger),
          logger,
        },
        { apply },
      );
      process.stdout.write(`${formatMigrationReport(result)}\n`);
      if (result.failed) process.exitCode = 1;
    } catch (err) {
      logger.error({ err }, 'migrate-standing-rules: fatal error');
      process.exitCode = 1;
    } finally {
      try {
        await pool.end();
      } catch (endErr) {
        logger.error({ err: endErr }, 'migrate-standing-rules: failed to close the pool');
        process.exitCode = 1;
      }
    }
  };
  await main();
}
