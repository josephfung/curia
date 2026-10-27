# Ant Farm as a video call

**Status:** design, not started. Tracked in #2127.
**Decision:** replace the Phaser pixel-art office with a video-call view. Agents are the participants. The principal and third parties appear in a chat panel that can be toggled. The scheduler shows as a system banner. Specialists that have been quiet for a while mute, play a low-key idle animation, and then turn their camera off into a thumbnail strip. The directive contract, the Conductor and the timeline and stream routes stay. Only the renderer and a few directive fields change.

## Context

Ant Farm (spec 21) replays `audit_log` as an animated office. It works, but the renderer is the expensive part:

- `OfficeScene.ts` is 1,194 lines of Phaser 4. Most of it is chained tween callbacks: the claw delivery alone nests about six deep.
- Phaser's boot sequence has caused a startup race (#1549) and two CSP bugs (it needs `data:` and `blob:` in `img-src`).
- The LimeZu art is all-or-nothing. If one sheet fails to load, the whole office drops to placeholders. The claw, the tubes and the scheduler machine have no pack art and stay procedural.
- Refining the look means editing sprite sheets or tween chains.

[agent-standup](https://github.com/Atoll92/agent-standup) (MIT) shows a lighter way to make the same thing legible: replay an agent session as a video call. It uses no graphics library. Characters are SVG generated from a hash of the agent id. CSS keyframes animate them. One timer drives the mouth from the audio level. Sound is synthesised with Web Audio. The call metaphor also scales better than a floor plan: a call is used to many participants, only one of whom is talking.

### What Ant Farm shows today for messages and the scheduler

- `inbound.message` maps to `tube.in`, which keeps only `conversationId` and `channelId`. The bus payload's `senderId` and `content` are dropped. The particle always flies to the coordinator's desk, which is correct: every inbound message goes to the coordinator.
- `outbound.message` and `outbound.delivered` map to `tube.out`, which keeps `agentId` but drops `content`.
- `schedule.fired` maps to `claw.deliver` with `jobId`, `agentId` and `taskId`. The event carries no human label, so the card the claw drops is anonymous. The other `schedule.*` events are not mapped.

## Design

### 1. Stage: agents only

The stage is a grid of call tiles, one per agent. Each tile is an inline SVG: a background scene, the character, and a desk strip.

- **Characters come from the agent id.** A stable hash picks a body shape, eyes, accessory, colours, background scene and desk prop (agent-standup's `persona0` and `avatarSVG` are the reference). No art assets are loaded, so nothing has to degrade and Phaser's CSP additions go away.
- **The coordinator is the host.** It starts in the spotlight and never turns its camera off.
- **The speaker gets the spotlight.** The spotlight tile spans several grid cells and keeps the floor until someone else speaks.
- **Animation is CSS.** State is a class on the tile (`speaking`, `working`, `muted`, `camera-off`). Idle motion is keyframes on SVG groups: a slow bob, blinks, a talk pulse while speaking. One-off effects use the Web Animations API: a 📨 flying between tiles when work is delegated, a ✅ when results come back.
- **`prefers-reduced-motion`** turns idle and ambient animation off and keeps state changes as static styling.

### 2. Chat panel: the principal and third parties

People outside the agent team do not get tiles. Their messages go to a chat panel that the viewer can open and close, like the chat in a video client.

- Every inbound message goes to the coordinator, so the panel is a live thread between the coordinator and the outside world. It reads like a host taking questions from a live-stream audience.
- Inbound messages show the sender's display name, a channel icon (Signal, email, Slack, and so on) and the content. Outbound messages show as the coordinator's, with the channel icon and the content.
- When the panel is closed, a badge counts unread messages.
- The coordinator's tile shows a status line tied to the chat (see [Coordinator chat status](#4-coordinator-chat-status)).
- **A "names only" mode** hides message content and keeps the sender, channel and time. It is for screen-sharing and demos. It is a preference for each viewer, kept in `localStorage`, and the default shows content.
- Content is rendered as text, never as HTML: third-party email is untrusted input. Long messages are truncated in the panel and can be expanded.

### 3. Scheduler: a system banner

The scheduler is infrastructure, not a colleague, so it gets no tile. When a job fires, a banner in the style of "X joined the meeting" appears at the top of the stage, for example *⏰ Scheduled: morning briefing → Coordinator*. A 📨 then flies from the banner to the target tile, and that tile wakes up (see section 5).

The label comes from the job's `taskTitle` when the job is linked to a task (`JobRow.taskTitle`). Otherwise it comes from a short summary of `taskPayload`, falling back to "Scheduled job". `schedule.created`, `.suspended`, `.recovered` and `.drift_paused` stay unmapped.

### 4. Coordinator chat status

The coordinator's tile shows a status line derived from chat directives:

| Status | Shown from | Until |
|---|---|---|
| *reading chat…* | a `tube.in` | the coordinator's next directive of any kind |
| *typing in chat…* | the coordinator's first directive after an unanswered `tube.in` | a `tube.out` for that conversation |

"Unanswered" is tracked per `conversationId`: a `tube.in` opens the conversation and a `tube.out` closes it. A conversation that never gets a reply, such as a message that needs no answer, closes after the idle timeout. That way the status cannot stick.

While the coordinator is speaking (delegating), the speaking state takes priority over the chat status.

### 5. Presence: timeout-based, no "done" event

Agents do not reliably signal that they are finished. They just stop. `agent.response` marks the end of a runtime turn, not the end of a piece of work. So presence is based only on time since an agent's last directive:

| State | Condition | Looks like |
|---|---|---|
| Speaking | `agent.speak` is playing | spotlight, caption, mouth moving, optional babble |
| Working | a tool is running (`agent.think` start with no matching stop), or a tool ran within the last W seconds | laptop open, hands typing, tool chip on the tile |
| Present | any directive within the last N minutes | full-size tile, mic on, at rest |
| Muted / idle | no directive for N minutes | mic-muted icon, slightly dimmed, ambient idle animation |
| Camera off | no directive for M minutes | avatar on a plain background, moved to the thumbnail strip |

Starting values: W = 20 s, N = 2 min, M = 10 min. Tune them on real data.

- **Time is the playhead's logical time, never the wall clock.** Presence is a pure function of (directives, playhead), so scrubbing, pausing and 8× replay show the same states a live viewer saw. The Conductor already exposes the playhead.
- **A `think` start with no matching stop counts as working for at most M minutes.** A lost `tool.result` cannot leave an agent typing forever.
- **Agents with no directive in the loaded window** start in the thumbnail strip.
- **Any directive** for an agent, including being the target of a delegation or a scheduler delivery, brings it back to Present at full size.

**Idle animations must never look like work.** No typing and no reading a screen, because viewers would take that for activity. Use off-duty activities: sipping from a steaming mug, dozing with a drifting "zzz", reading a paper book, watering the desk plant, stretching, looking out of the window. Each agent's idle activity is picked from its hash, so the choice stays stable across replays. Animations are slow and small so they do not pull attention from the speaker.

### 6. Captions and sound

- **Captions are the primary channel.** Spoken lines appear as a caption on the speaker's tile, a sentence at a time for long lines. The reading time per line starts from agent-standup's formula, `min(9000, 900 + 42 ms × characters)`, scaled by playback speed.
- **Babble is optional and off by default.** It is a muffled, Peanuts-style "wah-wah" made with Web Audio: a buzzy oscillator through a resonant low-pass filter whose cutoff opens and closes on each syllable. Pitch rises through a question and falls through a statement. Each agent's base pitch comes from its hash. The mouth follows the audio level. agent-standup's `speakBabble` "sims" mode is the reference. There is no text-to-speech and no audio files.
- **No video export.**

### 7. Live catch-up

In live mode the call can fall behind a burst of directives. Rather than queueing captions without limit:

- With a short backlog, shorten each caption to its first sentence or sentences (agent-standup's `clipSpeech`).
- With a long backlog, show captions without babble.
- With a very long backlog, jump the playhead near the live edge. Recompute presence for the new position, and never skip past an inbound chat message.

### 8. Real data only

Spec 21's rule stands: every visible event comes from a real directive. agent-standup adds invented dialogue between events ("Thanks, that helps", "Can you hear me?"). Ant Farm does not. Decoration that cannot be mistaken for a statement is fine: idle animations, emoji thought bubbles, the flying 📨.

## Contract changes (`@curia/shared-types`)

These fields are additive and optional. The current Phaser renderer ignores them, so they can land before the new UI.

| Directive | Change | Source |
|---|---|---|
| `tube.in` | add `senderId`, `senderName?`, `isPrincipal?`, `content?` | `inbound.message` payload (`senderId`, `content`); name and principal flag resolved server-side |
| `tube.out` | add `channelId?`, `content?` | `outbound.message` payload |
| `claw.deliver` | add `label?` | `JobRow.taskTitle`, else a summary of `taskPayload` |

The interpreter is a pure function over `AuditEventRow`. The sender's display name and principal flag, and the job label, need a lookup. Two options:

- **Enrich at emit time.** Add the fields to the bus payloads (`ScheduleFiredPayload.label`, for example). Bus event types are a public API surface, so the changelog calls this out.
- **Enrich in the routes.** Look the values up in the timeline route and the SSE fan-out after `interpretEvent`, and keep the interpreter pure.

**Recommendation:** add the job label at emit time, because the scheduler already has the job row in hand at `fireJob()`. Resolve sender names in the routes, because a contact's display name can change and the call should show the current one.

Content is capped in the interpreter (about 4,000 characters) so a long email cannot bloat the SSE stream.

## What stays

- The `SceneDirective` union and `ActivityScript`
- The Conductor: modes, velocity, scrub, the replay/live merge, and stable snapshot references
- `GET /api/antfarm/timeline`, `GET /api/antfarm/stream` and their session gate
- The transport bar and detail overlay, restyled

## What goes

- Phaser, `OfficeScene.ts`, `PhaserOffice.tsx`, placeholder textures, the desk and world layout, character sheets
- The LimeZu art, the assets route and the credits footer. The licence approval (curia#1504) stays on record in case the art is wanted elsewhere.
- The scoped `/antfarm/` CSP relaxation (`img-src data: blob:`). The call view needs only the console's CSP.
- `agent.walk`. Delegation becomes a 📨 between tiles plus the spotlight moving, so the directive can be dropped from the union or left unrendered.

Swapping Phaser for DOM/SVG is a technology choice that other surfaces may follow. It gets an ADR alongside the implementation.

## Open questions

1. **Run both renderers for a while?** The directive stream supports two renderers. A `?view=office` flag would let the call view be compared on the same data before Phaser is deleted.
2. **Where does a delegation's `agent.speak` caption go?** On the delegating tile (the coordinator "says" the task), with the target tile lighting up, is the natural reading. Check that it holds when several delegations are in flight.
3. **Task cards and badges.** `task.appear` and `task.trash` could become a small "tasks" counter in the transport bar. `badge` could become a toast on the relevant tile, or on the coordinator when there is no agent. This needs a mockup.
4. **Thumbnail strip at scale.** With 20 or more camera-off agents the strip needs to scroll or collapse into a "+12" overflow.
