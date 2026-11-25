# Drive files: write Docs, move, rename, share, upload, attach, export

How to call the Google Drive tools for the jobs their own descriptions don't
spell out. The tools come from the upstream workspace-mcp server, so these notes
live here instead of in their descriptions.

## Write a Google Doc

Google Docs take rich text, not Markdown. `create_doc`, `modify_doc_text`,
`batch_update_doc` and `find_and_replace_doc` insert text exactly as given, so
Markdown passed to them shows up as literal `#`, `**` and `- `. Never put
Markdown syntax in them.

- **A Doc for the principal to read or review:** write it as a Curia document
  with `doc-write`, then call `doc-publish-google` with its path. The Doc comes
  out formatted, and the document stays the master copy. To update the Doc,
  change the document and publish again. If the principal edited or commented
  on the Doc since, the publish is refused: read the Doc back (below), fold the
  changes into the document, then publish again with the `doc_version` the
  refusal names. A new Doc lands in Curia's My Drive; move it into a folder
  with `update_drive_file`. `doc-publish-google` is not pinned; find it with
  `tool-registry` if it is not in your tool list.
- **Throwaway Markdown with no Curia document:** `import_to_google_doc` with
  `content` and `source_format: "md"`.
- **A formatted section added to an existing Doc:** `manage_doc_tab` with
  `action: "populate_from_markdown"`, `replace_existing: false`, and the tab ID
  from `inspect_doc_structure`. It does not render tables; add one with
  `create_table_with_data`.
- **A small fix (a word or a sentence):** `modify_doc_text` or
  `find_and_replace_doc`, plain text only.
- **Reading a Doc back into Curia:** `get_doc_as_markdown`, never
  `get_doc_content` or a plain-text export, which drop the formatting. Write
  the text back with `doc-write`, keeping the document's frontmatter.

Share the Doc afterwards as below; a new Doc is shared with no one.

## Move or rename a file

Use `update_drive_file`.

- **Move into a folder:** set `add_parents` to the destination folder ID and
  `remove_parents` to the current parent folder ID. Find the current parent first
  with `list_drive_items` or `search_drive_files`.
- **Rename:** set its `name` field.

## Share a file

Use `manage_drive_access` with `action: "grant"`.

- **The principal** always gets `writer`. A file shared with them is theirs to
  work on. A grant to the principal's address is raised to `writer` regardless.
- **Anyone else** gets the role that fits the content and the situation:
  `reader` for something they only need to see, `commenter` when they are asked
  for feedback, `writer` when they will work on it. When it is unclear what
  someone should be able to do with a sensitive file, ask the principal.

## Upload an email attachment to Drive

1. Download it with `email-download-attachment`.
2. Call `create_drive_file` with:
   - `fileUrl`: the download result's `temp_file_url` (a `file://` URL)
   - `file_name`: the attachment's original `filename`
   - `mime_type`: the download's `content_type`
   - `folder_id`: optional, the destination folder

Never pass the base64 bytes as `content`. That writes a corrupted file. Binary
uploads always go through `fileUrl`.

Temp files live only a few minutes. If `temp_file_url` is missing, or the upload
fails with a file-not-found error on it (the temp file expired), tell the
principal the attachment could not be saved and ask them to re-send the email.
Do not retry without a fresh download. On any other failure (quota, auth,
permissions), report the error. Never claim the upload worked.

## Attach a Drive file to an email

Download it with `drive-download-file`, then pass its `temp_file_url` as an
attachment's `file_url` on `email-send` or `email-reply`. Do not use
`get_drive_file_content` for this: it returns text only and is not binary-safe.
`drive-download-file` is not pinned; find it with `tool-registry` if it is not
in your tool list.

## Exporting knowledge-graph data to Drive or Sheets

`create_drive_file`, `append_table_rows` and `create_sheet` are bulk exports.
When the principal hasn't said which records to include, ask before exporting
everything that matches. The export gate counts discrete items and works out
their sensitivity from knowledge-graph node IDs. When the data comes from the
knowledge graph, pass `export_items` with one `{node_id, label}` per
confidential-or-higher row or file. Without node IDs the gate treats every item
as `internal`, so confidential thresholds never fire.
