// config.workspace-mcp-pin.test.ts — workspace-mcp and its whole dependency tree are
// pinned in exactly one place, the hash-pinned lockfile scripts/workspace-mcp/requirements.txt
// (compiled from requirements.in beside it), and every launch site goes through it
// (#2010, #2657).
//
// Before #2010, each site ran a bare `uvx workspace-mcp`, which floated to PyPI latest
// and downloaded the package and its dependencies on every boot. Until #2657 the tree was
// frozen by one global --exclude-newer cutoff, so fixing one CVE moved every package and
// Dependabot could not see any of them. The Dockerfile installs the lockfile at build time
// and imports one module per allowlisted service, so a service whose import breaks fails
// the build instead of quietly dropping its tools.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSkillsConfig } from '../../src/skills/mcp-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const LOCK_INPUT = 'scripts/workspace-mcp/requirements.in';
const LOCKFILE = 'scripts/workspace-mcp/requirements.txt';
const LAUNCHER = 'scripts/workspace-mcp.sh';
const VENDORED = '/opt/uv/bin/workspace-mcp';
// The Python the image installs into: the Debian trixie python3 the Dockerfile installs.
// The lockfile is compiled for it (--python-version), since markers and wheels depend on it.
const IMAGE_PYTHON = '3.13';

/** The `name==version` requirement lines of a requirements file, comments and hashes dropped. */
function pinnedRequirements(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+?)(?:\s|;|$)/.exec(line);
    if (match) pins.set(match[1]!.toLowerCase(), match[2]!);
  }
  return pins;
}

/** Requirement entries (one per package, continuation lines joined) of the lockfile. */
function lockEntries(text: string): string[] {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => /^[A-Za-z0-9]/.test(line));
}

// The module workspace-mcp's main.py imports for each `--tools` service. A service
// added to the allowlist needs its module here, so the Dockerfile's import check
// covers it; look it up in the `tool_imports` map in upstream main.py.
const SERVICE_MODULES: Record<string, string> = {
  drive: 'gdrive.drive_tools',
  docs: 'gdocs.docs_tools',
  sheets: 'gsheets.sheets_tools',
};

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

describe('the workspace-mcp lockfile', () => {
  it('requirements.in names exactly one requirement: workspace-mcp at an exact release', () => {
    const lines = read(LOCK_INPUT)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    // A range would float again; anything else would be installed beside the server.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^workspace-mcp==\d+\.\d+\.\d+$/);
  });

  it('requirements.txt pins the same workspace-mcp release', () => {
    const wanted = pinnedRequirements(read(LOCK_INPUT)).get('workspace-mcp');
    // A Dependabot bump of workspace-mcp edits both files; a hand edit to one is caught here.
    expect(pinnedRequirements(read(LOCKFILE)).get('workspace-mcp')).toBe(wanted);
  });

  it('pins every package to an exact version with at least one hash', () => {
    // The image installs with --require-hashes, which rejects an entry without one; this
    // says which entry at test time rather than at image build time.
    const entries = lockEntries(read(LOCKFILE));
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry, entry.slice(0, 60)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*==\S+/);
      expect(entry, entry.slice(0, 60)).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    }
  });

  it('holds requirements and comments only: no index, editable or include options', () => {
    // An --index-url / --extra-index-url line changes where packages come from, -e installs
    // what no hash can cover, and -r/-c pull in another file. None belongs in this lockfile.
    const optionLines = read(LOCKFILE)
      .split('\n')
      .filter((l) => l.startsWith('-'));
    expect(optionLines).toEqual([]);
  });

  it('was compiled the way Dependabot recompiles it', () => {
    // Dependabot's uv updater rebuilds its `uv pip compile` options from this header and
    // the file's content (--universal, --generate-hashes, --python-version). A missing
    // --universal drops other platforms' markers; another Python resolves other wheels.
    const header = read(LOCKFILE).split('\n').slice(0, 2).join('\n');
    expect(header).toContain('autogenerated by uv');
    expect(header).toContain('uv pip compile');
    expect(header).toContain('--universal');
    expect(header).toContain('--generate-hashes');
    expect(header).toContain(`--python-version ${IMAGE_PYTHON}`);
    // A cutoff in the header would be replayed on a hand recompile and hold the tree back.
    expect(header).not.toContain('--exclude-newer');
  });
});

describe('every launch site uses the lockfile', () => {
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

  it('the Dockerfile installs exactly the lockfile, checking every hash', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(`COPY ${LOCKFILE} /tmp/workspace-mcp.lock`);
    expect(dockerfile).toMatch(/uv pip sync [^;]*--require-hashes[^;]*\/tmp\/workspace-mcp\.lock/);
    // A wheel-less entry must fail the build, not fetch an unhashed build backend.
    expect(dockerfile).toMatch(/uv pip sync [^;]*--no-build[^;]*\/tmp\/workspace-mcp\.lock/);
    // uv 0.6.3's tool install ignores the hashes in a constraints file. Comments may name it.
    const instructions = dockerfile.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(instructions.join('\n')).not.toContain('uv tool install');
  });

  it('a lockfile change builds the image, on the PR and on main', () => {
    // No other PR check builds the image, so a Dependabot bump would otherwise merge unbuilt.
    expect(read('.github/workflows/workspace-mcp-lock.yml')).toContain("'scripts/workspace-mcp/**'");
    // Trivy's push-to-main filter decides whether the merged image gets scanned.
    expect(read('.github/workflows/trivy.yml')).toContain('^scripts/workspace-mcp/requirements\\.txt$');
  });

  it('no site hard-codes a version or a dependency cutoff', () => {
    expect(existsSync(join(ROOT, 'scripts/workspace-mcp.pin')), 'the old pin file is back').toBe(false);
    for (const path of ['Dockerfile', 'config/skills.yaml', 'scripts/gdrive-auth.py', LAUNCHER, 'docs/dev/google-drive.md']) {
      const text = read(path);
      expect(text, path).not.toMatch(/workspace-mcp\s*[=<>~!]=?\s*\d/);
      expect(text, path).not.toMatch(/--exclude-newer/);
      expect(text, path).not.toContain('WORKSPACE_MCP_EXCLUDE_NEWER');
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
  it('runs uvx constrained by the lockfile, passing arguments through', () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-uvx-'));
    try {
      writeFileSync(join(bin, 'uvx'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const out = execFileSync(join(ROOT, LAUNCHER), ['--tools', 'drive', 'docs'], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
      });
      expect(out.trim().split('\n')).toEqual([
        // Without it, a `uv tool install`ed workspace-mcp would run at its own version.
        '--isolated',
        '--constraints',
        join(ROOT, LOCKFILE),
        'workspace-mcp',
        '--tools',
        'drive',
        'docs',
      ]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
