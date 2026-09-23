import { describe, expect, it } from 'vitest';
import { AGENT_NAME_MAX_LENGTH, isAgentName } from './agent-name.js';

describe('isAgentName', () => {
  it.each([
    'coordinator',
    'health-service',
    'ceo-inbox',
    'a',
    'a'.repeat(AGENT_NAME_MAX_LENGTH),
  ])('accepts %j', (name) => {
    expect(isAgentName(name)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(AGENT_NAME_MAX_LENGTH + 1), 'over length'],
    ['coord\u0000inator', 'control char'],
    ['Coordinator', 'uppercase'],
    ['1agent', 'leading digit'],
    ['-agent', 'leading hyphen'],
    ['my_agent', 'underscore'],
    ['has space', 'whitespace'],
  ] as const)('rejects %j (%s)', (name, _reason) => {
    expect(isAgentName(name)).toBe(false);
  });
});
