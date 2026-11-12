// Log fields for errors on paths that handle principal-mailbox grant ids (#2475, R20).
// A Nylas SDK error can carry the grant id in its message or its own properties
// (NylasSdkTimeoutError.url is `…/grants/<id>`), so such errors are logged by class name and
// HTTP status only, never as `{ err }` (pino serializes own properties).

export interface GrantSafeErrorFields {
  errName: string;
  statusCode?: number;
}

/** Class name and HTTP status only: safe to log for any error, Nylas or not. */
export function grantSafeErrorFields(err: unknown): GrantSafeErrorFields {
  const errName = err instanceof Error ? err.name : typeof err;
  const code = typeof err === 'object' && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined;
  return typeof code === 'number' ? { errName, statusCode: code } : { errName };
}

/**
 * True when the error may have come from the Nylas SDK (its class name, or the HTTP status /
 * request URL it attaches). Anything that is not an Error counts too: its shape is unknown.
 */
export function mayCarryGrantId(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  return err.name.startsWith('Nylas') || 'statusCode' in err || 'url' in err;
}
