// describe-email.ts — the gateway-backed DescribeEmail shared by the list-spot-checks tool and
// the weekly fallback digest (#2159 Phase 3). It lives in its own module, not in the sampler,
// so the tool's tests can stub the sampler module without losing this lookup.

import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { DescribeEmail } from './spot-check-sampler.js';

/** Subject and sender ("Name <email>", or the bare email) of a message, read through the gateway. */
export function describeEmailVia(gateway: Pick<OutboundGateway, 'getEmailMessage'>): DescribeEmail {
  return async (messageId, account) => {
    const msg = await gateway.getEmailMessage(messageId, account);
    const sender = msg.from[0];
    const from = sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : undefined;
    return { subject: msg.subject || undefined, from: from || undefined };
  };
}
