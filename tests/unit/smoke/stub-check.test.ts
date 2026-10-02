// A stub that could never fire is caught before a paid run (#1956).
import { describe, expect, it } from 'vitest';
import { stubProblems, type RegistryView } from '../../smoke/stub-check.js';

const registry: RegistryView = {
  inputsOf: (tool) => ({ 'task-create': ['title', 'owner'], 'scheduler-list': ['status'] } as Record<string, string[]>)[tool],
};

describe('stubProblems', () => {
  it('passes stubs that name real tools and inputs', () => {
    expect(stubProblems([{ source: 'office', stubs: {
      'task-create': [{ match: {}, return: { title: '{{input:title}}' } }],
      'scheduler-list': [{ match: { status: 'active' }, return: [] }],
    } }], registry)).toEqual([]);
  });

  it('flags a misspelt tool, match key and input placeholder', () => {
    expect(stubProblems([{ source: 'case.yaml', stubs: {
      'task-crate': [{ match: {}, return: {} }],
      'task-create': [{ match: { titel: 'x' }, return: { title: '{{input:titel}}' } }],
    } }], registry)).toEqual([
      'case.yaml: tool_stubs.task-crate — no tool by that name is registered',
      "case.yaml: tool_stubs.task-create[0].match.titel — task-create has no input 'titel'",
      "case.yaml: tool_stubs.task-create[0] uses {{input:titel}} — task-create has no input 'titel'",
    ]);
  });
});
