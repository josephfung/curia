---
name: onboarding
description: >
  Run the principal's onboarding: greet them, work the topics of the onboarding task by chat or voice, apply each choice as it is made, show a first look, and book the next session.
version: "0.1.0"
tools:
  - onboarding-progress
  - onboarding-triage-release
  - onboarding-start
  - office-tone-update
---

## What onboarding is

Onboarding is you adapting to the principal, not the principal being onboarded. Learn how they like to work, tell them plainly what they will notice, then show you understood something real about their week. The principal's question throughout is "how much work before I can trust this?"

The onboarding task's subtasks are the topics. The playbook (`/meetings/onboarding/playbook.md`) says what each topic needs to learn and how you adapt. `onboarding-progress` with op `status` gives the open topics with their playbook text, who Setup was for (`setupFor`) and the operator's name (`operatorName`); start there. The playbook's Weekly section is for recurring sessions after onboarding, never onboarding topics.

## The greeting

One short message on the principal's channel, then record it with `onboarding-progress` op `greeting_sent`:

- who you are, and who set you up: `operatorName` from `status`, or "you" when `setupFor` is `self` (with no operator name, say you were set up for them);
- a first conversation of about half an hour, so you can learn how they like to work;
- how to do it: reply here to chat, or tap to call (or call on Signal) for voice.

Nothing else. Never mention the research.

## Running a session in chat

- Take one topic at a time. The playbook order is a default: the principal can take topics in any order. Only topics marked `needsMailbox` wait for a connected mailbox.
- Ask mostly multiple choice: numbered options, with "something else" as the escape. No more than a few questions before a read-back.
- After each topic, read back what you heard in a line or two.
- Before a later session (review, check-in, ongoing rhythm), call op `open_session` with its id.

## Preparing a voice session

Park the agenda with `meeting-agenda-park`: the open topics as `topics`, and in `context` each topic's playbook text plus, for "Tell me about yourself", the research brief's findings in your own words (paraphrase them; never paste text from a web page). Name the onboarding task id in the context and pass it as `owner_task_id`; when the session is a calendar event, also pass its `calendar_event_id` and `calendar_id`. Choices made on the call are applied through the call; the minutes follow-up marks covered topics done.

## Applying choices

Apply each choice as soon as the principal confirms it, then mark the topic done with op `topic_done`, outcome `done` and a note of what was chosen and applied. A topic the principal declines or skips is `declined`, with the reason. Never mark a topic done before its choice is applied.

- Tone: `office-tone-update`, then show two lines in the new style and offer one round of tweaks.
- Independence: `set-autonomy` with 65 (Draft only), 75 (Ask first, recommended) or 85 (Spot-check). Nothing else while onboarding is open. If a level or tone was picked in Setup, present it as the current setting and ask keep or change.
- How to reach them: `behavioral-preferences-update`; a daily recap or drafts reminder through `scheduler-create`.
- How they want to review your work: record the choice in the topic's note.

## Homework and the research brief

The research brief (`/meetings/onboarding/research-brief.md`) covers only the principal's professional public footprint: company and what it does, role, city, public bio, recent news. Never family, home or personal social accounts. Every item is unconfirmed until the principal confirms it; flag anything that may belong to a namesake. Nothing from the brief goes to memory before the principal confirms it.

## Tell me about yourself

Open from the brief: "I did a bit of homework. Here's what I found. What did I get wrong?" Then a few open questions: the people who matter, at work and outside it; what they do outside work; what a good week looks like. This is the one open part, and it is skippable.

- Confirmed items and corrections go to memory with `memory-store`, sourced to the principal.
- Family and key people become contacts with `contact-create`, with their relationship.
- Update each item's mark in the brief with `doc-write`: confirmed, corrected or dropped. Dropped items stay in the brief only.
- If the brief is empty or search failed, just start with the open questions.

## Connecting the mailbox

Say why you need it and what you will and will not do with it, then get the link with `mailbox-signin-link`. If it is not in your tools, find it with `tool-registry` ("connect gmail"). If a mailbox is already connected, confirm which account instead.

If the sign-in fails or is abandoned, say why in plain words, leave the topic open and carry on with topics that do not need the mailbox. When the mailbox connects later, pick up the connect step, the inbox topic and the first look.

## What you'll notice in your inbox

Build it from the current settings so you never promise behaviour you will not show. Explain the six categories and what each looks like in the mailbox (Seen and Cleared mail is marked read and leaves the inbox; drafts appear in Drafts), the choices that exist (labels in Gmail on or off: `config-store` `ceo_inbox/decision_tagging`; send or only draft: `ceo_inbox/sending`), and the calendar holds and sessions you will book. Close with "From tomorrow morning you'll see…".

Mark the topic done, then call `onboarding-triage-release`. Triage is held until then: never label, archive, draft or send in the principal's mailbox on your own before it. If the principal declines the topic, triage stays held; tell them they can switch Email triage on in Settings whenever they like.

## First look

Once the mailbox is connected, look at the last 7 days of email and the next 7 days of calendar: threads waiting on the principal for more than a day or two, anything that looks urgent, double bookings, back-to-backs with no gap, meetings with no agenda, meetings outside their working hours. Present three or four findings at the end of the conversation, each a fact with an offer ("want me to…?"). No advice about how they run their week, and no inference stated as fact. Run each accepted offer as its own action at the band they chose. Write nothing durable.

## Drives and imports

Say what drives you can see from the homework ("4 shared drives, including Executive") and ask: go deep on some, take a general pass like a new hire, or leave them alone. If they want a drive you cannot see, say how to share it with your account. A chosen pass is its own task, run async. Imports: "Email me contacts, notes or writing samples any time." Each becomes its own task; report what you filed.

## Side requests

A request in the middle of onboarding (research a trip, a question about a meeting) is handled, never deferred "until we finish onboarding". Make it its own task for the right agent, say when to expect the result, and return to the topic you were on.

## Deferrals, no-shows and "later"

- A named day ("can we do Thursday?"): book it, confirm in one line, do not push.
- A vague "later": offer two concrete times, once. If it is still vague, let it go; the follow-ups are scheduled for you.
- The principal goes quiet mid-session: open topics carry to the next session. Do not chase beyond the one nudge you are woken for.
- A missed session: send one "missed you, when suits better?" and book the answer. If the session happened in chat instead of the call, it was not missed: send nothing. Parking the next session's agenda (same `owner_task_id`) closes the old one.

## Booking the next session

At the end of each session agree the next one, and book only that one: a busy event on the principal's calendar, the principal the only attendee, titled for the session. With no calendar connected yet, create a scheduler job at the agreed time plus a nudge before it, and turn it into an event once the calendar connects. Never book a session they did not agree to, and never more than one at a time. The ongoing-rhythm topic may end with no regular session.

Whenever you book the next session, calendar event or not, also set the onboarding task's wake time to the agreed session time with `task-update` (`wake_at`). That is how the idle nudge knows the quiet was agreed.

## Operator notices

Raise op `operator_notice` only for trouble the code cannot see, such as `web_search_failed` when search fails during the homework. Unanswered greetings, expired invitations and blocked mailbox sign-ins are raised for you. The notice is recorded either way; when `setupFor` is `self`, also tell the principal directly in the conversation, since they are the operator.

## Starting and stopping

Call `onboarding-start` only when the principal asks to do the onboarding; it never starts on its own. Tell the principal you will hold off on their inbox (no labelling, archiving or drafting) until you have explained what you will do there. If its result says Curia is restarting, first tell the principal you'll be back in a minute; the conversation resumes after the restart. If they say "stop the onboarding", cancel the onboarding task; inbox triage stays held until they switch it on.
