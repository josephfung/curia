# ADR-045: Delegated specialist trust is decided upstream

Date: 2026-09-26
Status: Accepted

## Context

A coordinator relays work to a specialist by publishing an `agent.task` with `metadata.delegationOrigin`, the validated `metadata.originator`, and no `senderContext`. The specialist then runs tools and may send on the principal's behalf. Someone has to decide whether that requester was allowed to ask.

Two designs were on the table.

**A. The specialist checks.** Hand it structured evidence of who asked and let the prompt decide whether the relay is authorized. That was the original framing of #1859: a cautious specialist was refusing relays, and the proposed fix was better evidence so it could verify them.

**B. The specialist does not adjudicate.** Authorization is a deterministic decision made before the specialist runs. Requester identity in the prompt is context for doing the work, not an input to that decision.

#1871 showed why A was the wrong remedy. The runtime was not merely omitting sender context. On every `internal`-channel task, including delegated ones, it injected the unresolved-sender `LOW-TRUST SENDER` block, with the instruction not to share the principal's availability. The specialist refused because it was obeying that block. #1872 (`34069bfb`) removed the block from delegated tasks and rendered identity with the line "It is not a permission input."

That left the decision itself unrecorded. It matters more under open-core self-hosting ([#1436](https://github.com/josephfung/curia/issues/1436), [ADR-031](031-tools-vs-skills-vocabulary.md)): a deployment ships its own specialists against this contract. An author needs to know what a relay allows them to assume, and what they must still check, without reading `delegated-task-context.ts`.

## Decision

Adopt B. Authorization of a delegated task is decided upstream and only upstream. A specialist does not re-adjudicate requester identity.

The upstream decision is the execution layer's autonomy gates ([ADR-011](011-score-based-autonomy-engine.md)), not a sentence in the prompt. `isPrincipalOriginated` skips gates A and B. Every other lineage, including a delegated specialist task whose originator is missing or not principal-tier, stays subject to those gates. Gate C still applies to an external originator. Elevated skills still require a live principal turn. `delegationOrigin` does not change any of that. The delegated-task shape (`delegationOrigin` set, channel `internal`) is what the gate tests pin.

The prompt carries two different blocks:

- **Requester identity** — contact id, channel, system role, and tier. Any internal-channel task with a validated originator gets this, including a coordinator task such as the voice off-ramp. It describes who asked. It does not say the task was authorized.
- **Delegated-specialist addendum** — only when `delegationOrigin` is set. It states that the task is authorized, that this is separate from who is identified, and that a missing identity or tier `unknown` is not a further clearance. It includes the `<specialist_decline>` instructions. The coordinator does not receive this addendum and still adjudicates senders.

Detection keys off `delegationOrigin`, not `channelId`. Only `delegate` stamps that marker, on the specialist task. The dispatcher strips a channel-supplied `delegationOrigin` the same way it strips a channel-supplied `originator`.

### What a specialist author may assume

When a task carries `delegationOrigin`:

- The task was already authorized to run. Do not add a rule that refuses because the sender is unknown, unverified, or not the principal.
- The harness supplies requester identity for the work: who to address, which channel the ask arrived on, what role and tier to label. Use those values. Do not go looking for a contact record the harness did not give in order to decide whether the ask is allowed.
- A missing identity, or tier `unknown`, is not an extra clearance and is not a reason to treat the task as an unresolved external sender.
- Refusal is for being unable to do the task. End that reply with `<specialist_decline>`. An RSVP of "decline" is a normal answer, not that marker.

### What a specialist must still check

Independently of that authorization:

- The request is work this specialist does. A relay does not widen the job. Out of scope ends with `<specialist_decline>`.
- Sender judgment that changes the content of a decision stays scoped to that decision. Calendar RSVP policy applies to a formal-invite consult. A day brief has no invite sender. Do not generalize a task-quality check into "may I act at all."
- The prompt does not override the autonomy gates. Write as if gates A and B still apply to a non-principal originator, Gate C still applies to an external originator, and an elevated skill still needs a live principal turn. "This task is authorized" is not permission to skip them.
- Outbound sends, knowledge-graph writes, and other consequential tools keep their own gates. Authorized to run is not authorized to send.
- Do not key any of this off `channelId === 'internal'`. That channel also carries the voice off-ramp, which is a coordinator task and is not this contract.

### Rejected alternative

Specialist-checkable authorization evidence (option A, the original #1859 proposal) is rejected.

- **Not reproducible across model swaps.** The same evidence makes a cautious model refuse and a compliant one proceed. Authorization would change when the specialist's model changes.
- **Not auditable.** The decision would live in each specialist prompt, including third-party prompts shipped beside this repo. There is no single gate to reconstruct after the fact. #1871 was that failure in miniature: a prompt block the runtime injected became the authorization decision, and it was the wrong one.

The evidence is still recorded. It is recorded for an operator, not handed to the model as a permission input. Each delegated specialist task emits `delegation.requester_context` with the contact id, channel, system role, tier, and whether the addendum was actually inserted. `AuditLogRepo.findDelegationRequesterContext(delegateEventId)` returns that row. The correlation key is the specialist `agent.task` id.

## Consequences

- A specialist prompt that refuses unknown senders is a bug against this contract, including in deployments that ship their own agents.
- The autonomy gate is load-bearing. The prompt-side refusal #1872 removed was an accidental backstop. Gates A and B on a non-principal delegated task are what constrains that widening, and they are tested on the delegated shape.
- A context-budget drop is visible: `delegatedAddendumApplied: false` means the specialist was not told the task was authorized, and the identity fields are what the harness held rather than what the model saw. `outcome` on the audit row is `failure` in that case.
- Reconstructing a past relay does not require the prompt. It requires the `delegation.requester_context` row for that task id.
- A failed publish of that row aborts the specialist turn. The addendum is not left in the prompt with no audit row behind it.
