# Coordinator prompt: policy / reference split (#958)

Follow-up to #957. #957 parked tool-specific mechanics in a bottom **`## Reference`**
region of `agents/coordinator.yaml`. This change relocates those mechanics out of the
prompt — into the relevant **local** skill manifests where the model already sees the
text — so the coordinator prompt is pure operating policy and the Reference region is
removed.

## Constraint discovered during design

- Skill `description` and `inputs` text **is** surfaced verbatim to the model as the tool
  schema (`src/skills/registry.ts` `toToolDefinitions` → `anthropic.ts`). So moving prose
  into a local manifest keeps it visible. Confirmed end-to-end.
- **MCP tools have no local description override** (`src/skills/mcp-loader.ts:308` takes the
  server's description as-is). `create_drive_file` is an MCP tool (`google-workspace`
  server) — its Drive-upload how-to **cannot** move into a manifest.

## Decisions (confirmed with Joseph)

1. **Drive-upload mechanics** → keep a **condensed** version in the prompt's Google
   Workspace policy section (target tool is MCP-only; no manifest can hold it). The
   `## Reference` heading is still removed.
2. **Account-identity general rule** and **cold-compose address resolution** are operating
   *policy*, not per-tool how-to → relocate them out of Reference into their policy sections
   (account-identity → a small `### Account identity` subsection under "What I Do Directly";
   cold-compose → the existing "CEO inbox requests" section). They stay in the prompt.

## Reference subsection → destination map

| Reference subsection | Destination |
|---|---|
| config-store namespaces (company, meeting_links, travel_preferences, loyalty_programs) | `config-store` skill.json `description` |
| context_bridge shape (example JSON) | `email-reply` / `email-send` / `signal-send` `context_bridge` input description |
| Decay-warning nudge phrasings (by `reason`) | `decay-warnings-list` skill.json `description` |
| Account identity — general "default to yourself" | prompt: new `### Account identity` policy subsection |
| Account identity — email-skill account param exception | prompt: already covered by the email `account` input descriptions + CEO-inbox-delegate rule in the "CEO inbox requests" section; inline a one-line default in the Email section |
| CEO-inbox cold-compose address resolution | prompt: "CEO inbox requests" section (inline) |
| Uploading attachments to Drive | prompt: condensed into Google Workspace section (MCP target — decision 1) |

After all moves, delete the `## Reference` heading and fix the in-prompt pointers that
said "… are in Reference".

## Blast radius

- `config-store` is pinned by **coordinator, ceo-inbox, meeting-debrief**. Adding the
  namespace catalog to its description is additive/informational for the other two; they
  only use namespaces relevant to their work. Spot-check their behavior is unaffected.
- `email-draft-save` is pinned by coordinator + meeting-debrief; we are **not** changing its
  description (only adding context_bridge examples to email-reply/email-send/signal-send,
  which are coordinator-only).
- All other edited skills are coordinator-only.

## Versioning (patch — description/prompt clarification, behavior-preserving)

- `config-store` 1.0.0 → 1.0.1
- `email-reply` 1.3.0 → 1.3.1
- `email-send` 1.2.0 → 1.2.1
- `signal-send` 1.1.0 → 1.1.1
- `decay-warnings-list` 1.0.0 → 1.0.1
- `coordinator.yaml` 0.8.0 → 0.8.1

## Validation

- `pnpm run typecheck`
- Startup validator test (loads every manifest — catches malformed JSON / schema breaks)
- config-store / email / decay / signal handler tests
- Grep the coordinator prompt: no "in Reference" pointers remain; no `## Reference` heading.
- CHANGELOG `[Unreleased]` updated.
