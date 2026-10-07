// test-mode-mcp.test.ts — the test-mode stack's snapshot-served MCP servers (#2024).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { resolveSkillActivation } from '../../../src/skills/skill-activation.js';
import { GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME } from '../../../src/skills/mcp-loader.js';
import {
  cannedMcpResultText,
  loadMcpToolsSnapshot,
  registerSnapshotMcpServers,
} from '../../../src/startup/test-mode-mcp.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
const CONFIG_DIR = path.join(REPO, 'config');
const SNAPSHOT_DIR = path.join(REPO, 'tests', 'fixtures', 'mcp');
const SKILLS_DIR = path.join(REPO, 'skills');
const logger = pino({ level: 'silent' });

function register(snapshotDir = SNAPSHOT_DIR) {
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const result = registerSnapshotMcpServers({
    configDir: CONFIG_DIR, snapshotDir, toolRegistry, skillRegistry, skillsDir: SKILLS_DIR, logger,
  });
  return { toolRegistry, skillRegistry, result };
}

describe('google-workspace snapshot', () => {
  const snapshot = loadMcpToolsSnapshot(path.join(SNAPSHOT_DIR, 'google-workspace.tools.json'), 'google-workspace');

  it('holds no Calendar tool (the allowlist excludes Calendar, #1853)', () => {
    expect(snapshot.tools.filter(t => GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME.test(t.name))).toEqual([]);
  });

  it('includes the tools the coordinator scenarios exercise', () => {
    const names = new Set(snapshot.tools.map(t => t.name));
    for (const tool of ['update_drive_file', 'manage_drive_access', 'get_doc_as_markdown', 'search_drive_files']) {
      expect(names.has(tool)).toBe(true);
    }
  });
});

describe('registerSnapshotMcpServers', () => {
  it('registers every snapshot tool through production registration', () => {
    const { toolRegistry, result } = register();
    expect(result.serversWithoutSnapshot).toEqual([]);
    expect(result.tools.size).toBeGreaterThan(0);
    const tool = toolRegistry.get('update_drive_file')!;
    // The server entry's action_risk applies, as at boot.
    expect(tool.manifest.action_risk).toBe('low');
    // The fixed input (curia_google_email → user_google_email) is stripped from what
    // the model sees, as at boot.
    expect(tool.mcpInputSchema?.properties).not.toHaveProperty('user_google_email');
    expect(tool.mcpInputSchema?.required ?? []).not.toContain('user_google_email');
    expect(tool.mcpInputSchema?.properties).toHaveProperty('add_parents');
  });

  it('projects the server as a skill with its references, which skill-activate can load', () => {
    const { toolRegistry, skillRegistry, result } = register();
    const skill = skillRegistry.get('google-workspace')!;
    expect(skill.manifest.tools.length).toBe(result.tools.size);
    expect(skill.manifest.references).toContain('drive-files.md');

    const activation = resolveSkillActivation({
      skillName: 'google-workspace', skillRegistry, toolRegistry, agentId: 'coordinator', reference: 'drive-files.md',
    });
    expect('error' in activation).toBe(false);
    if (!('error' in activation)) {
      expect(activation.tools).toContain('update_drive_file');
      expect(activation.referenceContent?.content).toContain('update_drive_file');
    }
  });

  it('answers a call with the canned text and reaches nothing', async () => {
    const { toolRegistry } = register();
    const result = await toolRegistry.get('get_doc_as_markdown')!.handler.execute({
      input: { document_id: 'abc' },
    } as never);
    expect(result).toEqual({ success: true, data: cannedMcpResultText('google-workspace', 'get_doc_as_markdown') });
  });

  it('reports a configured server with no snapshot instead of registering it', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-snapshots-'));
    try {
      const { toolRegistry, skillRegistry, result } = register(empty);
      expect(result.serversWithoutSnapshot).toEqual(['google-workspace']);
      expect(toolRegistry.get('update_drive_file')).toBeUndefined();
      expect(skillRegistry.get('google-workspace')).toBeUndefined();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('rejects a snapshot for the wrong server or with no tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-snapshots-'));
    try {
      const file = path.join(dir, 'x.tools.json');
      fs.writeFileSync(file, JSON.stringify({ server: 'other', source: 's', captured: '2026-10-06', tools: [] }));
      expect(() => loadMcpToolsSnapshot(file, 'x')).toThrow(/for server 'other'/);
      fs.writeFileSync(file, JSON.stringify({ server: 'x', source: 's', captured: '2026-10-06', tools: [] }));
      expect(() => loadMcpToolsSnapshot(file, 'x')).toThrow(/no tools/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
