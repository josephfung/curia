// learned-describers.ts — describers for tools with none in code (#2455, ADR-059).
//
// describers.ts covers the tools Curia ships. A deployment also runs tools that
// file can't know about: an MCP server's sheet writes, a custom agent's tools. For
// those, a fast-tier model writes one row per agent and tool into the
// activity_describers table (describer-learner.ts): whether the tool reads or
// writes, and a tally ("logged" / "an expense" / "expenses"). The feed and the
// histogram read the rows through a DescriberCatalog.
//
// Lookup order: code describer → learned row → fallback. A tool known to write
// but with no row yet counts as a generic "took N actions". A tool with no row and
// no signal is left as it was before: unnamed, and never a hiccup.
//
// Display only. Nothing here feeds autonomy or action_risk enforcement.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit/hash-chain.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { ActionRisk, RegisteredTool } from '../skills/types.js';
import { hasDescriber, type Tally } from './describers.js';

export type ToolEffect = 'read' | 'write';
export type DescriberSource = 'hint' | 'learned' | 'operator';

/** One activity_describers row. */
export interface LearnedDescriber {
  agentId: string;
  toolName: string;
  effect: ToolEffect;
  verb: string;
  one: string;
  many: string;
  /** Infinitive for the failure line: "log an expense" → "couldn't log an expense". */
  attempt: string;
  descriptionHash: string;
  source: DescriberSource;
}

/** What the learner and the write signal read about a registered tool. */
export interface ToolFacts {
  name: string;
  description: string;
  /** The MCP JSON Schema, or a local manifest's shorthand inputs. */
  inputSchema: unknown;
  actionRisk: ActionRisk;
  mcp: boolean;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export function toolFactsFrom(tool: RegisteredTool): ToolFacts {
  return {
    name: tool.manifest.name,
    description: tool.manifest.description,
    inputSchema: tool.mcpInputSchema ?? tool.manifest.inputs,
    actionRisk: tool.manifest.action_risk,
    mcp: tool.mcpInputSchema !== undefined,
    ...(tool.mcpAnnotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.mcpAnnotations.readOnlyHint } : {}),
    ...(tool.mcpAnnotations?.destructiveHint !== undefined ? { destructiveHint: tool.mcpAnnotations.destructiveHint } : {}),
  };
}

/** The minimum score of `medium`: an outbound send or anything riskier changes something. */
const WRITE_RISK_FLOOR = 70;

/**
 * Read or write from a deterministic signal, or null when there is none and
 * the model decides.
 *
 * - MCP tools: their annotations. action_risk is one value for the whole server
 *   (mcp-loader.ts), so it says nothing about a single tool.
 * - Local tools: `none` is a read and `medium` or above a write. `low` covers
 *   both internal writes and reads filed above `none` (bullpen-read,
 *   meeting-agenda-load), so the model decides those.
 */
export function signalEffect(facts: ToolFacts): ToolEffect | null {
  if (facts.mcp) {
    if (facts.readOnlyHint === true) return 'read';
    if (facts.readOnlyHint === false || facts.destructiveHint === true) return 'write';
    return null;
  }
  const score = AutonomyService.minScoreForActionRisk(facts.actionRisk);
  if (score === 0) return 'read';
  if (score >= WRITE_RISK_FLOOR) return 'write';
  return null;
}

/**
 * Fingerprint of everything a row depends on: what the model saw (description,
 * schema, and the agent text it names the object in) and the deterministic
 * signal. A repurposed agent is learned again, so the feed's words follow it. A
 * tool whose server adds a hint, or whose action_risk crosses a signal boundary,
 * is learned again even with the same description; otherwise a stored "read"
 * would outrank the known-write fallback and hide its failures. The signal, not
 * the raw risk, goes in, so a change that leaves read/write as it was costs no
 * model call.
 */
export function describerHash(facts: ToolFacts, agentContext: string): string {
  return createHash('sha256')
    .update(canonicalJson({
      description: facts.description,
      inputSchema: facts.inputSchema ?? null,
      signal: signalEffect(facts),
      agent: agentContext,
    }))
    .digest('hex');
}

/** Generic tally for a known write with no learned row yet. */
export const GENERIC_ACTION_TALLY: Tally = { verb: 'took', one: 'an action', many: 'actions' };
export const GENERIC_ACTION_ATTEMPT = 'finish an action';

/** What the feed and the histogram know about tools with no code describer. */
export interface DescriberCatalog {
  /** The learned row for this agent and tool, if any. */
  learned(agentId: string, toolName: string): LearnedDescriber | undefined;
  /** True when the tool has no code describer and a deterministic signal says it writes. */
  knownWrite(toolName: string): boolean;
}

export const EMPTY_CATALOG: DescriberCatalog = {
  learned: () => undefined,
  knownWrite: () => false,
};

function pairKey(agentId: string, toolName: string): string {
  return `${agentId}\u001f${toolName}`;
}

/**
 * A catalog over loaded rows and the known-write tool names. A row for a tool
 * that has a code describer is ignored: code always wins.
 */
export function buildCatalog(rows: readonly LearnedDescriber[], knownWriteTools: Iterable<string>): DescriberCatalog {
  const byPair = new Map<string, LearnedDescriber>();
  for (const row of rows) {
    if (!hasDescriber(row.toolName)) byPair.set(pairKey(row.agentId, row.toolName), row);
  }
  const writes = new Set<string>();
  for (const name of knownWriteTools) {
    if (!hasDescriber(name)) writes.add(name);
  }
  return {
    learned: (agentId, toolName) => byPair.get(pairKey(agentId, toolName)),
    knownWrite: (toolName) => writes.has(toolName),
  };
}

/** Names of registered tools with no code describer whose signal says write. */
export function knownWriteToolNames(tools: readonly RegisteredTool[]): string[] {
  return tools
    .filter((tool) => !hasDescriber(tool.manifest.name) && signalEffect(toolFactsFrom(tool)) === 'write')
    .map((tool) => tool.manifest.name);
}
