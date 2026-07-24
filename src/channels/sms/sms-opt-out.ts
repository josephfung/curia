// sms-opt-out.ts — durable STOP/START opt-out ledger for US A2P compliance.

import type { Pool } from 'pg';
import type { Logger } from '../../logger.js';

export class SmsOptOutStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async isOptedOut(phoneE164: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM sms_opt_outs WHERE phone_e164 = $1',
      [phoneE164],
    );
    return rows.length > 0;
  }

  async recordOptOut(phoneE164: string, source: string = 'inbound_stop'): Promise<void> {
    await this.pool.query(
      `INSERT INTO sms_opt_outs (phone_e164, source)
       VALUES ($1, $2)
       ON CONFLICT (phone_e164) DO UPDATE SET source = EXCLUDED.source, opted_out_at = NOW()`,
      [phoneE164, source],
    );
    this.logger.info({ phoneSuffix: phoneE164.slice(-4) }, 'sms-opt-out: recorded STOP');
  }

  async clearOptOut(phoneE164: string): Promise<void> {
    await this.pool.query('DELETE FROM sms_opt_outs WHERE phone_e164 = $1', [phoneE164]);
    this.logger.info({ phoneSuffix: phoneE164.slice(-4) }, 'sms-opt-out: cleared via START');
  }
}
