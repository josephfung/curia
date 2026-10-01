// scripts/report-agent-context.test.ts
//
// The report is the baseline for the coordinator context diet (#1955). A wrong
// percentile or a tool charged to the wrong source would make every later
// before/after comparison lie, so the assembly, the pin expansion, and the
// SQL shape are tested here. The jsonb metric expressions are checked against
// Postgres when DATABASE_URL is set.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import {
  archiveMetricProbeSql,
  assertReadOnlySelect,
  buildReport,
  classifyToolSource,
  contextReportStatements,
  distribution,
  expandPins,
  formatReport,
  formatReportMarkdown,
  loadAgentPinCatalog,
  parseBudgetTiers,
  parseLatestTools,
  parseReportArgs,
  percentileCont,
  runAgentContextReport,
  type AgentPinCatalog,
} from './report-agent-context.js';

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function scriptedDb(rowsByName: Record<string, unknown[]>): Queryable & { sql: string[] } {
  const statements = contextReportStatements({
    agent: 'coordinator',
    since: new Date('2026-09-01T00:00:00.000Z'),
    until: new Date('2026-10-01T00:00:00.000Z'),
    localToolNames: ['email-get', 'delegate'],
  });
  const sql: string[] = [];
  return {
    sql,
    query: (text: string) => {
      sql.push(text);
      const statement = statements.find(item => text === item.sql);
      if (!statement) {
        throw new Error(`unexpected SQL: ${text.slice(0, 80)}`);
      }
      return Promise.resolve({ rows: rowsByName[statement.name] ?? [] });
    },
  };
}

const catalog: AgentPinCatalog = {
  agentName: 'coordinator',
  localPinnedTools: ['email-get', 'delegate'],
  mcpServers: ['google-workspace'],
  unresolvedPins: [],
  missingPinnedTools: [],
  localToolNames: ['email-get', 'delegate', 'web-search'],
};

function archiveRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    audit_event_id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-09-15T00:00:00.000Z',
    system_chars: '100',
    tool_count: '2',
    tool_definition_bytes: '100',
    local_bytes: '40',
    local_tool_count: '1',
    other_bytes: '50',
    other_tool_count: '1',
    latest_tools: null,
    ...overrides,
  };
}

describe('percentileCont', () => {
  it('matches Postgres percentile_cont on an even sample', () => {
    const sorted = [1, 2, 3, 4];
    expect(percentileCont(sorted, 0.5)).toBe(2.5);
    expect(percentileCont(sorted, 0.95)).toBeCloseTo(3.85);
    expect(percentileCont(sorted, 0)).toBe(1);
    expect(percentileCont(sorted, 1)).toBe(4);
  });

  it('returns the only sample for both percentiles', () => {
    expect(distribution([42])).toEqual({ n: 1, p50: 42, p95: 42 });
  });

  it('returns null percentiles for an empty sample', () => {
    expect(distribution([])).toEqual({ n: 0, p50: null, p95: null });
  });

  it('does not mutate the input', () => {
    const values = [3, 1, 2];
    distribution(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('parseReportArgs', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');

  it('defaults to a 30-day window ending at now', () => {
    const args = parseReportArgs(['--agent', 'coordinator'], now);
    expect(args.agent).toBe('coordinator');
    expect(args.until.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(args.since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(args.format).toBe('text');
  });

  it('rejects a path-shaped agent name before it can be used as a filename', () => {
    expect(() => parseReportArgs(['--agent', '../etc/passwd'], now)).toThrow(/agent name/);
  });

  it('rejects combining --days with --since', () => {
    expect(() => parseReportArgs([
      '--agent', 'coordinator',
      '--days', '7',
      '--since', '2026-09-01T00:00:00.000Z',
    ], now)).toThrow(/either --days or --since/);
  });

  it('rejects a window that does not move forward', () => {
    expect(() => parseReportArgs([
      '--agent', 'coordinator',
      '--since', '2026-10-01T00:00:00.000Z',
      '--until', '2026-09-01T00:00:00.000Z',
    ], now)).toThrow(/earlier than --until/);
  });

  it('accepts markdown output', () => {
    const args = parseReportArgs(['--agent', 'coordinator', '--format', 'markdown'], now);
    expect(args.format).toBe('markdown');
  });
});

describe('expandPins', () => {
  const bundles = new Map<string, readonly string[]>([
    ['email', ['email-get', 'email-send']],
  ]);
  const local = new Set(['email-get', 'email-send', 'delegate']);
  const mcp = new Set(['google-workspace', 'delegate']);

  it('expands a bundle, keeps a singleton tool, and records an MCP server', () => {
    const expanded = expandPins(
      ['email', 'delegate', 'google-workspace', 'nope'],
      bundles,
      local,
      new Set(['google-workspace']),
    );
    expect(expanded.localPinnedTools).toEqual(['email-get', 'email-send', 'delegate']);
    expect(expanded.mcpServers).toEqual(['google-workspace']);
    expect(expanded.unresolvedPins).toEqual(['nope']);
    expect(expanded.missingPinnedTools).toEqual([]);
  });

  it('lets a bundle win over an MCP server of the same name', () => {
    const expanded = expandPins(['email'], bundles, local, new Set(['email']));
    expect(expanded.localPinnedTools).toEqual(['email-get', 'email-send']);
    expect(expanded.mcpServers).toEqual([]);
  });

  it('lets an MCP server win over a tool of the same name', () => {
    // Runtime registers the projected skill before pin resolution, so the
    // server name is a skill pin, not a one-tool pin.
    const expanded = expandPins(['delegate'], bundles, local, mcp);
    expect(expanded.mcpServers).toEqual(['delegate']);
    expect(expanded.localPinnedTools).toEqual([]);
  });

  it('records a bundle member that has no tool.json instead of charging it to MCP', () => {
    const expanded = expandPins(
      ['email'],
      new Map([['email', ['email-get', 'email-gone']]]),
      new Set(['email-get']),
      mcp,
    );
    expect(expanded.missingPinnedTools).toEqual(['email-gone']);
    expect(expanded.localPinnedTools).toContain('email-gone');
  });
});

describe('classifyToolSource', () => {
  it('charges non-local tools to the only pinned MCP server', () => {
    const local = new Set(['email-get']);
    expect(classifyToolSource('email-get', local, ['google-workspace'])).toBe('local');
    expect(classifyToolSource('search_drive_files', local, ['google-workspace'])).toBe('mcp:google-workspace');
  });

  it('leaves non-local tools unattributed when more than one MCP server is pinned', () => {
    expect(classifyToolSource('search_drive_files', new Set(), ['google-workspace', 'other']))
      .toBe('unattributed');
  });
});

describe('SQL safety', () => {
  it('allows a SELECT that mentions llm.call inside a string literal', () => {
    expect(() => assertReadOnlySelect(
      "SELECT payload FROM audit_log WHERE event_type = 'llm.call'",
    )).not.toThrow();
  });

  it('rejects a second statement and a write verb', () => {
    expect(() => assertReadOnlySelect('SELECT 1; DELETE FROM audit_log')).toThrow(/non-SELECT/);
    expect(() => assertReadOnlySelect('INSERT INTO audit_log VALUES (1)')).toThrow(/non-SELECT/);
    expect(() => assertReadOnlySelect("SELECT 'delete' FROM audit_log")).not.toThrow();
  });

  it('builds five single SELECTs, with the offered-tool join before WHERE', () => {
    const statements = contextReportStatements({
      agent: 'coordinator',
      since: new Date('2026-09-01T00:00:00.000Z'),
      until: new Date('2026-10-01T00:00:00.000Z'),
      localToolNames: ['email-get'],
    });
    expect(statements.map(statement => statement.name)).toEqual([
      'archive', 'offered', 'tokens', 'budget', 'invocations',
    ]);
    for (const statement of statements) {
      expect(() => assertReadOnlySelect(statement.sql)).not.toThrow();
    }
    const offered = statements[1]!;
    expect(offered.sql.indexOf('CROSS JOIN')).toBeGreaterThan(offered.sql.indexOf('FROM'));
    expect(offered.sql.indexOf('CROSS JOIN')).toBeLessThan(offered.sql.search(/\bWHERE\b/));
    expect(offered.sql).not.toContain('skill.invoke');
    const invocations = statements[4]!;
    expect(invocations.sql).toContain("'tool.invoke'");
    expect(invocations.sql).toContain("'skill.invoke'");
    expect(invocations.sql).toContain("'[EXTRACTION_FAILED]'");
  });
});

describe('runAgentContextReport', () => {
  const since = new Date('2026-09-01T00:00:00.000Z');
  const until = new Date('2026-10-01T00:00:00.000Z');

  function run(rowsByName: Record<string, unknown[]>) {
    const db = scriptedDb(rowsByName);
    return runAgentContextReport(db, { agent: 'coordinator', since, until, catalog }).then(report => ({
      report,
      sql: db.sql,
    }));
  }

  it('reports payload percentiles, tokens, tiers, and pinned tools with zero calls', async () => {
    const { report, sql } = await run({
      archive: [
        archiveRow({}),
        archiveRow({
          audit_event_id: '00000000-0000-4000-8000-000000000002',
          created_at: '2026-09-20T00:00:00.000Z',
          system_chars: '120',
          tool_definition_bytes: '105',
          other_bytes: '55',
          latest_tools: [
            { name: 'email-get', bytes: 40 },
            { name: 'search_drive_files', bytes: 55 },
          ],
        }),
      ],
      offered: [
        { tool_name: 'email-get' },
        { tool_name: 'search_drive_files' },
        { tool_name: 'list_drive_items' },
      ],
      tokens: [
        { input_tokens: 1000 },
        { input_tokens: 2000 },
        { input_tokens: 3000 },
        { input_tokens: 4000 },
      ],
      budget: [{
        tiers: [
          { name: 'system_prompt', estimatedTokens: 4000, included: true },
          { name: 'sender_context', estimatedTokens: 0, included: false, droppedReason: 'empty' },
          { name: 'conversation_history', estimatedTokens: 800, included: true },
        ],
      }],
      invocations: [
        { tool_name: 'email-get', calls: '3' },
        { tool_name: 'search_drive_files', calls: '1' },
        { tool_name: 'web-search', calls: '2' },
      ],
    });

    expect(sql).toHaveLength(5);
    expect(report.archiveCalls).toBe(2);
    expect(report.systemChars).toEqual({ n: 2, p50: 110, p95: 119 });
    expect(report.inputTokens).toEqual({ n: 4, p50: 2500, p95: 3850 });
    expect(report.sources.map(source => source.source)).toEqual(['local', 'mcp:google-workspace']);
    expect(report.latestCallAt).toBe('2026-09-20T00:00:00.000Z');
    expect(report.latest?.tools.map(tool => tool.name)).toEqual(['search_drive_files', 'email-get']);
    expect(report.latest?.sources).toEqual([
      { source: 'local', bytes: 40, toolCount: 1 },
      { source: 'mcp:google-workspace', bytes: 55, toolCount: 1 },
    ]);
    expect(report.tiers.map(tier => tier.name)).toEqual([
      'system_prompt',
      'sender_context',
      'conversation_history',
    ]);
    expect(report.tiers[1]).toMatchObject({ included: 0, droppedEmpty: 1, includedTokens: { n: 0, p50: null } });
    expect(report.invocations.find(row => row.toolName === 'web-search')).toMatchObject({
      pinned: false,
      source: 'local',
      calls: 2,
    });
    expect(report.pinnedZeroCalls).toEqual([
      { toolName: 'delegate', source: 'local' },
      { toolName: 'list_drive_items', source: 'mcp:google-workspace' },
    ]);

    const text = formatReport(report);
    expect(text).toContain('system-string chars');
    expect(text).toContain('p50');
    expect(text).toContain('mcp:google-workspace');
    expect(text).toContain('delegate (local)');
    expect(text).toContain('list_drive_items (mcp:google-workspace)');
    expect(text).toContain('Provider input tokens');

    const markdown = formatReportMarkdown(report);
    expect(markdown.startsWith('### coordinator — window ending 2026-10-01T00:00:00.000Z')).toBe(true);
    expect(markdown).toContain('Pinned tools with zero calls');
    expect(markdown).toContain('`delegate` (local)');
  });

  it('throws rather than reporting a call whose source bytes exceed the total', async () => {
    await expect(run({
      archive: [archiveRow({ tool_definition_bytes: '10', local_bytes: '40', other_bytes: '50', latest_tools: [] })],
    })).rejects.toThrow(/smaller than the per-source sums/);
  });

  it('reports an empty window as zero samples, not an error', async () => {
    const { report } = await run({});
    expect(report.archiveCalls).toBe(0);
    expect(report.systemChars.p50).toBeNull();
    expect(report.latest).toBeNull();
    expect(report.pinnedZeroCalls.map(row => row.toolName)).toEqual(['delegate', 'email-get']);
    expect(report.mcpToolsObserved).toBe(0);
    expect(formatReport(report)).toContain('Latest call: n/a');
    expect(formatReport(report)).toContain('live server membership is unknown');
  });
});

describe('parsers', () => {
  it('rejects a context.budget tier that is not an object', () => {
    expect(() => parseBudgetTiers(['nope'])).toThrow(/not an object/);
  });

  it('rejects a latest-tool entry with a non-numeric size', () => {
    expect(() => parseLatestTools([{ name: 'email-get', bytes: 'lots' }])).toThrow(/bytes/);
  });
});

describe('modal tool count', () => {
  it('breaks ties toward the smaller tool count and reports that slice separately', () => {
    const call = (id: string, toolCount: number, latest: boolean) => ({
      id,
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
      systemChars: 10,
      toolCount,
      toolDefinitionBytes: 6,
      localBytes: 4,
      localToolCount: toolCount,
      otherBytes: 0,
      otherToolCount: 0,
      framingBytes: 2,
      latestTools: latest ? [{ name: 'email-get', bytes: 4 }] : null,
    });
    // Two calls at 1 tool and two at 3. The tie breaks toward the smaller count.
    const calls = [
      call('00000000-0000-4000-8000-000000000001', 1, true),
      call('00000000-0000-4000-8000-000000000002', 1, false),
      call('00000000-0000-4000-8000-000000000003', 3, false),
      call('00000000-0000-4000-8000-000000000004', 3, false),
    ];
    const report = buildReport({
      agent: 'coordinator',
      since: new Date('2026-09-01T00:00:00.000Z'),
      until: new Date('2026-10-01T00:00:00.000Z'),
      catalog,
      calls,
      offeredToolNames: [],
      inputTokens: [],
      budgetEvents: 0,
      tierSamples: [],
      invocations: [],
    });
    expect(report.modalToolCount).toBe(1);
    expect(report.modalCalls).toBe(2);
    expect(report.modal).not.toBeNull();
    expect(report.modal?.toolCount).toEqual({ n: 2, p50: 1, p95: 1 });
  });
});

describe('loadAgentPinCatalog', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands the real coordinator pins without leaving any unresolved', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const loaded = loadAgentPinCatalog(repoRoot, 'coordinator');
    expect(loaded.mcpServers).toEqual(['google-workspace']);
    expect(loaded.unresolvedPins).toEqual([]);
    expect(loaded.missingPinnedTools).toEqual([]);
    expect(loaded.localPinnedTools).toContain('email-get');
    expect(loaded.localPinnedTools).toContain('delegate');
    // Polymorphic pin: the tool, not the rest of the learning bundle.
    expect(loaded.localPinnedTools).toContain('list-learning-digest');
    expect(loaded.localPinnedTools).not.toContain('voice-learn');
    expect(loaded.localPinnedTools).not.toContain('google-workspace');
  });

  it('reads a fixture tree and keeps a missing member out of the MCP bucket', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-context-'));
    cleanup.push(root);
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    mkdirSync(path.join(root, 'skills', 'email', 'tools', 'email-get'), { recursive: true });
    mkdirSync(path.join(root, 'skills', 'delegate'), { recursive: true });
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(path.join(root, 'agents', 'helper.yaml'), [
      'name: helper',
      'model:',
      '  tier: fast',
      'system_prompt: hello',
      'pinned_skills:',
      '  - email',
      '  - delegate',
      '  - google-workspace',
      '  - missing-pin',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'skills', 'email', 'SKILL.md'), [
      '---',
      'name: email',
      'description: email tools',
      'tools:',
      '  - email-get',
      '  - email-gone',
      '---',
      '',
    ].join('\n'));
    writeFileSync(
      path.join(root, 'skills', 'email', 'tools', 'email-get', 'tool.json'),
      '{"name":"email-get","description":"get"}\n',
    );
    writeFileSync(
      path.join(root, 'skills', 'delegate', 'tool.json'),
      '{"name":"delegate","description":"delegate"}\n',
    );
    writeFileSync(path.join(root, 'config', 'skills.yaml'), [
      'servers:',
      '  - name: google-workspace',
      '    transport: stdio',
      '    command: uvx',
      '    action_risk: low',
      '',
    ].join('\n'));

    const loaded = loadAgentPinCatalog(root, 'helper');
    expect(loaded.localPinnedTools).toEqual(['email-get', 'email-gone', 'delegate']);
    expect(loaded.missingPinnedTools).toEqual(['email-gone']);
    expect(loaded.mcpServers).toEqual(['google-workspace']);
    expect(loaded.unresolvedPins).toEqual(['missing-pin']);
    expect(loaded.localToolNames).toContain('email-gone');
  });
});

const databaseUrl = process.env['DATABASE_URL'];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('archive metric SQL against Postgres', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it('counts system-string chars and splits tool-definition bytes', async () => {
    const prompt = {
      messages: [
        { role: 'system', content: 'abcd' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'éf' },
            { type: 'image', source: { type: 'url', url: 'https://example.test/x' } },
          ],
        },
        { role: 'user', content: 'IGNORE ME' },
        { role: 'system', content: 'ghij' },
      ],
    };
    const tools = [
      { name: 'email-get', description: 'x' },
      { name: 'search_drive_files', description: 'yy' },
    ];
    // node-pg does not serialize a plain object as json unless the parameter is
    // already text. The production queries read jsonb columns; this probe is the
    // only place we bind jsonb parameters.
    const result = await pool.query(archiveMetricProbeSql(), [
      JSON.stringify(prompt),
      JSON.stringify(tools),
      ['email-get'],
    ]);
    const row = result.rows[0] as Record<string, unknown>;
    // 'abcd' + 'éf' (é is one character) + 'ghij'. The user message and the image block are not counted.
    expect(Number(row['system_chars'])).toBe(4 + 2 + 4);
    expect(Number(row['tool_count'])).toBe(2);
    expect(Number(row['local_tool_count'])).toBe(1);
    expect(Number(row['other_tool_count'])).toBe(1);
    const listed = (row['latest_tools'] as Array<{ name: string; bytes: number }>)
      .reduce((sum, tool) => sum + tool.bytes, 0);
    expect(listed).toBe(Number(row['local_bytes']) + Number(row['other_bytes']));
    expect(Number(row['tool_definition_bytes'])).toBeGreaterThan(listed);
    const localTool = (row['latest_tools'] as Array<{ name: string; bytes: number }>)
      .find(tool => tool.name === 'email-get');
    expect(localTool?.bytes).toBe(Number(row['local_bytes']));
  });

  it('counts a bare message array and treats a non-array tool payload as unsplit bytes', async () => {
    const bare = await pool.query(archiveMetricProbeSql(), [
      JSON.stringify([{ role: 'system', content: 'hi' }]),
      JSON.stringify({ nope: true }),
      [],
    ]);
    const bareRow = bare.rows[0] as Record<string, unknown>;
    expect(Number(bareRow['system_chars'])).toBe(2);
    expect(Number(bareRow['tool_count'])).toBe(0);
    expect(Number(bareRow['local_bytes'])).toBe(0);
    expect(Number(bareRow['other_bytes'])).toBe(Number(bareRow['tool_definition_bytes']));
    expect(bareRow['latest_tools']).toEqual([]);

    const empty = await pool.query(archiveMetricProbeSql(), [
      JSON.stringify({ messages: [] }),
      JSON.stringify([]),
      [],
    ]);
    const emptyRow = empty.rows[0] as Record<string, unknown>;
    expect(Number(emptyRow['system_chars'])).toBe(0);
    expect(Number(emptyRow['tool_count'])).toBe(0);
    expect(Number(emptyRow['tool_definition_bytes'])).toBe(2);
    expect(Number(emptyRow['local_bytes'])).toBe(0);
    expect(Number(emptyRow['other_bytes'])).toBe(0);

    const absent = await pool.query(archiveMetricProbeSql(), [null, null, []]);
    const absentRow = absent.rows[0] as Record<string, unknown>;
    expect(Number(absentRow['system_chars'])).toBe(0);
    expect(Number(absentRow['tool_definition_bytes'])).toBe(0);
    expect(Number(absentRow['other_bytes'])).toBe(0);
  });

  it('plans the report statements when the archive tables exist', async () => {
    const tables = await pool.query<{ archive: string | null; audit: string | null }>(
      `SELECT to_regclass('public.llm_call_archive') AS archive, to_regclass('public.audit_log') AS audit`,
    );
    const present = tables.rows[0];
    if (!present?.archive || !present.audit) return;
    const statements = contextReportStatements({
      agent: 'coordinator',
      since: new Date('2026-09-01T00:00:00.000Z'),
      until: new Date('2026-10-01T00:00:00.000Z'),
      localToolNames: ['email-get'],
    });
    for (const statement of statements) {
      await pool.query(`EXPLAIN ${statement.sql}`, statement.params);
    }
  });
});
