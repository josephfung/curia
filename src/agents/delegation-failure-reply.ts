// Principal-facing reply when a delegation cannot continue (#1860).
//
// The model writes it, with the failed request in context, so two asks do not
// produce the same sentence. A deterministic fallback remains for the
// model-unavailable path and for any draft that still leaks a registry id or
// never names what was asked.

import type { ContentBlock, Message } from './llm/provider.js';
import { SPECIALIST_DECLINE_REASON } from './specialist-decline.js';
import { containsRawAgentId, redactRawAgentId } from './agent-display-name.js';

export interface DelegationFailureReplyInput {
  displayName: string;
  agentId: string;
  reason: string;
  declined?: boolean;
  possiblySucceeded?: boolean;
  escalated: boolean;
  /** Brief that failed. Quoted so the reply names the ask. */
  delegateTask: string;
  /** Specialist prose, already length-capped. Declines only. */
  detail?: string;
  /** Model draft. Absent when the narration call did not return text. */
  modelText?: string;
}

/** Short, single-line form of the failed request for quoting. */
export function requestAnchor(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'that request';
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117).trimEnd()}...`;
}

export function referencesRequest(text: string, anchor: string): boolean {
  const needle = anchor.length <= 40 ? anchor : anchor.slice(0, 40);
  return text.toLowerCase().includes(needle.toLowerCase());
}

export function delegationFailureNarrationPrompt(input: {
  displayName: string;
  anchor: string;
  reason: string;
  possiblySucceeded?: boolean;
  escalated: boolean;
  declined?: boolean;
}): string {
  const situation = describeFailure(input.reason, input.declined, input.possiblySucceeded);
  const followUp = input.escalated
    ? 'A follow-up task has already been logged.'
    : 'A follow-up task could not be logged.';
  return [
    'A delegated task failed. Write the one reply the principal will read.',
    `Refer to the specialist only as "${input.displayName}".`,
    'Do not use internal agent ids, tool names, or protocol markers.',
    `Name the request that failed by including this phrase: "${input.anchor}".`,
    'Write it as a fresh sentence about this request. Do not reuse a stock line.',
    situation,
    followUp,
    'Do not call tools. Reply in plain text only.',
  ].join('\n');
}

function describeFailure(reason: string, declined: boolean | undefined, possiblySucceeded: boolean | undefined): string {
  if (reason === 'timeout') {
    return possiblySucceeded
      ? 'The specialist did not answer in time. The work may still be finishing in the background.'
      : 'The specialist did not answer in time.';
  }
  if (reason === 'blocked') return 'The specialist was blocked and could not finish.';
  if (declined === true || reason === SPECIALIST_DECLINE_REASON) return 'The specialist declined the task.';
  return 'The specialist was not able to finish the task.';
}

export function formatDelegationFailureFallback(
  input: Omit<DelegationFailureReplyInput, 'modelText'>,
): string {
  const who = input.displayName;
  const ask = requestAnchor(input.delegateTask);
  const parts: string[] = [];
  if (input.reason === 'timeout') {
    parts.push(`I wasn't able to get a response from the ${who} in time on "${ask}".`);
    if (input.possiblySucceeded) parts.push('The request may still be completing in the background.');
  } else if (input.reason === 'blocked') {
    parts.push(`The ${who} was blocked and couldn't finish "${ask}".`);
  } else if (input.declined === true || input.reason === SPECIALIST_DECLINE_REASON) {
    const detail = redactDetail(input.detail, input.agentId, who);
    parts.push(detail.length > 0
      ? `The ${who} declined "${ask}". ${detail}`
      : `The ${who} declined "${ask}".`);
  } else {
    parts.push(`The ${who} wasn't able to finish "${ask}".`);
  }
  if (input.escalated) parts.push("I've logged a follow-up task to review the outcome.");
  return parts.join(' ');
}

function redactDetail(detail: string | undefined, agentId: string, displayName: string): string {
  if (!detail) return '';
  return redactRawAgentId(detail, agentId, displayName).replace(/\s+/g, ' ').trim();
}

/**
 * Prefer the model's draft when it names the request and does not leak the
 * registry id. Otherwise the deterministic fallback, which always does both.
 */
export function selectDelegationFailureReply(
  input: DelegationFailureReplyInput,
): { content: string; via: 'model' | 'fallback' } {
  const anchor = requestAnchor(input.delegateTask);
  const fallback = formatDelegationFailureFallback(input);
  const model = input.modelText?.trim() ?? '';
  if (
    model.length > 0
    && !containsRawAgentId(model, input.agentId)
    && referencesRequest(model, anchor)
    && !model.includes('_curia_protocol')
  ) {
    return { content: model, via: 'model' };
  }
  return { content: fallback, via: 'fallback' };
}

/**
 * Text-only transcript for the narration call.
 *
 * The live transcript ends in an assistant `tool_use` followed by a user
 * `tool_result`. Providers omit `tools` when none are passed, and the
 * Messages API rejects tool blocks without a tools list. Those blocks are
 * dropped here. The narration prompt already states the failure, and a
 * text-only call cannot wander off into another tool round.
 */
export function transcriptForNarration(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const text = narrationMessageText(message.content);
    if (text.length === 0) continue;
    out.push({ role: message.role, content: text });
  }
  return out;
}

function narrationMessageText(content: Message['content']): string {
  if (typeof content === 'string') return content.trim().length === 0 ? '' : content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.trim().length > 0) parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Registry ids live in delegate tool results. Replace them in those blocks
 * before the narration call so the model is not handed the handle to copy.
 * User and system text is left alone — that is the principal's own wording.
 */
export function redactAgentIdInTranscript(
  messages: Message[],
  agentId: string,
  displayName: string,
): Message[] {
  if (agentId.trim().length === 0) return messages;
  return messages.map((message) => ({
    ...message,
    content: redactMessageContent(message.content, agentId, displayName),
  }));
}

function redactMessageContent(
  content: Message['content'],
  agentId: string,
  displayName: string,
): Message['content'] {
  if (typeof content === 'string') return content;
  return content.map((block) => redactBlock(block, agentId, displayName));
}

function redactBlock(block: ContentBlock, agentId: string, displayName: string): ContentBlock {
  if (block.type !== 'tool_result') return block;
  return { ...block, content: redactRawAgentId(block.content, agentId, displayName) };
}
