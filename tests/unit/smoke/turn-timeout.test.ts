// A case's timeout_seconds can lengthen a turn's wait, never shorten it.
import { describe, expect, it } from 'vitest';
import { RESPONSE_TIMEOUT_MS, turnTimeoutMs } from '../../smoke/harness.js';

describe('turnTimeoutMs', () => {
  it('uses the default when the case sets none', () => {
    expect(turnTimeoutMs(undefined)).toBe(RESPONSE_TIMEOUT_MS);
  });

  it('uses a longer case timeout', () => {
    expect(turnTimeoutMs(RESPONSE_TIMEOUT_MS + 120_000)).toBe(RESPONSE_TIMEOUT_MS + 120_000);
  });

  it('keeps the default (or SMOKE_TIMEOUT_MS) when the case asks for less', () => {
    expect(turnTimeoutMs(10_000)).toBe(RESPONSE_TIMEOUT_MS);
  });
});
