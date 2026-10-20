// tool-loop-messages.ts — shared ContentBlock assembly for tool_use / tool_result turns.
//
// Used by the shared streaming turn primitive (streaming-turn.ts). Both voice
// (VoiceTurnRunner) and text (AgentRuntime.handleTask via chat-compatible
// openStream) assemble Anthropic-compatible assistant+user message pairs here
// when a model requests tools.
//
// See also: src/agents/llm/streaming-turn.ts, src/channels/voice/turn-runner.ts,
// src/agents/runtime.ts. Issues #1552 / #1563.

import type {
  ContentBlock,
  Message,
  ReasoningContent,
  TextContent,
  ToolCall,
  ToolResultContent,
  ToolUseContent,
} from './provider.js';

/**
 * Build the assistant turn that carries tool_use blocks (plus optional text preamble).
 * The next user turn's tool_result blocks must reference these ids.
 *
 * Reasoning blocks go first: Anthropic requires an assistant turn to begin with
 * its thinking, and the next request of the loop carries them back (ADR-048 §1).
 */
export function buildAssistantToolUseMessage(
  toolCalls: ToolCall[],
  content?: string,
  reasoningBlocks?: readonly ReasoningContent[],
): Message {
  const blocks: ContentBlock[] = [...(reasoningBlocks ?? [])];
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
