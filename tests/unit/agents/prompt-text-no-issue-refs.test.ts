// prompt-text-no-issue-refs.test.ts — no issue numbers in text the model reads.
//
// An issue reference like "(#2428)" in a prompt is history, not instruction: the
// model reads it as content, and on voice it can be read aloud. History belongs in
// code comments and commit messages. Caught in the PR #2433 review on the voice
// prompt; this scan covers every agent, not one channel.
//
// What the model reads, and what this walks:
// - tool manifests: every description and input/output string (tool.json)
// - skill bundle instructions (SKILL.md body; frontmatter is metadata)
// - agent YAML: system prompts, schedule task payloads, every string field
// - prompt modules (src/agents/prompts/ and any src file named *prompt*,
//   *guidance* or *instruction*): every string literal in the source, so text
//   built inside a function (the agenda block) is covered, not just exports
// - the voice prompt constants exported from src/channels/voice/voice-runtime.ts
//   (a runtime module: its log messages are operator text, so exports only)
//
// Log messages may cite issues; they are read by operators, not the model.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(import.meta.dirname, '../../..');
const ISSUE_REF = /#\d{3,}\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function stringHits(value: unknown, where: string, hits: string[]): void {
  if (typeof value === 'string') {
    const match = value.match(/.{0,40}#\d{3,}\b/);
    if (match) hits.push(`${where}: …${match[0]}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringHits(item, `${where}[${index}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringHits(item, `${where}.${key}`, hits);
  }
}

async function exportedStrings(file: string, hits: string[]): Promise<void> {
  const mod = await import(file) as Record<string, unknown>;
  for (const [name, value] of Object.entries(mod)) stringHits(value, `${relative(ROOT, file)} ${name}`, hits);
}

/** Prompt-text modules. prompt-budget measures prompts and holds none. */
function promptModules(): string[] {
  const named = /(prompt|guidance|instruction)[^/]*\.ts$/;
  return walk(join(ROOT, 'src'))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => file.includes('/src/agents/prompts/') || named.test(file))
    .filter((file) => !file.endsWith('/prompt-budget.ts'));
}

/** String literals in source, skipping comment lines and log calls. */
function literalHits(file: string, hits: string[]): void {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    if (/\b(?:log|logger|skillLogger)\.(?:debug|info|warn|error)\(/.test(code)) return;
    if (/(['"`])[^'"`]*#\d{3,}\b[^'"`]*\1/.test(code)) hits.push(`${relative(ROOT, file)}:${index + 1}: ${code.slice(0, 80)}`);
  });
}

describe('model-facing text carries no issue references', () => {
  it('tool manifests and skill instructions', () => {
    const hits: string[] = [];
    for (const file of walk(join(ROOT, 'skills'))) {
      if (file.endsWith('tool.json')) stringHits(JSON.parse(readFileSync(file, 'utf8')), relative(ROOT, file), hits);
      if (file.endsWith('SKILL.md')) {
        const body = readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
        body.split('\n').forEach((line, index) => {
          if (ISSUE_REF.test(line)) hits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it('agent YAML', () => {
    const hits: string[] = [];
    for (const name of readdirSync(join(ROOT, 'agents')).filter((file) => file.endsWith('.yaml'))) {
      stringHits(yaml.load(readFileSync(join(ROOT, 'agents', name), 'utf8')), `agents/${name}`, hits);
    }
    expect(hits).toEqual([]);
  });

  it('prompt modules and the voice prompt', async () => {
    const hits: string[] = [];
    const modules = promptModules();
    // A rename that drops every module would pass this test vacuously.
    expect(modules.some((file) => file.endsWith('/src/meetings/agenda-prompt.ts'))).toBe(true);
    for (const file of modules) literalHits(file, hits);
    await exportedStrings(join(ROOT, 'src/channels/voice/voice-runtime.ts'), hits);
    expect(hits).toEqual([]);
  });
});
