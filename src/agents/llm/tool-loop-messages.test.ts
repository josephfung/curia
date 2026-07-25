// tool-loop-messages.test.ts — contract: both tool-loop paths must emit the same
// ContentBlock shapes for the same mocked model tool_use output (#1552).

import { describe, it, expect } from 'vitest';
import type { ToolCall } from './provider.js';
import {
  buildAssistantToolUseMessage,
  buildToolResultBlock,
  buildUserToolResultMessage,
} from './tool-loop-messages.js';

const TOOL_CALLS: ToolCall[] = [
  { id: 'call_1', name: 'lookup', input: { q: 'weather' } },
  { id: 'call_2', name: 'search', input: { q: 'news' } },
];

describe('tool-loop message shape contract (#1552)', () => {
  it('assistant tool_use message matches Anthropic-required shape', () => {
    const msg = buildAssistantToolUseMessage(TOOL_CALLS, 'Let me check.');
    expect(msg.role).toBe('assistant');
    expect(Array.isArray(msg.content)).toBe(true);
    // Runtime check above — ContentBlock[] is not assignable to Record[] directly.
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { q: 'weather' },
    });
    expect(blocks[2]).toEqual({
      type: 'tool_use',
      id: 'call_2',
      name: 'search',
      input: { q: 'news' },
    });
  });

  it('omits empty text preamble (no empty text block)', () => {
    const msg = buildAssistantToolUseMessage(TOOL_CALLS);
    const blocks = msg.content as unknown as Array<{ type: string }>;
    expect(blocks.every((b) => b.type === 'tool_use')).toBe(true);
    expect(blocks).toHaveLength(2);
  });

  it('user tool_result message references prior tool_use ids', () => {
    const msg = buildUserToolResultMessage([
      { id: 'call_1', content: '{"ok":true}' },
      { id: 'call_2', content: 'failed', isError: true },
    ]);
    expect(msg.role).toBe('user');
    expect(msg.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'failed', is_error: true },
    ]);
  });

  it('buildToolResultBlock omits is_error when false/undefined', () => {
    expect(buildToolResultBlock('x', 'ok')).toEqual({
      type: 'tool_result',
      tool_use_id: 'x',
      content: 'ok',
    });
    expect(buildToolResultBlock('x', 'bad', true).is_error).toBe(true);
  });

  it('round-trip: assistant tool_use ids match subsequent tool_result ids', () => {
    const assistant = buildAssistantToolUseMessage(TOOL_CALLS, 'Checking…');
    const results = TOOL_CALLS.map((tc) => ({ id: tc.id, content: `result:${tc.name}` }));
    const user = buildUserToolResultMessage(results);

    const useIds = (assistant.content as unknown as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    const resultIds = (user.content as unknown as Array<{ type: string; tool_use_id?: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);

    expect(resultIds).toEqual(useIds);
  });
});
