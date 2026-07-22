// active-skills-progress.ts — typed read/write helpers for tasks.progress.activeSkills.
//
// Phase 3a (#1495): durable record of skills activated for a task so park/resume
// wakes can re-load them as a Tier-1 strong prior (design §6). Persisted under
// the existing tasks.progress JSONB — no schema migration.

import { serializedUtf8Bytes } from './resumable-progress.js';

/** Max skills kept active per task (≈ Anthropic's 25k / ~5k-per-skill budget). */
export const ACTIVE_SKILLS_CAP = 5;

/** Max serialized size (UTF-8 bytes) of the entire activeSkills block. */
export const ACTIVE_SKILLS_BLOCK_MAX_BYTES = 4096;

export interface ActiveSkillEntry {
  /** Skill (bundle) name. */
  name: string;
  /** ISO timestamp of the most recent activation (or wake re-load). */
  activatedAt: string;
}

export interface ActiveSkillsBlock {
  skills: ActiveSkillEntry[];
}

export type ActiveSkillsWriteResult =
  | { ok: true; block: ActiveSkillsBlock; progress: Record<string, unknown> }
  | { ok: false; code: 'block_overflow'; bytes: number; maxBytes: number }
  | { ok: false; code: 'invalid_block'; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(raw: unknown): ActiveSkillEntry | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (typeof raw.activatedAt !== 'string' || !raw.activatedAt.trim()) return null;
  return { name: raw.name.trim(), activatedAt: raw.activatedAt.trim() };
}

/** Read and validate progress.activeSkills; null when absent or malformed. */
export function readActiveSkillsBlock(
  progress: Record<string, unknown> | undefined | null,
): ActiveSkillsBlock | null {
  if (!progress) return null;
  const raw = progress.activeSkills;
  if (!isPlainObject(raw)) return null;
  if (!Array.isArray(raw.skills)) return null;
  const skills: ActiveSkillEntry[] = [];
  for (const item of raw.skills) {
    const entry = parseEntry(item);
    if (!entry) return null;
    skills.push(entry);
  }
  return { skills };
}

/** Skill names only (order preserved). Empty when block absent/invalid. */
export function readActiveSkillNames(
  progress: Record<string, unknown> | undefined | null,
): string[] {
  return readActiveSkillsBlock(progress)?.skills.map((s) => s.name) ?? [];
}

/** True when both name lists contain the same set (order-independent). */
export function activeSkillNameSetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((name) => setB.has(name));
}

/**
 * Merge `skillName` into the active set (MRU at front), capped at ACTIVE_SKILLS_CAP.
 * Drops oldest when over cap.
 */
export function activateSkillInBlock(
  existing: ActiveSkillsBlock | null | undefined,
  skillName: string,
  activatedAt: string = new Date().toISOString(),
  cap: number = ACTIVE_SKILLS_CAP,
): ActiveSkillsBlock {
  const name = skillName.trim();
  const prior = (existing?.skills ?? []).filter((s) => s.name !== name);
  const skills = [{ name, activatedAt }, ...prior].slice(0, Math.max(1, cap));
  return { skills };
}

/**
 * Reconcile the wake-selected name list into a block.
 * Preserves `activatedAt` for skills already present (stable prompt-cache prefix);
 * only stamps `now` for newly added names. Does not restamp survivors.
 */
export function reconcileActiveSkillsBlock(
  selectedNames: string[],
  existing: ActiveSkillsBlock | null | undefined,
  now: string = new Date().toISOString(),
  cap: number = ACTIVE_SKILLS_CAP,
): ActiveSkillsBlock {
  const priorByName = new Map((existing?.skills ?? []).map((s) => [s.name, s]));
  const seen = new Set<string>();
  const skills: ActiveSkillEntry[] = [];
  for (const raw of selectedNames) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const prior = priorByName.get(name);
    skills.push({ name, activatedAt: prior?.activatedAt ?? now });
    if (skills.length >= cap) break;
  }
  return { skills };
}

/**
 * @deprecated Prefer reconcileActiveSkillsBlock — this restamps every activatedAt
 * and should not be used on the wake path (prompt-cache / bus churn).
 */
export function replaceActiveSkillsBlock(
  names: string[],
  activatedAt: string = new Date().toISOString(),
  cap: number = ACTIVE_SKILLS_CAP,
): ActiveSkillsBlock {
  return reconcileActiveSkillsBlock(names, null, activatedAt, cap);
}

export function activeSkillsBlockBytes(block: ActiveSkillsBlock): number {
  return serializedUtf8Bytes(block);
}

export function prepareActiveSkillsBlock(
  block: ActiveSkillsBlock,
): ActiveSkillsWriteResult {
  if (!Array.isArray(block.skills)) {
    return { ok: false, code: 'invalid_block', message: 'skills must be an array' };
  }
  for (const entry of block.skills) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      return { ok: false, code: 'invalid_block', message: 'each skill needs a non-empty name' };
    }
    if (typeof entry.activatedAt !== 'string' || !entry.activatedAt.trim()) {
      return { ok: false, code: 'invalid_block', message: 'each skill needs activatedAt' };
    }
  }
  const bytes = activeSkillsBlockBytes(block);
  if (bytes > ACTIVE_SKILLS_BLOCK_MAX_BYTES) {
    return { ok: false, code: 'block_overflow', bytes, maxBytes: ACTIVE_SKILLS_BLOCK_MAX_BYTES };
  }
  return { ok: true, block, progress: { activeSkills: block } };
}
