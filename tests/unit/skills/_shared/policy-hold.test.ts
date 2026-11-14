// gatewaySendFailure (#2587): a gateway refusal becomes a skill failure, typed POLICY_HOLD
// only when the gateway marked it so. The console reads nothing else to tell them apart.

import { describe, expect, it } from 'vitest';
import { gatewaySendFailure } from '../../../../src/skills/_shared/policy-hold.js';

describe('gatewaySendFailure', () => {
  it('types a policy hold as POLICY_HOLD and keeps the gateway reason', () => {
    expect(gatewaySendFailure({ blockedReason: 'Recipient is blocked', policyHold: true }, 'Email send failed'))
      .toEqual({ success: false, error: 'Recipient is blocked', errorType: 'POLICY_HOLD' });
  });

  it('leaves a real failure untyped, so it still counts as a hiccup', () => {
    expect(gatewaySendFailure({ blockedReason: 'Send failed: Nylas 503' }, 'Email send failed'))
      .toEqual({ success: false, error: 'Send failed: Nylas 503' });
  });

  it('falls back to the caller text when the gateway gave no reason', () => {
    expect(gatewaySendFailure({}, 'Email send failed')).toEqual({ success: false, error: 'Email send failed' });
    expect(gatewaySendFailure({ policyHold: true }, 'Email send failed'))
      .toEqual({ success: false, error: 'Email send failed', errorType: 'POLICY_HOLD' });
  });

  it('never reads the reason text: a hold-sounding reason without the flag is a failure', () => {
    expect(gatewaySendFailure({ blockedReason: 'Held for the principal.' }, 'x')).not.toHaveProperty('errorType');
  });
});
