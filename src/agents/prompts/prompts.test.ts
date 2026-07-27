import { describe, it, expect } from 'vitest';
import {
  DATE_RESOLVE_GUARDRAIL,
  PRONOUN_RESOLUTION_GUARDRAIL,
  ROUTING_DECISION_GUARDRAIL,
  VOICE_ASYNC_OFFRAMP_GUIDANCE,
} from './index.js';

describe('shared prompt guardrails (#1595 / ADR-038)', () => {
  it('date-resolve guardrail requires the date-resolve tool', () => {
    expect(DATE_RESOLVE_GUARDRAIL).toContain('date-resolve to verify');
    expect(DATE_RESOLVE_GUARDRAIL).toContain('### Date & time');
  });

  it('pronoun guardrail resolves my/your/their before delegate', () => {
    expect(PRONOUN_RESOLUTION_GUARDRAIL).toContain('My calendar');
    expect(PRONOUN_RESOLUTION_GUARDRAIL).toContain('Your calendar');
  });

  it('routing guardrail names the three-way decision and outbound match rule', () => {
    expect(ROUTING_DECISION_GUARDRAIL).toContain('Handle directly');
    expect(ROUTING_DECISION_GUARDRAIL).toContain('Borrow-then-answer');
    expect(ROUTING_DECISION_GUARDRAIL).toContain('Transfer-ownership');
    expect(ROUTING_DECISION_GUARDRAIL).toContain('ACTIVE OUTBOUND CONTEXT');
  });

  it('voice async off-ramp offers deferral without inventing results', () => {
    expect(VOICE_ASYNC_OFFRAMP_GUIDANCE).toContain('async-offramp');
    expect(VOICE_ASYNC_OFFRAMP_GUIDANCE).toContain('follow up');
    expect(VOICE_ASYNC_OFFRAMP_GUIDANCE).toContain('Do **not** pretend you finished');
  });
});
