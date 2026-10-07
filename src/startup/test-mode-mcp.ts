// test-mode-mcp.ts — MCP servers in the test-mode stack, served from tools/list
// snapshots (#2024).
//
// Test mode never spawns an MCP server: google-workspace needs OAuth credentials and
// acts on a real Google account. Without its tools, though, the behavior suites cannot
// see whether an agent reaches for them at all — and since the coordinator no longer
// pins google-workspace, whether it activates the skill is exactly what they test.
//
// So each server in config/skills.yaml that has a snapshot at
// tests/fixtures/mcp/<server>.tools.json is registered from that snapshot, through
// production's own registration (registerMcpServerTools + registerMcpProjectedSkills):
// same manifests, same action_risk, same fixed-input stripping, same projected skill
// with its references. Only the session differs. It answers every call with a canned
// result and holds no connection, so a call reaches nothing.
//
// To refresh a snapshot, export the server's tools/list (curia-deploy keeps one current
// for its eval harness: tests/eval/tool-schemas/_bundle-<server>.json, checked against
// the production server by its drift check) into the format below.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logger.js';
import type { McpServerEntry } from '../skills/mcp-config-types.js';
import {
  loadSkillsConfig,
  registerMcpProjectedSkills,
  registerMcpServerTools,
  type McpListedTool,
  type McpToolSession,
} from '../skills/mcp-loader.js';
import type { ToolRegistry } from '../skills/registry.js';
import type { SkillRegistry } from '../skills/skill-registry.js';

/** A server's tools/list, captured for test mode. */
export interface McpToolsSnapshot {
  server: string;
  /** Where the list came from: server version and flags. */
  source: string;
  /** YYYY-MM-DD. */
  captured: string;
  tools: McpListedTool[];
}

/** Read and check one snapshot. Throws on a malformed file: a silently empty server
 *  would let a suite pass for the wrong reason. */
export function loadMcpToolsSnapshot(file: string, server: string): McpToolsSnapshot {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<McpToolsSnapshot>;
  if (parsed.server !== server) {
    throw new Error(`MCP snapshot ${file} is for server '${String(parsed.server)}', expected '${server}'`);
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    throw new Error(`MCP snapshot ${file} lists no tools`);
  }
  for (const tool of parsed.tools) {
    if (typeof tool?.name !== 'string' || typeof tool.inputSchema !== 'object' || tool.inputSchema === null) {
      throw new Error(`MCP snapshot ${file} has a tool without a name or inputSchema`);
    }
  }
  return parsed as McpToolsSnapshot;
}

/**
 * The text a snapshot-served tool returns. Plain about being a stand-in, so a model
 * that gets it (an unstubbed call) is not misled into reporting a real result, and
 * names the call so a transcript shows what was asked.
 */
export function cannedMcpResultText(server: string, toolName: string): string {
  return `Test mode: '${toolName}' was answered by a stand-in for the ${server} MCP server. ` +
    'Nothing was read from or changed in any real account, and there is no data to return.';
}

/** A session that answers every tools/call with the canned text and reaches nothing. */
export function cannedMcpSession(server: string): McpToolSession {
  const callTool = async (params: { name: string }) => ({
    content: [{ type: 'text' as const, text: cannedMcpResultText(server, params.name) }],
  });
  return {
    serverId: server,
    // Cast: the SDK's callTool is overloaded on its result schema; the handler only
    // reads `content` / `isError` from what this returns.
    client: { callTool: callTool as unknown as McpToolSession['client']['callTool'] },
  };
}

/** Parameter names a server's fixed inputs fill in (secrets-block and literal). Their
 *  values never matter here — the canned session ignores arguments — but the names do:
 *  production strips them from every schema the model sees. */
function fixedInputKeys(entry: McpServerEntry): string[] {
  const keys = new Set(Object.keys(entry.fixed_inputs ?? {}));
  if (entry.transport === 'stdio') {
    for (const decl of entry.secrets ?? []) {
      if (decl.inject.fixed_input !== undefined) keys.add(decl.inject.fixed_input);
    }
  }
  return [...keys];
}

export interface SnapshotMcpResult {
  /** Every tool registered from a snapshot, across servers. */
  tools: Set<string>;
  /** Configured servers with no snapshot: absent from this stack, as before #2024. */
  serversWithoutSnapshot: string[];
}

/**
 * Register every configured MCP server that has a snapshot, then project each as a
 * skill. Call after local tools load (a local tool wins a name collision, as at boot)
 * and before registerSyntheticSingletonSkills (so projected members are not wrapped as
 * singletons, as at boot).
 *
 * Every configured server is registered, whatever this database's MCP registry says:
 * the stack stands in for the production deployment, which runs them, and a dev
 * database usually has no Google credentials to enable one with.
 */
export function registerSnapshotMcpServers(params: {
  configDir: string;
  snapshotDir: string;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  skillsDir: string;
  logger: Logger;
}): SnapshotMcpResult {
  const { configDir, snapshotDir, toolRegistry, skillRegistry, skillsDir, logger } = params;
  const projected = new Map<string, string[]>();
  const tools = new Set<string>();
  const serversWithoutSnapshot: string[] = [];

  for (const entry of loadSkillsConfig(configDir).servers ?? []) {
    const file = path.join(snapshotDir, `${entry.name}.tools.json`);
    if (!fs.existsSync(file)) {
      serversWithoutSnapshot.push(entry.name);
      continue;
    }
    const snapshot = loadMcpToolsSnapshot(file, entry.name);
    const resolvedFixedInputs = Object.fromEntries(fixedInputKeys(entry).map(k => [k, 'test-mode']));
    const names = registerMcpServerTools({
      serverEntry: entry,
      session: cannedMcpSession(entry.name),
      tools: snapshot.tools,
      resolvedFixedInputs,
      registry: toolRegistry,
      logger,
    });
    projected.set(entry.name, names);
    for (const name of names) tools.add(name);
  }

  registerMcpProjectedSkills(projected, skillRegistry, logger, skillsDir);
  return { tools, serversWithoutSnapshot };
}
