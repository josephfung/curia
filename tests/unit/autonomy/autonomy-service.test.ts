import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { AutonomyBand } from '../../../src/autonomy/autonomy-service.js';

function mockPool() {
  return { query: vi.fn() };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe('AutonomyService', () => {
  // -- Static helpers --

  describe('bandForScore', () => {
    const cases: Array<[number, AutonomyBand]> = [
      [100, 'full'],
      [90, 'full'],
      [89, 'spot-check'],
      [80, 'spot-check'],
      [79, 'approval-required'],
      [70, 'approval-required'],
      [69, 'draft-only'],
      [60, 'draft-only'],
      [59, 'restricted'],
      [0, 'restricted'],
    ];

    it.each(cases)('score %i → band "%s"', (score, expected) => {
      expect(AutonomyService.bandForScore(score)).toBe(expected);
    });
  });

  describe('formatPromptBlock', () => {
    it('includes score, band label, and description', () => {
      const config = {
        score: 75,
        band: 'approval-required' as AutonomyBand,
        updatedAt: new Date(),
        updatedBy: 'ceo',
      };
      const block = AutonomyService.formatPromptBlock(config);
      expect(block).toContain('## Autonomy Level');
      expect(block).toContain('75');
      expect(block).toContain('Approval Required');
      // Should contain behavioral guidance for this band
      expect(block).toContain('present your plan');
    });

    it('produces different text for different bands', () => {
      const make = (score: number, band: AutonomyBand) =>
        AutonomyService.formatPromptBlock({ score, band, updatedAt: new Date(), updatedBy: 'ceo' });
      expect(make(95, 'full')).not.toBe(make(75, 'approval-required'));
    });

    it('throws for an unknown band value', () => {
      const config = {
        score: 75,
        band: 'invalid-band' as AutonomyBand,
        updatedAt: new Date(),
        updatedBy: 'ceo',
      };
      expect(() => AutonomyService.formatPromptBlock(config)).toThrow("Unknown autonomy band: 'invalid-band'");
    });
  });

  // -- getConfig --

  describe('getConfig', () => {
    let pool: ReturnType<typeof mockPool>;
    let logger: ReturnType<typeof mockLogger>;
    let svc: AutonomyService;

    beforeEach(() => {
      pool = mockPool();
      logger = mockLogger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc = new AutonomyService(pool as any, logger as any);
    });

    it('returns the current config when a row exists', async () => {
      const now = new Date();
      pool.query.mockResolvedValueOnce({
        rows: [{ score: 75, band: 'approval-required', updated_at: now, updated_by: 'ceo' }],
      });

      const config = await svc.getConfig();
      expect(config).toEqual({ score: 75, band: 'approval-required', updatedAt: now, updatedBy: 'ceo' });
    });

    it('returns null when no row exists', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      expect(await svc.getConfig()).toBeNull();
    });

    it('returns null (not throw) when the table is missing (pg code 42P01)', async () => {
      // 42P01 is the expected pre-migration state — should degrade gracefully.
      const missingTableErr = Object.assign(new Error('relation "autonomy_config" does not exist'), { code: '42P01' });
      pool.query.mockRejectedValueOnce(missingTableErr);
      expect(await svc.getConfig()).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('re-throws unexpected DB errors (not 42P01)', async () => {
      // Connection failures, timeouts, etc. should surface to the caller.
      const connectionErr = Object.assign(new Error('connection refused'), { code: '08006' });
      pool.query.mockRejectedValueOnce(connectionErr);
      await expect(svc.getConfig()).rejects.toThrow('connection refused');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // -- setScore --

  describe('setScore', () => {
    let pool: ReturnType<typeof mockPool>;
    let svc: AutonomyService;

    beforeEach(() => {
      pool = mockPool();
      const logger = mockLogger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc = new AutonomyService(pool as any, logger as any);
    });

    it('throws for out-of-range scores', async () => {
      await expect(svc.setScore(-1, 'ceo')).rejects.toThrow('Invalid autonomy score');
      await expect(svc.setScore(101, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });

    it('throws for non-integer scores', async () => {
      await expect(svc.setScore(75.5, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });

    it('upserts config and inserts history atomically, then returns new config', async () => {
      // Single atomic CTE query — RETURNING previous_score gives us the old value
      pool.query.mockResolvedValueOnce({ rows: [{ previous_score: 70 }] });

      const result = await svc.setScore(80, 'ceo', 'good week');
      expect(result.score).toBe(80);
      expect(result.band).toBe('spot-check');
      expect(result.updatedBy).toBe('ceo');
      expect(result.previousScore).toBe(70);

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO autonomy_config'),
        [80, 'spot-check', 'ceo', 'good week'],
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO autonomy_history'),
        [80, 'spot-check', 'ceo', 'good week'],
      );
    });

    it('passes null reason when not provided', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ previous_score: null }] });
      const result = await svc.setScore(75, 'system');
      expect(result.previousScore).toBeNull();
      expect(pool.query).toHaveBeenCalledWith(
        expect.any(String),
        [75, 'approval-required', 'system', null],
      );
    });

    it('throws for NaN', async () => {
      await expect(svc.setScore(NaN, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });

    it('throws for Infinity', async () => {
      await expect(svc.setScore(Infinity, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });
  });
});
