import type { Pool } from 'pg';

export type VoiceSessionStatus = 'starting' | 'active' | 'ended' | 'failed';

export interface VoiceSessionRecord {
  id: string;
  conversationId: string;
  livekitRoom: string;
  principalContactId: string | null;
  status: VoiceSessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  metadata: Record<string, unknown>;
}

interface VoiceSessionRow {
  id: string;
  conversation_id: string;
  livekit_room: string;
  principal_contact_id: string | null;
  status: VoiceSessionStatus;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateVoiceSessionInput {
  id?: string;
  conversationId: string;
  livekitRoom: string;
  principalContactId?: string;
  metadata?: Record<string, unknown>;
}

export class VoiceSessionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRecord> {
    const result = await this.pool.query<VoiceSessionRow>(
      `INSERT INTO voice_sessions (id, conversation_id, livekit_room, principal_contact_id, status, metadata)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'starting', $5::jsonb)
       RETURNING id, conversation_id, livekit_room, principal_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [
        input.id ?? null,
        input.conversationId,
        input.livekitRoom,
        input.principalContactId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRow(requireSingleRow(result.rows));
  }

  async get(id: string): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `SELECT id, conversation_id, livekit_room, principal_contact_id, status, started_at, ended_at, end_reason, metadata
       FROM voice_sessions
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async updateStatus(id: string, status: Exclude<VoiceSessionStatus, 'ended'>): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `UPDATE voice_sessions
       SET status = $2
       WHERE id = $1 AND status <> 'ended'
       RETURNING id, conversation_id, livekit_room, principal_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [id, status],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async endSession(id: string, reason: string): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `UPDATE voice_sessions
       SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), end_reason = $2
       WHERE id = $1 AND status <> 'ended'
       RETURNING id, conversation_id, livekit_room, principal_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [id, reason],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async markAbandonedOnRestart(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE voice_sessions
       SET status = 'failed', ended_at = COALESCE(ended_at, NOW()), end_reason = 'process_restart'
       WHERE status IN ('starting', 'active')`,
    );
    return result.rowCount ?? 0;
  }
}

function requireSingleRow(rows: VoiceSessionRow[]): VoiceSessionRow {
  const row = rows[0];
  if (!row) throw new Error('voice_sessions write returned no row');
  return row;
}

function mapRow(row: VoiceSessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    livekitRoom: row.livekit_room,
    principalContactId: row.principal_contact_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    metadata: row.metadata,
  };
}
