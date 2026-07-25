// tool-loop-messages.ts — shared ContentBlock assembly for tool_use / tool_result turns.
//
// VoiceTurnRunner (streaming) and AgentRuntime.handleTask (non-streaming) both must
// emit Anthropic-compatible assistant+user message pairs when a model requests tools.
// Keeping the *shape* of those blocks in one place prevents the two loops from
// silently drifting while #1552 (shared streaming turn primitive) is outstanding.
//
// See also: src/channels/voice/turn-runner.ts, src/agents/runtime.ts (~tool_use loop).

import type {
  ContentBlock,
  Message,
  TextContent,
  ToolCall,
  ToolResultContent,
  ToolUseContent,
} from './provider.js';

/**
 * Build the assistant turn that carries tool_use blocks (plus optional text preamble).
 * The next user turn's tool_result blocks must reference these ids.
 */
export function buildAssistantToolUseMessage(
  toolCalls: ToolCall[],
  content?: string,
): Message {
  const blocks: ContentBlock[] = [];
  if (content !== undefined && content.length > 0) {
    blocks.push({ type: 'text', text: content } satisfies TextContent);
  }
  for (const tc of toolCalls) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    } satisfies ToolUseContent);
  }
  return { role: 'assistant', content: blocks };
}

/** Build one tool_result content block. */
export function buildToolResultBlock(
  toolUseId: string,
  content: string,
  isError?: boolean,
): ToolResultContent {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
}

/**
 * Build the user turn that carries tool_result blocks for a prior assistant
 * tool_use turn. Order should match the tool_use order when possible.
 */
export function buildUserToolResultMessage(
  results: Array<{ id: string; content: string; isError?: boolean }>,
): Message {
  const blocks: ContentBlock[] = results.map((r) =>
    buildToolResultBlock(r.id, r.content, r.isError),
  );
  return { role: 'user', content: blocks };
}
