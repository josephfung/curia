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
      // Normalize to lowercase for matching — the runtime resolves secrets via
      // name.toUpperCase() against process.env, so 'ANTHROPIC_API_KEY' and
      // 'anthropic_api_key' are the same secret at runtime. The test must match
      // that semantics so it does not produce false positives or false negatives.
      const declaredSecrets = new Set<string>((manifest.secrets ?? []).map(s => s.toLowerCase()));

      const handlerSource = fs.readFileSync(handlerPath, 'utf-8');

      // Check literal string arguments: ctx.secret('name') and ctx.secret("name").
      // Case-insensitive comparison matches the runtime's toUpperCase() normalization.
      const literalPattern = /ctx\.secret\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of handlerSource.matchAll(literalPattern)) {
        const secretName = match[1].toLowerCase();
        if (!declaredSecrets.has(secretName)) {
          violations.push(
            `${entry.name}/handler: ctx.secret('${match[1]}') is not declared in skill.json secrets array`,
          );
        }
      }

      // Detect dynamic ctx.secret() calls (template literals, variable arguments) that
      // cannot be statically verified. Emit a visible warning to stderr so CI output
      // never silently implies full coverage when dynamic patterns are present.
      const dynamicPattern = /ctx\.secret\(\s*(?!['"])[^)]+\)/g;
      const dynamicMatches = [...handlerSource.matchAll(dynamicPattern)];
      if (dynamicMatches.length > 0) {
        process.stderr.write(
          `[secret-manifest-coverage] WARNING: ${entry.name}/handler has ${dynamicMatches.length} ` +
          `dynamic ctx.secret() call(s) that cannot be statically verified — manual review required:\n` +
          dynamicMatches.map(m => `  ${m[0].trim()}`).join('\n') + '\n',
        );
      }
    }

    // Surface all violations together so a developer can fix them in one pass
    expect(violations, `\nSecret manifest violations found:\n${violations.map(v => `  - ${v}`).join('\n')}\n`).toHaveLength(0);
  });
});
