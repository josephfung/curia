import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The built app runs under Node's own ESM loader, where web-push (CommonJS)
// exposes only WebPushError as a named export. Vitest's interop is more lenient,
// so a named import of generateVAPIDKeys passed the unit tests and crashed the
// deployed app at startup. This runs the real loader in a child process.
describe('web-push under Node ESM', () => {
  it('provides every function vapid.ts reads from the default export', () => {
    const script = [
      "import webpush from 'web-push';",
      "const names = ['generateVAPIDKeys', 'sendNotification', 'setVapidDetails', 'WebPushError'];",
      "const missing = names.filter((name) => typeof webpush[name] !== 'function');",
      'process.stdout.write(JSON.stringify(missing));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      // Eval code resolves packages from cwd, so run it from the repo root.
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual([]);
  });
});
