// mcp-loader.ts — reads config/skills.yaml, connects to each MCP server,
// discovers tools via tools/list, and registers them in the ToolRegistry.
//
// Called once at startup, right after loadToolsFromDirectory. Returns live
// McpSession objects plus per-server projected tool names so the bootstrap
// orchestrator can close sessions and register MCP-as-skill projections
// (ADR-032).
//
// Connection failures are error-logged and tracked in serverStatuses for
// /api/health (#1500) — a missing MCP server should not take down the whole
// system, but it must not be silent either.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ToolManifest, ToolHandler, ToolContext, ToolResult } from './types.js';
import type { ToolRegistry } from './registry.js';
import type { SkillRegistry } from './skill-registry.js';
import { connectStdio, connectSse } from './mcp-client.js';
import type { McpSession } from './mcp-client.js';
import type { Logger } from '../logger.js';
import type { SecretsService } from '../secrets/secrets-service.js';
import type {
  McpSecretDeclaration,
  McpServerEntry,
  McpStdioServerEntry,
  SkillsConfig,
} from './mcp-config-types.js';

/** Result of loading MCP servers: live sessions + tools registered per server. */
export type McpServerLoadStatus =
  | { status: 'ok'; toolCount: number }
  | { status: 'zero_tools' }
  | { status: 'unavailable'; reason: string };

export interface McpLoadResult {
  sessions: McpSession[];
  /**
   * Server name → tool names successfully registered this boot.
   * Used to project each MCP server as a skill into SkillRegistry (ADR-032).
   */
  projectedTools: Map<string, string[]>;
  /**
   * Boot outcome for every **enabled** server that was attempted (not skipped
   * by the registry filter). Consumed by HealthService so a silent 0-tool or
   * connect failure surfaces on `/api/health` (#1500).
   */
  serverStatuses: Map<string, McpServerLoadStatus>;
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
export function loadSkillsConfig(configDir: string): SkillsConfig {
  const filePath = path.join(configDir, 'skills.yaml');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // js-yaml v5 throws on empty input; treat an empty file as no MCP servers configured.
    if (raw.trim() === '') return {};
    const parsed = yaml.load(raw);
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
 * Map an MCP tools/call result to a Curia ToolResult.
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
): ToolResult {
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
// Vault-backed secret resolution for MCP servers (#913) — exported for testing
// ---------------------------------------------------------------------------

/**
 * Read a single secret from the vault, vault-only — no process.env fallback.
 * Trims the value and treats a blank/whitespace-only result as absent. Throws a
 * descriptive error when the secret is missing so the caller can skip the whole
 * server (the same loud-fail contract as a missing fixed_input) rather than
 * spawn a third-party subprocess with a half-populated credential set.
 */
async function getRequiredVaultSecret(
  vaultKey: string,
  secrets: SecretsService,
  context: string,
): Promise<string> {
  const value = (await secrets.get(vaultKey))?.trim();
  if (!value) {
    throw new Error(`${context}: secret "${vaultKey}" is not set in the vault`);
  }
  return value;
}

/**
 * Resolve a stdio server's `env:` block from the vault. The empty-string
 * sentinel (`KEY: ""` in config/skills.yaml) means "resolve KEY from the vault
 * by its lowercased name" — vault-only, never process.env (#913). Non-empty
 * values are literal passthroughs (e.g. ALLOWED_FILE_DIRS). Returns a fully
 * resolved map of literals ready for buildChildEnv; throws if any referenced
 * secret is missing so the caller skips the server.
 *
 * By design there is no way to express a literal empty-string env value: an
 * empty value is always a vault-resolution request. No MCP server needs an empty
 * literal today; if one ever does, give it a sentinel non-empty value instead.
 */
export async function resolveStdioEnvFromVault(
  configEnv: Record<string, string>,
  secrets: SecretsService,
  serverName: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(configEnv)) {
    if (value !== '') {
      resolved[key] = value;
      continue;
    }
    resolved[key] = await getRequiredVaultSecret(
      key.toLowerCase(),
      secrets,
      `MCP server '${serverName}' env.${key}`,
    );
  }
  return resolved;
}

/**
 * Resolve a single fixed_inputs value from the vault. An "env:VAR" reference is
 * resolved vault-only by VAR's lowercased name (#913); a literal string passes
 * through unchanged. Throws if a referenced secret is missing. This is the
 * vault-backed replacement for the process.env-based resolveEnvValue() that
 * fixed_inputs used before the migration.
 */
export async function resolveFixedInputFromVault(
  value: string,
  secrets: SecretsService,
  context: string,
): Promise<string> {
  if (value.startsWith('env:')) {
    const varName = value.slice(4);
    return getRequiredVaultSecret(varName.toLowerCase(), secrets, context);
  }
  return value;
}

/**
 * Resolve all credentials declared in a server's `secrets:` block from the vault.
 * For each declaration: reads `key` from vault; if `inject.env`, places the value in
 * the returned `env` map under that var name; if `inject.fixed_input`, places it in
 * `fixedInputs`. A missing required secret throws so the caller can skip the server.
 * Missing optional secrets are silently skipped. Vault-only — no process.env fallback.
 */
export async function resolveSecretsBlock(
  declarations: McpSecretDeclaration[],
  secrets: SecretsService,
  serverName: string,
): Promise<{ env: Record<string, string>; fixedInputs: Record<string, string> }> {
  const env: Record<string, string> = {};
  const fixedInputs: Record<string, string> = {};

  for (const decl of declarations) {
    const value = (await secrets.get(decl.key))?.trim();
    if (!value) {
      if (decl.required) {
        throw new Error(
          `MCP server '${serverName}': required secret "${decl.key}" is not set in the vault`,
        );
      }
      continue;
    }
    if (decl.inject.env !== undefined) {
      env[decl.inject.env] = value;
    } else if (decl.inject.fixed_input !== undefined) {
      fixedInputs[decl.inject.fixed_input] = value;
    } else {
      // Unreachable for valid config: the startup JSON schema validator enforces
      // exactly one of env/fixed_input. Guard defensively so malformed YAML fails
      // loudly instead of silently producing a broken fixedInputs key.
      throw new Error(
        `MCP server '${serverName}': secret "${decl.key}" inject block has neither 'env' nor 'fixed_input'.`,
      );
    }
  }

  return { env, fixedInputs };
}

// ---------------------------------------------------------------------------
// MCP tool handler
// ---------------------------------------------------------------------------

/** The subset of an {@link McpSession} the tool handler needs: a `callTool`-capable
 *  client plus the server id for logs. Narrowed so unit tests can pass a mock
 *  client without constructing a full SDK `Client`. */
type McpToolSession = {
  serverId: string;
  client: Pick<McpSession['client'], 'callTool'>;
};

/**
 * Build the execution handler for a single MCP tool.
 *
 * Extracted from loadMcpServers so the request-cancellation behavior below can be
 * unit-tested against a mock MCP client.
 *
 * #1666 — the execution layer races this handler against `manifest.timeout` and,
 * when the timeout wins, rejects our promise WITHOUT cancelling the underlying MCP
 * request. That leaves the SDK's pending-request entry (and the captured request +
 * closures) alive until the SDK's own default timeout fires. We tie an
 * AbortController to a timer set to the same `timeoutMs` the execution layer uses,
 * and also pass an explicit `timeout`, so a timed-out tool call also tears down the
 * in-flight MCP request instead of stranding it.
 */
export function buildMcpToolHandler(params: {
  session: McpToolSession;
  toolName: string;
  resolvedFixedInputs: Record<string, string>;
  timeoutMs: number;
  logger: Logger;
}): ToolHandler {
  const { session, toolName, resolvedFixedInputs, timeoutMs, logger } = params;
  return {
    async execute(ctx: ToolContext): Promise<ToolResult> {
      // Abort the MCP request if it outlives the execution-layer timeout (#1666).
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Merge fixed_inputs into the tool call arguments. Fixed values take
        // precedence — even if an agent somehow passed a value for a stripped
        // parameter (e.g. via prompt injection), the config value wins.
        const mergedInput = mergeFixedInputs(ctx.input, resolvedFixedInputs);
        const rawResult = await session.client.callTool(
          { name: toolName, arguments: mergedInput },
          undefined, // use the SDK's default CallToolResultSchema
          { signal: controller.signal, timeout: timeoutMs },
        );
        const result = mapMcpResult(rawResult, logger, session.serverId, toolName);
        if (!result.success) {
          // Log tool-level errors so operators can detect persistently failing tools.
          logger.warn(
            { server: session.serverId, tool: toolName, error: result.error },
            'MCP tool returned an error result',
          );
        }
        return result;
      } catch (err) {
        // Log before converting — a thrown rejection here (transport/subprocess
        // crash, JSON-RPC protocol error, the SDK's RequestTimeout, or our own
        // abort above) is a MORE severe failure than the tool-level `isError`
        // result logged above, yet would otherwise be invisible: the execution
        // layer only logs when handler.execute *throws*, and we deliberately
        // return `{ success: false }` instead (skills must never throw).
        logger.warn({ server: session.serverId, tool: toolName, err }, 'MCP tool call threw');
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `MCP tool '${toolName}' error: ${message}` };
      } finally {
        // Always clear the timer so a completed call doesn't leave a pending abort
        // (which would also keep the event loop alive during graceful shutdown).
        clearTimeout(abortTimer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load MCP servers from config/skills.yaml, connect to each one, discover
 * tools via tools/list, and register them in the ToolRegistry.
 *
 * @param configDir          - Absolute path to the config/ directory (same as used by loadYamlConfig).
 * @param registry           - The ToolRegistry to register discovered tools into.
 * @param logger             - Pino logger for structured log output.
 * @param secrets            - Vault accessor. A server's `env:` empty-string sentinels and
 *                             `fixed_inputs` "env:VAR" references are resolved from the vault
 *                             at spawn time (vault-only, #913). A missing secret skips that
 *                             server, the same as a connection failure.
 * @param enabledServerNames - When provided, only servers whose name is in this set are spawned.
 *                             Servers absent from the set are skipped with a debug log (not an error).
 *                             Pass undefined to skip the filter (legacy / test behavior).
 * @returns Live sessions plus per-server tool names registered this boot.
 */
export async function loadMcpServers(
  configDir: string,
  registry: ToolRegistry,
  logger: Logger,
  secrets: SecretsService,
  enabledServerNames?: Set<string>,
): Promise<McpLoadResult> {
  const config = loadSkillsConfig(configDir);
  const servers = config.servers ?? [];

  if (servers.length === 0) {
    logger.debug('No MCP servers configured in config/skills.yaml');
    return { sessions: [], projectedTools: new Map(), serverStatuses: new Map() };
  }

  const sessions: McpSession[] = [];
  const projectedTools = new Map<string, string[]>();
  const serverStatuses = new Map<string, McpServerLoadStatus>();

  for (const serverEntry of servers) {
    // Registry filter first: disabled servers must not affect health (#1500).
    if (enabledServerNames !== undefined && !enabledServerNames.has(serverEntry.name)) {
      logger.debug(
        { server: serverEntry.name },
        'MCP server not in enabled registry set — skipping',
      );
      continue;
    }

    // Validate required transport-specific fields here rather than in the JSON Schema
    // so that the error messages are human-readable and include the server name.
    if (serverEntry.transport === 'stdio' && !serverEntry.command) {
      logger.warn(
        { server: serverEntry.name },
        'MCP server config missing required "command" for stdio transport — skipping',
      );
      serverStatuses.set(serverEntry.name, {
        status: 'unavailable',
        reason: 'missing stdio command',
      });
      continue;
    }
    if (serverEntry.transport === 'sse' && !serverEntry.url) {
      logger.warn(
        { server: serverEntry.name },
        'MCP server config missing required "url" for sse transport — skipping',
      );
      serverStatuses.set(serverEntry.name, {
        status: 'unavailable',
        reason: 'missing sse url',
      });
      continue;
    }

    // SSE servers: the secrets: block is schema-valid but not injected (no subprocess).
    // Warn early so the operator knows their config is a no-op and should use headers: instead.
    if (serverEntry.transport === 'sse') {
      const rawSecrets = (serverEntry as unknown as Record<string, unknown>)['secrets'];
      if (Array.isArray(rawSecrets) && rawSecrets.length > 0) {
        logger.warn(
          { server: serverEntry.name },
          'SSE MCP server declares secrets: block, but SSE transport has no subprocess — secrets are not injected. Use headers: for SSE auth instead.',
        );
      }
    }

    // Resolve credentials and build the env for the subprocess.
    // New path: if the server declares a secrets: block, resolve from it and merge with
    // any non-secret env literals. Legacy path: resolve env: "" sentinels and
    // fixed_inputs: "env:VAR" references from the vault (kept for backward-compat).
    const declarations = serverEntry.transport === 'stdio' ? ((serverEntry as McpStdioServerEntry).secrets ?? []) : [];
    const resolvedFixedInputs: Record<string, string> = {};
    let connectEntry: McpServerEntry = serverEntry;

    if (declarations.length > 0) {
      let secretsResult: { env: Record<string, string>; fixedInputs: Record<string, string> };
      try {
        secretsResult = await resolveSecretsBlock(declarations, secrets, serverEntry.name);
      } catch (err) {
        logger.error(
          { err, server: serverEntry.name },
          'secrets block resolution failed — skipping this MCP server',
        );
        serverStatuses.set(serverEntry.name, {
          status: 'unavailable',
          reason: 'secrets resolution failed',
        });
        continue;
      }
      // Non-secret literals in env: pass through; secrets block env values overlay them.
      const literalEnv = serverEntry.transport === 'stdio' ? ((serverEntry as McpStdioServerEntry).env ?? {}) : {};
      connectEntry = { ...serverEntry, env: { ...literalEnv, ...secretsResult.env } } as McpStdioServerEntry;
      // Any old literal fixed_inputs + secrets block fixed_inputs.
      const literalFixed = 'fixed_inputs' in serverEntry ? (serverEntry.fixed_inputs ?? {}) : {};
      // Guard against partial migrations: if fixed_inputs still carries 'env:VAR' sentinels while
      // secrets: is also present, those sentinels would land as literal strings in the subprocess
      // env instead of being vault-resolved. Fail fast so the misconfiguration is obvious.
      const sentinelKeys = Object.entries(literalFixed)
        .filter(([, v]) => v.startsWith('env:'))
        .map(([k]) => k);
      if (sentinelKeys.length > 0) {
        logger.error(
          { server: serverEntry.name, keys: sentinelKeys },
          "MCP server has secrets: block but fixed_inputs still contains 'env:VAR' sentinels — " +
          'migrate them to the secrets: block and remove from fixed_inputs; skipping this server',
        );
        serverStatuses.set(serverEntry.name, {
          status: 'unavailable',
          reason: 'fixed_inputs env sentinels with secrets block',
        });
        continue;
      }
      Object.assign(resolvedFixedInputs, literalFixed, secretsResult.fixedInputs);
      logger.info(
        { server: serverEntry.name, envKeys: Object.keys(secretsResult.env), fixedKeys: Object.keys(secretsResult.fixedInputs) },
        'MCP server secrets block resolved',
      );
    } else {
      // Legacy path: env: "" sentinels and fixed_inputs: "env:VAR" references.
      const rawFixedInputs = 'fixed_inputs' in serverEntry ? serverEntry.fixed_inputs : undefined;
      if (rawFixedInputs) {
        let resolutionFailed = false;
        for (const [key, value] of Object.entries(rawFixedInputs)) {
          try {
            resolvedFixedInputs[key] = await resolveFixedInputFromVault(
              value,
              secrets,
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
        if (resolutionFailed) {
          serverStatuses.set(serverEntry.name, {
            status: 'unavailable',
            reason: 'fixed_inputs resolution failed',
          });
          continue;
        }
        logger.info(
          { server: serverEntry.name, keys: Object.keys(resolvedFixedInputs) },
          'MCP server fixed_inputs resolved',
        );
      }
      if (serverEntry.transport === 'stdio' && serverEntry.env) {
        try {
          const resolvedEnv = await resolveStdioEnvFromVault(
            serverEntry.env,
            secrets,
            serverEntry.name,
          );
          connectEntry = { ...serverEntry, env: resolvedEnv };
        } catch (err) {
          logger.error(
            { err, server: serverEntry.name },
            'env secret resolution from vault failed — skipping this MCP server',
          );
          serverStatuses.set(serverEntry.name, {
            status: 'unavailable',
            reason: 'env secret resolution failed',
          });
          continue;
        }
      }
    }

    let session: McpSession;
    try {
      session = connectEntry.transport === 'stdio'
        ? await connectStdio(connectEntry, logger)
        : await connectSse(connectEntry, logger);
    } catch (err) {
      // Connection failure is non-recoverable without a restart — tools from this
      // server will be unavailable for the lifetime of this process. Log at error
      // so operators are alerted, but don't crash the system.
      logger.error(
        { err, server: serverEntry.name },
        'Failed to connect to MCP server — tools from this server will be unavailable until restart',
      );
      serverStatuses.set(serverEntry.name, {
        status: 'unavailable',
        reason: 'connect failed',
      });
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
      serverStatuses.set(serverEntry.name, {
        status: 'unavailable',
        reason: 'tools/list failed',
      });
      continue;
    }

    const tools = toolList.tools ?? [];
    if (tools.length === 0) {
      // Zero tools most commonly means the OAuth flow hasn't been completed yet,
      // or the server crashed mid-boot before advertising tools (curia-deploy#181).
      // This is a loud health failure (#1500) — not a silent warn-and-continue.
      logger.error(
        { server: serverEntry.name },
        'MCP server advertises no tools — tools from this server will be unavailable until restart. If this is google-workspace, the OAuth flow may not have been completed (see docs/dev/google-drive.md Step 5).',
      );
      // Keep the session open — the server might add tools in a future protocol version.
      // Still project an empty skill so the server name is pinnable/discoverable.
      projectedTools.set(serverEntry.name, []);
      sessions.push(session);
      serverStatuses.set(serverEntry.name, { status: 'zero_tools' });
      continue;
    }

    let registered = 0;
    const registeredNames: string[] = [];
    for (const tool of tools) {
      // Build a minimal ToolManifest from the tool's metadata.
      // inputs is left empty ({}) because toToolDefinitions() uses mcpInputSchema
      // instead of the shorthand inputs notation for MCP-sourced tools.
      const manifest: ToolManifest = {
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

      // Passing `session` as an argument captures it per-tool, so the reference
      // stays valid across the async loop even as the outer `session` is reassigned.
      const handler = buildMcpToolHandler({
        session,
        toolName: tool.name,
        resolvedFixedInputs,
        timeoutMs: manifest.timeout,
        logger,
      });

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
        registeredNames.push(tool.name);
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

    projectedTools.set(serverEntry.name, registeredNames);
    logger.info(
      { server: serverEntry.name, registered, total: tools.length, tools: registeredNames },
      'MCP server tools registered',
    );
    sessions.push(session);
    serverStatuses.set(serverEntry.name, { status: 'ok', toolCount: registeredNames.length });
  }

  return { sessions, projectedTools, serverStatuses };
}

/**
 * Project each connected MCP server as a skill into SkillRegistry (ADR-032).
 *
 * Membership is the live tool set registered this boot (dynamic — can change
 * between restarts). Pinning the server name (e.g. `google-workspace`) expands
 * to those tools. Individual MCP tool pins remain first-class via polymorphic pins.
 *
 * Returns the number of skills registered.
 */
export function registerMcpProjectedSkills(
  projectedTools: Map<string, string[]>,
  skillRegistry: SkillRegistry,
  logger: Logger,
): number {
  let added = 0;
  for (const [serverName, tools] of projectedTools) {
    if (skillRegistry.get(serverName)) {
      logger.warn(
        { server: serverName },
        'MCP skill projection skipped — a skill with this name is already registered',
      );
      continue;
    }
    skillRegistry.register(
      {
        name: serverName,
        description: `MCP server '${serverName}' — ${tools.length} tool${tools.length === 1 ? '' : 's'} projected as a skill (ADR-032)`,
        version: '1.0.0',
        tools: [...tools],
        instructions: '',
      },
      '', // no on-disk SKILL.md — membership is live from tools/list
    );
    logger.info(
      { skill: serverName, tools, kind: 'mcp' },
      'MCP server projected as skill',
    );
    added++;
  }
  return added;
}
