// llm-archive-response.ts — one shape for the llm_call_archive response column.
//
// Five call sites publish llm.call (the agent runtime, the telemetry wrapper,
// the outbound judge, the escalation judge, and infra-llm). Each used to pick
// its own fields, so a new one — reasoning — would be archived in some places
// and dropped in others. Tool-call text was already dropped in two of them.

import type { LLMReasoning, LLMUsage, ToolCall } from '../agents/llm/provider.js';

/** JSON stored in llm_call_archive.response. */
export interface LlmArchiveResponseBody extends LLMReasoning {
  type: 'text' | 'tool_use';
  /** Visible text. Always set for a text response; set for tool_use only when the model wrote some. */
  content?: string;
  toolCalls?: ToolCall[];
  /** Present when the provider reported a reasoning-token count, including zero. */
  reasoningTokens?: number;
}

/**
 * Build the archive response from a successful chat or stream result.
 * `message_end` is stored as `text`. Text written beside tool calls is kept.
 */
export function buildLlmArchiveResponse(source: {
  type: 'text' | 'tool_use' | 'message_end';
  content?: string;
  toolCalls?: ToolCall[];
  usage?: Pick<LLMUsage, 'reasoningTokens'>;
} & LLMReasoning): LlmArchiveResponseBody {
  const body: LlmArchiveResponseBody = source.type === 'tool_use'
    ? {
        type: 'tool_use',
        toolCalls: source.toolCalls ?? [],
        ...(source.content ? { content: source.content } : {}),
      }
    : {
        type: 'text',
        content: source.content ?? '',
      };

  if (source.reasoning) body.reasoning = source.reasoning;
  if (source.reasoningOmitted) body.reasoningOmitted = source.reasoningOmitted;
  if (typeof source.usage?.reasoningTokens === 'number') {
    body.reasoningTokens = source.usage.reasoningTokens;
  }
  return body;
}
