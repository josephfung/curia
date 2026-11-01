import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleBuildId } from './vite-build-id.js';

const publicDir = path.resolve(import.meta.dirname, 'public');

function withoutPrecache(bundle: Record<string, unknown>, workerSource: string): string {
  return createHash('sha256')
    .update(Object.keys(bundle).sort().join('\n'))
    .update('\0')
    .update(workerSource)
    .digest('hex')
    .slice(0, 16);
}

describe('bundleBuildId', () => {
  const bundle = { 'assets/app.js': {} };
  const worker = 'self.addEventListener("install", () => {});';

  it('is stable and includes the precache file bytes', () => {
    const id = bundleBuildId(bundle, worker, publicDir);
    expect(id).toBe(bundleBuildId(bundle, worker, publicDir));
    expect(id).not.toBe(withoutPrecache(bundle, worker));
    expect(bundleBuildId({ 'assets/other.js': {} }, worker, publicDir)).not.toBe(id);
  });
});
