// The sender line states the audience (prompt trim PR 4). It replaced the YAML's
// "How to determine the audience" paragraph, so these cases are that paragraph's tests.

import { describe, expect, it } from 'vitest';
import {
  NOT_PRINCIPAL_LINE,
  renderSenderLine,
  UNRESOLVED_SENDER_HEAD,
} from '../../../../src/agents/prompts/sender-line.js';

describe('renderSenderLine', () => {
  it('marks the principal by system role and says nothing more', () => {
    const line = renderSenderLine({ displayName: 'Avery', systemRole: 'principal', role: 'ceo', verified: true });
    expect(line).toBe('Current sender: Avery (principal) [verified]');
  });

  it('says a non-principal is not the principal', () => {
    const line = renderSenderLine({ displayName: 'Priya Shah', systemRole: null, role: 'board member', verified: true });
    expect(line).toBe(`Current sender: Priya Shah (role: board member) [verified]\n${NOT_PRINCIPAL_LINE}`);
  });

  it('keeps a job title of "Principal" from reading as the principal', () => {
    // A venture "Principal" used to render as "(Principal)", one letter's case away
    // from the system role.
    const line = renderSenderLine({ displayName: 'Dana', systemRole: null, role: 'Principal', verified: false });
    expect(line).toContain('(role: Principal)');
    expect(line).not.toContain('(Principal)');
    expect(line).toContain(NOT_PRINCIPAL_LINE);
  });

  it('says a non-principal with no role is not the principal', () => {
    const line = renderSenderLine({ displayName: 'Sam', systemRole: undefined, role: null, verified: false });
    expect(line).toBe(`Current sender: Sam [unverified]\n${NOT_PRINCIPAL_LINE}`);
  });

  it('treats another system role as not the principal', () => {
    const line = renderSenderLine({ displayName: 'Curia', systemRole: 'agent', role: null, verified: true });
    expect(line).toContain('(agent)');
    expect(line).toContain(NOT_PRINCIPAL_LINE);
  });

  it('states the audience for an unresolved sender too', () => {
    expect(UNRESOLVED_SENDER_HEAD).toContain(NOT_PRINCIPAL_LINE);
  });
});
