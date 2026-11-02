import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, 'check-dist-imports.mjs');
const dirs: string[] = [];

/** Run the checker with plain node, as CI does, on a one-file bundle. */
function check(bundle: string): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-imports-'));
  dirs.push(dir);
  const file = path.join(dir, 'index.js');
  writeFileSync(file, bundle);
  const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-dist-imports', () => {
  it('fails on a named import that a CommonJS package only has on its default (#2410)', () => {
    const { status, output } = check('import { generateVAPIDKeys, WebPushError } from "web-push";\n');
    expect(status).toBe(1);
    expect(output).toContain('web-push: no named export "generateVAPIDKeys"');
    expect(output).toContain('import its default');
    // WebPushError is a real named export, so it is not reported.
    expect(output).not.toContain('"WebPushError"');
  });

  it('passes the default import, named ESM imports, and skips relative and node: imports', () => {
    const { status, output } = check([
      'import webpush from "web-push";',
      'import { getDomain } from "tldts";',
      'import { readFileSync } from "node:fs";',
      'import { helper } from "./chunk.js";',
      '',
    ].join('\n'));
    expect(output).toContain('resolve under Node ESM');
    expect(status).toBe(0);
  });

  it('checks a re-export from a package, and a default import beside a namespace', () => {
    const bad = check([
      'export { generateVAPIDKeys } from "web-push";',
      'import missing, * as missingAll from "curia-no-such-package";',
      '',
    ].join('\n'));
    expect(bad.status).toBe(1);
    expect(bad.output).toContain('web-push: no named export "generateVAPIDKeys"');
    // The default-plus-namespace form is parsed, so its package is loaded and checked.
    expect(bad.output).toContain('curia-no-such-package: could not be loaded');

    const good = check([
      'export { WebPushError } from "web-push";',
      'export * from "tldts";',
      'import webpush, * as webpushAll from "web-push";',
      '',
    ].join('\n'));
    expect(good.status).toBe(0);
  });

  it('fails when a package cannot be loaded at all', () => {
    const { status, output } = check('import { thing } from "curia-no-such-package";\n');
    expect(status).toBe(1);
    expect(output).toContain('curia-no-such-package: could not be loaded');
  });
});
