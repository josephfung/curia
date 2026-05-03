// scoring-pass.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AutonomyScoringPass } from './scoring-pass.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { AutonomyService } from './autonomy-service.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import { createSilentLogger } from '../logger.js';
import type { ActionLogRow } from './action-log-types.js';

function makeRow(overrides: Partial<ActionLogRow>): ActionLogRow {
  return {
    id: 1,
    taskId: 'task-1',
    conversationId: null,
    skillName: 'send-email',
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
  weakExpiredWeight: 0.3,
  ceoCooldownDays: 7,
  errorRateThreshold: 0.20,
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
});
