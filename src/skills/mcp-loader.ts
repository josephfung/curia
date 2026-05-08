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
import { resolveEnvValue } from '../config.js';

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
  /** Constant parameter values injected into every tool call from this server.
   *  Keys are parameter names; values are literal strings or "env:VAR_NAME" references.
   *  Listed parameters are stripped from the tool schema — agents never see them. */
  fixed_inputs?: Record<string, string>;
}

interface McpSseServerEntry {
  name: string;
  transport: 'sse';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  url: string;
  headers?: Record<string, string>;
  /** Constant parameter values injected into every tool call from this server.
   *  Keys are parameter names; values are literal strings or "env:VAR_NAME" references.
   *  Listed parameters are stripped from the tool schema — agents never see them. */
  fixed_inputs?: Record<string, string>;
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
  logger: Logger,
  serverId: string,
  toolName: string,
): SkillResult {
  // Legacy compatibility result shape from older MCP servers (toolResult wrapper).
  // The legacy protocol has no isError flag, so we cannot determine success/failure.
  // Log a warning so operators know which servers still need upgrading.
  if ('toolResult' in result) {
    logger.warn(
      { server: serverId, tool: toolName },
      'MCP server returned legacy toolResult shape — cannot determine success/failure; upgrade the server to MCP 2024-11-05+',
    );
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
// fixed_inputs helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Remove fixed_inputs keys from an MCP tool's JSON Schema so agents never see
 * them as tool parameters. Returns a deep clone; the original is not mutated.
 */
export function stripFixedInputsFromSchema(
  schema: import('./types.js').ToolDefinition['input_schema'],
  fixedKeys: string[],
): import('./types.js').ToolDefinition['input_schema'] {
  if (fixedKeys.length === 0) return schema;
  const stripped = structuredClone(schema);
  if (stripped.properties && typeof stripped.properties === 'object') {
    for (const key of fixedKeys) {
      delete stripped.properties[key];
    }
  }
  if (Array.isArray(stripped.required)) {
    stripped.required = stripped.required.filter(r => !fixedKeys.includes(r));
  }
  return stripped;
}

/**
 * Merge resolved fixed_inputs into tool call arguments. Fixed values take
 * precedence over agent-supplied values to prevent prompt injection overrides.
 */
export function mergeFixedInputs(
  agentInput: Record<string, unknown>,
  fixedInputs: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(fixedInputs).length === 0) return agentInput;
  return { ...agentInput, ...fixedInputs };
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

    // Resolve fixed_inputs once at startup. These values are captured in closures
    // and merged into every callTool invocation for this server's tools.
    // Env-var references (e.g. "env:CURIA_GOOGLE_EMAIL") are resolved here —
    // a missing env var skips this server entirely (same as a connection failure).
    // This keeps google-workspace optional: deployments without CURIA_GOOGLE_EMAIL
    // simply don't get Workspace tools, rather than crashing the process.
    const rawFixedInputs = 'fixed_inputs' in serverEntry ? serverEntry.fixed_inputs : undefined;
    const resolvedFixedInputs: Record<string, string> = {};
    if (rawFixedInputs) {
      let resolutionFailed = false;
      for (const [key, value] of Object.entries(rawFixedInputs)) {
        try {
          resolvedFixedInputs[key] = resolveEnvValue(
            value,
            `MCP server '${serverEntry.name}' fixed_inputs.${key}`,
          );
        } catch (err) {
          logger.error(
            { err, server: serverEntry.name, key },
            'fixed_inputs resolution failed — skipping this MCP server',
          );
          resolutionFailed = true;
          break;
        }
      }
      if (resolutionFailed) continue;
      logger.info(
        { server: serverEntry.name, keys: Object.keys(resolvedFixedInputs) },
        'MCP server fixed_inputs resolved',
      );
    }

    let session: McpSession;
    try {
      session = serverEntry.transport === 'stdio'
        ? await connectStdio(serverEntry, logger)
        : await connectSse(serverEntry, logger);
    } catch (err) {
      // Connection failure is non-recoverable without a restart — tools from this
      // server will be unavailable for the lifetime of this process. Log at error
      // so operators are alerted, but don't crash the system.
      logger.error(
        { err, server: serverEntry.name },
        'Failed to connect to MCP server — tools from this server will be unavailable until restart',
      );
      continue;
    }

    // Discover all tools this server exposes.
    let toolList: Awaited<ReturnType<typeof session.client.listTools>>;
    try {
      toolList = await session.client.listTools();
    } catch (err) {
      // tools/list failure means no tools can be registered from this server — non-recoverable.
      logger.error(
        { err, server: serverEntry.name },
        'tools/list failed for MCP server — tools from this server will be unavailable until restart; closing connection',
      );
      await session.close().catch((closeErr: unknown) => {
        logger.error({ err: closeErr, server: serverEntry.name }, 'Error closing MCP session after tools/list failure');
      });
      continue;
    }

    const tools = toolList.tools ?? [];
    if (tools.length === 0) {
      // Zero tools most commonly means the OAuth flow hasn't been completed yet.
      // The server starts and handshakes successfully but won't expose tools until
      // the user authenticates. Check docs/dev/google-drive.md Step 5 if this is
      // the google-workspace server. Token cache: ~/.workspace-mcp/cli-tokens/
      logger.warn({ server: serverEntry.name }, 'MCP server advertises no tools — nothing to register. If this is the google-workspace server, the OAuth flow may not have been completed (see docs/dev/google-drive.md Step 5).');
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
            // Merge fixed_inputs into the tool call arguments. Fixed values take
            // precedence — even if an agent somehow passed a value for a stripped
            // parameter (e.g. via prompt injection), the config value wins.
            const mergedInput = mergeFixedInputs(ctx.input, resolvedFixedInputs);
            const rawResult = await capturedSession.client.callTool({
              name: toolName,
              arguments: mergedInput,
            });
            const result = mapMcpResult(rawResult, logger, capturedSession.serverId, toolName);
            if (!result.success) {
              // Log tool-level errors so operators can detect persistently failing tools.
              logger.warn(
                { server: capturedSession.serverId, tool: toolName, error: result.error },
                'MCP tool returned an error result',
              );
            }
            return result;
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
      //
      // When fixed_inputs are configured, strip those keys from the schema so
      // agents never see them as tool parameters. The values are injected
      // server-side in the execute handler below.
      let mcpInputSchema = tool.inputSchema as import('./types.js').ToolDefinition['input_schema'];
      const fixedKeys = Object.keys(resolvedFixedInputs);
      if (fixedKeys.length > 0) {
        // Warn if a fixed_inputs key doesn't match any parameter in this tool's
        // schema — likely means the upstream MCP server renamed the parameter and
        // the config is stale. The tool call will still work (extra keys are
        // ignored by most MCP servers) but the intended parameter won't be set.
        for (const key of fixedKeys) {
          if (mcpInputSchema.properties && !(key in mcpInputSchema.properties)) {
            logger.warn(
              { server: serverEntry.name, tool: tool.name, fixedInputKey: key },
              'fixed_inputs key not found in tool schema — the MCP server may not recognize this parameter',
            );
          }
        }
        mcpInputSchema = stripFixedInputsFromSchema(mcpInputSchema, fixedKeys);
      }

      try {
        registry.register(manifest, handler, mcpInputSchema);
        registered++;
        logger.debug(
          { server: serverEntry.name, tool: tool.name },
          'MCP tool registered',
        );
      } catch (err) {
        const isDuplicate = err instanceof Error && err.message.toLowerCase().includes('already registered');
        if (isDuplicate) {
          // Duplicate name — another local skill or MCP server registered this tool first.
          logger.warn(
            { server: serverEntry.name, tool: tool.name },
            'MCP tool name collision with existing skill — skipping; first registration wins',
          );
        } else {
          // Unexpected error — likely a bug or a malformed manifest derived from the tool metadata.
          logger.error(
            { err, server: serverEntry.name, tool: tool.name },
            'Unexpected error registering MCP tool — skipping',
          );
        }
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
