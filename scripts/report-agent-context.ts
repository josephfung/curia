// scripts/report-agent-context.ts
//
// Read-only per-call context and tool-usage report (#1955).
//
// The coordinator diet (#1954) needs before/after numbers. `context.budget`
// estimates the system prompt and injected tiers and never counts tool
// definitions, which are most of the payload. This script reads the exact
// per-call payload already stored in `llm_call_archive` (system messages and
// `tool_definitions`) plus provider-reported input tokens and `context.budget`
// tiers from `audit_log`, and the invocation counts that show which pinned
// tools are actually called.
//
// Run on prod. DATABASE_URL is already in the app container; do not wrap this
// in `pnpm run` (that expects a `.env` the container does not have):
//
//   ssh -p 2222 <host> 'docker exec curia-curia-1 \
//     ./node_modules/.bin/tsx scripts/report-agent-context.ts \
//     --agent coordinator --days 30 --format markdown'
//
// Append each capture to docs/wip/2026-10-01-coordinator-context-baseline.md.
//
// Safety: every statement this script sends is a single SELECT. The CLI also
// sets the session to default_transaction_read_only before those SELECTs.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import pino from 'pino';
import { isAgentName } from '../src/agents/agent-name.js';
import { loadAgentConfig } from '../src/agents/loader.js';
import { discoverToolManifests } from '../src/skills/loader.js';
import { loadSkillsConfig } from '../src/skills/mcp-loader.js';
import { discoverSkillManifests } from '../src/skills/skill-loader.js';

// stderr, so stdout stays a clean report. `--format markdown` is pasted into the
// baseline doc; a pino line on stdout would land in that doc.
const logger = pino({ name: 'report-agent-context' }, process.stderr);
const { Pool } = pg;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tiers the runtime emits today, in assembly order. Unknown names sort after these. */
const TIER_ORDER = [
  'system_prompt',
  'user_message',
  'sender_context',
  'bullpen',
  'resolved_entities',
  'contact_recent_history',
  'conversation_history',
] as const;

const WRITE_VERB = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface Distribution {
  n: number;
  /** percentile_cont. Null when n is 0. */
  p50: number | null;
  p95: number | null;
}

export interface SourceDistribution {
  source: string;
  bytes: Distribution;
  toolCount: Distribution;
}

export interface LatestSource {
  source: string;
  bytes: number;
  toolCount: number;
}

export interface LatestTool {
  name: string;
  source: string;
  bytes: number;
}

export interface TierSummary {
  name: string;
  samples: number;
  included: number;
  droppedBudget: number;
  droppedEmpty: number;
  droppedOther: number;
  /** Estimated tokens on the samples where the tier was actually injected. */
  includedTokens: Distribution;
}

export interface ToolUsage {
  toolName: string;
  calls: number;
  pinned: boolean;
  source: string;
}

export interface AgentPinCatalog {
  agentName: string;
  /** Tools the agent's pins expand to, excluding MCP server pins. */
  localPinnedTools: string[];
  /** MCP servers pinned by name. Membership is the live set in the archive. */
  mcpServers: string[];
  /** Pins that matched neither a bundle, a local tool, nor an MCP server. */
  unresolvedPins: string[];
  /** Pinned bundle members with no on-disk tool.json. Still treated as local. */
  missingPinnedTools: string[];
  /** Every on-disk tool.json name, plus missing pinned members. */
  localToolNames: string[];
}

export interface AgentContextReport {
  agent: string;
  since: string;
  until: string;
  mcpServers: string[];
  unresolvedPins: string[];
  missingPinnedTools: string[];
  archiveCalls: number;
  tokenSamples: number;
  budgetEvents: number;
  systemChars: Distribution;
  toolCount: Distribution;
  toolDefinitionBytes: Distribution;
  sources: SourceDistribution[];
  framingBytes: Distribution;
  /** Tool count that appears most often. Ties break toward the smaller count. */
  modalToolCount: number | null;
  modalCalls: number;
  /**
   * Payload distribution restricted to the modal tool count. Null when every
   * archive row already has that count (the all-rows table is the same slice).
   */
  modal: {
    systemChars: Distribution;
    toolCount: Distribution;
    toolDefinitionBytes: Distribution;
    sources: SourceDistribution[];
    framingBytes: Distribution;
  } | null;
  latestCallAt: string | null;
  latest: {
    systemChars: number;
    toolCount: number;
    toolDefinitionBytes: number;
    sources: LatestSource[];
    framingBytes: number;
    tools: LatestTool[];
  } | null;
  inputTokens: Distribution;
  tiers: TierSummary[];
  invocations: ToolUsage[];
  pinnedZeroCalls: Array<{ toolName: string; source: string }>;
  /**
   * Distinct non-local tool names seen in the archive or the invocation log.
   * Zero means the live MCP membership could not be recovered for this window.
   */
  mcpToolsObserved: number;
}

export interface ReportArgs {
  agent: string;
  since: Date;
  until: Date;
  format: 'text' | 'markdown' | 'json';
}

interface ArchiveCall {
  id: string;
  createdAt: Date;
  systemChars: number;
  toolCount: number;
  toolDefinitionBytes: number;
  localBytes: number;
  localToolCount: number;
  otherBytes: number;
  otherToolCount: number;
  framingBytes: number;
  latestTools: LatestToolRow[] | null;
}

interface LatestToolRow {
  name: string | null;
  bytes: number;
}

interface TierSample {
  name: string;
  estimatedTokens: number;
  included: boolean;
  droppedReason: string | null;
}

interface BuildInput {
  agent: string;
  since: Date;
  until: Date;
  catalog: AgentPinCatalog;
  calls: ArchiveCall[];
  offeredToolNames: string[];
  inputTokens: number[];
  budgetEvents: number;
  tierSamples: TierSample[];
  invocations: Array<{ toolName: string; calls: number }>;
}

// ---------------------------------------------------------------------------
// Percentiles — same linear interpolation as Postgres percentile_cont
// ---------------------------------------------------------------------------

export function percentileCont(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (p < 0 || p > 1) {
    throw new Error(`report-agent-context: percentile ${p} is outside [0, 1]`);
  }
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sortedAsc[lo];
  const hiVal = sortedAsc[hi];
  if (loVal === undefined || hiVal === undefined) {
    throw new Error('report-agent-context: percentile index fell outside the sample');
  }
  if (lo === hi) return loVal;
  // 0.95 is not a binary fraction, so the interpolation picks up ulp noise
  // (3849.9999999999995 instead of 3850). Snap to a micro-unit; token and byte
  // counts never need more precision than that, and Postgres numeric would have
  // landed on the decimal value.
  const value = loVal + (hiVal - loVal) * (rank - lo);
  return Math.round(value * 1e6) / 1e6;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentileCont(sorted, 0.5),
    p95: percentileCont(sorted, 0.95),
  };
}

export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseReportArgs(argv: readonly string[], now: Date): ReportArgs {
  let agent: string | undefined;
  let days = 30;
  let sinceRaw: string | undefined;
  let untilRaw: string | undefined;
  let format: ReportArgs['format'] = 'text';
  let daysExplicit = false;

  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`report-agent-context: ${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') {
      agent = take(arg, i);
      i += 1;
    } else if (arg === '--days') {
      const raw = take(arg, i);
      i += 1;
      if (!/^[1-9]\d*$/.test(raw)) {
        throw new Error(`report-agent-context: --days must be a positive integer, got ${JSON.stringify(raw)}`);
      }
      days = Number(raw);
      daysExplicit = true;
    } else if (arg === '--since') {
      sinceRaw = take(arg, i);
      i += 1;
    } else if (arg === '--until') {
      untilRaw = take(arg, i);
      i += 1;
    } else if (arg === '--format') {
      const raw = take(arg, i);
      i += 1;
      if (raw !== 'text' && raw !== 'markdown' && raw !== 'json') {
        throw new Error(`report-agent-context: --format must be text, markdown, or json, got ${JSON.stringify(raw)}`);
      }
      format = raw;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('HELP');
    } else {
      throw new Error(`report-agent-context: unknown argument ${JSON.stringify(arg)}`);
    }
  }

  if (agent === undefined) {
    throw new Error('report-agent-context: --agent is required');
  }
  if (!isAgentName(agent)) {
    throw new Error(`report-agent-context: --agent ${JSON.stringify(agent)} is not a valid agent name`);
  }
  if (daysExplicit && sinceRaw !== undefined) {
    throw new Error('report-agent-context: pass either --days or --since, not both');
  }

  const until = untilRaw === undefined ? now : parseInstant('--until', untilRaw);
  const since = sinceRaw === undefined
    ? new Date(until.getTime() - days * DAY_MS)
    : parseInstant('--since', sinceRaw);
  if (since.getTime() >= until.getTime()) {
    throw new Error('report-agent-context: --since must be earlier than --until');
  }
  return { agent, since, until, format };
}

function parseInstant(flag: string, raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`report-agent-context: ${flag} ${JSON.stringify(raw)} is not a valid date`);
  }
  return parsed;
}

export function usageText(): string {
  return [
    'Usage: tsx scripts/report-agent-context.ts --agent <name> [--days N | --since ISO] [--until ISO] [--format text|markdown|json]',
    '',
    'Read-only. Prints system-string chars, tool-definition bytes by source,',
    'provider input tokens (p50/p95), context.budget tier sizes, and per-tool',
    'invocation counts including pinned tools with zero calls.',
    '',
    'On the app container:',
    '  ./node_modules/.bin/tsx scripts/report-agent-context.ts --agent coordinator --days 30 --format markdown',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Catalog — pins expanded the way the runtime does, without booting MCP
// ---------------------------------------------------------------------------

export interface PinExpansion {
  localPinnedTools: string[];
  mcpServers: string[];
  unresolvedPins: string[];
  missingPinnedTools: string[];
}

/**
 * Expand pins in the same order the runtime resolves them: a SKILL.md bundle,
 * then an MCP server name (projected as a skill at boot), then a single tool.
 * MCP membership is not on disk — callers read it from the archive.
 */
export function expandPins(
  pins: readonly string[],
  bundles: ReadonlyMap<string, readonly string[]>,
  localToolNames: ReadonlySet<string>,
  mcpServerNames: ReadonlySet<string>,
): PinExpansion {
  const localPinnedTools: string[] = [];
  const seenTools = new Set<string>();
  const mcpServers: string[] = [];
  const seenMcp = new Set<string>();
  const unresolvedPins: string[] = [];
  const missingPinnedTools: string[] = [];
  const seenMissing = new Set<string>();

  const pushTool = (name: string): void => {
    if (seenTools.has(name)) return;
    seenTools.add(name);
    localPinnedTools.push(name);
    if (!localToolNames.has(name) && !seenMissing.has(name)) {
      seenMissing.add(name);
      missingPinnedTools.push(name);
    }
  };

  for (const pin of pins) {
    const members = bundles.get(pin);
    if (members) {
      for (const member of members) pushTool(member);
      continue;
    }
    if (mcpServerNames.has(pin)) {
      if (!seenMcp.has(pin)) {
        seenMcp.add(pin);
        mcpServers.push(pin);
      }
      continue;
    }
    if (localToolNames.has(pin)) {
      pushTool(pin);
      continue;
    }
    unresolvedPins.push(pin);
  }

  return { localPinnedTools, mcpServers, unresolvedPins, missingPinnedTools };
}

export function loadAgentPinCatalog(repoRoot: string, agentName: string): AgentPinCatalog {
  if (!isAgentName(agentName)) {
    throw new Error(`report-agent-context: agent name ${JSON.stringify(agentName)} is not valid`);
  }
  const config = loadAgentConfig(path.join(repoRoot, 'agents', `${agentName}.yaml`));
  if (config.name !== agentName) {
    throw new Error(
      `report-agent-context: agents/${agentName}.yaml declares name ${JSON.stringify(config.name)}`,
    );
  }

  const skillsDir = path.join(repoRoot, 'skills');
  const localToolNames = new Set<string>();
  for (const disc of discoverToolManifests(skillsDir)) {
    if (disc.metadata === null || !disc.manifest) {
      throw new Error(
        `report-agent-context: tool '${disc.name}' failed to parse: ${disc.error ?? 'unknown error'}`,
      );
    }
    if (typeof disc.manifest.name !== 'string' || disc.manifest.name === '') {
      throw new Error(`report-agent-context: tool at ${disc.dir} has no name`);
    }
    localToolNames.add(disc.manifest.name);
  }

  const bundles = new Map<string, readonly string[]>();
  for (const disc of discoverSkillManifests(skillsDir)) {
    if (disc.metadata === null || !disc.manifest) {
      throw new Error(
        `report-agent-context: skill '${disc.name}' failed to parse: ${disc.error ?? 'unknown error'}`,
      );
    }
    bundles.set(disc.manifest.name, disc.manifest.tools);
  }

  const mcpServerNames = new Set<string>();
  const skillsConfig = loadSkillsConfig(path.join(repoRoot, 'config'));
  for (const server of skillsConfig.servers ?? []) {
    if (typeof server.name !== 'string' || server.name === '') {
      throw new Error('report-agent-context: config/skills.yaml has an MCP server without a name');
    }
    if (mcpServerNames.has(server.name)) {
      throw new Error(`report-agent-context: MCP server '${server.name}' is listed twice`);
    }
    mcpServerNames.add(server.name);
  }

  const expanded = expandPins(
    config.pinned_skills ?? [],
    bundles,
    localToolNames,
    mcpServerNames,
  );
  const classificationNames = [...localToolNames, ...expanded.missingPinnedTools];
  return {
    agentName,
    localPinnedTools: expanded.localPinnedTools,
    mcpServers: expanded.mcpServers,
    unresolvedPins: expanded.unresolvedPins,
    missingPinnedTools: expanded.missingPinnedTools,
    localToolNames: classificationNames,
  };
}

export function classifyToolSource(
  toolName: string,
  localNames: ReadonlySet<string>,
  mcpServers: readonly string[],
): string {
  if (localNames.has(toolName)) return 'local';
  if (mcpServers.length === 1) {
    const server = mcpServers[0];
    if (server === undefined) return 'unattributed';
    return `mcp:${server}`;
  }
  return 'unattributed';
}

function otherSourceLabel(mcpServers: readonly string[]): string {
  if (mcpServers.length === 1) {
    const server = mcpServers[0];
    if (server !== undefined) return `mcp:${server}`;
  }
  return 'unattributed';
}

// ---------------------------------------------------------------------------
// SQL — one SELECT each. Expressions are shared with the probe used in tests.
// ---------------------------------------------------------------------------

/**
 * Refuse anything other than a single SELECT. String literals are stripped
 * first so an event type like 'llm.call' cannot trip the verb check, and so a
 * semicolon hiding inside a literal cannot open a second statement.
 */
export function assertReadOnlySelect(sql: string): void {
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .trim();
  if (!/^select\b/i.test(stripped) || stripped.includes(';') || WRITE_VERB.test(stripped)) {
    throw new Error('report-agent-context: refusing to run a non-SELECT statement');
  }
}

function messagesExpr(promptSql: string): string {
  return `(CASE
    WHEN jsonb_typeof(${promptSql}) = 'array' THEN ${promptSql}
    WHEN jsonb_typeof(${promptSql}->'messages') = 'array' THEN ${promptSql}->'messages'
    ELSE '[]'::jsonb
  END)`;
}

function toolArrayExpr(toolsSql: string): string {
  return `(CASE
    WHEN jsonb_typeof(${toolsSql}) = 'array' THEN ${toolsSql}
    ELSE '[]'::jsonb
  END)`;
}

/**
 * Metric expressions over alias `a` (columns prompt, tool_definitions).
 * `localParam` is the text[] placeholder, e.g. `$4`.
 * `latest` = `always` for the one-row probe; `window` marks only the newest
 * archive row so the per-tool breakdown cannot drift from its aggregates.
 */
export function archiveMetricSelectList(localParam: string, latest: 'always' | 'window'): string {
  const prompt = 'a.prompt';
  const tools = 'a.tool_definitions';
  const elements = toolArrayExpr(tools);
  const localMatch = `elem->>'name' = ANY(${localParam}::text[])`;
  const otherMatch = `(elem->>'name' IS NULL OR NOT (${localMatch}))`;
  const latestTools = `COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', elem->>'name',
      'bytes', octet_length(elem::text)::int
    ))
    FROM jsonb_array_elements(${elements}) AS elem
  ), '[]'::jsonb)`;
  const latestSql = latest === 'always'
    ? latestTools
    : `CASE
        WHEN row_number() OVER (ORDER BY a.created_at DESC, a.audit_event_id DESC) = 1
        THEN ${latestTools}
        ELSE NULL
      END`;

  return `
    ${systemCharsSql(prompt)} AS system_chars,
    (SELECT count(*)::bigint FROM jsonb_array_elements(${elements}) AS elem) AS tool_count,
    (CASE
      WHEN ${tools} IS NULL OR jsonb_typeof(${tools}) = 'null' THEN 0
      ELSE octet_length(${tools}::text)
    END)::bigint AS tool_definition_bytes,
    (SELECT COALESCE(SUM(octet_length(elem::text)), 0)::bigint
       FROM jsonb_array_elements(${elements}) AS elem
      WHERE ${localMatch}) AS local_bytes,
    (SELECT count(*)::bigint
       FROM jsonb_array_elements(${elements}) AS elem
      WHERE ${localMatch}) AS local_tool_count,
    (CASE
      WHEN ${tools} IS NULL OR jsonb_typeof(${tools}) = 'null' THEN 0
      WHEN jsonb_typeof(${tools}) <> 'array' THEN octet_length(${tools}::text)
      ELSE (
        SELECT COALESCE(SUM(octet_length(elem::text)), 0)::bigint
          FROM jsonb_array_elements(${tools}) AS elem
         WHERE ${otherMatch}
      )
    END)::bigint AS other_bytes,
    (SELECT count(*)::bigint
       FROM jsonb_array_elements(${elements}) AS elem
      WHERE ${otherMatch}) AS other_tool_count,
    ${latestSql} AS latest_tools`;
}

function systemCharsSql(promptSql: string): string {
  return `(SELECT COALESCE(SUM(
    CASE
      WHEN jsonb_typeof(m->'content') = 'string' THEN char_length(m->>'content')
      WHEN jsonb_typeof(m->'content') = 'array' THEN (
        SELECT COALESCE(SUM(
          CASE
            WHEN jsonb_typeof(block) = 'string' THEN char_length(block #>> '{}')
            WHEN jsonb_typeof(block->'text') = 'string' THEN char_length(block->>'text')
            ELSE 0
          END
        ), 0)
        FROM jsonb_array_elements(m->'content') AS block
      )
      ELSE 0
    END
  ), 0)::bigint
  FROM jsonb_array_elements(${messagesExpr(promptSql)}) AS m
  WHERE m->>'role' = 'system')`;
}

/** One-row probe of the metric expressions. Params: prompt jsonb, tools jsonb, local names text[]. */
export function archiveMetricProbeSql(): string {
  return `SELECT ${archiveMetricSelectList('$3', 'always')}
    FROM (SELECT $1::jsonb AS prompt, $2::jsonb AS tool_definitions) AS a`;
}

const ARCHIVE_WINDOW = `
  FROM llm_call_archive a
  JOIN audit_log l ON l.id = a.audit_event_id
  WHERE l.event_type = 'llm.call'
    AND l.payload->>'agentId' = $1
    AND a.created_at >= $2
    AND a.created_at < $3`;

const AUDIT_WINDOW = `
  FROM audit_log l
  WHERE l.payload->>'agentId' = $1
    AND l.timestamp >= $2
    AND l.timestamp < $3`;

export interface ReportStatement {
  name: string;
  sql: string;
  params: unknown[];
}

export function contextReportStatements(input: {
  agent: string;
  since: Date;
  until: Date;
  localToolNames: readonly string[];
}): ReportStatement[] {
  const windowParams: unknown[] = [input.agent, input.since, input.until];
  const archiveParams: unknown[] = [...windowParams, input.localToolNames];
  return [
    {
      name: 'archive',
      sql: `SELECT a.audit_event_id, a.created_at, ${archiveMetricSelectList('$4', 'window')}
        ${ARCHIVE_WINDOW}
        ORDER BY a.created_at ASC, a.audit_event_id ASC`,
      params: archiveParams,
    },
    {
      name: 'offered',
      // CROSS JOIN stays in FROM. ARCHIVE_WINDOW puts WHERE first, so it cannot
      // be reused here — a join after WHERE is a syntax error.
      sql: `SELECT DISTINCT elem->>'name' AS tool_name
        FROM llm_call_archive a
        JOIN audit_log l ON l.id = a.audit_event_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.tool_definitions) = 'array' THEN a.tool_definitions ELSE '[]'::jsonb END
        ) AS elem
        WHERE l.event_type = 'llm.call'
          AND l.payload->>'agentId' = $1
          AND a.created_at >= $2
          AND a.created_at < $3
          AND elem->>'name' IS NOT NULL
          AND elem->>'name' <> ''`,
      params: windowParams,
    },
    {
      name: 'tokens',
      sql: `SELECT (l.payload->>'inputTokens')::double precision AS input_tokens
        ${AUDIT_WINDOW}
        AND l.event_type = 'llm.call'
        AND jsonb_typeof(l.payload->'inputTokens') = 'number'`,
      params: windowParams,
    },
    {
      name: 'budget',
      sql: `SELECT l.payload->'tiers' AS tiers
        ${AUDIT_WINDOW}
        AND l.event_type = 'context.budget'`,
      params: windowParams,
    },
    {
      name: 'invocations',
      sql: `SELECT COALESCE(
          NULLIF(CASE
            WHEN l.target_type = 'skill'
             AND l.target_id IS NOT NULL
             AND l.target_id <> '[EXTRACTION_FAILED]'
            THEN l.target_id
          END, ''),
          NULLIF(l.payload->>'toolName', ''),
          NULLIF(l.payload->>'skillName', '')
        ) AS tool_name,
        count(*)::bigint AS calls
        ${AUDIT_WINDOW}
        AND l.event_type IN ('tool.invoke', 'skill.invoke')
        GROUP BY 1
        ORDER BY calls DESC, tool_name ASC`,
      params: windowParams,
    },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function requireBigint(value: unknown, column: string): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `report-agent-context: column "${column}" was ${JSON.stringify(value)}, not a safe integer`,
    );
  }
  return n;
}

function requireFinite(value: unknown, column: string): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new Error(
      `report-agent-context: column "${column}" was ${JSON.stringify(value)}, not a number`,
    );
  }
  return n;
}

function requireText(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `report-agent-context: column "${column}" was ${JSON.stringify(value)}, not a non-empty string`,
    );
  }
  return value;
}

export function parseLatestTools(value: unknown): LatestToolRow[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error('report-agent-context: latest_tools was not an array');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`report-agent-context: latest_tools[${index}] was not an object`);
    }
    const row = entry as Record<string, unknown>;
    const name = row['name'];
    if (name !== null && typeof name !== 'string') {
      throw new Error(`report-agent-context: latest_tools[${index}].name was ${JSON.stringify(name)}`);
    }
    return {
      name: name === '' ? null : name,
      bytes: requireBigint(row['bytes'], `latest_tools[${index}].bytes`),
    };
  });
}

export function parseBudgetTiers(value: unknown): TierSample[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error('report-agent-context: context.budget tiers was not an array');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`report-agent-context: tier ${index} was not an object`);
    }
    const row = entry as Record<string, unknown>;
    const dropped = row['droppedReason'];
    if (dropped != null && typeof dropped !== 'string') {
      throw new Error(`report-agent-context: tier ${index} droppedReason was not a string`);
    }
    return {
      name: requireText(row['name'], `tier ${index} name`),
      estimatedTokens: requireFinite(row['estimatedTokens'], `tier ${index} estimatedTokens`),
      included: row['included'] === true || row['included'] === 'true',
      droppedReason: dropped == null || dropped === '' ? null : dropped,
    };
  });
}

function parseArchiveRow(row: Record<string, unknown>): ArchiveCall {
  const createdRaw = row['created_at'];
  const createdAt = createdRaw instanceof Date
    ? createdRaw
    : typeof createdRaw === 'string'
      ? new Date(createdRaw)
      : new Date(Number.NaN);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `report-agent-context: created_at was ${JSON.stringify(createdRaw)}, not a timestamp`,
    );
  }
  const toolCount = requireBigint(row['tool_count'], 'tool_count');
  const localToolCount = requireBigint(row['local_tool_count'], 'local_tool_count');
  const otherToolCount = requireBigint(row['other_tool_count'], 'other_tool_count');
  if (localToolCount + otherToolCount !== toolCount) {
    throw new Error(
      `report-agent-context: tool counts do not add up (${localToolCount} local + ${otherToolCount} other != ${toolCount})`,
    );
  }
  const toolDefinitionBytes = requireBigint(row['tool_definition_bytes'], 'tool_definition_bytes');
  const localBytes = requireBigint(row['local_bytes'], 'local_bytes');
  const otherBytes = requireBigint(row['other_bytes'], 'other_bytes');
  const framingBytes = toolDefinitionBytes - localBytes - otherBytes;
  if (framingBytes < 0) {
    throw new Error(
      `report-agent-context: tool-definition bytes ${toolDefinitionBytes} are smaller than the per-source sums`,
    );
  }
  const latestRaw = row['latest_tools'];
  return {
    id: requireText(row['audit_event_id'], 'audit_event_id'),
    createdAt,
    systemChars: requireBigint(row['system_chars'], 'system_chars'),
    toolCount,
    toolDefinitionBytes,
    localBytes,
    localToolCount,
    otherBytes,
    otherToolCount,
    framingBytes,
    latestTools: latestRaw == null ? null : parseLatestTools(latestRaw),
  };
}

function sourceDistributions(
  calls: readonly ArchiveCall[],
  otherLabel: string,
): { sources: SourceDistribution[]; framingBytes: Distribution } {
  return {
    sources: [
      {
        source: 'local',
        bytes: distribution(calls.map(call => call.localBytes)),
        toolCount: distribution(calls.map(call => call.localToolCount)),
      },
      {
        source: otherLabel,
        bytes: distribution(calls.map(call => call.otherBytes)),
        toolCount: distribution(calls.map(call => call.otherToolCount)),
      },
    ],
    framingBytes: distribution(calls.map(call => call.framingBytes)),
  };
}

function sliceMetrics(calls: readonly ArchiveCall[], otherLabel: string): {
  systemChars: Distribution;
  toolCount: Distribution;
  toolDefinitionBytes: Distribution;
  sources: SourceDistribution[];
  framingBytes: Distribution;
} {
  const split = sourceDistributions(calls, otherLabel);
  return {
    systemChars: distribution(calls.map(call => call.systemChars)),
    toolCount: distribution(calls.map(call => call.toolCount)),
    toolDefinitionBytes: distribution(calls.map(call => call.toolDefinitionBytes)),
    sources: split.sources,
    framingBytes: split.framingBytes,
  };
}

function modalToolCount(calls: readonly ArchiveCall[]): number | null {
  if (calls.length === 0) return null;
  const counts = new Map<number, number>();
  for (const call of calls) {
    counts.set(call.toolCount, (counts.get(call.toolCount) ?? 0) + 1);
  }
  let bestCount = 0;
  let bestN = -1;
  for (const [count, n] of counts) {
    if (n > bestN || (n === bestN && count < bestCount)) {
      bestN = n;
      bestCount = count;
    }
  }
  return bestCount;
}

function tierRank(name: string): number {
  const index = TIER_ORDER.indexOf(name as (typeof TIER_ORDER)[number]);
  return index === -1 ? TIER_ORDER.length : index;
}

export function buildReport(input: BuildInput): AgentContextReport {
  const otherLabel = otherSourceLabel(input.catalog.mcpServers);
  const localNames = new Set(input.catalog.localToolNames);
  const calls = input.calls;
  const all = sliceMetrics(calls, otherLabel);
  const modalCount = modalToolCount(calls);
  const modalCalls = modalCount === null ? [] : calls.filter(call => call.toolCount === modalCount);
  const modal = modalCalls.length === calls.length || modalCount === null
    ? null
    : sliceMetrics(modalCalls, otherLabel);

  // The SQL marks exactly one row — the newest by (created_at, id) — with the
  // per-tool breakdown. Trust that flag rather than re-sorting here: UUID
  // ordering in Postgres is not the same function as String#localeCompare.
  const flagged = calls.filter(call => call.latestTools !== null);
  if (flagged.length > 1) {
    throw new Error('report-agent-context: more than one archive row carried a tool breakdown');
  }
  if (calls.length > 0 && flagged.length === 0) {
    throw new Error('report-agent-context: the newest archive row did not carry its tool breakdown');
  }
  const latestCall = flagged[0] ?? null;
  let latest: AgentContextReport['latest'] = null;
  if (latestCall) {
    if (latestCall.latestTools === null) {
      throw new Error('report-agent-context: the newest archive row did not carry its tool breakdown');
    }
    const tools: LatestTool[] = latestCall.latestTools.map(tool => {
      const name = tool.name ?? '(unnamed)';
      return {
        name,
        source: classifyToolSource(name, localNames, input.catalog.mcpServers),
        bytes: tool.bytes,
      };
    });
    tools.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    if (latestCall.toolCount > 0 && tools.length !== latestCall.toolCount) {
      throw new Error(
        `report-agent-context: latest tool list has ${tools.length} entries but tool_count is ${latestCall.toolCount}`,
      );
    }
    const listedLocal = tools.filter(tool => tool.source === 'local').reduce((sum, tool) => sum + tool.bytes, 0);
    const listedOther = tools.filter(tool => tool.source !== 'local').reduce((sum, tool) => sum + tool.bytes, 0);
    if (latestCall.toolCount > 0 && (listedLocal !== latestCall.localBytes || listedOther !== latestCall.otherBytes)) {
      throw new Error('report-agent-context: latest tool bytes do not match the per-source sums on that call');
    }
    const bySource = new Map<string, LatestSource>();
    for (const tool of tools) {
      const existing = bySource.get(tool.source);
      if (existing) {
        existing.bytes += tool.bytes;
        existing.toolCount += 1;
      } else {
        bySource.set(tool.source, { source: tool.source, bytes: tool.bytes, toolCount: 1 });
      }
    }
    // A non-array tool_definitions blob has no elements to list, but its bytes
    // still sit in otherBytes. Show them on the same source as the p50 row.
    if (tools.length === 0 && latestCall.otherBytes > 0) {
      bySource.set(otherLabel, { source: otherLabel, bytes: latestCall.otherBytes, toolCount: 0 });
    }
    latest = {
      systemChars: latestCall.systemChars,
      toolCount: latestCall.toolCount,
      toolDefinitionBytes: latestCall.toolDefinitionBytes,
      sources: [...bySource.values()].sort((a, b) => compareSources(a.source, b.source)),
      framingBytes: latestCall.framingBytes,
      tools,
    };
  }

  const offered = new Set(input.offeredToolNames);
  const pinnedLocal = new Set(input.catalog.localPinnedTools);
  const invocations: ToolUsage[] = input.invocations
    .map(row => {
      const source = row.toolName === '(unnamed)'
        ? 'unattributed'
        : classifyToolSource(row.toolName, localNames, input.catalog.mcpServers);
      const pinned = pinnedLocal.has(row.toolName)
        || (source.startsWith('mcp:') && (offered.has(row.toolName) || input.catalog.mcpServers.length === 1));
      return { toolName: row.toolName, calls: row.calls, pinned, source };
    })
    .sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
  const invoked = new Set(invocations.map(row => row.toolName));

  const pinnedZeroCalls: Array<{ toolName: string; source: string }> = [];
  for (const name of [...pinnedLocal].sort()) {
    if (!invoked.has(name)) pinnedZeroCalls.push({ toolName: name, source: 'local' });
  }
  const offeredNonLocal = [...offered]
    .filter(name => !localNames.has(name))
    .sort();
  for (const name of offeredNonLocal) {
    if (!invoked.has(name)) {
      pinnedZeroCalls.push({
        toolName: name,
        source: classifyToolSource(name, localNames, input.catalog.mcpServers),
      });
    }
  }
  const mcpToolsObserved = new Set<string>(offeredNonLocal);
  for (const row of invocations) {
    if (row.source.startsWith('mcp:')) mcpToolsObserved.add(row.toolName);
  }

  const tiersByName = new Map<string, TierSample[]>();
  for (const sample of input.tierSamples) {
    const list = tiersByName.get(sample.name);
    if (list) list.push(sample);
    else tiersByName.set(sample.name, [sample]);
  }
  const tiers: TierSummary[] = [...tiersByName.entries()]
    .map(([name, samples]) => ({
      name,
      samples: samples.length,
      included: samples.filter(sample => sample.included).length,
      droppedBudget: samples.filter(sample => sample.droppedReason === 'budget_exceeded').length,
      droppedEmpty: samples.filter(sample => sample.droppedReason === 'empty').length,
      droppedOther: samples.filter(sample => (
        !sample.included
        && sample.droppedReason !== 'budget_exceeded'
        && sample.droppedReason !== 'empty'
        && sample.droppedReason !== null
      )).length,
      includedTokens: distribution(
        samples.filter(sample => sample.included).map(sample => sample.estimatedTokens),
      ),
    }))
    .sort((a, b) => tierRank(a.name) - tierRank(b.name) || a.name.localeCompare(b.name));

  return {
    agent: input.agent,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    mcpServers: [...input.catalog.mcpServers],
    unresolvedPins: [...input.catalog.unresolvedPins],
    missingPinnedTools: [...input.catalog.missingPinnedTools],
    archiveCalls: calls.length,
    tokenSamples: input.inputTokens.length,
    budgetEvents: input.budgetEvents,
    systemChars: all.systemChars,
    toolCount: all.toolCount,
    toolDefinitionBytes: all.toolDefinitionBytes,
    sources: all.sources,
    framingBytes: all.framingBytes,
    modalToolCount: modalCount,
    modalCalls: modalCalls.length,
    modal,
    latestCallAt: latestCall ? latestCall.createdAt.toISOString() : null,
    latest,
    inputTokens: distribution(input.inputTokens),
    tiers,
    invocations,
    pinnedZeroCalls,
    mcpToolsObserved: mcpToolsObserved.size,
  };
}

function compareSources(a: string, b: string): number {
  const rank = (source: string): number => {
    if (source === 'local') return 0;
    if (source === 'unattributed') return 2;
    return 1;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

function asRows(result: { rows: unknown[] }): Array<Record<string, unknown>> {
  return result.rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`report-agent-context: row ${index} was not an object`);
    }
    return row as Record<string, unknown>;
  });
}

export async function runAgentContextReport(
  db: Queryable,
  input: { agent: string; since: Date; until: Date; catalog: AgentPinCatalog },
): Promise<AgentContextReport> {
  const statements = contextReportStatements({
    agent: input.agent,
    since: input.since,
    until: input.until,
    localToolNames: input.catalog.localToolNames,
  });
  const results = new Map<string, Array<Record<string, unknown>>>();
  for (const statement of statements) {
    assertReadOnlySelect(statement.sql);
    const result = await db.query(statement.sql, statement.params);
    results.set(statement.name, asRows(result));
  }

  const archiveRows = results.get('archive') ?? [];
  const calls = archiveRows.map(parseArchiveRow);
  const latestFlags = calls.filter(call => call.latestTools !== null);
  if (calls.length > 0 && latestFlags.length !== 1) {
    throw new Error(
      `report-agent-context: expected one newest archive row, found ${latestFlags.length}`,
    );
  }

  const offeredToolNames = (results.get('offered') ?? []).map(row => (
    requireText(row['tool_name'], 'tool_name')
  ));
  const inputTokens = (results.get('tokens') ?? []).map(row => (
    requireFinite(row['input_tokens'], 'input_tokens')
  ));
  const budgetRows = results.get('budget') ?? [];
  const tierSamples = budgetRows.flatMap(row => parseBudgetTiers(row['tiers']));
  const invocations = (results.get('invocations') ?? []).map(row => ({
    toolName: typeof row['tool_name'] === 'string' && row['tool_name'] !== ''
      ? row['tool_name']
      : '(unnamed)',
    calls: requireBigint(row['calls'], 'calls'),
  }));

  return buildReport({
    agent: input.agent,
    since: input.since,
    until: input.until,
    catalog: input.catalog,
    calls,
    offeredToolNames,
    inputTokens,
    budgetEvents: budgetRows.length,
    tierSamples,
    invocations,
  });
}

interface Releasable {
  query: Queryable['query'];
  release: () => void;
}

/**
 * One session, forced read-only, so a future edit that adds a write fails
 * closed even if the SELECT guard is bypassed. RESET runs before release so
 * the setting does not stick to a pooled client.
 */
export async function withReadOnlyClient<T>(
  pool: { connect: () => Promise<Releasable> },
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '300s'");
    return await fn(client);
  } finally {
    try {
      await client.query('RESET statement_timeout');
      await client.query('RESET default_transaction_read_only');
    } catch (err) {
      logger.error({ err }, 'report-agent-context: failed to reset the read-only session');
    }
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function payloadRows(report: {
  systemChars: Distribution;
  toolCount: Distribution;
  toolDefinitionBytes: Distribution;
  sources: SourceDistribution[];
  framingBytes: Distribution;
}): Array<[string, Distribution]> {
  const rows: Array<[string, Distribution]> = [
    ['system-string chars', report.systemChars],
    ['tool count', report.toolCount],
    ['tool-definition bytes', report.toolDefinitionBytes],
  ];
  for (const source of report.sources) {
    rows.push([`${source.source} bytes`, source.bytes]);
    rows.push([`${source.source} tools`, source.toolCount]);
  }
  rows.push(['json-framing bytes', report.framingBytes]);
  return rows;
}

export function formatReport(report: AgentContextReport): string {
  const lines: string[] = [
    `Agent context report — ${report.agent}`,
    `Window: ${report.since} ≤ t < ${report.until}`,
    '',
    'System-string chars count every role=system message in the archived prompt',
    '(the YAML prompt plus later injected blocks). Tool-definition bytes are',
    'octet_length of the stored jsonb. Source bytes sum each tool object;',
    'json-framing is the array punctuation left over. When the agent pins one',
    'MCP server, every tool that is not in the on-disk local catalog is charged',
    'to that server.',
    '',
    `MCP servers pinned: ${report.mcpServers.length === 0 ? '(none)' : report.mcpServers.join(', ')}`,
    `Unresolved pins: ${report.unresolvedPins.length === 0 ? '(none)' : report.unresolvedPins.join(', ')}`,
    `Pinned tools missing on disk: ${report.missingPinnedTools.length === 0 ? '(none)' : report.missingPinnedTools.join(', ')}`,
    '',
    'Samples',
    `  llm_call_archive rows     ${report.archiveCalls}`,
    `  llm.call token samples    ${report.tokenSamples}`,
    `  context.budget events     ${report.budgetEvents}`,
    '',
    'Per-call payload (all archive rows)',
    '  metric                         p50        p95',
  ];

  for (const [label, dist] of payloadRows(report)) {
    lines.push(`  ${label.padEnd(28)} ${formatNumber(dist.p50).padStart(8)} ${formatNumber(dist.p95).padStart(10)}`);
  }

  if (report.modalToolCount === null) {
    lines.push('', 'Modal tool count: n/a');
  } else if (report.modal === null) {
    lines.push('', `Modal tool count: ${report.modalToolCount} (every archive row)`);
  } else {
    lines.push(
      '',
      `Modal tool count: ${report.modalToolCount} (${report.modalCalls} of ${report.archiveCalls} calls — the usual fixed tool list; skill-activate grows the rest)`,
      '  metric                         p50        p95',
    );
    for (const [label, dist] of payloadRows(report.modal)) {
      lines.push(`  ${label.padEnd(28)} ${formatNumber(dist.p50).padStart(8)} ${formatNumber(dist.p95).padStart(10)}`);
    }
  }

  lines.push('', `Latest call: ${report.latestCallAt ?? 'n/a'}`);
  if (report.latest) {
    lines.push(
      `  system-string chars            ${report.latest.systemChars}`,
      `  tool count                     ${report.latest.toolCount}`,
      `  tool-definition bytes          ${report.latest.toolDefinitionBytes}`,
    );
    for (const source of report.latest.sources) {
      lines.push(`  ${source.source.padEnd(28)} ${source.toolCount} tools, ${source.bytes} bytes`);
    }
    lines.push(`  json-framing bytes             ${report.latest.framingBytes}`);
    if (report.latest.tools.length > 0) {
      lines.push('  tools:');
      for (const tool of report.latest.tools) {
        lines.push(`    ${tool.name.padEnd(32)} ${tool.source.padEnd(28)} ${tool.bytes}`);
      }
    }
  }

  lines.push(
    '',
    'Provider input tokens (llm.call)',
    `  n    ${report.inputTokens.n}`,
    `  p50  ${formatNumber(report.inputTokens.p50)}`,
    `  p95  ${formatNumber(report.inputTokens.p95)}`,
    '',
    'Context budget tiers (estimated tokens when the block was included)',
    '  tier                        samples  included      p50      p95  dropped',
  );
  if (report.tiers.length === 0) {
    lines.push('  (no context.budget tiers in the window)');
  }
  for (const tier of report.tiers) {
    const dropped = `budget ${tier.droppedBudget}, empty ${tier.droppedEmpty}, other ${tier.droppedOther}`;
    lines.push(
      `  ${tier.name.padEnd(26)} ${String(tier.samples).padStart(7)} ${String(tier.included).padStart(9)} ${formatNumber(tier.includedTokens.p50).padStart(8)} ${formatNumber(tier.includedTokens.p95).padStart(8)}  ${dropped}`,
    );
  }

  lines.push('', 'Tool invocations', '  tool                            calls  pinned  source');
  if (report.invocations.length === 0) {
    lines.push('  (none)');
  }
  for (const row of report.invocations) {
    lines.push(
      `  ${row.toolName.padEnd(30)} ${String(row.calls).padStart(7)}  ${row.pinned ? 'yes' : 'no '}     ${row.source}`,
    );
  }

  lines.push('', 'Pinned tools with zero calls');
  if (report.pinnedZeroCalls.length === 0) {
    lines.push('  (none)');
  }
  for (const row of report.pinnedZeroCalls) {
    lines.push(`  ${row.toolName} (${row.source})`);
  }
  if (report.mcpServers.length > 0 && report.mcpToolsObserved === 0) {
    lines.push('  (no MCP tool names in this window — the live server membership is unknown, so those zero-call tools are not listed)');
  }
  return lines.join('\n');
}

export function formatReportMarkdown(report: AgentContextReport): string {
  const lines: string[] = [
    `### ${report.agent} — window ending ${report.until}`,
    '',
    `Window \`${report.since}\` ≤ t < \`${report.until}\`. Archive rows: ${report.archiveCalls}. llm.call token samples: ${report.tokenSamples}. context.budget events: ${report.budgetEvents}.`,
    '',
    `MCP servers pinned: ${report.mcpServers.length === 0 ? '(none)' : report.mcpServers.map(name => `\`${name}\``).join(', ')}. Unresolved pins: ${report.unresolvedPins.length === 0 ? '(none)' : report.unresolvedPins.map(name => `\`${name}\``).join(', ')}. Pinned tools missing on disk: ${report.missingPinnedTools.length === 0 ? '(none)' : report.missingPinnedTools.map(name => `\`${name}\``).join(', ')}.`,
    '',
    'System-string chars count every `role=system` message in the archived prompt. Tool-definition bytes are `octet_length` of the stored jsonb. A single pinned MCP server owns every tool that is not in the on-disk local catalog. `json-framing` is array punctuation, so source bytes plus framing equal the total on a single call. Percentiles are `percentile_cont` and do not sum across rows.',
    '',
    '#### Per-call payload',
    '',
    '| Metric | p50 | p95 |',
    '|---|---:|---:|',
  ];
  for (const [label, dist] of payloadRows(report)) {
    lines.push(`| ${label} | ${formatNumber(dist.p50)} | ${formatNumber(dist.p95)} |`);
  }

  if (report.modal) {
    lines.push(
      '',
      `#### Modal tool count ${report.modalToolCount} (${report.modalCalls} of ${report.archiveCalls} calls)`,
      '',
      'The usual fixed tool list. Later calls in a task grow when `skill-activate` adds tools.',
      '',
      '| Metric | p50 | p95 |',
      '|---|---:|---:|',
    );
    for (const [label, dist] of payloadRows(report.modal)) {
      lines.push(`| ${label} | ${formatNumber(dist.p50)} | ${formatNumber(dist.p95)} |`);
    }
  } else if (report.modalToolCount !== null) {
    lines.push('', `Modal tool count ${report.modalToolCount} covers every archive row.`);
  }

  lines.push('', '#### Latest call', '');
  if (!report.latest || report.latestCallAt === null) {
    lines.push('No archive rows in the window.');
  } else {
    lines.push(
      `At \`${report.latestCallAt}\`. System-string chars ${report.latest.systemChars}. Tool count ${report.latest.toolCount}. Tool-definition bytes ${report.latest.toolDefinitionBytes}. json-framing ${report.latest.framingBytes}.`,
      '',
      '| Source | Tools | Bytes |',
      '|---|---:|---:|',
    );
    for (const source of report.latest.sources) {
      lines.push(`| ${source.source} | ${source.toolCount} | ${source.bytes} |`);
    }
    if (report.latest.tools.length > 0) {
      lines.push('', '| Tool | Source | Bytes |', '|---|---|---:|');
      for (const tool of report.latest.tools) {
        lines.push(`| \`${tool.name}\` | ${tool.source} | ${tool.bytes} |`);
      }
    }
  }

  lines.push(
    '',
    '#### Provider input tokens',
    '',
    `n=${report.inputTokens.n}, p50 ${formatNumber(report.inputTokens.p50)}, p95 ${formatNumber(report.inputTokens.p95)}.`,
    '',
    '#### Context budget tiers',
    '',
    'Estimated tokens of each injected block on the samples where it was included.',
    '',
    '| Tier | Samples | Included | p50 | p95 | Dropped (budget / empty / other) |',
    '|---|---:|---:|---:|---:|---|',
  );
  if (report.tiers.length === 0) {
    lines.push('| (none) | 0 | 0 | n/a | n/a | |');
  }
  for (const tier of report.tiers) {
    lines.push(
      `| ${tier.name} | ${tier.samples} | ${tier.included} | ${formatNumber(tier.includedTokens.p50)} | ${formatNumber(tier.includedTokens.p95)} | ${tier.droppedBudget} / ${tier.droppedEmpty} / ${tier.droppedOther} |`,
    );
  }

  lines.push(
    '',
    '#### Tool invocations',
    '',
    '| Tool | Calls | Pinned | Source |',
    '|---|---:|---|---|',
  );
  if (report.invocations.length === 0) {
    lines.push('| (none) | 0 | | |');
  }
  for (const row of report.invocations) {
    lines.push(`| \`${row.toolName}\` | ${row.calls} | ${row.pinned ? 'yes' : 'no'} | ${row.source} |`);
  }

  lines.push('', '#### Pinned tools with zero calls', '');
  if (report.pinnedZeroCalls.length === 0) {
    lines.push('(none)');
  }
  for (const row of report.pinnedZeroCalls) {
    lines.push(`- \`${row.toolName}\` (${row.source})`);
  }
  if (report.mcpServers.length > 0 && report.mcpToolsObserved === 0) {
    lines.push('', 'No MCP tool names appeared in this window, so the live server membership is unknown and those zero-call tools are not listed.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args: ReportArgs;
  try {
    args = parseReportArgs(process.argv.slice(2), new Date());
  } catch (err) {
    if (err instanceof Error && err.message === 'HELP') {
      process.stdout.write(`${usageText()}\n`);
      return;
    }
    logger.error({ err }, 'report-agent-context: bad arguments');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('report-agent-context: DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  let catalog: AgentPinCatalog;
  try {
    catalog = loadAgentPinCatalog(REPO_ROOT, args.agent);
  } catch (err) {
    logger.error({ err }, 'report-agent-context: failed to load the agent catalog');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const report = await withReadOnlyClient(pool, client => runAgentContextReport(client, {
      agent: args.agent,
      since: args.since,
      until: args.until,
      catalog,
    }));
    const body = args.format === 'json'
      ? JSON.stringify(report, null, 2)
      : args.format === 'markdown'
        ? formatReportMarkdown(report)
        : formatReport(report);
    process.stdout.write(`${body}\n`);
    logger.info(
      { agent: args.agent, archiveCalls: report.archiveCalls, tokenSamples: report.tokenSamples },
      'report-agent-context: done',
    );
  } catch (err) {
    logger.error({ err }, 'report-agent-context: fatal error');
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'report-agent-context: failed to close the pool');
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
