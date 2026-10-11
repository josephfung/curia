// config.workspace-mcp-pin.test.ts — workspace-mcp is pinned in exactly one place,
// scripts/workspace-mcp.pin, and every launch site goes through it (#2010).
//
// Before this, each site ran a bare `uvx workspace-mcp`, which floated to PyPI latest
// and downloaded the package and its dependencies on every boot. The Dockerfile now
// installs the pin at build time and imports one module per allowlisted service, so a
// service whose import breaks fails the build instead of quietly dropping its tools.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSkillsConfig } from '../../src/skills/mcp-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const PIN_FILE = 'scripts/workspace-mcp.pin';
const LAUNCHER = 'scripts/workspace-mcp.sh';
const VENDORED = '/opt/uv/bin/workspace-mcp';

// The module workspace-mcp's main.py imports for each `--tools` service. A service
// added to the allowlist needs its module here, so the Dockerfile's import check
// covers it; look it up in the `tool_imports` map in upstream main.py.
const SERVICE_MODULES: Record<string, string> = {
  drive: 'gdrive.drive_tools',
  docs: 'gdocs.docs_tools',
  sheets: 'gsheets.sheets_tools',
};

function readPin(): Record<string, string> {
  const pin: Record<string, string> = {};
  for (const line of read(PIN_FILE).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_]+)=(\S+)$/.exec(trimmed);
    if (!match) throw new Error(`${PIN_FILE}: not a plain KEY=VALUE line: ${line}`);
    pin[match[1]!] = match[2]!;
  }
  return pin;
}

function googleWorkspaceServer() {
  const servers = loadSkillsConfig(join(ROOT, 'config')).servers ?? [];
  const server = servers.find((s) => s.name === 'google-workspace');
  if (!server || server.transport !== 'stdio') throw new Error('no stdio google-workspace server in config/skills.yaml');
  return server;
}

/** The `--tools` services; config.google-workspace-allowlist.test.ts pins their exact set. */
function allowlistedServices(): string[] {
  const args = (googleWorkspaceServer().args ?? []).map(String);
  const services: string[] = [];
  for (const arg of args.slice(args.indexOf('--tools') + 1)) {
    if (arg.startsWith('-')) break;
    services.push(arg);
  }
  return services;
}

describe('scripts/workspace-mcp.pin', () => {
  it('defines exactly the version and the dependency cutoff', () => {
    const pin = readPin();
    expect(Object.keys(pin).sort()).toEqual(['WORKSPACE_MCP_EXCLUDE_NEWER', 'WORKSPACE_MCP_VERSION']);
    // An exact release: a range would float again.
    expect(pin.WORKSPACE_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // RFC 3339 in UTC, the form uv's --exclude-newer takes.
    expect(pin.WORKSPACE_MCP_EXCLUDE_NEWER).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(pin.WORKSPACE_MCP_EXCLUDE_NEWER!))).toBe(false);
  });
});

describe('every launch site uses the pin', () => {
  it('config/skills.yaml launches the server through the launcher', () => {
    const server = googleWorkspaceServer();
    expect(server.command).toBe(LAUNCHER);
    // The launcher supplies the package itself; a leading package token would reach
    // workspace-mcp as a stray argument.
    expect((server.args ?? []).some((a) => String(a).startsWith('workspace-mcp'))).toBe(false);
  });

  it('scripts/gdrive-auth.py launches the server through the launcher', () => {
    const script = read('scripts/gdrive-auth.py');
    expect(script).toContain('"workspace-mcp.sh"');
    expect(script).not.toMatch(/command\s*=\s*"uvx"/);
  });

  it('the Dockerfile installs from the pin file', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(`COPY ${PIN_FILE} `);
    expect(dockerfile).toContain('--exclude-newer "$WORKSPACE_MCP_EXCLUDE_NEWER" "workspace-mcp==$WORKSPACE_MCP_VERSION"');
  });

  it('no site hard-codes a version or a cutoff', () => {
    for (const path of ['Dockerfile', 'config/skills.yaml', 'scripts/gdrive-auth.py', LAUNCHER, 'docs/dev/google-drive.md']) {
      const text = read(path);
      expect(text, path).not.toMatch(/workspace-mcp\s*[=<>~!]=?\s*\d/);
      expect(text, path).not.toMatch(/--exclude-newer[ =]+["']?\d/);
    }
  });
});

describe('the Dockerfile import check', () => {
  it('imports main plus the module of every allowlisted service, and nothing else', () => {
    const match = /-c\s*\\?\s*"import (main(?:, [\w.]+)*)"/.exec(read('Dockerfile'));
    expect(match, 'no `python -c "import main, ..."` check in the Dockerfile').not.toBeNull();
    const imported = match![1]!.split(', ').sort();

    const services = allowlistedServices();
    const unmapped = services.filter((s) => !(s in SERVICE_MODULES));
    expect(unmapped, 'add these services to SERVICE_MODULES').toEqual([]);
    expect(imported).toEqual(['main', ...services.map((s) => SERVICE_MODULES[s]!)].sort());
  });
});

// Runs the real launcher against a fake uvx that echoes its arguments. Skipped where
// the image's vendored install exists, since the launcher would exec that instead.
describe.skipIf(existsSync(VENDORED))('scripts/workspace-mcp.sh off the image', () => {
  it('runs uvx at the pinned version and cutoff, passing arguments through', () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-uvx-'));
    try {
      writeFileSync(join(bin, 'uvx'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const out = execFileSync(join(ROOT, LAUNCHER), ['--tools', 'drive', 'docs'], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
      });
      const pin = readPin();
      expect(out.trim().split('\n')).toEqual([
        '--exclude-newer',
        pin.WORKSPACE_MCP_EXCLUDE_NEWER,
        `workspace-mcp==${pin.WORKSPACE_MCP_VERSION}`,
        '--tools',
        'drive',
        'docs',
      ]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
