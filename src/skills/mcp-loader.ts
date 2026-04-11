// mcp-loader.ts — reads config/skills.yaml, connects to each MCP server,
// discovers tools via tools/list, and registers them in the SkillRegistry.
//
// Called once at startup, right after loadSkillsFromDirectory. Returns the live
// McpSession array so the bootstrap orchestrator can close them on shutdown.
//
// Connection failures are warn-only — a missing MCP server should not take
// down the whole system. The failed server's tools are simply not registered.

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { SkillManifest, SkillHandler, SkillContext, SkillResult } from './types.js';
import type { SkillRegistry } from './registry.js';
import { connectStdio, connectSse } from './mcp-client.js';
import type { McpSession } from './mcp-client.js';
import type { Logger } from '../logger.js';
import type { ActionRisk } from './types.js';

// ---------------------------------------------------------------------------
// Config types — mirrors schemas/skills-config.json
// ---------------------------------------------------------------------------

interface McpStdioServerEntry {
  name: string;
  transport: 'stdio';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpSseServerEntry {
  name: string;
  transport: 'sse';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  url: string;
}

type McpServerEntry = McpStdioServerEntry | McpSseServerEntry;

interface SkillsConfig {
  servers?: McpServerEntry[];
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Read and parse config/skills.yaml.
 * Returns an empty config object if the file is absent — no MCP servers
 * configured is a valid deployment state.
 * Throws on YAML parse errors so startup fails loudly on broken config.
 */
function loadSkillsConfig(configDir: string): SkillsConfig {
  const filePath = path.join(configDir, 'skills.yaml');
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8'));
    if (parsed == null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config/skills.yaml must contain a YAML mapping at the root');
    }
    return parsed as SkillsConfig;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absent file = no MCP servers configured. Not an error.
      return {};
    }
    throw new Error(
      `Failed to load config/skills.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Result mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map an MCP tools/call result to a Curia SkillResult.
 *
 * The MCP SDK returns:
 *   { content: Array<{ type: 'text' | 'image' | ..., text?: string }>, isError?: boolean }
 *
 * We join text content blocks into a single string for the LLM. Non-text
 * blocks (images, resources) are represented as a JSON description so they
 * are not silently dropped — the LLM can describe them even if it can't
 * render them.
 */
function mapMcpResult(
  result: Awaited<ReturnType<import('./mcp-client.js').McpSession['client']['callTool']>>,
): SkillResult {
  // Legacy compatibility result shape from older MCP servers (toolResult wrapper).
  if ('toolResult' in result) {
    return { success: true, data: result.toolResult };
  }

  const content = result.content ?? [];
  const isError = result.isError === true;

  // Collect text from content blocks; represent non-text blocks as a JSON note.
  const parts = content.map((block) => {
    if (block.type === 'text') {
      return block.text;
    }
    // Non-text content (image, audio, resource) — describe it so it's not silently dropped.
    return `[${block.type} content not rendered]`;
  });

  const text = parts.join('\n').trim();

  if (isError) {
    return { success: false, error: text || 'MCP tool returned an error' };
  }
  return { success: true, data: text };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load MCP servers from config/skills.yaml, connect to each one, discover
 * tools via tools/list, and register them in the SkillRegistry.
 *
 * @param configDir - Absolute path to the config/ directory (same as used by loadYamlConfig).
 * @param registry  - The SkillRegistry to register discovered tools into.
 * @param logger    - Pino logger for structured log output.
 * @returns Array of live McpSession objects. Pass to the shutdown handler to close them.
 */
export async function loadMcpServers(
  configDir: string,
  registry: SkillRegistry,
  logger: Logger,
): Promise<McpSession[]> {
  const config = loadSkillsConfig(configDir);
  const servers = config.servers ?? [];

  if (servers.length === 0) {
    logger.debug('No MCP servers configured in config/skills.yaml');
    return [];
  }

  const sessions: McpSession[] = [];

  for (const serverEntry of servers) {
    // Validate required transport-specific fields here rather than in the JSON Schema
    // so that the error messages are human-readable and include the server name.
    if (serverEntry.transport === 'stdio' && !serverEntry.command) {
      logger.warn(
        { server: serverEntry.name },
        'MCP server config missing required "command" for stdio transport — skipping',
      );
      continue;
    }
    if (serverEntry.transport === 'sse' && !serverEntry.url) {
      logger.warn(
        { server: serverEntry.name },
        'MCP server config missing required "url" for sse transport — skipping',
      );
      continue;
    }

    let session: McpSession;
    try {
      session = serverEntry.transport === 'stdio'
        ? await connectStdio(serverEntry, logger)
        : await connectSse(serverEntry, logger);
    } catch (err) {
      // Connection failure is warn-not-crash: a missing or broken MCP server
      // should not take down the whole system. The server's tools simply won't
      // be available until the next restart.
      logger.warn(
        { err, server: serverEntry.name },
        'Failed to connect to MCP server — skipping; tools from this server will be unavailable',
      );
      continue;
    }

    // Discover all tools this server exposes.
    let toolList: Awaited<ReturnType<typeof session.client.listTools>>;
    try {
      toolList = await session.client.listTools();
    } catch (err) {
      logger.warn(
        { err, server: serverEntry.name },
        'tools/list failed for MCP server — skipping; closing connection',
      );
      await session.close().catch((closeErr: unknown) => {
        logger.error({ err: closeErr, server: serverEntry.name }, 'Error closing MCP session after tools/list failure');
      });
      continue;
    }

    const tools = toolList.tools ?? [];
    if (tools.length === 0) {
      logger.warn({ server: serverEntry.name }, 'MCP server advertises no tools — nothing to register');
      // Keep the session open — the server might add tools in a future protocol version.
      sessions.push(session);
      continue;
    }

    let registered = 0;
    for (const tool of tools) {
      // Build a minimal SkillManifest from the tool's metadata.
      // inputs is left empty ({}) because toToolDefinitions() uses mcpInputSchema
      // instead of the shorthand inputs notation for MCP-sourced tools.
      const manifest: SkillManifest = {
        name: tool.name,
        description: tool.description ?? `Tool '${tool.name}' from MCP server '${serverEntry.name}'`,
        version: '1.0.0',
        sensitivity: serverEntry.sensitivity ?? 'normal',
        action_risk: serverEntry.action_risk,
        inputs: {},
        outputs: {},
        permissions: [],
        secrets: [],
        timeout: serverEntry.timeout_ms ?? 30000,
      };

      // Capture the session reference in the closure — each tool needs its own
      // copy so the reference stays valid across the async loop.
      const capturedSession = session;
      const toolName = tool.name;

      const handler: SkillHandler = {
        async execute(ctx: SkillContext): Promise<SkillResult> {
          try {
            const result = await capturedSession.client.callTool({
              name: toolName,
              arguments: ctx.input,
            });
            return mapMcpResult(result);
          } catch (err) {
            // Skills must never throw — return a failure result instead.
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, error: `MCP tool '${toolName}' error: ${message}` };
          }
        },
      };

      // Build the raw MCP input schema for the fast-path in toToolDefinitions.
      // The MCP SDK returns `inputSchema` as a full JSON Schema object; we cast
      // it to the ToolDefinition input_schema shape which shares the same structure.
      const mcpInputSchema = tool.inputSchema as import('./types.js').ToolDefinition['input_schema'];

      try {
        registry.register(manifest, handler, mcpInputSchema);
        registered++;
        logger.debug(
          { server: serverEntry.name, tool: tool.name },
          'MCP tool registered',
        );
      } catch (err) {
        // Duplicate name is the most common error — another local skill or MCP
        // server already registered a tool with this name.
        logger.warn(
          { err, server: serverEntry.name, tool: tool.name },
          'Failed to register MCP tool — skipping',
        );
      }
    }

    logger.info(
      { server: serverEntry.name, registered, total: tools.length },
      'MCP server tools registered',
    );
    sessions.push(session);
  }

  return sessions;
}
