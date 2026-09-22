// manifest-placeholder-free.test.ts — static analysis guards against model-facing
// text in tool manifests that has already bitten us in production.
//
// ## Runtime template placeholders (#1800)
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
//
// ## Retired email config surfaces (#1856)
//
// `docs/specs/04-channels.md` retires both `channel_accounts.email` and `CEO_PRIMARY_EMAIL`
// (#1101 — email_accounts table + console UI). Naming either in a tool.json points the
// model at a surface that no longer exists. Point at the console path instead:
// "as configured under Settings → Channels → Email → Email accounts".
//
// Limits of this scan (deliberate, not oversights):
// - **tool.json only.** SKILL.md instructions also reach the model, but walking them is a
//   separate change — out of scope for #1856's blast-radius carve-out.
// - **Bare substring.** Catches `channel_accounts.email`, `channel_accounts:`, and prose.
//   A future legitimate mention of the retirement would also trip it; that is the
//   intended tripwire, not a false-positive bug.

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

// Shared across both guards so neither silently depends on a sibling for its own validity,
// and so we parse each of the ~124 manifests once rather than twice (#1856 review).
const MANIFESTS = collectManifestPaths().map(p => ({
  relative: path.relative(SKILLS_DIR, p),
  manifest: JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown,
}));

const RETIRED_SURFACES = ['channel_accounts', 'CEO_PRIMARY_EMAIL'] as const;

describe('tool manifest walk covers both layouts', () => {
  it('finds manifests to scan in both layouts', () => {
    // Guards the guards: a broken walk returning [] would make every scan below vacuous.
    // Both layout branches must be present — nested alone can satisfy length + tools/, so
    // also require at least one flat path (no /tools/ segment).
    expect(MANIFESTS.length).toBeGreaterThan(50);
    expect(MANIFESTS.some(m => m.relative.includes(`${path.sep}tools${path.sep}`))).toBe(true);
    expect(MANIFESTS.some(m => !m.relative.includes(`${path.sep}tools${path.sep}`))).toBe(true);
  });
});

describe('tool manifests are free of runtime template placeholders', () => {
  it('no tool.json string contains a ${...} token', () => {
    const violations: string[] = [];

    for (const { relative, manifest } of MANIFESTS) {
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

describe('tool manifests do not mention retired email config surfaces', () => {
  it('no tool.json string contains a retired email config surface', () => {
    const violations: string[] = [];

    for (const { relative, manifest } of MANIFESTS) {
      for (const { field, text } of stringFields(manifest)) {
        for (const surface of RETIRED_SURFACES) {
          if (text.includes(surface)) {
            violations.push(`${relative} → ${field}: ${surface}`);
          }
        }
      }
    }

    expect(
      violations,
      `\nRetired email config surfaces found in tool manifests:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nchannel_accounts.email and CEO_PRIMARY_EMAIL were retired in #1101. ` +
        `Name the console path instead:\n` +
        `"as configured under Settings → Channels → Email → Email accounts" (#1856).\n`,
    ).toHaveLength(0);
  });
});

// Example mailbox names in an `account` description invite the model to guess a
// mailbox that may not exist (#1867). Every email tool that takes `account` must
// point at the same console path the #1856 manifests already use.
const EMAIL_ACCOUNT_PROVENANCE =
  'as configured under Settings → Channels → Email → Email accounts';
const EXAMPLE_MAILBOX = /e\.g\.\s*'[^']+'|'curia'|'joseph'/;

describe('email account inputs cite console provenance', () => {
  it('every email tool account input names the console path and no example mailbox', () => {
    const withAccount = MANIFESTS.filter(m => {
      if (!m.relative.startsWith(`email${path.sep}tools${path.sep}`)) return false;
      if (typeof m.manifest !== 'object' || m.manifest === null) return false;
      const inputs = (m.manifest as { inputs?: unknown }).inputs;
      if (typeof inputs !== 'object' || inputs === null) return false;
      return typeof (inputs as { account?: unknown }).account === 'string';
    });

    // All twelve email tools that take `account`. A new one must cite the same path.
    expect(withAccount.map(m => m.relative).sort()).toEqual([
      'email/tools/email-archive/tool.json',
      'email/tools/email-create-folder/tool.json',
      'email/tools/email-download-attachment/tool.json',
      'email/tools/email-draft-save/tool.json',
      'email/tools/email-get/tool.json',
      'email/tools/email-label/tool.json',
      'email/tools/email-list-folders/tool.json',
      'email/tools/email-list/tool.json',
      'email/tools/email-mark-read/tool.json',
      'email/tools/email-reply/tool.json',
      'email/tools/email-send/tool.json',
      'email/tools/send-draft/tool.json',
    ]);

    const violations: string[] = [];
    for (const { relative, manifest } of withAccount) {
      const inputs = (manifest as { inputs: { account: string } }).inputs;
      const account = inputs.account;
      if (!account.includes(EMAIL_ACCOUNT_PROVENANCE)) {
        violations.push(`${relative} → inputs.account: missing console provenance`);
      }
      if (EXAMPLE_MAILBOX.test(account)) {
        violations.push(`${relative} → inputs.account: hardcoded example mailbox`);
      }
    }

    expect(
      violations,
      `\nEmail account inputs must cite console provenance and name no example mailbox:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nUse "${EMAIL_ACCOUNT_PROVENANCE}" (#1867).\n`,
    ).toHaveLength(0);
  });
});
