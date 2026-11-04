import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  describerHash,
  knownWriteToolNames,
  signalEffect,
  toolFactsFrom,
  type LearnedDescriber,
  type ToolFacts,
} from '../../../src/activity/learned-describers.js';
import type { RegisteredTool } from '../../../src/skills/types.js';

function facts(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return { name: 'sheet-append', description: 'Append a row', inputSchema: { type: 'object' }, actionRisk: 'low', mcp: false, ...overrides };
}

function registered(name: string, actionRisk: RegisteredTool['manifest']['action_risk'], mcp?: { readOnlyHint?: boolean }): RegisteredTool {
  return {
    manifest: { name, description: name, version: '1.0.0', sensitivity: 'normal', action_risk: actionRisk, inputs: {}, outputs: {}, permissions: [], secrets: [], timeout: 1000 },
    handler: { execute: async () => ({ success: true, data: null }) },
    ...(mcp ? { mcpInputSchema: { type: 'object', properties: {} }, mcpAnnotations: mcp } : {}),
  } as RegisteredTool;
}

function row(overrides: Partial<LearnedDescriber> = {}): LearnedDescriber {
  return {
    agentId: 'expenses', toolName: 'sheet-append', effect: 'write', verb: 'logged', one: 'an expense', many: 'expenses',
    attempt: 'log an expense', descriptionHash: 'h', source: 'learned', ...overrides,
  };
}

describe('signalEffect', () => {
  it('reads local action_risk: none is a read, medium and above a write, low is left to the model', () => {
    expect(signalEffect(facts({ actionRisk: 'none' }))).toBe('read');
    expect(signalEffect(facts({ actionRisk: 0 }))).toBe('read');
    expect(signalEffect(facts({ actionRisk: 'low' }))).toBeNull();
    expect(signalEffect(facts({ actionRisk: 65 }))).toBeNull();
    expect(signalEffect(facts({ actionRisk: 'medium' }))).toBe('write');
    expect(signalEffect(facts({ actionRisk: 'critical' }))).toBe('write');
  });

  it('ignores an MCP tool\'s server-wide action_risk and reads its annotations', () => {
    expect(signalEffect(facts({ mcp: true, actionRisk: 'high', readOnlyHint: true }))).toBe('read');
    expect(signalEffect(facts({ mcp: true, actionRisk: 'none', readOnlyHint: false }))).toBe('write');
    expect(signalEffect(facts({ mcp: true, actionRisk: 'none', destructiveHint: true }))).toBe('write');
    expect(signalEffect(facts({ mcp: true, actionRisk: 'critical' }))).toBeNull();
  });
});

describe('describerHash', () => {
  it('is stable across key order and changes with the description or schema', () => {
    const base = describerHash(facts({ inputSchema: { a: 1, b: 2 } }));
    expect(describerHash(facts({ inputSchema: { b: 2, a: 1 } }))).toBe(base);
    expect(describerHash(facts({ inputSchema: { a: 1, b: 3 } }))).not.toBe(base);
    expect(describerHash(facts({ description: 'Append two rows', inputSchema: { a: 1, b: 2 } }))).not.toBe(base);
  });

  it('changes when the deterministic signal changes, and only then', () => {
    const mcp = facts({ mcp: true, actionRisk: 'none' });
    expect(describerHash({ ...mcp, readOnlyHint: false })).not.toBe(describerHash(mcp));
    expect(describerHash({ ...mcp, destructiveHint: true })).not.toBe(describerHash(mcp));
    // Server-wide action_risk does not change an MCP tool's signal.
    expect(describerHash({ ...mcp, actionRisk: 'high' })).toBe(describerHash(mcp));
    const local = facts({ actionRisk: 'low' });
    expect(describerHash({ ...local, actionRisk: 'medium' })).not.toBe(describerHash(local));
    expect(describerHash({ ...local, actionRisk: 'none' })).not.toBe(describerHash(local));
    // low and 65 both leave it to the model: nothing to relearn.
    expect(describerHash({ ...local, actionRisk: 65 })).toBe(describerHash(local));
  });
});

describe('buildCatalog', () => {
  it('finds a row by agent and tool, and ignores rows for tools described in code', () => {
    const catalog = buildCatalog([row(), row({ toolName: 'email-archive', verb: 'binned' })], []);
    expect(catalog.learned('expenses', 'sheet-append')?.verb).toBe('logged');
    expect(catalog.learned('coordinator', 'sheet-append')).toBeUndefined();
    expect(catalog.learned('expenses', 'email-archive')).toBeUndefined();
  });

  it('reports known writes, never for a tool described in code', () => {
    const catalog = buildCatalog([], ['sheet-append', 'email-send']);
    expect(catalog.knownWrite('sheet-append')).toBe(true);
    expect(catalog.knownWrite('email-send')).toBe(false);
    expect(catalog.knownWrite('sheet-read')).toBe(false);
  });
});

describe('knownWriteToolNames', () => {
  it('lists undescribed tools whose signal is a write', () => {
    const names = knownWriteToolNames([
      registered('custom-payment', 'critical'),
      registered('custom-note', 'low'),
      registered('custom-lookup', 'none'),
      registered('email-send', 'medium'),
      registered('sheet-write', 'none', { readOnlyHint: false }),
      registered('sheet-read', 'high', { readOnlyHint: true }),
    ]);
    expect(names).toEqual(['custom-payment', 'sheet-write']);
  });

  it('carries MCP annotations into the facts', () => {
    expect(toolFactsFrom(registered('sheet-read', 'high', { readOnlyHint: true }))).toMatchObject({ mcp: true, readOnlyHint: true });
    expect(toolFactsFrom(registered('custom-note', 'low'))).toMatchObject({ mcp: false });
  });
});
