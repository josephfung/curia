import { describe, it, expect } from 'vitest';
import { redactArchiveContent } from '../../../src/audit/llm-call-archive.js';

describe('redactArchiveContent', () => {
  it('redacts sensitive keys and secret-shaped strings', () => {
    const redacted = redactArchiveContent({
      messages: [
        { role: 'user', content: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz012345' },
      ],
      api_key: 'should-not-appear',
      nested: { token: 'secret-token-value' },
    }) as Record<string, unknown>;

    expect(redacted.api_key).toBe('[REDACTED]');
    expect((redacted.nested as Record<string, unknown>).token).toBe('[REDACTED]');
    const content = ((redacted.messages as Array<{ content: string }>)[0]!).content;
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-ant-');
  });

  it('throws on non-plain objects rather than writing them', () => {
    expect(() => redactArchiveContent({ buf: Buffer.from('x') })).toThrow(/non-plain/);
  });
});
