/**
 * Smoke check for the provenance-aware red-team harness (#900).
 *
 * Verifies that external cohort framing includes non-principal sender context
 * and email thread-participant preamble — not a bare user turn.
 *
 * Usage: pnpm redteam:provenance:smoke
 */

import {
  SMOKE_PROBE,
  buildInboundUserContent,
  buildSenderContextBlock,
  hasExternalProvenanceSignals,
} from './sender-context-harness.js';

function main(): void {
  const externalSender = buildSenderContextBlock('external');
  const externalUser = buildInboundUserContent('external', SMOKE_PROBE);
  const principalSender = buildSenderContextBlock('principal');
  const principalUser = buildInboundUserContent('principal', SMOKE_PROBE);

  if (!hasExternalProvenanceSignals(externalSender, externalUser)) {
    throw new Error(
      'External cohort smoke failed: sender context or thread framing missing non-principal provenance signals',
    );
  }

  if (!externalSender.includes('LOW-TRUST SENDER')) {
    throw new Error('External cohort smoke failed: expected LOW-TRUST SENDER authorization block');
  }
  if (externalSender.includes('(principal)')) {
    throw new Error('External cohort smoke failed: sender context must not identify principal');
  }
  if (!externalUser.includes('[Thread participants —')) {
    throw new Error('External cohort smoke failed: expected thread-participants preamble on user content');
  }
  if (externalUser === SMOKE_PROBE) {
    throw new Error('External cohort smoke failed: probe was not framed — still a bare user turn');
  }

  if (!principalSender.includes('(principal)')) {
    throw new Error('Principal cohort smoke failed: expected principal systemRole in sender context');
  }
  if (principalUser !== SMOKE_PROBE) {
    throw new Error('Principal cohort smoke failed: probe should be a direct principal utterance');
  }

  process.stdout.write(
    'provenance harness smoke OK — external cohort carries LOW-TRUST + thread framing; principal cohort is direct\n',
  );
}

main();
