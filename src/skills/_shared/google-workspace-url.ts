// Google Docs, Sheets, Slides and Drive URLs open only through the google-workspace
// tools (prompt trim PR 6). web-fetch and web-browser have no Google credentials, so
// such a link gets them a sign-in page, which the model then reports as the file. This
// was a sentence in the coordinator prompt; the tools now refuse the URL and say where
// the file opens instead.
//
// Left open: Google Forms (public, and the browser fills them) and Docs published to the
// web (`/d/e/<id>/pub`), which are public pages whose publish ID the Workspace tools
// cannot read.

/** Paths on docs.google.com that are files, optionally under a Workspace domain (`/a/<domain>`). */
const DOCS_FILE_PATH = /^\/(?:a\/[^/]+\/)?(?:document|spreadsheets|presentation)\/(?!d\/e\/)/;

/** Hosts whose every page is a Drive file or folder. */
const DRIVE_HOSTS = new Set(['drive.google.com', 'sheets.google.com']);

/** True when `url` is a Google Docs, Sheets, Slides or Drive file that needs the Workspace tools. */
export function isGoogleWorkspaceFileUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (DRIVE_HOSTS.has(host)) return true;
  return host === 'docs.google.com' && DOCS_FILE_PATH.test(url.pathname);
}

/** The refusal a web tool returns for such a URL. */
export function googleWorkspaceUrlError(tool: string): string {
  return `Google Docs, Sheets and Drive links open only through the Google Workspace tools; ${tool} gets a sign-in page for them, so nothing was fetched. `
    + 'Call skill-activate with skill "google-workspace" and read the file with its tools. '
    + 'If you have no skill-activate, say the file needs Google Workspace access.';
}
