import { describe, it, expect } from 'vitest';
import {
  VOICE_GREETING_USER_MESSAGE,
  VOICE_GREETING_INSTRUCTION,
  buildVoiceGreetingInstruction,
  isVoiceGreetingCueContent,
} from './greeting.js';

describe('voice greeting cue (#1596)', () => {
  it('identifies the synthetic opening cue for console history filtering', () => {
    expect(isVoiceGreetingCueContent(VOICE_GREETING_USER_MESSAGE)).toBe(true);
    expect(isVoiceGreetingCueContent('hello')).toBe(false);
    expect(isVoiceGreetingCueContent(`${VOICE_GREETING_USER_MESSAGE} `)).toBe(false);
  });
});

describe('buildVoiceGreetingInstruction (#1874)', () => {
  it('keeps exact principal wording for liveTurn callers', () => {
    const instruction = buildVoiceGreetingInstruction({ liveTurn: true });
    expect(instruction).toBe(VOICE_GREETING_INSTRUCTION);
    expect(instruction).toContain('The principal just called and joined the line');
    expect(instruction).toContain('If active outbound context is present');
  });

  it('uses named-caller framing without principal language when liveTurn is false', () => {
    const instruction = buildVoiceGreetingInstruction({
      liveTurn: false,
      displayName: 'Alex Partner',
    });
    expect(instruction).toContain('Alex Partner just called and joined the line');
    expect(instruction).not.toContain('principal');
    expect(instruction).not.toContain('outbound context');
  });

  it('uses generic caller framing for an unnamed non-principal', () => {
    const instruction = buildVoiceGreetingInstruction({ liveTurn: false });
    expect(instruction).toContain('A caller just joined the line');
    expect(instruction).not.toContain('principal');
    expect(instruction).not.toContain('outbound context');
  });
});
