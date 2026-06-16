// Normalize ZAP SARIF location URIs for GitHub Code Scanning.
//
// ZAP is a DAST tool: its findings point at web URLs, so each result's
// physicalLocation.artifactLocation.uri is an absolute http(s) URL (e.g.
// http://172.17.0.1:3000/api/health). GitHub Code Scanning is source-oriented and
// rejects SARIF whose location URIs use a scheme that doesn't match the checkout
// (file://), failing the upload with:
//   "SARIF URI scheme \"http\" did not match the checkout URI scheme \"file\""
//
// We rewrite each absolute http(s) location URI to a repo-relative path (the URL's
// path, e.g. `api/health`), which Code Scanning accepts. The full original URL is
// preserved in artifactLocation.description so no information is lost in the report.
// helpUri / taxonomy / rule URLs are left untouched — only result *locations* matter
// to the checkout-scheme validation.
//
// Usage: node .zap/normalize-sarif.mjs <sarif-file>   (rewrites the file in place)
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node normalize-sarif.mjs <sarif-file>');
  process.exit(1);
}

const sarif = JSON.parse(readFileSync(file, 'utf8'));
let rewritten = 0;

// Reduce an absolute http(s) URL to a repo-relative path: the URL's pathname only,
// with the leading slash stripped. Query string and fragment are intentionally dropped
// — Code Scanning expects a file-like path, not URL components. A bare site root (empty
// pathname) maps to `index` so the URI is non-empty and valid. Non-http(s) or already
// relative URIs return null (left untouched).
function toRelative(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null; // not an absolute URL (already relative, or non-URL) — leave as-is
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/^\/+/, '');
  return path === '' ? 'index' : path;
}

function fixLocation(loc) {
  const al = loc?.physicalLocation?.artifactLocation;
  if (!al || typeof al.uri !== 'string') return;
  const relative = toRelative(al.uri);
  if (relative === null) return;
  // Always preserve the full original URL (incl. query/fragment dropped from the path)
  // in the description, appending to any description ZAP already wrote rather than
  // overwriting or skipping it.
  const note = `ZAP scanned URL: ${al.uri}`;
  const existing = typeof al.description?.text === 'string' ? al.description.text.trim() : '';
  al.description = { text: existing ? `${existing} — ${note}` : note };
  al.uri = relative;
  rewritten++;
}

for (const run of sarif.runs ?? []) {
  for (const res of run.results ?? []) {
    for (const loc of res.locations ?? []) fixLocation(loc);
    for (const loc of res.relatedLocations ?? []) fixLocation(loc);
  }
}

writeFileSync(file, JSON.stringify(sarif, null, 2));
console.log(`normalized ${rewritten} location URI(s) in ${file}`);
