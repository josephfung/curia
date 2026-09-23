/**
 * voice_sessions.caller_contact_id is a nullable UUID (ON DELETE SET NULL).
 * Persist a real contact id only. Synthetic values such as `primary-user`
 * stay unset so they never land in the UUID column.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function persistableCallerContactId(contactId: string): string | undefined {
  return UUID_RE.test(contactId) ? contactId : undefined;
}
