# doc-publish-google live spike (#2758)

Run 2026-11-26 against Curia's own Google account (workspace-mcp's token file, the
production code path through `getDriveClient`). `run.ts` probes Drive directly;
`handler-e2e.ts` drives the real handler with an in-memory document store. Each run
deletes its Doc.

## Conversion (`run.ts`, fixture.md)

Drive lists `text/markdown` → `application/vnd.google-apps.document` in
`about.importFormats`, and the upload converts:

| Fixture construct | In the Doc |
| --- | --- |
| `#`, `##`, `###` | HEADING_1, HEADING_2, HEADING_3 |
| Ordered and unordered lists, nested a level | bullets, nesting level 0 and 1 |
| `**bold**`, `*italic*`, `~~strike~~`, links | bold, italic, strikethrough, link runs |
| Inline code, fenced code block | Roboto Mono runs |
| Pipe table | a 3×3 table |
| Block quote, horizontal rule | kept (round-trip below) |

Nothing in the fixture came through as literal Markdown syntax.

## Round trip

Exporting the new Doc as `text/markdown` and diffing against the fixture: the only
differences are two trailing spaces on list items and `:----` alignment markers in
the table's separator row. No content is lost.

## Change detection: `modifiedTime` fails, the export hash works

| Event | Drive `modifiedTime` | Hash of the Markdown export |
| --- | --- | --- |
| ~1.5 s after create, no edit | moved | unchanged |
| Drive comment added | unchanged | unchanged |
| Shared, then unshared | moved each time | unchanged |
| Text edit through the Docs API | **unchanged, still 5 s later** | changed at once |
| Style-only edit (bold) | unchanged | changed at once |

`modifiedTime` would refuse clean republishes after any share and miss real edits,
so the guard compares a hash of the export instead (`content_hash` in the record,
also the `doc_version` a refusal names).

## Republish

`files.update` with `text/markdown` media keeps the file a Google Doc and replaces
its content. A Drive comment open at the time is not deleted.

## Handler end to end (`handler-e2e.ts`)

1. First publish: `created`.
2. Publish again, Doc unchanged: `updated`.
3. Publish after a share and unshare: `updated`.
4. Publish after a principal edit: refused ("it was edited"), naming `doc_version`.
5. Publish with that `doc_version` after folding the edit in: `updated`.
