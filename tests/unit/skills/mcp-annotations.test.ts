// MCP tool annotations reach the registry for the activity feed (#2455, ADR-059)
// without touching the action_risk autonomy enforces.

import { describe, expect, it, vi } from 'vitest';
import { signalEffect, toolFactsFrom } from '../../../src/activity/learned-describers.js';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { createSilentLogger } from '../../../src/logger.js';
import { registerMcpServerTools, type McpToolSession } from '../../../src/skills/mcp-loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';

describe('registerMcpServerTools annotations', () => {
  it('keeps boolean read-only/destructive hints and leaves the server action_risk in place', () => {
    const registry = new ToolRegistry();
    const session = { serverId: 'sheets', client: { callTool: vi.fn() } } as unknown as McpToolSession;
    const schema = { type: 'object', properties: {} };
    registerMcpServerTools({
      serverEntry: { name: 'sheets', transport: 'sse', url: 'https://mcp.example.com', action_risk: 'high' },
      session,
      tools: [
        { name: 'read_rows', inputSchema: schema, annotations: { readOnlyHint: true, title: 'Read rows' } },
        { name: 'clear_sheet', inputSchema: schema, annotations: { destructiveHint: true, readOnlyHint: 'no' } },
        { name: 'append_row', inputSchema: schema },
      ],
      resolvedFixedInputs: {},
      registry,
      logger: createSilentLogger(),
    });

    expect(registry.get('read_rows')?.mcpAnnotations).toEqual({ readOnlyHint: true });
    expect(registry.get('clear_sheet')?.mcpAnnotations).toEqual({ destructiveHint: true });
    expect(registry.get('append_row')?.mcpAnnotations).toBeUndefined();

    // The feed reads the hints; autonomy still sees the server's risk for every tool.
    expect(signalEffect(toolFactsFrom(registry.get('read_rows')!))).toBe('read');
    expect(signalEffect(toolFactsFrom(registry.get('clear_sheet')!))).toBe('write');
    expect(signalEffect(toolFactsFrom(registry.get('append_row')!))).toBeNull();
    for (const name of ['read_rows', 'clear_sheet', 'append_row']) {
      const risk = registry.get(name)!.manifest.action_risk;
      expect(risk).toBe('high');
      expect(AutonomyService.minScoreForActionRisk(risk)).toBe(80);
    }
  });
});
