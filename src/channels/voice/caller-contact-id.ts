/**
 * voice_sessions.caller_contact_id is a nullable UUID (ON DELETE SET NULL).
 * Persist a real contact id only. Synthetic values such as `primary-user`
 * stay unset so they never land in the UUID column.
 */
import { isUuid } from '../../util/uuid.js';

export function persistableCallerContactId(contactId: string): string | undefined {
  return isUuid(contactId) ? contactId : undefined;
}
