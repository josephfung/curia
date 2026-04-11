// mcp-client.ts — MCP transport connection lifecycle.
//
// This file is the only place in Curia that imports @modelcontextprotocol/sdk.
// It owns establishing a connection to an MCP server (stdio or SSE), wrapping
// the SDK session, and exposing a clean close() for graceful shutdown.
//
// It has zero knowledge of SkillRegistry or skill manifests — that's the loader's job.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Logger } from '../logger.js';

/**
 * Parameters for a stdio MCP server — spawns a child process and communicates
 * via stdin/stdout.
 */
export interface McpStdioServerConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  /** Extra env vars merged on top of the inherited environment. */
  env?: Record<string, string>;
}

/**
 * Parameters for an HTTP MCP server — connects via StreamableHTTPClientTransport,
 * the recommended transport for hosted MCP servers (Google, GitHub, etc.).
 *
 * The `headers` field supports arbitrary HTTP headers on every request, making
 * it straightforward to pass Authorization: Bearer tokens for authenticated
 * hosted MCP servers. See ADR 016.
 */
export interface McpSseServerConfig {
  name: string;
  transport: 'sse';
  url: string;
  /** HTTP headers to include with every request (e.g. Authorization: Bearer <token>). */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig;

/**
 * A connected MCP session — wraps the SDK client and exposes close() for
 * orderly shutdown. The serverId is the name from config, used in log messages.
 */
export interface McpSession {
  serverId: string;
  client: Client;
  close(): Promise<void>;
}

/**
 * Connect to a stdio MCP server.
 * Spawns the configured process and performs the MCP initialization handshake.
 * Throws on connection failure — callers decide whether to warn-and-continue
 * or propagate.
 */
export async function connectStdio(
  config: McpStdioServerConfig,
  logger: Logger,
): Promise<McpSession> {
  logger.debug(
    { server: config.name, command: config.command, args: config.args },
    'Connecting to stdio MCP server',
  );

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // Merge caller-supplied env vars on top of the defaults the SDK inherits.
    // If no extra env is declared, the SDK's getDefaultEnvironment() applies.
    env: config.env
      ? { ...process.env as Record<string, string>, ...config.env }
      : undefined,
    // Pipe stderr so the spawned server's error output goes through our logger
    // rather than leaking to the parent process's stderr untagged.
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'curia', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  logger.info(
    { server: config.name, serverInfo: client.getServerVersion() },
    'stdio MCP server connected',
  );

  return {
    serverId: config.name,
    client,
    close: async () => {
      logger.debug({ server: config.name }, 'Closing stdio MCP session');
      await client.close();
    },
  };
}

/**
 * Connect to an HTTP MCP server via StreamableHTTPClientTransport.
 *
 * Uses a single endpoint for both POST (tool calls) and SSE (streaming responses),
 * matching the pattern used by Google's hosted MCP servers and other modern
 * MCP-compatible services. Custom headers (e.g. Authorization: Bearer <token>)
 * are applied to every request via requestInit.
 *
 * Throws on connection failure — callers decide whether to warn-and-continue
 * or propagate.
 */
export async function connectSse(
  config: McpSseServerConfig,
  logger: Logger,
): Promise<McpSession> {
  logger.debug({ server: config.name, url: config.url }, 'Connecting to HTTP MCP server');

  const transport = new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers && Object.keys(config.headers).length > 0
      ? { requestInit: { headers: config.headers } }
      : undefined,
  );

  const client = new Client(
    { name: 'curia', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  logger.info(
    { server: config.name, serverInfo: client.getServerVersion() },
    'HTTP MCP server connected',
  );

  return {
    serverId: config.name,
    client,
    close: async () => {
      logger.debug({ server: config.name }, 'Closing HTTP MCP session');
      await client.close();
    },
  };
}
