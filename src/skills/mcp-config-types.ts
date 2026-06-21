// mcp-config-types.ts — Shared config types for MCP server entries (skills.yaml schema).
// Imported by both mcp-loader.ts and mcp-registry-service.ts.
import type { ActionRisk } from './types.js';

/** Wiring: how a resolved vault value is delivered to the MCP subprocess. */
export type McpSecretInject =
  | { env: string; fixed_input?: never }        // inject as env var named `env`
  | { fixed_input: string; env?: never };        // inject as fixed_inputs param named `fixed_input`

/** A single declared credential on an MCP server. */
export interface McpSecretDeclaration {
  /** Flat vault key — shareable across skills and MCP servers (e.g. `google_oauth_client_id`). */
  key: string;
  /** Human-readable label for the console credential form. */
  label: string;
  /** True = blocks enable until vault has a non-empty value for this key. */
  required: boolean;
  /** True = masked input in the console UI (passwords); false = plain text (handles, IDs). */
  secret: boolean;
  /** How the resolved vault value reaches the subprocess at spawn time. */
  inject: McpSecretInject;
}

export interface McpStdioServerEntry {
  name: string;
  transport: 'stdio';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  command: string;
  args?: string[];
  /** Non-secret env var literals only. Use secrets[] + inject:{env:} for vault-backed values. */
  env?: Record<string, string>;
  /** Constant tool-call parameters. Use secrets[] + inject:{fixed_input:} for vault-backed values. */
  fixed_inputs?: Record<string, string>;
  /** Declared credentials. Each entry names a flat vault key, provides console metadata,
   *  and specifies how the resolved value is injected into the subprocess. */
  secrets?: McpSecretDeclaration[];
}

export interface McpSseServerEntry {
  name: string;
  transport: 'sse';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  url: string;
  headers?: Record<string, string>;
  fixed_inputs?: Record<string, string>;
}

export type McpServerEntry = McpStdioServerEntry | McpSseServerEntry;

export interface SkillsConfig {
  servers?: McpServerEntry[];
}
