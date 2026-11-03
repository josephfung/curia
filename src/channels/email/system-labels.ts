// Gmail system labels that Nylas rejects in a message update with HTTP 400
// "unsupported Google label: SENT" (#2426). Gmail keeps them on the message
// whether or not the update lists them, so dropping them loses nothing.
const READ_ONLY_SYSTEM_LABELS = new Set(['SENT', 'DRAFT']);

export function isReadOnlySystemLabel(folder: string): boolean {
  return READ_ONLY_SYSTEM_LABELS.has(folder.toUpperCase());
}

export function withoutReadOnlySystemLabels(folders: readonly string[]): string[] {
  return folders.filter((folder) => !isReadOnlySystemLabel(folder));
}
