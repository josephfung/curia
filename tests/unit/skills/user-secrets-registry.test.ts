// user-secrets-registry.test.ts — list-user-secrets + secret-capture-request
// must be in registry-defaults so reconcile enrolls them on existing installs (#1497).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

describe('user-secret tools registry enrollment (#1497)', () => {
  it('lists list-user-secrets and secret-capture-request in registry-defaults tools', () => {
    const defaultsPath = path.resolve(import.meta.dirname, '../../../config/registry-defaults.yaml');
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const loaded = yaml.load(raw) as { tools?: string[] };
    expect(loaded.tools).toContain('list-user-secrets');
    expect(loaded.tools).toContain('secret-capture-request');
  });
});
