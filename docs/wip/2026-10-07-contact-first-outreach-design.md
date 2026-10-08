# Contact-first outreach

**Status:** implemented on branch feat/contact-first-outreach (#2041).
**Decision:** retire the raw-address send fields. Cold outreach creates a contact first. Addresses an agent enters get their own source, `agent_stated`, which is verified only after a duplicate check that runs before anything is written.

## Context

ADR-047 (#2033) moved the send skills to contact references and kept a separately named raw-address field for people with no contact record: `to_address` and `cc_addresses` on `email-send`, `recipient_number` on `signal-send` and `sms-send`, `recipient_user_id` on `slack-send`. `email-draft-save` still takes a typed `to`. #2047 added the label hint, so a contact's secondary address no longer needs the raw field. That was the blocker for this change.

What the code does today, and why it matters here:

- The resolver (`src/skills/_shared/recipient-reference.ts`) sends only to **verified**, active identities. Only the principal can verify an identity after the fact, from the console (`PATCH` in `src/channels/http/routes/kg.ts`). The verification rule for agent-entered addresses therefore decides whether "create, then send by ID" works at all.
- `contact-create` and `contact-link-identity` record source `ceo_stated`. That source is auto-verified, so an address the agent typed looks as if the principal stated it.
- `contact-create` runs no duplicate check before it writes. The dedup check in `ContactService.createContactWithKgOutcome` is fire-and-forget, compares names only, and runs after the insert, and nothing reaches the agent. An address that is already on file fails at `linkIdentity` with a raw unique-violation message, after the contact row was created. The orphan stays.
- Contacts that a raw send created since #2033 carry an unverified `outbound_recipient` identity. Once the raw fields are gone nothing can reach them, unless an agent can vouch for the address or the principal verifies it.
- The coordinator does not pin `contact-create`. It pins `contact-update` as a single tool, so `contact-create` can be pinned the same way.

## Decision

### 1. The send skills take references only

`to_address`, `cc_addresses`, `recipient_number` and `recipient_user_id` are removed from the four manifests and handlers, and from every reader:

| Reader | Change |
|---|---|
| `SEND_SKILL_RECIPIENT_FIELDS` | The `raw` entry becomes a `retired` list of field names |
| `resolveSendSkillReferences` (pre-gate) | Refuses a retired field. The "a reference in a raw field" check goes |
| Gate C parsers (`src/channels/*/principal-rules.ts`) | Parse reference fields only. Retired names join `unparsedRecipientKeys`, so the parser fails closed |
| `approvalDisplayInput` | The raw-path display goes |
| `src/security/export-controls.ts` | Reads the reference field only |

A call that still passes a retired field is **refused, not ignored**. A dropped `cc_addresses` would otherwise send to fewer people than the agent asked for and report success. Three layers refuse it: the pre-gate check, the handler (handler tests call handlers directly), and the Gate C parser. The message names the field, says sends go to contacts only, and says how to get a contact ID. It never echoes an address.

An address in a reference field gets the same direction. The resolver's message no longer points at a raw field. It says to send by contact ID, and to add someone who is not a contact yet with `contact-create`, which returns their ID.

An approval stored before the deploy with a raw field fails when it is approved, with the retired-field message. The window is 48 hours, as it was for ADR-047.

### 2. `email-draft-save` takes a reference; `send-draft` is unchanged

`email-draft-save`'s `to` becomes a single contact reference (contact ID, `principal`, or either with a `#label`). It resolves through `OutboundGateway.resolveRecipientReference`, and the draft is addressed to the resolved address. The result adds `to_identity`, and `contact_id` when a UUID was passed, the same as `email-send`. If the call is held for approval, the approval shows the resolved address.

`send-draft` stays as it is. Its gate is principal origin (ADR-017), and it sends whatever envelope the draft holds. Once `email-draft-save` stops writing typed addresses, every draft it sends was addressed either by reference or by a person in their own mail client.

`ceo-inbox-draft-compose` and `ceo-inbox-draft-edit` also take typed addresses. They write drafts the principal sends from Gmail. #2053 takes them on separately: references, plus a raw address only when it appears in the principal's mail. They are not part of this change.

### 3. Addresses an agent enters: source `agent_stated`, verified after a duplicate check

`contact-create` and `contact-link-identity` record `agent_stated` on the identity, and as the contact's creation source. `agent_stated` is auto-verified (`AUTO_VERIFIED_SOURCES`). `ceo_stated` stays where the principal really entered the data: the console and the setup wizard.

`agent_stated` does not earn `MANUAL_BOOST` in the confidence scorer. That boost is for contacts the principal created. Agent-created contacts start at tier `known`, and no gate reads confidence above `unknown` (it drives unknown → known elevation only).

#### The duplicate check

`ContactService.findLikelyDuplicates({ displayName?, identities, excludeContactId? })` runs synchronously before any write. It returns blocking matches and candidates:

| Finding | Kind |
|---|---|
| The identifier is already on another contact, on the same channel (email compared case-insensitively) | **Blocking.** The store cannot hold it twice. The agent is told to use that contact |
| The same number on a sibling phone channel (`phone`, `signal`, `sms`) | Candidate |
| A near-miss email: optimal-string-alignment distance 1–2 on the lowercased address, or exactly 1 when the shorter address has fewer than 12 characters | Candidate |
| A near-miss number: distance exactly 1 on the E.164 digits (one substitution, adjacent swap, insertion or deletion), across the phone channels | Candidate |
| The same display name, compared after sanitizing, case-insensitive (`contact-create` only) | Candidate |
| A near-miss display name: Jaro-Winkler ≥ 0.95 on the sanitized, normalized names (`contact-create` only) | Candidate |

Slack and Telegram ids are opaque, so they are matched exactly and have no near-miss. The two incidents in ADR-047 fall inside the bounds: `.com` for `.ca` is distance 2 on a 20-character address, and an inserted dot is distance 1.

A candidate blocks the write until the call passes `distinct_from`, listing **every** candidate's ID. The `distinct_from` IDs are the agent saying "I checked these, and they are different people". A boolean override was rejected, because a model learns to set a flag before it has seen anything. IDs outside the candidate list are ignored. `distinct_from` never overrides a blocking match.

The refusal lists each candidate by name, contact ID and reason (`same name`, `similar name`, `similar email address`, `same number on signal`). It never includes an address, because a model handed one will retype it. The principal is listed as `the principal`, with `principal` as its `distinct_from` token, so the principal's contact ID stays out of the model's context (spec 09). The refusal says how to continue:
- if one candidate is this person, use that contact's ID, and `contact-link-identity` adds a new address to it;
- if not, retry with `distinct_from`.

Mechanics:

- A new backend method, `listIdentitiesOnChannels(channels)`, reads the identities for the near-miss scan. Creation is rare, and a principal's store holds thousands of identities at most, so the scan runs in memory.
- The name scan reads every contact (`listContacts()`, which has no default cap) and scores each name with the dedup service's Jaro-Winkler. The 0.95 threshold (`NAME_NEAR_MISS_THRESHOLD`) sits between typos of one name ("Priya Natarajan" / "Priya Natrajan", 0.958; "Jenna Torres" / "Jena Torres", 0.981) and different people who share part of a name ("David Kim" / "David King", 0.938; "Sarah Johnson" / "Sarah Jones", 0.936; "Alex Morgan" / "Alex Martin", 0.905). It catches a one-letter typo after the first letter in a name of about eight or more characters; shorter names and first-letter typos can fall below it, and a few different people with one-letter-apart names of 8+ characters land above it ("Wei Chen" / "Wei Chan", 0.95). A contact that already matched exactly is not listed twice.
- A failed lookup fails the create closed, with the cause logged. It does not create without the check.
- The check is not a lock. A concurrent create can still win the unique index. `contact-create` therefore validates every input before it writes. If `linkIdentity` then fails, it deletes the contact it just created (`deleteContact` with `archiveAnchoredNode` from `createContactWithKgOutcome`, as `contact-register` does) and reports a unique violation as the blocking match.

#### Identifier shape

Identifiers are validated before the check, per channel:
- email must be an address, and is lowercased;
- `phone`, `signal` and `sms` are normalized to E.164 with `normalizePhone` (the normalizer `contact-update` uses), and a value that cannot be normalized is refused;
- `slack` must be a user id (`U…`, or `W…` on Enterprise Grid; the resolver sends only to `U…`).

Without this, an SMS number typed as `(555) 123-4567` would be stored, and then skipped as unsendable at the first send.

`contact-create` gains `sms` and `slack` inputs. Cold outreach on SMS or Slack is then one call, not a create followed by a link.

#### Residual risk

A typo in a brand-new address that resembles nothing on file is stored and verified. The principal's message is the only check on that transcription. This is the risk the raw field carried. It now sits in one checked, recorded place instead of every send. The rejected alternatives were approval on the first send to an agent-entered address, which makes every cold outreach wait on the principal, and an unverified-but-sendable source, which breaks the rule that only verified addresses are sendable. They are recorded in ADR-047.

### 4. Re-stating an address an agent typed earlier

`contact-link-identity` with an identifier that is already on the **same** contact:

| Existing identity | Result |
|---|---|
| Verified | Success, unchanged (`already_linked: true`) |
| Unverified, source `outbound_recipient` | The §3 duplicate check runs first. If it passes, verified in place (`verifyIdentity`) and the source is kept, so the store still shows the address first came from a send. If it finds a candidate or a blocking match, the call is refused and nothing is verified |
| Unverified, any other source (`self_claimed`, `sms_participant`) | Refused. Only the principal can verify those, in the console |

A re-statement writes no new identity, but verifying is the risky step: the gateway records an `outbound_recipient` address as the agent typed it, so a typo of the principal's address (the 2026-10-07 incident) sits there unverified until someone vouches for it. The re-statement therefore runs the same check as a new address, with `excludeContactId` set to this contact, before it verifies. A candidate refuses the call until `distinct_from` names it; a check that cannot run refuses too. A verified identity is returned unchanged with no check, since nothing changes. The identifier is still normalized first, so `+1 (555) 123-4567` finds the stored `+15551234567`. An identifier on a *different* contact is the blocking match from §3.

An agent may vouch only for what an agent typed. This is how agents reach the contacts that raw sends created. Spec 09's source table changes the `outbound_recipient` row to "No: verified when the principal confirms it or an agent re-states it (after the duplicate check)".

### 5. Coordinator ergonomics

`contact-create` is pinned to the coordinator as a single tool, the way `contact-update` is. A cold outreach is `contact-create` and then the send, with the returned `contact_id`, in the same turn. No always-on prompt text is added (ADR-046). The rule lives where the model meets it: the `to`/`recipient` descriptions say how to reach someone who is not a contact, and `contact-create`'s description says it returns the ID to send to and refuses likely duplicates. The removed raw-field descriptions should offset most of the added tool definition. `tests/unit/agents/prompt-budget.test.ts` decides.

## Out of scope

- **#2040**, the tier of contacts the gateway creates after a first-time send. With the raw fields gone, the gateway creates one only after `send-draft` sends a draft that a person addressed.
- **The ceo-inbox draft tools** (#2053). See §2.
- **Contacts already stored as `ceo_stated` that an agent actually entered.** Relabelling them is a data change, left to the operator, as ADR-047 left the gateway-created ones.

## Documentation

- **ADR-047.**
  - The "No raw path at all" alternative becomes the decision.
  - "The raw path is separate and deliberate" is replaced by the contact-first rule and the `agent_stated` provenance.
  - Consequences cover the breaking change and the approval window.
  - The not-covered list trades "a typo in a raw-address field" for "a typo in a new address at creation".
  - The two rejected verification rules are recorded with their reasons.
- **Spec 09:** the source table and the send section.
- **CLAUDE.md:** "Reaching the principal".
- **CHANGELOG:** Changed, Removed and Security entries.
- **Manifest versions:** minor bumps for the four send skills, `email-draft-save`, `contact-create`, `contact-link-identity` and `agents/coordinator.yaml`.

## Testing

**Unit tests:**
- the near-miss matcher, at both thresholds, the short-address rule, and phone edits;
- `findLikelyDuplicates`, one test per table row, on the in-memory backend;
- the `contact-create` and `contact-link-identity` handlers:
  - blocking matches;
  - candidates;
  - `distinct_from` that covers all candidates, and that covers only some;
  - the principal alias;
  - normalization refusals;
  - the orphan cleanup;
  - each re-statement row;
- the retired-field refusal in all four handlers and in the pre-gate check, which must refuse before any gate files an approval;
- the Gate C parsers failing closed on a retired key;
- `email-draft-save` reference resolution and refusals;
- the approval display for a held `email-draft-save`.

**End-to-end unit test:** `contact-create` against a real `ContactService` (in-memory backend), then `email-send` through the real resolver, with a stub gateway transport. The send goes to the address that was created, and a second create with a near-miss address is refused with that contact as a candidate.

**Scenario 14d (cold outreach):** the principal asks the coordinator to email a new person at a given address. The critical check is that `email-send`'s `to` is the new contact's ID. The `contact-create` stub and the contacts-specialist `delegate` stub return the same ID, so the case passes on either route.

**Scenario 14b:** gains `not_called: [contact-create]`, so the coordinator does not create a duplicate of a known contact. Cases 03b, 07, 14a, 14b and 14c drop their raw-field checks, because a check may name only real inputs.
