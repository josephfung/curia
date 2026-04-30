import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';
import type { SkillManifest, SkillHandler } from '../../../src/skills/types.js';

const stubHandler: SkillHandler = {
  execute: async () => ({ success: true, data: 'stub' }),
};

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    description: 'A test skill',
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'none',
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 30000,
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('registers and retrieves a skill by name', () => {
    const manifest = makeManifest({ name: 'my-skill' });
    registry.register(manifest, stubHandler);
    const skill = registry.get('my-skill');
    expect(skill).toBeDefined();
    expect(skill!.manifest.name).toBe('my-skill');
  });

  it('returns undefined for unknown skill', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered skills', () => {
    registry.register(makeManifest({ name: 'a' }), stubHandler);
    registry.register(makeManifest({ name: 'b' }), stubHandler);
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.manifest.name)).toEqual(['a', 'b']);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeManifest({ name: 'dup' }), stubHandler);
    expect(() => registry.register(makeManifest({ name: 'dup' }), stubHandler))
      .toThrow(/already registered/);
  });

  it('searches skills by description keyword', () => {
    registry.register(makeManifest({ name: 'email-parser', description: 'Parse emails from IMAP' }), stubHandler);
    registry.register(makeManifest({ name: 'web-fetch', description: 'Fetch web pages via HTTP' }), stubHandler);
    const results = registry.search('email');
    expect(results).toHaveLength(1);
    expect(results[0].manifest.name).toBe('email-parser');
  });

  it('search is case-insensitive', () => {
    registry.register(makeManifest({ name: 'web-fetch', description: 'Fetch web pages via HTTP GET' }), stubHandler);
    const results = registry.search('HTTP');
    expect(results).toHaveLength(1);
  });

  it('converts registered skills to LLM tool definitions', () => {
    registry.register(makeManifest({
      name: 'web-fetch',
      description: 'Fetch a web page',
      inputs: { url: 'string', max_length: 'number?' },
    }), stubHandler);
    const tools = registry.toToolDefinitions(['web-fetch']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web-fetch');
    expect(tools[0].description).toBe('Fetch a web page');
    expect(tools[0].input_schema.properties).toHaveProperty('url');
    expect(tools[0].input_schema.properties).toHaveProperty('max_length');
  });

  it('strips parenthetical descriptions from type strings and moves them to description', () => {
    registry.register(makeManifest({
      name: 'template-skill',
      description: 'A template skill',
      inputs: {
        action: 'string (generate | update | save | reset)',
        recipient_name: 'string? (required for generate)',
        offer_reschedule: 'boolean? (optional for generate — whether to offer rescheduling)',
      },
    }), stubHandler);
    const tools = registry.toToolDefinitions(['template-skill']);
    const props = tools[0].input_schema.properties;

    // Required field with parenthetical description
    expect(props.action.type).toBe('string');
    expect(props.action.description).toBe('generate | update | save | reset');

    // Optional field with parenthetical description
    expect(props.recipient_name.type).toBe('string');
    expect(props.recipient_name.description).toBe('required for generate');

    // Optional boolean with long parenthetical description
    expect(props.offer_reschedule.type).toBe('boolean');
    expect(props.offer_reschedule.description).toBe('optional for generate — whether to offer rescheduling');

    // action is required, the other two are optional
    expect(tools[0].input_schema.required).toEqual(['action']);
  });

  it('does not add description when type has no parenthetical', () => {
    registry.register(makeManifest({
      name: 'simple-skill',
      description: 'Simple',
      inputs: { url: 'string', count: 'number' },
    }), stubHandler);
    const tools = registry.toToolDefinitions(['simple-skill']);
    const props = tools[0].input_schema.properties;
    expect(props.url).toEqual({ type: 'string' });
    expect(props.count).toEqual({ type: 'number' });
  });

  it('converts array type inputs to JSON Schema array with items', () => {
    registry.register(makeManifest({
      name: 'array-skill',
      description: 'Takes arrays',
      inputs: {
        ids: 'string[]',
        tags: 'string[]? (optional list of tags)',
      },
    }), stubHandler);
    const tools = registry.toToolDefinitions(['array-skill']);
    const props = tools[0].input_schema.properties;

    // Required string array
    expect(props.ids).toEqual({ type: 'array', items: { type: 'string' } });
    // Optional string array with description
    expect(props.tags).toEqual({ type: 'array', items: { type: 'string' }, description: 'optional list of tags' });
    // ids is required, tags is not
    expect(tools[0].input_schema.required).toEqual(['ids']);
  });

  it('throws on invalid primitive type in skill manifest (e.g. em-dash format)', () => {
    // Regression test: "string — description" was the format that caused a production
    // outage — the em-dash made the parser capture "string — description" as the type
    // token, which is not a valid JSON Schema type. This must fail at startup.
    registry.register(makeManifest({
      name: 'bad-type-skill',
      description: 'Bad manifest',
      inputs: { entity: 'string — the entity name' },
    }), stubHandler);
    expect(() => registry.toToolDefinitions(['bad-type-skill']))
      .toThrow(/invalid type/);
  });

  it('throws on invalid array item type in skill manifest', () => {
    registry.register(makeManifest({
      name: 'bad-array-skill',
      description: 'Bad manifest',
      inputs: { ids: 'foo[]' },
    }), stubHandler);
    expect(() => registry.toToolDefinitions(['bad-array-skill']))
      .toThrow(/invalid array item type 'foo'/);
  });

  it('toToolDefinitions ignores unknown skill names', () => {
    const tools = registry.toToolDefinitions(['nonexistent']);
    expect(tools).toHaveLength(0);
  });

  // ── MCP input schema fast-path ──────────────────────────────────────────────

  it('registers an MCP-sourced skill with mcpInputSchema', () => {
    const mcpInputSchema = {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'File path to read' } },
      required: ['path'],
    };
    const manifest = makeManifest({ name: 'mcp-readfile', inputs: {} });
    registry.register(manifest, stubHandler, mcpInputSchema);

    const skill = registry.get('mcp-readfile');
    expect(skill).toBeDefined();
    expect(skill!.mcpInputSchema).toEqual(mcpInputSchema);
  });

  it('toToolDefinitions uses mcpInputSchema directly (bypasses shorthand parsing)', () => {
    // MCP tools have a rich JSON Schema that would be lossy to convert to shorthand.
    // The fast-path should emit it verbatim.
    const mcpInputSchema = {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Max results' },
      },
      required: ['query'],
    };
    const manifest = makeManifest({
      name: 'mcp-search',
      description: 'Search documents',
      inputs: {}, // hollow — not used for MCP tools
    });
    registry.register(manifest, stubHandler, mcpInputSchema);

    const tools = registry.toToolDefinitions(['mcp-search']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp-search');
    expect(tools[0].description).toBe('Search documents');
    // Schema must be passed through verbatim — not re-parsed via shorthand notation.
    expect(tools[0].input_schema).toEqual(mcpInputSchema);
  });

  it('toToolDefinitions mixes local and MCP skills in one call', () => {
    // Local skill — uses shorthand inputs.
    registry.register(makeManifest({
      name: 'local-fetch',
      description: 'Fetch a URL',
      inputs: { url: 'string' },
    }), stubHandler);

    // MCP skill — uses raw schema.
    const mcpInputSchema = {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    registry.register(
      makeManifest({ name: 'mcp-read', description: 'Read a file', inputs: {} }),
      stubHandler,
      mcpInputSchema,
    );

    const tools = registry.toToolDefinitions(['local-fetch', 'mcp-read']);
    expect(tools).toHaveLength(2);

    const localTool = tools.find(t => t.name === 'local-fetch')!;
    expect(localTool.input_schema.properties.url).toEqual({ type: 'string' });

    const mcpTool = tools.find(t => t.name === 'mcp-read')!;
    expect(mcpTool.input_schema).toEqual(mcpInputSchema);
  });
});
