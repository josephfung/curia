# Coordinator per-call context baseline

Standing before/after log for the coordinator context diet (#1954 / #1955).
Append a section after each epic phase. Leave earlier sections in place.

The script is `scripts/report-agent-context.ts`. It is read-only: every statement
is a single `SELECT`, and the CLI sets the session to
`default_transaction_read_only` before running them.

## How to capture

`DATABASE_URL` is already in the app container. Do not use `pnpm run` — that
wrapper expects a `.env` the container does not have.

```bash
ssh -p 2222 <host> 'docker exec curia-curia-1 \
  ./node_modules/.bin/tsx scripts/report-agent-context.ts \
  --agent coordinator --days 30 --format markdown'
```

`<host>` is the office SSH alias (`ceo-office` in `docs/dev/google-drive.md`).
Paste the markdown under Captures. For a later phase, pass `--since` / `--until`
when the window should not be "the 30 days ending now".

## What the numbers are

- **System-string chars** — every `role=system` message in the archived prompt.
  That is the YAML prompt plus the blocks injected on that call. It is not the
  `context.budget` `system_prompt` tier, which is only the assembled system prompt.
- **Tool-definition bytes** — `octet_length` of the stored `tool_definitions`
  jsonb. **Source bytes** sum each tool object. **json-framing** is the array
  punctuation, so on one call the source bytes plus framing equal the total.
  Percentiles do not sum across rows.
- **Source split** — a tool whose name is on disk under `skills/**/tool.json`
  (or is a pinned bundle member) is `local`. When the agent pins exactly one
  MCP server, every other tool is charged to that server. The live membership
  is whatever showed up in `tool_definitions` during the window; MCP tool lists
  are not in the repo.
- **Provider input tokens** — `llm.call` `inputTokens`, `percentile_cont` p50
  and p95. Archive rows and token samples can differ when the archive
  kill-switch was off.
- **Context budget tiers** — estimated tokens of each injected block on the
  samples where it was included, plus how often it was dropped.
- **Pinned tools with zero calls** — local pins expanded from `agents/<name>.yaml`
  the way the runtime expands them, plus MCP tools that were offered in the
  window, minus `tool.invoke` / `skill.invoke` rows for that agent.
- **Modal tool count** — the tool-list size that appears most often (ties break
  toward the smaller count). Later calls in a task grow when `skill-activate`
  adds tools, so this slice is the usual fixed payload.

## Captures

### 2026-10-01 — coordinator baseline, before any #1954 change

This is the baseline the rest of the epic measures against.

**Capture conditions**

- Deployed revision `6f3e6b36` (v0.43.0, the #1965 merge). The app container
  was created at 2026-10-01T21:39Z.
- Run at 2026-10-01T21:43:27Z with
  `--agent coordinator --days 30 --format markdown`.
- Pins: `google-workspace` is the only MCP server. No unresolved pins and no
  missing tools.

**A configuration change inside the window.** The calendar holdback (#1853)
took effect on 2026-09-22. It removed the google-workspace calendar tools from
the coordinator's list. Calls offered 186–187 tools before that date and
exactly 180 after it (66 local + 114 google-workspace). The 30-day p50
therefore mixes two configurations. For example, its p50 of 186 tools and
175,002 google-workspace bytes describe the earlier configuration. Compare
later phases against the **post-holdback** figures below, or against the
"Modal tool count 180" slice of the full report. Their tool figures are
identical. The calendar
tools `create_calendar`, `manage_focus_time` and `manage_out_of_office` appear
under "Pinned tools with zero calls" only because they were offered before
2026-09-22. The coordinator no longer receives them.

The prompt also grew inside the window. The `system_prompt` tier estimate has
a 30-day p50 of 17,625 tokens and a post-holdback p50 of 20,284.

**Post-holdback headline (current configuration)**

Window `2026-09-23T00:00:00Z` ≤ t < `2026-10-01T21:43:27.105Z`, with 1,343
archive rows, 1,343 token samples and 373 `context.budget` events. Every row
has 180 tools. To reproduce it, run with
`--since 2026-09-23T00:00:00Z --until 2026-10-01T21:43:27.105Z`.

| Metric | p50 | p95 |
|---|---:|---:|
| system-string chars | 71,292 | 77,486 |
| tool count | 180 | 180 |
| tool-definition bytes | 225,809 | 226,910 |
| local bytes (66 tools) | 66,652 | 67,753 |
| mcp:google-workspace bytes (114 tools) | 158,797 | 158,797 |
| provider input tokens | 76,239 | 109,430 |
| `system_prompt` tier (est. tokens) | 20,284 | 20,802 |
| `conversation_history` tier when included (est. tokens, 59 of 373) | 8,543 | 15,395 |

google-workspace accounts for about 70% of the tool-definition bytes. In the
30-day window the coordinator called 16 google-workspace tools. Four were
calendar tools, which are now held back. The other 12 come from the 114 still
offered. The local catalog has 22 pinned tools with zero calls.

**Full 30-day report (verbatim script output)**

#### coordinator — window ending 2026-10-01T21:43:27.105Z

Window `2026-09-01T21:43:27.105Z` ≤ t < `2026-10-01T21:43:27.105Z`. Archive rows: 3852. llm.call token samples: 3852. context.budget events: 1169.

MCP servers pinned: `google-workspace`. Unresolved pins: (none). Pinned tools missing on disk: (none).

System-string chars count every `role=system` message in the archived prompt. Tool-definition bytes are `octet_length` of the stored jsonb. A single pinned MCP server owns every tool that is not in the on-disk local catalog. `json-framing` is array punctuation, so source bytes plus framing equal the total on a single call. Percentiles are `percentile_cont` and do not sum across rows.

##### Per-call payload

| Metric | p50 | p95 |
|---|---:|---:|
| system-string chars | 62641 | 73022 |
| tool count | 186 | 187 |
| tool-definition bytes | 235435 | 236286 |
| local bytes | 60859 | 67753 |
| local tools | 66 | 66 |
| mcp:google-workspace bytes | 175002 | 175002 |
| mcp:google-workspace tools | 121 | 121 |
| json-framing bytes | 372 | 374 |

##### Modal tool count 180 (1455 of 3852 calls)

The usual fixed tool list. Later calls in a task grow when `skill-activate` adds tools.

| Metric | p50 | p95 |
|---|---:|---:|
| system-string chars | 71292 | 77375 |
| tool count | 180 | 180 |
| tool-definition bytes | 225809 | 226910 |
| local bytes | 66652 | 67753 |
| local tools | 66 | 66 |
| mcp:google-workspace bytes | 158797 | 158797 |
| mcp:google-workspace tools | 114 | 114 |
| json-framing bytes | 360 | 360 |

##### Latest call

At `2026-10-01T21:00:27.385Z`. System-string chars 71104. Tool count 180. Tool-definition bytes 226910. json-framing 360.

| Source | Tools | Bytes |
|---|---:|---:|
| local | 66 | 67753 |
| mcp:google-workspace | 114 | 158797 |

| Tool | Source | Bytes |
|---|---|---:|
| `batch_update_doc` | mcp:google-workspace | 23180 |
| `manage_contacts_batch` | mcp:google-workspace | 12236 |
| `manage_contact` | mcp:google-workspace | 9025 |
| `web-browser` | local | 6451 |
| `send_gmail_message` | mcp:google-workspace | 4180 |
| `resize_sheet_dimensions` | mcp:google-workspace | 4175 |
| `update_paragraph_style` | mcp:google-workspace | 3737 |
| `list_drive_items` | mcp:google-workspace | 3727 |
| `modify_doc_text` | mcp:google-workspace | 3155 |
| `draft_gmail_message` | mcp:google-workspace | 3124 |
| `manage_drive_access` | mcp:google-workspace | 3119 |
| `email-reply` | local | 3014 |
| `search_drive_files` | mcp:google-workspace | 2993 |
| `email-send` | local | 2973 |
| `memory-store` | local | 2908 |
| `update_drive_file` | mcp:google-workspace | 2902 |
| `manage_conditional_formatting` | mcp:google-workspace | 2605 |
| `task-create` | local | 2286 |
| `inspect_doc_structure` | mcp:google-workspace | 2233 |
| `format_sheet_range` | mcp:google-workspace | 2200 |
| `doc-write` | local | 2171 |
| `create_table_with_data` | mcp:google-workspace | 2087 |
| `search_custom` | mcp:google-workspace | 2029 |
| `list_tasks` | mcp:google-workspace | 1943 |
| `manage_task` | mcp:google-workspace | 1896 |
| `slack-send` | local | 1892 |
| `sms-send` | local | 1837 |
| `import_to_google_sheets` | mcp:google-workspace | 1821 |
| `import_to_google_doc` | mcp:google-workspace | 1819 |
| `signal-send` | local | 1802 |
| `get_doc_as_markdown` | mcp:google-workspace | 1741 |
| `import_to_google_slides` | mcp:google-workspace | 1588 |
| `file-parse` | local | 1581 |
| `config-store` | local | 1573 |
| `generate_trigger_code` | mcp:google-workspace | 1525 |
| `bullpen` | local | 1517 |
| `email-draft-save` | local | 1497 |
| `manage_doc_tab` | mcp:google-workspace | 1464 |
| `debug_table_structure` | mcp:google-workspace | 1449 |
| `set_drive_file_permissions` | mcp:google-workspace | 1446 |
| `secret-capture-request` | local | 1409 |
| `manage_contact_group` | mcp:google-workspace | 1353 |
| `update_doc_headers_footers` | mcp:google-workspace | 1349 |
| `create_drive_file` | mcp:google-workspace | 1347 |
| `task-update` | local | 1316 |
| `get_gmail_thread_content` | mcp:google-workspace | 1254 |
| `get_gmail_attachment_content` | mcp:google-workspace | 1242 |
| `drive-download-file` | local | 1223 |
| `find_and_replace_doc` | mcp:google-workspace | 1207 |
| `move_sheet_rows` | mcp:google-workspace | 1188 |
| `get_drive_file_download_url` | mcp:google-workspace | 1170 |
| `email-download-attachment` | local | 1146 |
| `read_sheet_values` | mcp:google-workspace | 1127 |
| `search_messages` | mcp:google-workspace | 1122 |
| `modify_sheet_values` | mcp:google-workspace | 1087 |
| `memory-query` | local | 1085 |
| `email-list` | local | 1060 |
| `scheduler-create` | local | 1019 |
| `checkpoint` | local | 1017 |
| `insert_doc_elements` | mcp:google-workspace | 1008 |
| `get_gmail_messages_content_batch` | mcp:google-workspace | 1003 |
| `scheduler-update` | local | 984 |
| `manage_gmail_label` | mcp:google-workspace | 957 |
| `get_doc_content` | mcp:google-workspace | 941 |
| `contact-update` | local | 923 |
| `context-bridge-release` | local | 921 |
| `skill-activate` | local | 919 |
| `manage_deployment` | mcp:google-workspace | 901 |
| `batch_update_form` | mcp:google-workspace | 882 |
| `activity-log` | local | 879 |
| `decay-warnings-list` | local | 879 |
| `manage_gmail_filter` | mcp:google-workspace | 878 |
| `plan` | local | 867 |
| `get_gmail_threads_content_batch` | mcp:google-workspace | 854 |
| `send-draft` | local | 845 |
| `create_doc` | mcp:google-workspace | 832 |
| `modify_gmail_message_labels` | mcp:google-workspace | 830 |
| `append_table_rows` | mcp:google-workspace | 825 |
| `search_gmail_messages` | mcp:google-workspace | 822 |
| `task-list` | local | 819 |
| `batch_modify_gmail_message_labels` | mcp:google-workspace | 814 |
| `date-resolve` | local | 806 |
| `check_drive_file_public_access` | mcp:google-workspace | 795 |
| `start_google_auth` | mcp:google-workspace | 791 |
| `get_messages` | mcp:google-workspace | 790 |
| `copy_drive_file` | mcp:google-workspace | 789 |
| `manage_presentation_comment` | mcp:google-workspace | 783 |
| `manage_spreadsheet_comment` | mcp:google-workspace | 776 |
| `manage_document_comment` | mcp:google-workspace | 770 |
| `context-bridge-clear` | local | 761 |
| `get_drive_file_content` | mcp:google-workspace | 759 |
| `delete-relationship` | local | 737 |
| `manage_task_list` | mcp:google-workspace | 735 |
| `delegate` | local | 713 |
| `behavioral-preferences-update` | local | 709 |
| `resolve-learning-digest` | local | 708 |
| `get_gmail_message_content` | mcp:google-workspace | 698 |
| `email-label` | local | 688 |
| `insert_doc_image` | mcp:google-workspace | 684 |
| `create_sheet` | mcp:google-workspace | 673 |
| `list_contacts` | mcp:google-workspace | 663 |
| `scheduler-report` | local | 655 |
| `email-create-folder` | local | 653 |
| `query-relationships` | local | 650 |
| `doc-read` | local | 641 |
| `run_script_function` | mcp:google-workspace | 638 |
| `set_publish_settings` | mcp:google-workspace | 627 |
| `send_message` | mcp:google-workspace | 620 |
| `download_chat_attachment` | mcp:google-workspace | 616 |
| `email-get` | local | 614 |
| `list-user-secrets` | local | 611 |
| `export_doc_to_pdf` | mcp:google-workspace | 604 |
| `image-generate` | local | 593 |
| `doc-search` | local | 592 |
| `tool-registry` | local | 592 |
| `email-archive` | local | 588 |
| `get_page_thumbnail` | mcp:google-workspace | 583 |
| `create_form` | mcp:google-workspace | 579 |
| `create_version` | mcp:google-workspace | 522 |
| `web-search` | local | 518 |
| `list_form_responses` | mcp:google-workspace | 516 |
| `create_drive_folder` | mcp:google-workspace | 511 |
| `get_script_metrics` | mcp:google-workspace | 508 |
| `doc-list` | local | 507 |
| `email-mark-read` | local | 505 |
| `memory-confirm` | local | 504 |
| `email-list-folders` | local | 500 |
| `create_spreadsheet` | mcp:google-workspace | 493 |
| `list_script_projects` | mcp:google-workspace | 492 |
| `scheduler-list` | local | 480 |
| `batch_update_presentation` | mcp:google-workspace | 473 |
| `executive-profile-update` | local | 461 |
| `update_script_content` | mcp:google-workspace | 457 |
| `search_contacts` | mcp:google-workspace | 449 |
| `list_contact_groups` | mcp:google-workspace | 443 |
| `list_task_lists` | mcp:google-workspace | 438 |
| `dismiss-action` | local | 436 |
| `create_reaction` | mcp:google-workspace | 430 |
| `list_script_processes` | mcp:google-workspace | 430 |
| `get_contact_group` | mcp:google-workspace | 424 |
| `list-learning-digest` | local | 424 |
| `get_page` | mcp:google-workspace | 419 |
| `approve-action` | local | 409 |
| `list_spaces` | mcp:google-workspace | 404 |
| `set-autonomy` | local | 404 |
| `list_sheet_tables` | mcp:google-workspace | 402 |
| `task-complete` | local | 401 |
| `create_script_project` | mcp:google-workspace | 399 |
| `get_drive_file_permissions` | mcp:google-workspace | 395 |
| `list_versions` | mcp:google-workspace | 389 |
| `executive-profile-get` | local | 384 |
| `list_presentation_comments` | mcp:google-workspace | 383 |
| `get_version` | mcp:google-workspace | 382 |
| `deny-action` | local | 379 |
| `get_script_content` | mcp:google-workspace | 379 |
| `list_docs_in_folder` | mcp:google-workspace | 379 |
| `list_spreadsheet_comments` | mcp:google-workspace | 379 |
| `get_task` | mcp:google-workspace | 374 |
| `search_docs` | mcp:google-workspace | 374 |
| `list_document_comments` | mcp:google-workspace | 367 |
| `get_form_response` | mcp:google-workspace | 360 |
| `delete_script_project` | mcp:google-workspace | 353 |
| `create_presentation` | mcp:google-workspace | 347 |
| `get_spreadsheet_info` | mcp:google-workspace | 342 |
| `get_drive_shareable_link` | mcp:google-workspace | 340 |
| `list_spreadsheets` | mcp:google-workspace | 339 |
| `get_contact` | mcp:google-workspace | 334 |
| `get_presentation` | mcp:google-workspace | 307 |
| `get-autonomy` | local | 302 |
| `get_script_project` | mcp:google-workspace | 294 |
| `web-fetch` | local | 294 |
| `get_task_list` | mcp:google-workspace | 284 |
| `list_deployments` | mcp:google-workspace | 273 |
| `scheduler-cancel` | local | 269 |
| `list-pending-actions` | local | 243 |
| `get_form` | mcp:google-workspace | 239 |
| `approval-expiry-sweep` | local | 209 |
| `get_search_engine_info` | mcp:google-workspace | 208 |
| `list_gmail_filters` | mcp:google-workspace | 207 |
| `list_gmail_labels` | mcp:google-workspace | 194 |

##### Provider input tokens

n=3852, p50 77517, p95 96908.5.

##### Context budget tiers

Estimated tokens of each injected block on the samples where it was included.

| Tier | Samples | Included | p50 | p95 | Dropped (budget / empty / other) |
|---|---:|---:|---:|---:|---|
| system_prompt | 1169 | 1169 | 17625 | 20411 | 0 / 0 / 0 |
| user_message | 1169 | 1169 | 154 | 1575.8 | 0 / 0 / 0 |
| sender_context | 164 | 164 | 696 | 710 | 0 / 0 / 0 |
| bullpen | 1169 | 91 | 475 | 1185.5 | 0 / 1078 / 0 |
| resolved_entities | 409 | 21 | 165 | 171 | 0 / 388 / 0 |
| contact_recent_history | 51 | 39 | 1310 | 1496.5 | 0 / 12 / 0 |
| conversation_history | 1169 | 139 | 4115 | 15218.1 | 0 / 1030 / 0 |

##### Tool invocations

| Tool | Calls | Pinned | Source |
|---|---:|---|---|
| `scheduler-report` | 905 | yes | local |
| `approval-expiry-sweep` | 713 | yes | local |
| `delegate` | 241 | yes | local |
| `task-list` | 159 | yes | local |
| `activity-log` | 122 | yes | local |
| `bullpen` | 118 | yes | local |
| `date-resolve` | 103 | yes | local |
| `signal-send` | 96 | yes | local |
| `get_events` | 76 | yes | mcp:google-workspace |
| `list-pending-actions` | 68 | yes | local |
| `memory-query` | 66 | yes | local |
| `email-send` | 62 | yes | local |
| `context-bridge-release` | 60 | yes | local |
| `doc-read` | 53 | yes | local |
| `web-search` | 49 | yes | local |
| `doc-search` | 36 | yes | local |
| `list-learning-digest` | 35 | yes | local |
| `web-fetch` | 34 | yes | local |
| `doc-write` | 33 | yes | local |
| `email-list` | 32 | yes | local |
| `list_calendars` | 30 | yes | mcp:google-workspace |
| `web-browser` | 30 | yes | local |
| `email-get` | 28 | yes | local |
| `manage_event` | 28 | yes | mcp:google-workspace |
| `task-create` | 28 | yes | local |
| `config-store` | 16 | yes | local |
| `memory-store` | 16 | yes | local |
| `task-complete` | 16 | yes | local |
| `task-update` | 12 | yes | local |
| `doc-list` | 11 | yes | local |
| `query_freebusy` | 10 | yes | mcp:google-workspace |
| `email-download-attachment` | 9 | yes | local |
| `file-parse` | 8 | yes | local |
| `get_doc_as_markdown` | 8 | yes | mcp:google-workspace |
| `email-archive` | 7 | yes | local |
| `get_drive_file_permissions` | 7 | yes | mcp:google-workspace |
| `resolve-learning-digest` | 7 | yes | local |
| `scheduler-list` | 7 | yes | local |
| `email-reply` | 6 | yes | local |
| `update_drive_file` | 6 | yes | mcp:google-workspace |
| `dismiss-action` | 4 | yes | local |
| `doc-place` | 4 | yes | local |
| `manage_drive_access` | 4 | yes | mcp:google-workspace |
| `search_drive_files` | 4 | yes | mcp:google-workspace |
| `get_gmail_message_content` | 3 | yes | mcp:google-workspace |
| `inspect_doc_structure` | 3 | yes | mcp:google-workspace |
| `search_gmail_messages` | 3 | yes | mcp:google-workspace |
| `tool-registry` | 3 | yes | local |
| `list-user-secrets` | 2 | yes | local |
| `scheduler-update` | 2 | yes | local |
| `approve-action` | 1 | yes | local |
| `batch_update_doc` | 1 | yes | mcp:google-workspace |
| `email-mark-read` | 1 | yes | local |
| `entity-context` | 1 | no | local |
| `executive-profile-get` | 1 | yes | local |
| `get_doc_content` | 1 | yes | mcp:google-workspace |
| `get_gmail_thread_content` | 1 | yes | mcp:google-workspace |
| `list_docs_in_folder` | 1 | yes | mcp:google-workspace |
| `query-relationships` | 1 | yes | local |
| `scheduler-create` | 1 | yes | local |
| `secret-capture-request` | 1 | yes | local |

##### Pinned tools with zero calls

- `behavioral-preferences-update` (local)
- `checkpoint` (local)
- `contact-update` (local)
- `context-bridge-clear` (local)
- `decay-warnings-list` (local)
- `delete-relationship` (local)
- `deny-action` (local)
- `drive-download-file` (local)
- `email-create-folder` (local)
- `email-draft-save` (local)
- `email-label` (local)
- `email-list-folders` (local)
- `executive-profile-update` (local)
- `get-autonomy` (local)
- `image-generate` (local)
- `memory-confirm` (local)
- `plan` (local)
- `scheduler-cancel` (local)
- `send-draft` (local)
- `set-autonomy` (local)
- `slack-send` (local)
- `sms-send` (local)
- `append_table_rows` (mcp:google-workspace)
- `batch_modify_gmail_message_labels` (mcp:google-workspace)
- `batch_update_form` (mcp:google-workspace)
- `batch_update_presentation` (mcp:google-workspace)
- `check_drive_file_public_access` (mcp:google-workspace)
- `copy_drive_file` (mcp:google-workspace)
- `create_calendar` (mcp:google-workspace)
- `create_doc` (mcp:google-workspace)
- `create_drive_file` (mcp:google-workspace)
- `create_drive_folder` (mcp:google-workspace)
- `create_form` (mcp:google-workspace)
- `create_presentation` (mcp:google-workspace)
- `create_reaction` (mcp:google-workspace)
- `create_script_project` (mcp:google-workspace)
- `create_sheet` (mcp:google-workspace)
- `create_spreadsheet` (mcp:google-workspace)
- `create_table_with_data` (mcp:google-workspace)
- `create_version` (mcp:google-workspace)
- `debug_table_structure` (mcp:google-workspace)
- `delete_script_project` (mcp:google-workspace)
- `download_chat_attachment` (mcp:google-workspace)
- `draft_gmail_message` (mcp:google-workspace)
- `export_doc_to_pdf` (mcp:google-workspace)
- `find_and_replace_doc` (mcp:google-workspace)
- `format_sheet_range` (mcp:google-workspace)
- `generate_trigger_code` (mcp:google-workspace)
- `get_contact` (mcp:google-workspace)
- `get_contact_group` (mcp:google-workspace)
- `get_drive_file_content` (mcp:google-workspace)
- `get_drive_file_download_url` (mcp:google-workspace)
- `get_drive_shareable_link` (mcp:google-workspace)
- `get_form` (mcp:google-workspace)
- `get_form_response` (mcp:google-workspace)
- `get_gmail_attachment_content` (mcp:google-workspace)
- `get_gmail_messages_content_batch` (mcp:google-workspace)
- `get_gmail_threads_content_batch` (mcp:google-workspace)
- `get_messages` (mcp:google-workspace)
- `get_page` (mcp:google-workspace)
- `get_page_thumbnail` (mcp:google-workspace)
- `get_presentation` (mcp:google-workspace)
- `get_script_content` (mcp:google-workspace)
- `get_script_metrics` (mcp:google-workspace)
- `get_script_project` (mcp:google-workspace)
- `get_search_engine_info` (mcp:google-workspace)
- `get_spreadsheet_info` (mcp:google-workspace)
- `get_task` (mcp:google-workspace)
- `get_task_list` (mcp:google-workspace)
- `get_version` (mcp:google-workspace)
- `import_to_google_doc` (mcp:google-workspace)
- `import_to_google_sheets` (mcp:google-workspace)
- `import_to_google_slides` (mcp:google-workspace)
- `insert_doc_elements` (mcp:google-workspace)
- `insert_doc_image` (mcp:google-workspace)
- `list_contact_groups` (mcp:google-workspace)
- `list_contacts` (mcp:google-workspace)
- `list_deployments` (mcp:google-workspace)
- `list_document_comments` (mcp:google-workspace)
- `list_drive_items` (mcp:google-workspace)
- `list_form_responses` (mcp:google-workspace)
- `list_gmail_filters` (mcp:google-workspace)
- `list_gmail_labels` (mcp:google-workspace)
- `list_presentation_comments` (mcp:google-workspace)
- `list_script_processes` (mcp:google-workspace)
- `list_script_projects` (mcp:google-workspace)
- `list_sheet_tables` (mcp:google-workspace)
- `list_spaces` (mcp:google-workspace)
- `list_spreadsheet_comments` (mcp:google-workspace)
- `list_spreadsheets` (mcp:google-workspace)
- `list_task_lists` (mcp:google-workspace)
- `list_tasks` (mcp:google-workspace)
- `list_versions` (mcp:google-workspace)
- `manage_conditional_formatting` (mcp:google-workspace)
- `manage_contact` (mcp:google-workspace)
- `manage_contact_group` (mcp:google-workspace)
- `manage_contacts_batch` (mcp:google-workspace)
- `manage_deployment` (mcp:google-workspace)
- `manage_doc_tab` (mcp:google-workspace)
- `manage_document_comment` (mcp:google-workspace)
- `manage_focus_time` (mcp:google-workspace)
- `manage_gmail_filter` (mcp:google-workspace)
- `manage_gmail_label` (mcp:google-workspace)
- `manage_out_of_office` (mcp:google-workspace)
- `manage_presentation_comment` (mcp:google-workspace)
- `manage_spreadsheet_comment` (mcp:google-workspace)
- `manage_task` (mcp:google-workspace)
- `manage_task_list` (mcp:google-workspace)
- `modify_doc_text` (mcp:google-workspace)
- `modify_gmail_message_labels` (mcp:google-workspace)
- `modify_sheet_values` (mcp:google-workspace)
- `move_sheet_rows` (mcp:google-workspace)
- `read_sheet_values` (mcp:google-workspace)
- `resize_sheet_dimensions` (mcp:google-workspace)
- `run_script_function` (mcp:google-workspace)
- `search_contacts` (mcp:google-workspace)
- `search_custom` (mcp:google-workspace)
- `search_docs` (mcp:google-workspace)
- `search_messages` (mcp:google-workspace)
- `send_gmail_message` (mcp:google-workspace)
- `send_message` (mcp:google-workspace)
- `set_drive_file_permissions` (mcp:google-workspace)
- `set_publish_settings` (mcp:google-workspace)
- `start_google_auth` (mcp:google-workspace)
- `update_doc_headers_footers` (mcp:google-workspace)
- `update_paragraph_style` (mcp:google-workspace)
- `update_script_content` (mcp:google-workspace)
