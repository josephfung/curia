// user-secrets-registry.test.ts — secrets skill must be in registry-defaults so
// reconcile enrolls list-user-secrets + secret-capture-request (#1497 / #2764).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

describe('user-secret tools registry enrollment (#1497 / #2764)', () => {
  it('enrolls vault tools through the secrets skill, not as standalone tools', () => {
    const defaultsPath = path.resolve(import.meta.dirname, '../../../config/registry-defaults.yaml');
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const loaded = yaml.load(raw) as { tools?: string[]; skills?: string[] };
    expect(loaded.skills).toContain('secrets');
    expect(loaded.skills).toContain('files');
    expect(loaded.tools ?? []).not.toContain('list-user-secrets');
    expect(loaded.tools ?? []).not.toContain('secret-capture-request');
    expect(loaded.tools ?? []).not.toContain('file-parse');
    expect(loaded.tools ?? []).not.toContain('archive-extract');
  });
});
