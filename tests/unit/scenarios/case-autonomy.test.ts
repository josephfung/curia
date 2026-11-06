// A case's autonomy fixture, read back inside its attempt (#2312).
import { describe, expect, it, vi } from 'vitest';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { createLogger } from '../../../src/logger.js';
import { FixtureAutonomyService, runWithAutonomyFixture } from '../../../src/startup/test-mode-stack.js';
import { caseAutonomyError, gatedReviewerError, throughGatewayJudgeError } from '../../scenarios/harness.js';
import { BAND_GATE_C_UNREVIEWED_REASON } from '../../../src/skills/execution.js';

const logger = createLogger('error');
const stored = { score: 95, band: 'full', updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'ceo' };
const pool = { query: vi.fn(async () => ({ rows: [stored] })) } as unknown as ConstructorParameters<typeof AutonomyService>[0];

describe('caseAutonomyError', () => {
  it('passes a case whose fixture the stack reads inside its attempt', async () => {
    const service = new FixtureAutonomyService(pool, logger);
    const fixture = { score: 74, gating: 'band' as const };
    await expect(runWithAutonomyFixture(fixture, () => caseAutonomyError(fixture, service))).resolves.toBeUndefined();
  });

  it('passes a case with no fixture, whatever the stack reads', async () => {
    await expect(caseAutonomyError(undefined, new AutonomyService(pool, logger))).resolves.toBeUndefined();
  });

  it('fails a case whose fixture never reached the stack', async () => {
    // A stack whose service ignores fixtures: the database's 95 under tier.
    const fixture = { score: 84, gating: 'band' as const };
    const error = await runWithAutonomyFixture(fixture, () => caseAutonomyError(fixture, new AutonomyService(pool, logger)));
    expect(error).toBe('autonomy fixture not in force: the stack reads autonomy 95 (tier gating); the fixture asked for 84 (band gating)');
  });

  it('fails a case read outside its attempt\'s fixture', async () => {
    const service = new FixtureAutonomyService(pool, logger, { fixture: { score: 84, gating: 'band' } });
    const error = await caseAutonomyError({ score: 74, gating: 'band' }, service);
    expect(error).toMatch(/reads autonomy 84 \(band gating\); the fixture asked for 74 \(band gating\)/);
  });
});

// Band review without its judge fails every detected item closed (#2312 review): a
// through-gateway run on such a stack is an error, never a scored result.
describe('throughGatewayJudgeError', () => {
  const missing = "the band-review judge (escalation.judge.model 'claude-haiku-5-5') needs the 'anthropic' provider, which is not registered: add anthropic_api_key to the vault";

  it('errors a through-gateway run when the stack has no band-review judge', () => {
    expect(throughGatewayJudgeError({ throughGateway: true }, { bandReviewJudgeMissing: missing }))
      .toBe(`through_gateway run needs the band-review judge: ${missing}`);
  });

  it('leaves a through-gateway run alone when the judge is there', () => {
    expect(throughGatewayJudgeError({ throughGateway: true }, {})).toBeUndefined();
  });

  it('leaves a case that stubs its sends alone, judge or not', () => {
    expect(throughGatewayJudgeError({}, { bandReviewJudgeMissing: missing })).toBeUndefined();
  });
});

// #2499: a gated call Gate C held for want of a reviewer errors the run.
describe('gatedReviewerError', () => {
  const held = (reason: string) => ({ holds: [{ preamble: `Curia wanted to run 'calendar-create-event', and ${reason}.` }] });
  it('errors a gated run held because the reviewer was unavailable', () => {
    expect(gatedReviewerError({ gatedTools: ['calendar-create-event'] }, held(BAND_GATE_C_UNREVIEWED_REASON))).toMatch(/reviewer was unavailable/);
  });
  it('passes a steered hold, a run without gated tools, and a run without a gateway outcome', () => {
    expect(gatedReviewerError({ gatedTools: ['calendar-create-event'] }, held("it looks steered by someone outside the principal's business"))).toBeUndefined();
    expect(gatedReviewerError({}, held(BAND_GATE_C_UNREVIEWED_REASON))).toBeUndefined();
    expect(gatedReviewerError({ gatedTools: ['calendar-create-event'] }, undefined)).toBeUndefined();
  });
});
