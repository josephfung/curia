import { describe, it, expect } from 'vitest';
import {
  VOICE_GREETING_USER_MESSAGE,
  isVoiceGreetingCueContent,
} from './greeting.js';

describe('voice greeting cue (#1596)', () => {
  it('identifies the synthetic opening cue for console history filtering', () => {
    expect(isVoiceGreetingCueContent(VOICE_GREETING_USER_MESSAGE)).toBe(true);
    expect(isVoiceGreetingCueContent('hello')).toBe(false);
    expect(isVoiceGreetingCueContent(`${VOICE_GREETING_USER_MESSAGE} `)).toBe(false);
  });
});
