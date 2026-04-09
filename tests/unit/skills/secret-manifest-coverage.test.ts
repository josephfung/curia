// secret-manifest-coverage.test.ts — static analysis guard for secrets isolation.
//
// Every ctx.secret('name') call in a skill handler must have 'name' declared in
// that skill's manifest secrets array. This test catches:
//
//   1. A developer adds ctx.secret('new_key') but forgets to update skill.json.
//   2. A malicious handler calls ctx.secret('OTHER_SKILL_API_KEY') — cross-skill
//      secret access. The runtime allowlist blocks this at execution time, but this
//      test surfaces it at CI time before it can reach production.
//
// The test reads manifests from disk and scans handler source for literal string
// arguments to ctx.secret(). Dynamic arguments (e.g. ctx.secret(keyVar)) cannot
// be caught here — those would be a code review concern.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve skills/ directory relative to this test file (tests/unit/skills/ → ../../../skills/)
const SKILLS_DIR = path.join(import.meta.dirname, '../../../skills');

describe('secret manifest coverage', () => {
  it('every ctx.secret() call references a secret declared in that skill\'s manifest', () => {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const violations: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(SKILLS_DIR, entry.name);
      const manifestPath = path.join(skillDir, 'skill.json');

      // Prefer handler.ts (development source) over handler.js (compiled output)
      const handlerPath = fs.existsSync(path.join(skillDir, 'handler.ts'))
        ? path.join(skillDir, 'handler.ts')
        : path.join(skillDir, 'handler.js');

      if (!fs.existsSync(manifestPath) || !fs.existsSync(handlerPath)) continue;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { secrets?: string[] };
      const declaredSecrets = new Set<string>(manifest.secrets ?? []);

      const handlerSource = fs.readFileSync(handlerPath, 'utf-8');

      // Match both single-quoted and double-quoted literal string arguments:
      //   ctx.secret('tavily_api_key')
      //   ctx.secret("ANTHROPIC_API_KEY")
      // Template literals and variable arguments are not checked here — use code review.
      const pattern = /ctx\.secret\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of handlerSource.matchAll(pattern)) {
        const secretName = match[1];
        if (!declaredSecrets.has(secretName)) {
          violations.push(
            `${entry.name}/handler: ctx.secret('${secretName}') is not declared in skill.json secrets array`,
          );
        }
      }
    }

    // Surface all violations together so a developer can fix them in one pass
    expect(violations, `\nSecret manifest violations found:\n${violations.map(v => `  - ${v}`).join('\n')}\n`).toHaveLength(0);
  });
});
