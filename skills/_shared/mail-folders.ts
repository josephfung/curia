// Gmail files these outside the inbox. A native query such as `is:unread` still
// returns them, and triage must not draft a reply (#2035).
const SPAM_OR_TRASH = new Set(['SPAM', 'TRASH']);

export function isSpamOrTrash(folders: readonly string[]): boolean {
  return folders.some((folder) => SPAM_OR_TRASH.has(folder.toUpperCase()));
}
