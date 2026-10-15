import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOverlay } from '../../scenarios/overlay.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'overlay-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function file(rel: string, body: string): void {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe('buildOverlay (#2025)', () => {
  beforeEach(() => {
    file('core/agents/coordinator.yaml', 'core coordinator');
    file('core/agents/calendar.yaml', 'core calendar');
    file('core/skills/delegate/tool.json', '{}');
    file('core/skills/calendar/SKILL.md', 'core');
    file('core/skills/calendar/tools/calendar-list-events/tool.json', '{}');
    file('core/config/default.yaml', 'core: true');
    file('core/config/skills.yaml', 'servers: [core]');
    file('custom/agents/digest.yaml', 'custom digest');
    file('custom/agents/calendar.yaml', 'custom calendar');
    file('custom/skills/fx-lookup/tool.json', '{}');
    file('custom/skills/fx-lookup/handler.ts', 'export {}');
    file('custom/config/skills.yaml', 'servers: [core, bluesky]');
    file('custom/config/local.yaml', 'local: true');
  });

  it('lays the deployment\'s agents, skills and config over core\'s, as its image does', () => {
    const o = buildOverlay(path.join(dir, 'custom'), path.join(dir, 'core'));
    try {
      expect(readFileSync(path.join(o.agentsDir, 'coordinator.yaml'), 'utf-8')).toBe('core coordinator');
      expect(readFileSync(path.join(o.agentsDir, 'calendar.yaml'), 'utf-8')).toBe('custom calendar');
      expect(readFileSync(path.join(o.agentsDir, 'digest.yaml'), 'utf-8')).toBe('custom digest');
      expect(existsSync(path.join(o.skillsDir, 'calendar/tools/calendar-list-events/tool.json'))).toBe(true);
      expect(readFileSync(path.join(o.configDir, 'skills.yaml'), 'utf-8')).toBe('servers: [core, bluesky]');
      expect(readFileSync(path.join(o.configDir, 'local.yaml'), 'utf-8')).toBe('local: true');
      expect(readFileSync(path.join(o.configDir, 'default.yaml'), 'utf-8')).toBe('core: true');
    } finally {
      o.cleanup();
    }
    expect(existsSync(o.agentsDir)).toBe(false);
  });

  it('mirrors directories as real ones and files as links to the originals', () => {
    const o = buildOverlay(path.join(dir, 'custom'), path.join(dir, 'core'));
    try {
      // Discovery skips a symlinked directory; a handler imports from its real path.
      expect(lstatSync(path.join(o.skillsDir, 'fx-lookup')).isDirectory()).toBe(true);
      const handler = path.join(o.skillsDir, 'fx-lookup', 'handler.ts');
      expect(lstatSync(handler).isSymbolicLink()).toBe(true);
      expect(realpathSync(handler)).toBe(realpathSync(path.join(dir, 'custom/skills/fx-lookup/handler.ts')));
    } finally {
      o.cleanup();
    }
  });

  it('leaves a layer the deployment lacks as core\'s', () => {
    rmSync(path.join(dir, 'custom/skills'), { recursive: true });
    const o = buildOverlay(path.join(dir, 'custom'), path.join(dir, 'core'));
    try {
      expect(existsSync(path.join(o.skillsDir, 'delegate/tool.json'))).toBe(true);
      expect(existsSync(path.join(o.skillsDir, 'fx-lookup'))).toBe(false);
    } finally {
      o.cleanup();
    }
  });
});
