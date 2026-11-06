// What a tool call contributes to identifier provenance (#2498): agent input recorded
// before the call, under the conversation and the browser session; the result recorded
// after, minus that input.
import { describe, it, expect } from 'vitest';
import { IdentifierSourceIndex } from '../../../src/agents/identifier-source-index.js';
import { browserSessionScope, recordAgentInputBeforeCall, recordSourceAfterCall } from '../../../src/agents/provenance-recording.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';

const ECHO = new Set(['web-fetch', 'web-browser']);
const execution = {
  provenanceSourceText: (name: string, _input: unknown, data: unknown) =>
    (ECHO.has(name) || name === 'email-get' ? String((data as { content?: unknown })?.content ?? data) : null),
  isAgentEchoSource: (name: string) => ECHO.has(name),
  provenanceAgentInputText: (name: string, input: unknown) => (ECHO.has(name) ? JSON.stringify(input) : null),
} as unknown as Pick<ExecutionLayer, 'provenanceSourceText' | 'isAgentEchoSource' | 'provenanceAgentInputText'>;

function call(index: IdentifierSourceIndex, conversation: string, name: string, input: Record<string, unknown>, data: unknown): void {
  const before = recordAgentInputBeforeCall(execution, index, conversation, name, input);
  recordSourceAfterCall(execution, index, conversation, name, input, data, before);
}

describe('provenance recording (#2498)', () => {
  it('excludes what was typed into a browser session when another conversation reattaches it', () => {
    const index = new IdentifierSourceIndex();
    // Run 1 opens a session (its id arrives only in the result) and types a mistyped address.
    call(index, 'scheduler:job:run-1', 'web-browser', { action: 'navigate', url: 'https://book.example' }, { session_id: 's1', content: 'Book' });
    call(index, 'scheduler:job:run-1', 'web-browser', { action: 'type', selector: 'Email', text: 'jon@acme.co', session_id: 's1' }, { session_id: 's1', content: 'ok' });
    // Run 2, a new conversation, reattaches the kept-warm session and reads the confirmation.
    call(index, 'scheduler:job:run-2', 'web-browser', { action: 'get_content', session_id: 's1' },
      { session_id: 's1', content: 'Confirmation sent to jon@acme.co. Questions: help@book.example' });
    expect(index.has('scheduler:job:run-2', 'email:jon@acme.co')).toBe(false);
    expect(index.has('scheduler:job:run-2', 'email:help@book.example')).toBe(true);
  });

  it("records a new session's first input under that session once the result names it", () => {
    const index = new IdentifierSourceIndex();
    call(index, 'conv-a', 'web-browser', { action: 'navigate', url: 'https://search.example/?q=evnts@venue.example' },
      { session_id: 's2', content: 'Results' });
    call(index, 'conv-b', 'web-browser', { action: 'get_content', session_id: 's2' }, { session_id: 's2', content: 'Results for evnts@venue.example' });
    expect(index.has('conv-b', 'email:evnts@venue.example')).toBe(false);
    expect(index.has(browserSessionScope('s2'), 'email:evnts@venue.example')).toBe(false);
  });

  it('records the input under the fresh session when the requested one had expired', () => {
    const index = new IdentifierSourceIndex();
    // The agent passes stale s-old; the browser runs the call in a new session, s-new.
    call(index, 'conv-a', 'web-browser', { action: 'type', text: 'jon@acme.co', session_id: 's-old', keep_warm: true },
      { session_id: 's-new', session_reused: false, content: 'ok' });
    call(index, 'conv-b', 'web-browser', { action: 'get_content', session_id: 's-new' }, { session_id: 's-new', content: 'Confirmation sent to jon@acme.co' });
    expect(index.has('conv-b', 'email:jon@acme.co')).toBe(false);
  });

  it('keeps a browser session scope when many conversations record sources', () => {
    const index = new IdentifierSourceIndex({ maxConversations: 2 });
    call(index, 'conv-a', 'web-browser', { action: 'type', text: 'jon@acme.co', session_id: 's1' }, { session_id: 's1', content: 'ok' });
    for (const conv of ['c1', 'c2', 'c3']) index.record(conv, `x@${conv}.example`);
    call(index, 'conv-z', 'web-browser', { action: 'get_content', session_id: 's1' }, { session_id: 's1', content: 'Sent to jon@acme.co' });
    expect(index.has('conv-z', 'email:jon@acme.co')).toBe(false);
  });

  it('records nothing from a requested session whose input record is gone (evicted, or never seen)', () => {
    const index = new IdentifierSourceIndex();
    // s-lost was typed into in a record that no longer exists (e.g. an approval replay).
    call(index, 'conv-a', 'web-browser', { action: 'get_content', session_id: 's-lost' },
      { session_id: 's-lost', content: 'Confirmation sent to jon@acme.co' });
    expect(index.has('conv-a', 'email:jon@acme.co')).toBe(false);
    // The empty record the first read created does not restore trust: a second read of the
    // same address (typed before the history was lost) still records nothing.
    call(index, 'conv-a', 'web-browser', { action: 'get_content', session_id: 's-lost' },
      { session_id: 's-lost', content: 'Confirmation sent to jon@acme.co' });
    expect(index.has('conv-a', 'email:jon@acme.co')).toBe(false);
    call(index, 'conv-a', 'web-browser', { action: 'get_content', session_id: 's-lost' },
      { session_id: 's-lost', content: 'Questions: help@book.example' });
    expect(index.has('conv-a', 'email:help@book.example')).toBe(false);
    // A fresh session (a new id) is trusted again.
    call(index, 'conv-a', 'web-browser', { action: 'navigate', url: 'https://book.example' },
      { session_id: 's-fresh', content: 'Questions: help@book.example' });
    expect(index.has('conv-a', 'email:help@book.example')).toBe(true);
  });

  it('records nothing when the session scope was evicted between calls', () => {
    const index = new IdentifierSourceIndex({ maxAgentInputScopes: 2 });
    call(index, 'conv-a', 'web-browser', { action: 'type', text: 'jon@acme.co', session_id: 's1' }, { session_id: 's1', content: 'ok' });
    // Other scopes push s1's record out.
    for (const id of ['s2', 's3']) call(index, `conv-${id}`, 'web-browser', { action: 'navigate', url: 'https://x.example' }, { session_id: id, content: 'ok' });
    call(index, 'conv-z', 'web-browser', { action: 'get_content', session_id: 's1' }, { session_id: 's1', content: 'Sent to jon@acme.co' });
    expect(index.has('conv-z', 'email:jon@acme.co')).toBe(false);
  });

  it('does not exclude agent input from a non-echo source', () => {
    const index = new IdentifierSourceIndex();
    call(index, 'conv-a', 'web-browser', { action: 'type', text: 'sam@venue.example', session_id: 's3' }, { session_id: 's3', content: 'ok' });
    call(index, 'conv-a', 'email-get', { message_id: 'm1' }, 'From: sam@venue.example');
    expect(index.has('conv-a', 'email:sam@venue.example')).toBe(true);
  });
});
