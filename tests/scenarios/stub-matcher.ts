// tests/scenarios/stub-matcher.ts — subset matching for tool stubs.
//
// Ported from curia-deploy tests/eval/stub-matcher.ts. Differences: values are
// compared structurally (so a stub can match an array or object argument), and the
// caller gets the stub itself so it can tell a success return from a scripted error.
import { isDeepStrictEqual } from 'node:util';
import type { ToolStub } from './types.js';

/**
 * True when every key in `pattern` matches `args`. Extra keys in `args` are ignored, so
 * `{}` matches anything. A pattern value of `null` means "this argument is absent":
 * real tools reject a malformed call with a named error, and without a way to express
 * absence a case cannot reproduce that.
 */
export function argsMatch(pattern: Record<string, unknown>, args: Record<string, unknown>): boolean {
  return Object.entries(pattern).every(([key, expected]) => {
    const actual = args[key];
    if (expected === null) return actual === undefined || actual === null;
    return isDeepStrictEqual(actual, expected);
  });
}

/** The first stub for `toolName` whose match fits `args`, or undefined. */
export function matchToolStub(
  toolName: string,
  args: Record<string, unknown>,
  stubs: Record<string, ToolStub[]>,
): ToolStub | undefined {
  return stubs[toolName]?.find(stub => argsMatch(stub.match, args));
}
