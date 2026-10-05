// config.google-workspace-allowlist.test.ts — the google-workspace MCP server's `--tools`
// allowlist in config/skills.yaml is the only thing that keeps Calendar tools out (#1957).
//
// Calendar tools authenticate as Curia's own Google identity, so a principal calendar
// read through them returns success with an empty calendar (#1853). Until #1957 an
// in-process holdback also dropped them at registration, but it logged at info, so a
// deployment overlay ran with no allowlist at all for months without anyone noticing.
// The holdback is gone; this test catches config drift at PR time instead. curia-deploy
// runs the same rules against its overlay (tests/config/google-workspace-allowlist.test.ts
// there), since that file replaces this one in the production image.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadSkillsConfig } from '../../src/skills/mcp-loader.js';
import type { McpServerEntry } from '../../src/skills/mcp-config-types.js';

const SERVER = 'google-workspace';

// The exact allowlist. Pinned here so widening the coordinator's tool surface takes a
// deliberate edit to this line, not just a config change that passes unremarked. Gmail,
// Tasks and Contacts overlap Curia's own email, task and contacts tools; the rest saw no
// use. Calendar may never be added (see above).
const ALLOWED_SERVICES = ['docs', 'drive', 'sheets'];

/** Every rule the allowlist must meet, as violations (empty = compliant). Pure, so the
 *  negative cases below can show each rule fires instead of passing vacuously. */
function allowlistViolations(servers: McpServerEntry[]): string[] {
  const matches = servers.filter((s) => s.name === SERVER);
  // mcp-loader spawns every entry, so a second entry would be a second server.
  if (matches.length !== 1) return [`expected exactly one '${SERVER}' server, found ${matches.length}`];
  const server = matches[0]!;
  if (server.transport !== 'stdio') return [`expected a stdio '${SERVER}' server`];
  const args = (server.args ?? []).map(String);

  const violations: string[] = [];
  if (args.some((a) => a.toLowerCase().includes('calendar'))) {
    violations.push('args include calendar (#1853)');
  }
  if (args.some((a) => a.startsWith('--tools='))) {
    violations.push('use `--tools a b c`, not `--tools=`; this check cannot read that form');
  }
  // workspace-mcp's argparse keeps the LAST --tools, so a repeat would serve a different
  // list from the one this check reads.
  const toolsFlags = args.filter((a) => a === '--tools').length;
  if (toolsFlags !== 1) {
    violations.push(`expected exactly one --tools flag, found ${toolsFlags}`);
    return violations;
  }

  // --tools is variadic: every argument up to the next flag.
  const services: string[] = [];
  for (const arg of args.slice(args.indexOf('--tools') + 1)) {
    if (arg.startsWith('-')) break;
    services.push(arg);
  }
  const sorted = [...services].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(ALLOWED_SERVICES)) {
    violations.push(`--tools must be exactly [${ALLOWED_SERVICES.join(', ')}], got [${sorted.join(', ')}]`);
  }
  return violations;
}

describe(`${SERVER} --tools allowlist (config/skills.yaml)`, () => {
  it('meets every allowlist rule', () => {
    const configDir = resolve(import.meta.dirname, '../../config');
    expect(allowlistViolations(loadSkillsConfig(configDir).servers ?? [])).toEqual([]);
  });
});

describe('allowlistViolations rejects', () => {
  const ok = ['workspace-mcp', '--tool-tier', 'complete', '--tools', 'drive', 'docs', 'sheets'];
  const server = (args?: string[]): McpServerEntry[] => [
    { name: SERVER, transport: 'stdio', command: 'uvx', args, action_risk: 'medium' } as McpServerEntry,
  ];

  it('accepts the compliant shape (control)', () => {
    expect(allowlistViolations(server(ok))).toEqual([]);
  });

  it.each([
    ['no --tools', ['workspace-mcp', '--tool-tier', 'complete']],
    ['an empty --tools', ['workspace-mcp', '--tools', '--tool-tier', 'complete']],
    ['calendar in --tools', [...ok, 'calendar']],
    ['another service in --tools', [...ok, 'gmail']],
    ['a subset of the allowlist', ['workspace-mcp', '--tools', 'drive', 'docs']],
    ['--tools=<list>', ['workspace-mcp', '--tools=drive,docs,sheets']],
    ['a repeated --tools (argparse keeps the last)', [...ok, '--tools', 'gmail']],
    ['no args at all', undefined],
  ])('%s', (_label, args) => {
    expect(allowlistViolations(server(args))).not.toEqual([]);
  });

  it('a missing or duplicated server entry', () => {
    expect(allowlistViolations([])).not.toEqual([]);
    expect(allowlistViolations([...server(ok), ...server(ok)])).not.toEqual([]);
  });
});
