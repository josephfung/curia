// scripts/report-prompt-budget.ts
//
// Print what an agent's budgeted context is made of: the always-on prompt by
// section (system_prompt headings, then each pinned SKILL.md), every local tool
// definition, and the specialist roster. This is the "full breakdown" a failing
// tests/unit/agents/prompt-budget.test.ts points at (ADR-046).
//
// Local and read-only: it measures the checkout's agents/, skills/ and config/ with
// the same function the test uses (src/agents/prompt-budget.ts). No database, no LLM.
//
//   pnpm report:budget                       # every agent in agents/
//   pnpm report:budget --agent coordinator   # one agent
//
// The budgets themselves live in tests/unit/agents/prompt-budget.test.ts; the failure
// message there states measured against limit.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatContributorTable } from '../src/agents/budget-report.js';
import { CHARS_PER_TOKEN, measureAgentContext, type AgentContextMeasurement } from '../src/agents/prompt-budget.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCES = {
  agentsDir: path.join(REPO_ROOT, 'agents'),
  skillsDir: path.join(REPO_ROOT, 'skills'),
  configDir: path.join(REPO_ROOT, 'config'),
};

export function renderBreakdown(agent: string, m: AgentContextMeasurement): string {
  const rosterTokens = Math.ceil(m.rosterChars / CHARS_PER_TOKEN);
  const out = [
    `${agent}`,
    `  always-on prompt: ~${m.alwaysOnPromptTokens.toLocaleString('en-US')} tokens ` +
      `(system_prompt ${m.yamlChars.toLocaleString('en-US')} chars + SKILL.md ${m.skillMdChars.toLocaleString('en-US')} chars, ${CHARS_PER_TOKEN} chars/token)`,
    formatContributorTable(m.contributors.prompt, 'tokens', m.alwaysOnPromptTokens),
    '',
    `  local tool definitions: ${m.localToolDefinitionBytes.toLocaleString('en-US')} bytes over ${m.localToolCount} tools`,
    formatContributorTable(m.contributors.tools, 'bytes', m.localToolDefinitionBytes),
  ];
  if (m.contributors.roster.length > 0) {
    out.push(
      '',
      `  specialist roster: ~${rosterTokens.toLocaleString('en-US')} tokens over ${m.contributors.roster.length} specialists`,
      formatContributorTable(m.contributors.roster, 'tokens', rosterTokens),
    );
  }
  return out.join('\n');
}

export function main(argv: string[]): number {
  const flag = argv.indexOf('--agent');
  const only = flag >= 0 ? argv[flag + 1] : undefined;
  if (flag >= 0 && !only) {
    console.error('usage: pnpm report:budget [--agent <name>]');
    return 2;
  }
  const agents = only
    ? [only]
    : readdirSync(SOURCES.agentsDir).filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, '')).sort();
  for (const agent of agents) {
    console.log(renderBreakdown(agent, measureAgentContext(agent, SOURCES)));
    console.log('');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
