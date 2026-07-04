import { describe, it, expect } from 'vitest';
import {
  extractPromptExfiltrationMarkers,
  MIN_EXFILTRATION_MARKER_LENGTH,
  PROMPT_INSTRUCTION_PREFIX_MARKERS,
} from '../../../src/dispatch/prompt-exfiltration-markers.js';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';
import type { OfficeIdentity } from '../../../src/identity/types.js';

describe('extractPromptExfiltrationMarkers', () => {
  it('includes the "You are [name]" instruction form', () => {
    const markers = extractPromptExfiltrationMarkers(DEFAULT_OFFICE_IDENTITY);
    expect(markers).toContain('You are Alex Curia');
  });

  it('does not emit the email signature as a marker', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: {
        name: 'Nathan Curia',
        title: 'Agent EA',
        emailSignature: '--\nNathan Curia\nAgent EA',
      },
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).not.toContain('Nathan Curia, Agent EA');
  });

  it('includes length-gated constraints', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      constraints: [
        'Never impersonate the CEO',
        'short', // under MIN_EXFILTRATION_MARKER_LENGTH — skipped
      ],
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).toContain('Never impersonate the CEO');
    expect(markers).not.toContain('short');
  });

  it('includes length-gated behavioral preferences', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      behavioralPreferences: [
        'Be concise unless detail is explicitly requested',
        'Be brief', // under threshold
      ],
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).toContain('Be concise unless detail is explicitly requested');
    expect(markers).not.toContain('Be brief');
  });

  it('includes static instruction-prefix patterns', () => {
    const markers = extractPromptExfiltrationMarkers(DEFAULT_OFFICE_IDENTITY);
    for (const prefix of PROMPT_INSTRUCTION_PREFIX_MARKERS) {
      expect(prefix.length).toBeGreaterThanOrEqual(MIN_EXFILTRATION_MARKER_LENGTH);
      expect(markers).toContain(prefix);
    }
  });

  it('returns only instruction prefixes when identity has no name', () => {
    const identity: OfficeIdentity = {
      ...DEFAULT_OFFICE_IDENTITY,
      assistant: { name: '', title: 'Digital EA', emailSignature: '' },
      constraints: [],
      behavioralPreferences: [],
    };
    const markers = extractPromptExfiltrationMarkers(identity);
    expect(markers).toEqual([...PROMPT_INSTRUCTION_PREFIX_MARKERS]);
  });
});
