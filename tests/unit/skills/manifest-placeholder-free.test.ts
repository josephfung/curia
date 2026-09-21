// manifest-placeholder-free.test.ts — static analysis guard against runtime template
// tokens leaking into tool manifests (#1800).
//
// `${principal_contact_id}` and friends are resolved by interpolateRuntimeContext()
// (src/agents/loader.ts), which runs on agent system prompts and nothing else. A tool.json
// is never interpolated: ToolRegistry.toToolDefinitions() passes `description` through
// verbatim and turns the `inputs` shorthand into JSON-Schema property descriptions. So a
// token written into a manifest reaches the model as literal text that looks like advice,
// and the model copies it into tool arguments — where it is rejected as a non-UUID.
//
// In prod this cost the social-media agent 28 of 44 calendar-list-events calls over eight
// weeks. That agent's system prompt has no placeholder at all, so the tool hint was the
// only "value" it could see.
//
// Describe the value instead of templating it: "the principal's contact ID as given in
// your system prompt".

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findTemplateTokens } from '../../../src/skills/_shared/placeholder-guard.js';

// tests/unit/skills/ → ../../../skills/
const SKILLS_DIR = path.join(import.meta.dirname, '../../../skills');

/**
 * Collect every tool.json under skills/, covering both production layouts:
 *   flat:   skills/<tool>/tool.json
 *   bundle: skills/<bundle>/tools/<tool>/tool.json
 *
 * Mirrors the walk in src/startup/validator.ts. Walking only the flat layout would have
 * missed all three of the original #1800 leaks — they were bundle tools.
 */
function collectManifestPaths(): string[] {
  const manifests: string[] = [];

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const flat = path.join(SKILLS_DIR, entry.name, 'tool.json');
    if (fs.existsSync(flat)) manifests.push(flat);

    const toolsDir = path.join(SKILLS_DIR, entry.name, 'tools');
    if (!fs.existsSync(toolsDir)) continue;
    for (const tool of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!tool.isDirectory()) continue;
      const nested = path.join(toolsDir, tool.name, 'tool.json');
      if (fs.existsSync(nested)) manifests.push(nested);
    }
  }

  return manifests;
}

/** Recursively yield every string value in a parsed manifest, with a dotted path. */
function* stringFields(value: unknown, trail = ''): Generator<{ field: string; text: string }> {
  if (typeof value === 'string') {
    yield { field: trail || '(root)', text: value };
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* stringFields(item, `${trail}[${i}]`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield* stringFields(item, trail ? `${trail}.${key}` : key);
    }
  }
}

describe('tool manifests are free of runtime template placeholders', () => {
  it('finds manifests to scan in both layouts', () => {
    const manifests = collectManifestPaths();
    // Guards the guard: a broken walk returning [] would make the assertion below vacuous.
    expect(manifests.length).toBeGreaterThan(50);
    expect(manifests.some(m => m.includes(`${path.sep}tools${path.sep}`))).toBe(true);
  });

  it('no tool.json string contains a ${...} token', () => {
    const violations: string[] = [];

    for (const manifestPath of collectManifestPaths()) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
      const relative = path.relative(SKILLS_DIR, manifestPath);

      for (const { field, text } of stringFields(manifest)) {
        // Shares findTemplateTokens() with the skill input guard and the scheduler, so a
        // token this scan permits can never be one the guard rejects at runtime. Matching
        // only `[a-z_]+` here let `${principal_contact_id_2}` through the scan while
        // isUnresolvedPlaceholder() still rejected it as an argument.
        for (const token of findTemplateTokens(text)) {
          violations.push(`${relative} → ${field}: ${token}`);
        }
      }
    }

    expect(
      violations,
      `\nRuntime template placeholders found in tool manifests:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nManifests are never interpolated — the model reads the token literally and ` +
        `copies it into tool arguments (#1800).\nDescribe the value instead, e.g. ` +
        `"the principal's contact ID as given in your system prompt".\n`,
    ).toHaveLength(0);
  });
});

// channel_accounts.email was retired in #1101 (email_accounts table + console UI).
// Naming the old YAML path in a tool.json points the model at a surface that no longer
// exists — agents then tell users to edit local.yaml. Point at the console path instead:
// "as configured under Settings → Channels → Email → Email accounts" (#1856).
describe('tool manifests do not mention the retired channel_accounts path', () => {
  it('no tool.json string contains channel_accounts', () => {
    const violations: string[] = [];

    for (const manifestPath of collectManifestPaths()) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
      const relative = path.relative(SKILLS_DIR, manifestPath);

      for (const { field, text } of stringFields(manifest)) {
        if (text.includes('channel_accounts')) {
          violations.push(`${relative} → ${field}`);
        }
      }
    }

    expect(
      violations,
      `\nRetired channel_accounts path found in tool manifests:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nchannel_accounts.email was retired in #1101. Name the console path instead:\n` +
        `"as configured under Settings → Channels → Email → Email accounts" (#1856).\n`,
    ).toHaveLength(0);
  });
});
