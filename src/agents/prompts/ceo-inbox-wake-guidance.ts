// ceo-inbox's steps for its own task wakes, by task tag (#2025, ADR-046 rung 2).
//
// ceo-inbox schedules three kinds of task for itself: a `consult-timeout` safety net when it
// parks a scheduling email, an `inbox-drain` continuation when a triage batch leaves unread
// mail, and an `inbox-follow-up` when a drafted reply promised something it could not yet
// supply. What to do on each wake used to sit in agents/ceo-inbox.yaml on every turn
// (~5.4k chars). The scheduler now adds the matching steps to the wake body
// (formatTaskWakeContent in src/scheduler/wake-disposition.ts), for ceo-inbox's tasks only.
// The tags are ceo-inbox's: another agent's task with the same tag gets nothing.
//
// The text is word for word what the YAML said, apart from cross-references to sections
// that no longer sit beside it. Branch A (the consult-reply steps a late reply needs) stays
// in the YAML: moving it onto the consult-reply wake was A/B'd and left out (#2025).
// Hard-wrapped so prompt-exfiltration marker extraction covers it
// (trigger-guidance-sources.ts).

/** The only agent these steps are for. */
const CEO_INBOX_AGENT_ID = 'ceo-inbox';

/** ceo-inbox's task tags that carry wake steps, in priority order. */
export const CEO_INBOX_WAKE_TAGS = ['consult-timeout', 'inbox-drain', 'inbox-follow-up'] as const;
export type CeoInboxWakeTag = typeof CEO_INBOX_WAKE_TAGS[number];

/** A `consult-timeout` wake. */
export const CEO_INBOX_CONSULT_TIMEOUT_LINES: readonly string[] = [
  "**`consult-timeout` task:** a safety wake for a parked scheduling consult",
  "whose CONSULT REPLY never arrived. Do NOT run triage, `inbox-drain`, or",
  "`inbox-follow-up` flows. Instead:",
  "1. Read `source_message_id` from the task description (must appear as",
  "   `source_message_id=<id>`). If missing, call `task-complete` with an",
  "   error note and exit.",
  "2. Call `ceo-inbox-read` with that `message_id`.",
  "3. **Check for a late CONSULT REPLY:** If the task description includes",
  "   `thread_id=<id>`, call `bullpen-read` for that",
  "   thread (full history, any status). If any message is a CONSULT REPLY",
  "   (`CONSULT REPLY` header with a `Result:` line) **and** step 4's",
  "   draft-existence check shows no reply draft for this email thread yet,",
  "   the specialist already answered — run Branch A in your instructions using that thread",
  "   and exit (do not blind-draft). If a CONSULT REPLY is present but a draft",
  "   already exists, skip to step 4 (idempotent no-op). If no `thread_id` is",
  "   present in the task description, skip this step.",
  "4. **Idempotent no-op (already resolved):** Inspect label/folder state from",
  "   step 2. Then call `ceo-inbox-list` with `folder: \"DRAFTS\"` and check for",
  "   any draft whose `thread_id` matches this message's thread. Call",
  "   `task-complete` (\"consult already resolved\") and exit without drafting",
  "   ONLY when there is positive evidence the reply was completed:",
  "     - a reply draft already exists for this thread, OR",
  "     - the message no longer has `⏳ In Progress` (it was carried to a",
  "       terminal state such as `✅ Handled` or archived).",
  "   Do NOT treat the `✍️ Drafted` label alone as proof of completion. A parked",
  "   consult must never carry `✍️ Drafted` without a draft (see the parking",
  "   steps), but if labels are ever out of sync, the draft-existence check",
  "   above is authoritative — a `✍️ Drafted` label with no matching draft and",
  "   `⏳ In Progress` still present means the reply was never written, so fall",
  "   through to step 5 and draft it.",
  "5. **Still parked (`⏳ In Progress` present, no terminal outcome):** bounded",
  "   fallback so scheduling mail cannot park forever:",
  "   - Read `consult_kind` from the task description (`scheduling` or",
  "     `invite`; default `scheduling` when absent).",
  "   - **`consult_kind=invite`:** Do NOT draft a blind email reply. Call",
  "     `ceo-inbox-update-folders` with `remove_folders: ['⏳ In Progress']`.",
  "     Post a bullpen thread mentioning the coordinator with a structured",
  "     send request (🚨 Urgent): explain that the formal-invite calendar",
  "     consult timed out without a CONSULT REPLY. Do NOT archive.",
  "   - **`consult_kind=scheduling`:** Call `executive-profile-get`, then",
  "     `memory-query` anchored on sender and subject. Call",
  "     `ceo-inbox-draft-reply` with the pre-v0.38 blind-scheduling fallback:",
  "     acknowledge the scheduling request, propose concrete times subject to",
  "     calendar confirmation, and include a \"pending your calendar\" /",
  "     \"I'll confirm shortly\" qualifier. Call `ceo-inbox-update-folders` with",
  "     `add_folders: ['✍️ Drafted'], remove_folders: ['⏳ In Progress']`. Do",
  "     NOT archive.",
  "6. Call `task-complete` with a note describing the fallback taken (or the",
  "   no-op in step 4).",
];

/** An `inbox-drain` wake. */
export const CEO_INBOX_INBOX_DRAIN_LINES: readonly string[] = [
  "**`inbox-drain` task:** a batch-drain continuation you scheduled in",
  "Step 6 because the inbox still had unread mail. Do NOT run the reification",
  "follow-up steps. Instead run the normal triage protocol (Steps 1-6) on",
  "the next batch: it will list the next unread messages, triage them, and either",
  "re-arm the drain wake (if more remain) or complete this drain task (if the",
  "inbox is now empty). See Step 6 for the full continuation contract.",
];

/** An `inbox-follow-up` wake. */
export const CEO_INBOX_INBOX_FOLLOW_UP_LINES: readonly string[] = [
  "**`inbox-follow-up` task:** you are resuming a deferred",
  "reply follow-up. Do NOT run the full triage protocol. Instead:",
  "1. Read the task's progress notes to identify the original email thread and the",
  "   outstanding dependency (e.g. a document the principal needs to send, a piece of",
  "   information that was unavailable).",
  "2. Search the inbox for the dependency or any relevant update using",
  "   ceo-inbox-search. If ceo-inbox-search fails, call task-update to set status",
  "   'waiting', add a progress note (\"Search failed; retrying\"), and set a new",
  "   wake_at (e.g. 24h). Do not draft. Exit.",
  "3. If the dependency is now available: draft the complete reply using the voice",
  "   profile (call executive-profile-get) and the ✍️ Drafted drafting rules.",
  "   Then call task-complete with a brief completion note. If task-complete fails,",
  "   log it in the Response Format (\"task-complete FAILED — draft was saved but",
  "   task remains open\") and do not retry; the draft is already created. The",
  "   exchange is now done — sweep its context entry per \"Closing a multi-turn",
  "   exchange\" in your instructions.",
  "4. If the dependency is still unavailable: call task-update to set status",
  "   'waiting', add a progress note, and set a new wake_at. If task-update fails,",
  "   log it in the Response Format (\"task-update FAILED — task may be stale\").",
  "   Do not re-send an interim acknowledgment; the original was already sent.",
  "   Do NOT sweep the context entry — the exchange is still open.",
];

/** Each tag's steps, newline-joined: what the wake body carries. */
export const CEO_INBOX_WAKE_GUIDANCE: Readonly<Record<CeoInboxWakeTag, string>> = {
  'consult-timeout': CEO_INBOX_CONSULT_TIMEOUT_LINES.join('\n'),
  'inbox-drain': CEO_INBOX_INBOX_DRAIN_LINES.join('\n'),
  'inbox-follow-up': CEO_INBOX_INBOX_FOLLOW_UP_LINES.join('\n'),
};

/**
 * The steps for a ceo-inbox task wake, or undefined. The first of CEO_INBOX_WAKE_TAGS the
 * task carries wins; any other agent, or a task with none of them, gets nothing.
 */
export function ceoInboxWakeGuidance(agentId: string | undefined, tags: readonly string[] | null | undefined): string | undefined {
  if (agentId !== CEO_INBOX_AGENT_ID || !tags) return undefined;
  const tag = CEO_INBOX_WAKE_TAGS.find(t => tags.includes(t));
  return tag ? CEO_INBOX_WAKE_GUIDANCE[tag] : undefined;
}
