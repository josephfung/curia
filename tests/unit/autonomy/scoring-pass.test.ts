// scoring-pass.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AutonomyScoringPass, parseLlmJudgeFlags } from '../../../src/autonomy/scoring-pass.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import { DETERMINISTIC_SCORES } from '../../../src/autonomy/action-log-types.js';
import { NO_REASONING } from '../../../src/agents/llm/sampling-options.js';

function makeRow(overrides: Partial<ActionLogRow>): ActionLogRow {
  return {
    id: 1,
    taskId: 'task-1',
    conversationId: null,
    toolName: 'send-email',
    actionRisk: 'medium',
    outcome: 'success',
    taskSummary: 'Send a reply to Dana',
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: null,
    notificationSentAt: null,
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    parentActionId: null,
    shortRef: null,
    approvalNumber: null,
    description: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ActionLogRepo> = {}): ActionLogRepo {
  return {
    findUnscoredTerminal: vi.fn().mockResolvedValue([]),
    updateScoringFlags: vi.fn().mockResolvedValue(undefined),
    countScored: vi.fn().mockResolvedValue(0),
    getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
    findAllScored: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeAutonomyService(score = 75, lastChangedBy = 'ceo', changedAt = new Date()): AutonomyService {
  return {
    getConfig: vi.fn().mockResolvedValue({
      score,
      band: 'approval-required',
      updatedAt: changedAt,
      updatedBy: lastChangedBy,
    }),
    setScore: vi.fn().mockResolvedValue({
      score: score + 3,
      band: 'approval-required',
      updatedAt: new Date(),
      updatedBy: 'system',
      previousScore: score,
    }),
    getHistory: vi.fn().mockResolvedValue([
      { id: 1, score, previousScore: score - 2, band: 'approval-required', changedBy: lastChangedBy, reason: null, changedAt },
    ]),
  } as unknown as AutonomyService;
}

function makeLlmProvider(competence: 0 | 1 = 1, commitment: 0 | 1 = 1, compatibility: 0 | 1 = 1): LLMProvider {
  return {
    id: 'anthropic',
    chat: vi.fn().mockResolvedValue({
      // LLMResponse uses type: 'text', not 'message'
      type: 'text',
      content: JSON.stringify({
        competence_flag: competence,
        commitment_flag: commitment,
        compatibility: compatibility,
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as LLMProvider;
}

const defaultConfig = {
  intervalMs: 86_400_000,
  model: 'claude-haiku-4-5',
  batchSize: 50,
  minScoredActions: 30,
  halfLifeDays: 30,
  ceoCooldownDays: 7,
  errorRateThreshold: 0.20,
  errorRateWindowDays: 90,
  unparseableAfterDays: 3,
};

describe('AutonomyScoringPass', () => {
  describe('scoreRows', () => {
    it('applies deterministic scores for approved outcome', async () => {
      const row = makeRow({ id: 10, outcome: 'approved' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(10, {
        competenceFlag: 1,
        commitmentFlag: 1,
        compatibility: 1,
        scoredBy: 'deterministic',
      });
    });

    it('applies deterministic scores for denied outcome', async () => {
      const row = makeRow({ id: 11, outcome: 'denied' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(11, {
        competenceFlag: 0,
        commitmentFlag: null,
        compatibility: 0,
        scoredBy: 'deterministic',
      });
    });

    // #2159: only the principal's own decisions are feedback.
    it('scores a coordinator-resolved approval as no signal', async () => {
      const row = makeRow({ id: 20, outcome: 'approved', resolvedBy: 'coordinator' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(20, {
        competenceFlag: null,
        commitmentFlag: null,
        compatibility: null,
        scoredBy: 'deterministic-coordinator',
      });
    });

    it('scores a coordinator-denied approval as no signal', async () => {
      const row = makeRow({ id: 21, outcome: 'denied', resolvedBy: 'coordinator' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(21, expect.objectContaining({
        competenceFlag: null,
        scoredBy: 'deterministic-coordinator',
      }));
    });

    it('keeps the principal signal for a reaction-resolved approval', async () => {
      const row = makeRow({ id: 22, outcome: 'approved', resolvedBy: 'principal' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(22, expect.objectContaining({
        competenceFlag: 1,
        scoredBy: 'deterministic',
      }));
    });

    // #2196: the re-execution of an approved action has no summary; the parent carries the signal.
    it('scores a successful re-execution of an approved action as no signal, without the judge', async () => {
      const row = makeRow({ id: 45, outcome: 'success', parentActionId: 43, taskSummary: null });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = makeLlmProvider(0, 0, 0);
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      const result = await pass.run();

      expect(llm.chat).not.toHaveBeenCalled();
      expect(result.llmCallsMade).toBe(0);
      expect(repo.updateScoringFlags).toHaveBeenCalledWith(45, {
        competenceFlag: null,
        commitmentFlag: null,
        compatibility: null,
        scoredBy: 'deterministic-approved-execution',
      });
    });

    it('still judges a failed re-execution of an approved action, with its error as context', async () => {
      const row = makeRow({ id: 32, outcome: 'failure', parentActionId: 31, taskSummary: 'calendar API returned 403' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = makeLlmProvider(0, 1, 1);
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(llm.chat).toHaveBeenCalledTimes(1);
      const prompt = vi.mocked(llm.chat).mock.calls[0]![0].messages[1]!.content as string;
      expect(prompt).toContain('calendar API returned 403');
      // A background scoring call never inherits reasoning (ADR-048 §3).
      expect(vi.mocked(llm.chat).mock.calls[0]![0].options).toEqual({ reasoning: NO_REASONING });
      expect(repo.updateScoringFlags).toHaveBeenCalledWith(32, expect.objectContaining({
        competenceFlag: 0,
        scoredBy: 'llm-judge',
      }));
    });

    it('applies deterministic scores for rejected outcome', async () => {
      const row = makeRow({ id: 12, outcome: 'rejected' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(12, {
        competenceFlag: 0,
        commitmentFlag: 1,
        compatibility: null,
        scoredBy: 'deterministic',
      });
    });

    it('calls LLM judge for success outcome', async () => {
      const row = makeRow({ id: 13, outcome: 'success' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = makeLlmProvider(1, 1, 1);
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(llm.chat).toHaveBeenCalledTimes(1);
      expect(repo.updateScoringFlags).toHaveBeenCalledWith(13, {
        competenceFlag: 1,
        commitmentFlag: 1,
        compatibility: 1,
        scoredBy: 'llm-judge',
      });
    });

    it('leaves row unscored when LLM call fails', async () => {
      const row = makeRow({ id: 14, outcome: 'failure' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = { id: 'anthropic', chat: vi.fn().mockRejectedValue(new Error('API timeout')) } as unknown as LLMProvider;
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).not.toHaveBeenCalled();
    });

    it('leaves row unscored when LLM returns valid JSON with wrong field types', async () => {
      const row = makeRow({ id: 15, outcome: 'success' });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = {
        id: 'anthropic',
        chat: vi.fn().mockResolvedValue({
          type: 'text',
          content: JSON.stringify({ competence_flag: 'yes', commitment_flag: '1', compatibility: true }),
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      } as unknown as LLMProvider;
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      const result = await pass.run();

      expect(repo.updateScoringFlags).not.toHaveBeenCalled();
      expect(result.llmCallsFailed).toBe(1);
      expect(result.rowsScored).toBe(0);
    });

    it('dead-letters an old row when the judge JSON stays unparseable past the retry floor', async () => {
      const row = makeRow({
        id: 16,
        outcome: 'success',
        createdAt: new Date(Date.now() - 4 * 86_400_000),
      });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = {
        id: 'anthropic',
        chat: vi.fn().mockResolvedValue({
          type: 'text',
          content: JSON.stringify({ competence_flag: 2, commitment_flag: 0.8, compatibility: -1 }),
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      } as unknown as LLMProvider;
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      const result = await pass.run();

      expect(repo.updateScoringFlags).toHaveBeenCalledWith(16, {
        competenceFlag: null,
        commitmentFlag: null,
        compatibility: null,
        scoredBy: 'llm-judge-unparseable',
      });
      expect(result.llmCallsFailed).toBe(1);
      expect(result.rowsScored).toBe(1);
    });

    it('does not dead-letter an old row when the LLM call itself fails', async () => {
      const row = makeRow({
        id: 17,
        outcome: 'failure',
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      });
      const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
      const llm = { id: 'anthropic', chat: vi.fn().mockRejectedValue(new Error('API timeout')) } as unknown as LLMProvider;
      const pass = new AutonomyScoringPass(repo, makeAutonomyService(), llm, createSilentLogger(), defaultConfig);

      await pass.run();

      expect(repo.updateScoringFlags).not.toHaveBeenCalled();
    });
  });

  describe('parseLlmJudgeFlags', () => {
    it('accepts numeric 0/1 flags', () => {
      expect(parseLlmJudgeFlags(JSON.stringify({
        competence_flag: 1,
        commitment_flag: 0,
        compatibility: 1,
      }))).toEqual({
        competenceFlag: 1,
        commitmentFlag: 0,
        compatibility: 1,
        scoredBy: 'llm-judge',
      });
    });

    it('coerces boolean flags to 0/1', () => {
      expect(parseLlmJudgeFlags(JSON.stringify({
        competence_flag: true,
        commitment_flag: false,
        compatibility: true,
      }))).toEqual({
        competenceFlag: 1,
        commitmentFlag: 0,
        compatibility: 1,
        scoredBy: 'llm-judge',
      });
    });

    it('strips a wrapping markdown code fence', () => {
      const body = JSON.stringify({ competence_flag: 1, commitment_flag: 0, compatibility: 1 });
      expect(parseLlmJudgeFlags('```json\n' + body + '\n```')).toEqual({
        competenceFlag: 1,
        commitmentFlag: 0,
        compatibility: 1,
        scoredBy: 'llm-judge',
      });
    });

    it('throws when required fields are missing', () => {
      expect(() => parseLlmJudgeFlags('{}')).toThrow(/missing or out-of-range flags/);
      expect(() => parseLlmJudgeFlags('{}')).toThrow(/competence_flag=absent/);
      expect(() => parseLlmJudgeFlags('{}')).toThrow(/preview=/);
    });

    it('throws when required fields are non-numeric', () => {
      expect(() => parseLlmJudgeFlags(JSON.stringify({
        competence_flag: 'yes',
        commitment_flag: 1,
        compatibility: 0,
      }))).toThrow(/competence_flag="yes"/);
    });

    it('truncates long string flag values in the error', () => {
      const long = 'x'.repeat(80);
      expect(() => parseLlmJudgeFlags(JSON.stringify({
        competence_flag: long, commitment_flag: 1, compatibility: 1,
      }))).toThrow(/competence_flag="x{40}"…\(80\)/);
    });

    it('throws on numeric flags outside 0/1', () => {
      expect(() => parseLlmJudgeFlags(JSON.stringify({
        competence_flag: 2, commitment_flag: 0.8, compatibility: -1,
      }))).toThrow(/competence_flag=2/);
    });

    it('throws when a field is explicitly null', () => {
      expect(() => parseLlmJudgeFlags(JSON.stringify({
        competence_flag: null, commitment_flag: 1, compatibility: 1,
      }))).toThrow(/competence_flag=null/);
    });

    it('throws when JSON is not an object', () => {
      expect(() => parseLlmJudgeFlags('[]')).toThrow(/non-object JSON/);
      expect(() => parseLlmJudgeFlags('null')).toThrow(/non-object JSON/);
      expect(() => parseLlmJudgeFlags('1')).toThrow(/non-object JSON/);
    });
  });

  describe('adjustment formula', () => {
    it('does not adjust when fewer than minScoredActions exist', async () => {
      const repo = makeRepo({ countScored: vi.fn().mockResolvedValue(10) });
      const svc = makeAutonomyService();
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).not.toHaveBeenCalled();
    });

    it('does not adjust during CEO cooldown period', async () => {
      const recentCeoChange = new Date(); // just now — within 7-day cooldown
      const repo = makeRepo({ countScored: vi.fn().mockResolvedValue(50) });
      const svc = makeAutonomyService(75, 'ceo', recentCeoChange);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).not.toHaveBeenCalled();
    });

    it('adjusts score upward when capability > 0.5 and all guards pass', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000); // 30 days ago — past cooldown
      const scoredRows = Array.from({ length: 35 }, (_, i) =>
        makeRow({
          id: i + 1,
          outcome: 'success',
          competenceFlag: 1,
          commitmentFlag: 1,
          compatibility: 1,
          scoredBy: 'llm-judge',
          createdAt: new Date(Date.now() - i * 86_400_000), // spread over 35 days
        }),
      );
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(35),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      expect(svc.setScore).toHaveBeenCalledTimes(1);
      const [newScore, changedBy] = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls[0]! as [number, string, string];
      expect(newScore).toBeGreaterThan(75);
      expect(newScore).toBeLessThanOrEqual(80); // max +5
      expect(changedBy).toBe('system');
    });

    // #2159: coordinator-resolved approvals no longer carry competence, so the recent
    // window can be empty. That is "no evidence", and must not read as a 0% error rate.
    it('blocks score increase when there is no recent competence evidence', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000);
      const scoredRows = Array.from({ length: 35 }, (_, i) =>
        makeRow({ id: i + 1, competenceFlag: null, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge', createdAt: new Date(Date.now() - i * 86_400_000) }),
      );
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(35),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(null),
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      const result = await pass.run();

      expect(svc.setScore).not.toHaveBeenCalled();
      expect(result.reason).toMatch(/no competence evidence in the last 90d/);
    });

    it('blocks score increase when error rate exceeds threshold', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000);
      const scoredRows = [
        ...Array.from({ length: 25 }, (_, i) =>
          makeRow({ id: i + 1, competenceFlag: 1, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge', createdAt: new Date(Date.now() - i * 86_400_000) }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          makeRow({ id: i + 26, competenceFlag: 0, commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic', createdAt: new Date(Date.now() - (i + 25) * 86_400_000) }),
        ),
      ];
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(35),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0.25), // 25% > 20% threshold
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      // Should not increase — error rate guard blocks it
      if ((svc.setScore as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const [newScore] = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls[0]! as [number];
        expect(newScore).toBeLessThanOrEqual(75);
      }
    });

    it('does not write when delta rounds to 0', async () => {
      const oldDate = new Date(Date.now() - 30 * 86_400_000);
      const scoredRows = Array.from({ length: 30 }, (_, i) =>
        makeRow({
          id: i + 1,
          competenceFlag: i % 2 === 0 ? 1 : 0,
          commitmentFlag: 1,
          compatibility: i % 2 === 0 ? 1 : 0,
          scoredBy: 'llm-judge',
          createdAt: new Date(Date.now() - i * 86_400_000),
        }),
      );
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(30),
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0.5),
        findAllScored: vi.fn().mockResolvedValue(scoredRows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);

      await pass.run();

      const calls = (svc.setScore as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect((call as [number])[0]).toBeLessThanOrEqual(75);
      }
    });
  });

  // #2159 Phase 3: the scorer weights the principal's spot-check verdicts most and
  // ignores lapsed approvals. computeCapabilityScore is private, so these drive run()
  // with a mocked repo that clears the sample-size and cooldown guards.
  describe('principal verdicts and expired approvals (#2159 Phase 3)', () => {
    async function capabilityFor(rows: ActionLogRow[]): Promise<number | null> {
      const oldDate = new Date(Date.now() - 30 * 86_400_000); // past the principal cooldown
      const repo = makeRepo({
        countScored: vi.fn().mockResolvedValue(rows.length + 100), // above minScoredActions
        getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
        findAllScored: vi.fn().mockResolvedValue(rows),
      });
      const svc = makeAutonomyService(75, 'system', oldDate);
      const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), defaultConfig);
      const result = await pass.run();
      return result.capabilityScore;
    }

    it('expired approvals score with no signal on any dimension', () => {
      expect(DETERMINISTIC_SCORES.expired).toEqual({
        competenceFlag: null,
        commitmentFlag: null,
        compatibility: null,
        scoredBy: 'deterministic',
      });
    });

    it('weights a principal verdict three times a judge verdict', async () => {
      const rows = [
        makeRow({ id: 1, competenceFlag: 0, scoredBy: 'principal' }),
        makeRow({ id: 2, competenceFlag: 1, scoredBy: 'llm-judge' }),
        makeRow({ id: 3, competenceFlag: 1, scoredBy: 'llm-judge' }),
      ];

      const capability = await capabilityFor(rows);

      // Competence (1 + 1 + 0*3) / (1 + 1 + 3) = 0.4; commitment and compatibility have no data (0.5).
      expect(capability).not.toBeNull();
      expect(Math.abs(capability! - (0.45 * 0.4 + 0.35 * 0.5 + 0.20 * 0.5))).toBeLessThan(1e-9);
    });

    // A mixed set is the real guard: a lone row scores 0.5 whether it is skipped or the
    // set is empty, so it cannot tell "ignored" from "weighted down" (review finding).
    it('leaves the capability at the normal rows alone when an old expired row carries flags', async () => {
      const rows = [
        makeRow({ id: 1, outcome: 'success', competenceFlag: 1, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge' }),
        makeRow({ id: 2, outcome: 'expired', commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic' }),
      ];

      const capability = await capabilityFor(rows);

      // The normal row alone is 0.45 + 0.35 + 0.20 = 1.0; any weight on the expired row pulls compatibility down.
      expect(capability).not.toBeNull();
      expect(Math.abs(capability! - 1.0)).toBeLessThan(1e-9);
    });

    it('ignores an old expired row that still carries flags', async () => {
      const rows = [
        makeRow({ id: 1, outcome: 'expired', commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic' }),
      ];

      const capability = await capabilityFor(rows);

      expect(capability).toBeCloseTo(0.5, 9);
    });

    // #2191: shadow drafts are counterfactual (drafted only for punted messages), not evidence
    // about actions taken. Mixed set for the same reason as the expired test above.
    it('leaves a shadow disagreement out of the capability score', async () => {
      const rows = [
        makeRow({ id: 1, outcome: 'success', competenceFlag: 1, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge' }),
        makeRow({ id: 2, outcome: 'shadow_evaluated', competenceFlag: 0, scoredBy: 'shadow-reconciler' }),
      ];

      const capability = await capabilityFor(rows);

      // Any weight on the shadow row pulls competence below 1.0.
      expect(capability).not.toBeNull();
      expect(Math.abs(capability! - 1.0)).toBeLessThan(1e-9);
    });
  });

  // #2191: the guard's window is bounded by age as well as count.
  it('passes the configured age bound to the error-rate window', async () => {
    const oldDate = new Date(Date.now() - 30 * 86_400_000);
    const scoredRows = Array.from({ length: 35 }, (_, i) =>
      makeRow({ id: i + 1, competenceFlag: 1, commitmentFlag: 1, compatibility: 1, scoredBy: 'llm-judge', createdAt: new Date(Date.now() - i * 86_400_000) }),
    );
    const getRecentCompetenceErrorRate = vi.fn().mockResolvedValue(0);
    const repo = makeRepo({
      countScored: vi.fn().mockResolvedValue(35),
      getRecentCompetenceErrorRate,
      findAllScored: vi.fn().mockResolvedValue(scoredRows),
    });
    const svc = makeAutonomyService(75, 'system', oldDate);
    const pass = new AutonomyScoringPass(repo, svc, makeLlmProvider(), createSilentLogger(), {
      ...defaultConfig,
      errorRateWindowDays: 45,
    });

    await pass.run();

    expect(getRecentCompetenceErrorRate).toHaveBeenCalledWith(30, 45);
  });
});
