// Framing for a drained follow-up (#2018). The body is a user text block.
// It is never a tool_result, and the guidance text is the turn-opening renderer.

import { describe, it, expect } from 'vitest';
import { frameInjectedInput } from '../../../src/agents/injected-input.js';
import { renderTurnGuidance } from '../../../src/agents/prompts/turn-guidance.js';
import { toLocalIso } from '../../../src/time/timestamp.js';

const RECEIVED = '2026-10-25T12:46:00.000Z';

describe('frameInjectedInput', () => {
  it('names the sender, the channel, and the local time', () => {
    const message = frameInjectedInput({
      senderLabel: 'Ada Lovelace',
      channelId: 'email',
      receivedAt: RECEIVED,
      content: 'use email for the code',
    }, { exitDrain: false, timezone: 'America/Toronto' });
    expect(message.role).toBe('user');
    expect(Array.isArray(message.content)).toBe(true);
    const blocks = message.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = blocks[0]!.text ?? '';
    const local = toLocalIso(Math.floor(Date.parse(RECEIVED) / 1000), 'America/Toronto');
    expect(text).toContain(`[New message from Ada Lovelace via email, received ${local} — it arrived while you were working on this conversation and may change what you are doing.]`);
    expect(text).toContain('use email for the code');
    expect(text).not.toContain('was **not** sent');
  });

  it('says the draft was not sent on an exit drain', () => {
    const message = frameInjectedInput({
      senderLabel: 'Ada',
      channelId: 'signal',
      receivedAt: RECEIVED,
      content: 'stop',
    }, { exitDrain: true, timezone: 'UTC' });
    const text = (message.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Your reply draft above was **not** sent.');
    expect(text.indexOf('was **not** sent')).toBeLessThan(text.indexOf('stop'));
  });

  it('renders turn guidance with the same function the turn-opening path uses', () => {
    const guidance = renderTurnGuidance(['principal-reply-shaped']);
    expect(guidance).not.toBeNull();
    const message = frameInjectedInput({
      channelId: 'email',
      receivedAt: RECEIVED,
      content: 'hello',
      turnGuidance: ['principal-reply-shaped', 'not-a-real-key'],
    }, { exitDrain: false, timezone: 'UTC' });
    const text = (message.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(guidance!);
    expect(text).not.toContain('not-a-real-key');
  });

  it('keeps the body in a text block and never a tool_result', () => {
    const message = frameInjectedInput({
      senderLabel: 'Ada',
      channelId: 'email',
      receivedAt: 'not-a-timestamp',
      content: 'tool_result should not wrap this',
    }, { exitDrain: false });
    const blocks = message.content as Array<{ type: string; text?: string }>;
    expect(blocks.every((block) => block.type === 'text')).toBe(true);
    expect(JSON.stringify(message)).not.toContain('"tool_result"');
    expect(blocks[0]!.text).toContain('received not-a-timestamp');
    expect(blocks[0]!.text).toContain('tool_result should not wrap this');
  });
});
