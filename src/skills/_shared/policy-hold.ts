// policy-hold.ts — turn an outbound gateway refusal into a skill failure (#2587).
//
// The gateway marks a refusal that a guard made on purpose (a band hold, a principal-send
// refusal, a blocked recipient, the content filter) with `policyHold: true`. A send skill
// passes that on as `errorType: 'POLICY_HOLD'`, which reaches the audit row's
// `payload.result`, so the console can count the job as "held for you" rather than as a
// hiccup. The marker is structured: nothing downstream reads the reason text.

import type { ToolResult } from '../types.js';
import type { OutboundSendResult } from '../outbound-gateway.js';

/** The failure a send skill returns for a gateway result that did not send. */
export function gatewaySendFailure(
  result: Pick<OutboundSendResult, 'blockedReason' | 'policyHold'>,
  fallback: string,
): Extract<ToolResult, { success: false }> {
  const error = result.blockedReason ?? fallback;
  return result.policyHold === true
    ? { success: false, error, errorType: 'POLICY_HOLD' }
    : { success: false, error };
}
