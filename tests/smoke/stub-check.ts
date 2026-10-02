// tests/smoke/stub-check.ts — catch a stub that can never fire before a paid run (#1956).
//
// A stub for a misspelt tool name never matches, so the real tool runs (or fails) and the
// case quietly tests something else. An `{{input:titel}}` fills in as an empty string.
// Both are checked against the booted stack's tool registry.
import type { ToolStub } from '../scenarios/types.js';

const INPUT_PLACEHOLDER = /\{\{\s*input:([A-Za-z0-9_]+)\s*\}\}/g;

export interface RegistryView {
  /** The tool's declared inputs, or undefined if no such tool is registered. */
  inputsOf(toolName: string): readonly string[] | undefined;
}

/** One problem per line, naming where it is. Empty when every stub can fire as written. */
export function stubProblems(sources: Array<{ source: string; stubs: Record<string, ToolStub[]> }>, registry: RegistryView): string[] {
  const problems: string[] = [];
  for (const { source, stubs } of sources) {
    for (const [tool, entries] of Object.entries(stubs)) {
      const inputs = registry.inputsOf(tool);
      if (inputs === undefined) {
        problems.push(`${source}: tool_stubs.${tool} — no tool by that name is registered`);
        continue;
      }
      entries.forEach((stub, i) => {
        for (const key of Object.keys(stub.match)) {
          if (!inputs.includes(key)) problems.push(`${source}: tool_stubs.${tool}[${i}].match.${key} — ${tool} has no input '${key}'`);
        }
        for (const m of JSON.stringify(stub.return ?? null).matchAll(INPUT_PLACEHOLDER)) {
          if (!inputs.includes(m[1]!)) problems.push(`${source}: tool_stubs.${tool}[${i}] uses {{input:${m[1]}}} — ${tool} has no input '${m[1]}'`);
        }
      });
    }
  }
  return problems;
}
