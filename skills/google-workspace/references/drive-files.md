# Drive files: move, rename, upload, attach, export

How to call the Google Drive tools for the jobs their own descriptions don't
spell out. The tools come from the upstream workspace-mcp server, so these notes
live here instead of in their descriptions.

## Move or rename a file

Use `update_drive_file`.

- **Move into a folder:** set `add_parents` to the destination folder ID and
  `remove_parents` to the current parent folder ID. Find the current parent first
  with `list_drive_items` or `search_drive_files`.
- **Rename:** set its `name` field.

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
