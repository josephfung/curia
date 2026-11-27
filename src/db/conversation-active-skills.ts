// conversation-active-skills.ts — skills that carry across messages in a conversation (#2764).
//
// Rule: keep a skill until unused for `idleTtlMs` of wall time, at most `cap` per
// (conversation, agent), most recently used first. "Used" means activating it again
// or calling any of its member tools.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

/** Default idle TTL: 24 hours (owner decision, #2764). */
export const CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default cap per conversation/agent (owner decision, #2764). */
export const CONVERSATION_ACTIVE_SKILLS_CAP = 8;

/**
 * Config `conversationActiveSkills.idleTtlHours` → milliseconds. 0 is valid (the schema allows
 * it): nothing carries. Absent, negative or non-numeric falls back to the 24-hour default.
 */
export function conversationActiveSkillsIdleTtlMs(hours: unknown): number {
  return typeof hours === 'number' && Number.isFinite(hours) && hours >= 0
    ? hours * 60 * 60 * 1000
    : CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS;
}

export interface ConversationActiveSkillsConfig {
  idleTtlMs?: number;
  cap?: number;
}

export interface ConversationActiveSkillsStore {
  /** Skills still within the idle TTL, MRU first, capped. */
  listActive(conversationId: string, agentId: string, now?: Date): Promise<string[]>;
  /** Record that a skill was activated or used. */
  touch(conversationId: string, agentId: string, skill: string, now?: Date): Promise<void>;
}

interface Row {
  skill: string;
  last_used_at: Date | string;
}

export class PgConversationActiveSkillsStore implements ConversationActiveSkillsStore {
  private readonly idleTtlMs: number;
  private readonly cap: number;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    config: ConversationActiveSkillsConfig = {},
  ) {
    this.idleTtlMs = config.idleTtlMs ?? CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS;
    this.cap = config.cap ?? CONVERSATION_ACTIVE_SKILLS_CAP;
  }

  async listActive(conversationId: string, agentId: string, now: Date = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - this.idleTtlMs);
    try {
      const result = await this.pool.query<Row>(
        `SELECT skill, last_used_at
           FROM conversation_active_skills
          WHERE conversation_id = $1
            AND agent_id = $2
            AND last_used_at >= $3
          ORDER BY last_used_at DESC
          LIMIT $4`,
        [conversationId, agentId, cutoff.toISOString(), this.cap],
      );
      return result.rows.map((r) => r.skill);
    } catch (err) {
      this.logger.error(
        { err, conversationId, agentId },
        'conversation_active_skills list failed — carrying no skills this turn',
      );
      return [];
    }
  }

  async touch(
    conversationId: string,
    agentId: string,
    skill: string,
    now: Date = new Date(),
  ): Promise<void> {
    const name = skill.trim();
    if (!name) return;
    try {
      await this.pool.query(
        `INSERT INTO conversation_active_skills (conversation_id, agent_id, skill, last_used_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, agent_id, skill)
         DO UPDATE SET last_used_at = EXCLUDED.last_used_at`,
        [conversationId, agentId, name, now.toISOString()],
      );
      // Trim excess beyond the cap (oldest last_used_at first).
      await this.pool.query(
        `DELETE FROM conversation_active_skills cas
          WHERE cas.conversation_id = $1
            AND cas.agent_id = $2
            AND cas.skill IN (
              SELECT skill FROM conversation_active_skills
               WHERE conversation_id = $1 AND agent_id = $2
               ORDER BY last_used_at DESC
              OFFSET $3
            )`,
        [conversationId, agentId, this.cap],
      );
    } catch (err) {
      this.logger.error(
        { err, conversationId, agentId, skill: name },
        'conversation_active_skills touch failed',
      );
      throw err;
    }
  }
}
