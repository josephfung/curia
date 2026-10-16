// Tests for the pure parts of the Bedrock smoke gate. The live run needs AWS credentials
// and is exercised by `pnpm run smoke:bedrock-tools`, not here.

import { describe, it, expect } from 'vitest';
import {
  buildSmokeFixture,
  judgeResponse,
  parseArgs,
  DEFAULT_RUNS,
  MIN_SYSTEM_PROMPT_TOKENS,
  MIN_TOOL_COUNT,
  TARGET_TOOL,
} from './smoke-bedrock-tool-use.js';
import type { LLMResponse } from '../src/agents/llm/provider.js';
import { classifyError } from '../src/errors/classify.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'm', actualModel: 'm', providerRequestId: 'r' };
const offered = [TARGET_TOOL.name, 'dummy_tool_0'];

describe('buildSmokeFixture', () => {
  it('reproduces the production-shaped load the gate exists to exercise', () => {
    const fixture = buildSmokeFixture();
    expect(fixture.systemPromptTokens).toBeGreaterThanOrEqual(MIN_SYSTEM_PROMPT_TOKENS);
    expect(fixture.tools.length).toBeGreaterThanOrEqual(MIN_TOOL_COUNT);
    expect(fixture.tools.map((t) => t.name)).toContain(TARGET_TOOL.name);
  });

  it('gives every tool a unique name', () => {
    const names = buildSmokeFixture().tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('judgeResponse', () => {
  it('passes only a real tool_use call to the target tool', () => {
    const result: LLMResponse = {
      type: 'tool_use', toolCalls: [{ id: '1', name: TARGET_TOOL.name, input: {} }], usage, provenance,
    };
    expect(judgeResponse(result, offered)).toEqual({ pass: true });
  });

  it('fails a tool_use call to some other tool', () => {
    const result: LLMResponse = {
      type: 'tool_use', toolCalls: [{ id: '1', name: 'dummy_tool_0', input: {} }], usage, provenance,
    };
    expect(judgeResponse(result, offered)).toMatchObject({ pass: false, reason: 'wrong_tool' });
  });

  it('fails a narrated call, which Converse reports as a normal successful reply', () => {
    const result: LLMResponse = {
      type: 'text',
      content: `I'll check.\n\`\`\`json\n{"name": "${TARGET_TOOL.name}", "input": {}}\n\`\`\``,
      usage, provenance,
    };
    expect(judgeResponse(result, offered)).toMatchObject({ pass: false, reason: 'narrated_tool_call' });
  });

  it('fails plain text too — a reply with no tool call is not a pass', () => {
    const result: LLMResponse = { type: 'text', content: 'You have no scheduled jobs.', usage, provenance };
    expect(judgeResponse(result, offered)).toMatchObject({ pass: false, reason: 'text_instead_of_tool_call' });
  });

  it('fails a provider error and reports its message', () => {
    const result: LLMResponse = { type: 'error', error: classifyError(new Error('ValidationException: nope'), 'bedrock') };
    expect(judgeResponse(result, offered)).toMatchObject({ pass: false, reason: 'provider_error' });
  });
});

describe('parseArgs', () => {
  it('defaults to no model override and the default run count', () => {
    expect(parseArgs([])).toEqual({ model: undefined, runs: DEFAULT_RUNS });
  });

  it('reads --model and --runs, tolerating the "--" pnpm passes through', () => {
    expect(parseArgs(['--', '--model', 'global.anthropic.claude-sonnet-4-6', '--runs', '3']))
      .toEqual({ model: 'global.anthropic.claude-sonnet-4-6', runs: 3 });
  });

  it.each([['--runs', '0'], ['--runs', 'x'], ['--runs'], ['--model'], ['--bogus']])('rejects %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
