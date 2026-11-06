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
// - every string literal in src/channels/voice/voice-runtime.ts, which builds
//   the voice prompt inside functions (log-call arguments are skipped)
//
// Log messages may cite issues; they are read by operators, not the model.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import ts from 'typescript';

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

/** Prompt-text modules. prompt-budget measures prompts and holds none. */
function promptModules(): string[] {
  const named = /(prompt|guidance|instruction)[^/]*\.ts$/;
  return walk(join(ROOT, 'src'))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => file.includes('/src/agents/prompts/') || named.test(file))
    .filter((file) => !file.endsWith('/prompt-budget.ts'));
}

const LOG_CALL = /\b(?:log|logger|skillLogger)\.(?:debug|info|warn|error)$/;

/** True when `node` is an argument to a log call: operator text, not model text. */
function inLogCall(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && LOG_CALL.test(current.expression.getText(source))) return true;
  }
  return false;
}

/**
 * Every string and template literal in the source, parsed rather than matched
 * line by line, so a multi-line template and an apostrophe inside double quotes
 * are read correctly (PR #2433 review). Log-call arguments are skipped.
 */
function literalHits(file: string, hits: string[]): void {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const isLiteral = ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isLiteral && !inLogCall(node, source)) {
      const text = (node as ts.LiteralLikeNode).text;
      const match = text.match(/.{0,40}#\d{3,}\b/);
      if (match) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push(`${relative(ROOT, file)}:${line + 1}: …${match[0]}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

  it('finds a reference inside a multi-line template literal', () => {
    // A private mkdtemp directory, not a predictable name in the shared temp dir.
    const dir = mkdtempSync(join(tmpdir(), 'prompt-text-probe-'));
    const file = join(dir, 'probe.ts');
    const hits: string[] = [];
    try {
      writeFileSync(file, "export const P = `Start\nDiscuss #2428 here\n`;\nconst q = \"don't (#1234)\";\nlog.info('skip (#5555)');\n");
      literalHits(file, hits);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(hits).toHaveLength(2);
    expect(hits.join()).toContain('#2428');
    expect(hits.join()).toContain('#1234');
  });

  it('prompt modules and the voice prompt', async () => {
    const hits: string[] = [];
    const modules = promptModules();
    // A rename that drops every module would pass this test vacuously.
    expect(modules.some((file) => file.endsWith('/src/meetings/agenda-prompt.ts'))).toBe(true);
    for (const file of modules) literalHits(file, hits);
    // The voice runtime builds its prompt inside functions; log calls are skipped.
    literalHits(join(ROOT, 'src/channels/voice/voice-runtime.ts'), hits);
    expect(hits).toEqual([]);
  });
});
