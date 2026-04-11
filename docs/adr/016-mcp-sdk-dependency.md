# ADR 016 — Official MCP SDK over hand-rolled transport layer

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Issue #270 adds an MCP (Model Context Protocol) client layer so agents can invoke
tools from external MCP-compatible servers alongside local skills. Two implementation
approaches were considered:

1. **Hand-rolled transport** — implement stdio and SSE transports from scratch using
   Node.js `child_process` and `EventSource`, speaking the MCP JSON-RPC wire protocol
   directly. No external dependency; full control.

2. **Official `@modelcontextprotocol/sdk`** — use the SDK published by Anthropic, which
   provides `Client`, `StdioClientTransport`, and `SSEClientTransport` with protocol
   negotiation, capability exchange, and request/response correlation handled internally.

A third question was whether to model MCP tools as a separate registry, or to register
them transparently alongside local skills in the existing `SkillRegistry`.

## Decision

### Use `@modelcontextprotocol/sdk` (option 2)

MCP's wire protocol is non-trivial: it involves capability negotiation (`initialize` /
`initialized` lifecycle), JSON-RPC request/response correlation with pending-request
tracking, and multiple transport variants. Hand-rolling this is substantial code that
duplicates work already done in the official SDK and diverges from the canonical
implementation as the spec evolves.

The SDK is published under an MIT licence by the MCP authors (Anthropic). It is the
reference implementation used by other MCP-compatible clients and servers, which means
interoperability is guaranteed against the same protocol version. Adopting it incurs a
single additional `dependencies` entry; the SDK bundles no heavy transitive dependencies.

All SDK usage is isolated to `src/skills/mcp-client.ts`. No other module imports from
`@modelcontextprotocol/sdk`, which limits the blast radius of a future SDK upgrade or
replacement.

### Register MCP tools transparently in `SkillRegistry` (registry-transparent design)

MCP tools are registered in the existing `SkillRegistry` using the same
`register(manifest, handler)` interface as local skills. Agents call
`registry.toToolDefinitions()` and receive a flat list — they cannot distinguish local
from MCP tools. The `ExecutionLayer` is invoked for every tool call regardless of origin,
which means sanitization, timeout enforcement, sensitivity gating, and audit logging apply
uniformly.

This honours the design constraint stated in the original spec: *"Two types, one
interface. Agents don't know or care which kind they're using."*

An optional `mcpInputSchema` field on `RegisteredSkill` stores the raw JSON Schema
returned by `tools/list`. When present, `toToolDefinitions()` passes it through directly
instead of converting from the shorthand `inputs` format used by local skill manifests.
This avoids a lossy round-trip and preserves the full JSON Schema fidelity that MCP
servers produce.

### `SSEClientTransport` → `StreamableHTTPClientTransport` migration

~~At the time of writing, `SSEClientTransport` carries an internal deprecation notice in
the SDK in favour of the newer `StreamableHTTPClientTransport`.~~

**Completed in PR #271.** The `sse` transport type in `config/skills.yaml` now routes
through `StreamableHTTPClientTransport`, which uses a single combined POST+SSE endpoint
pattern matching Google's and other hosted MCP servers. The migration was isolated to
`src/skills/mcp-client.ts` as predicted.

An optional `headers: Record<string, string>` field was added to the SSE server config
to support bearer-token authentication (e.g. `Authorization: Bearer <token>`) required
by hosted MCP servers. The config schema and loader interface were updated accordingly.

## Consequences

- **Easier:** Adding new MCP servers requires only a `config/skills.yaml` entry; no code
  changes. Operators can extend Curia's tool surface without touching the codebase.
- **Easier:** Protocol upgrades (new MCP spec versions) are handled by bumping the SDK
  dependency rather than patching hand-rolled JSON-RPC logic.
- **Easier:** MCP tool calls inherit the full execution pipeline (audit log, timeouts,
  sanitization) with no extra wiring.
- **Harder:** The SDK's internal retry and reconnection behaviour is opaque. Connection
  failures are handled at the loader level (warn-not-crash), but persistent disconnects
  after startup are not yet managed. A future reconnection loop may be needed for
  long-running deployments.
- ~~**Risk:** `SSEClientTransport` is deprecated upstream. When it is removed, the `sse`
  transport type will need to be remapped to `StreamableHTTPClientTransport`.~~ **Resolved
  in PR #271** — the migration is complete.
