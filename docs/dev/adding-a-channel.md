# Adding a Channel

A **channel** is the bridge between an external messaging platform (Signal, Email, Slack, …) and Curia's internal message bus. Every channel does the same three things: receive platform messages and normalize them into `inbound.*` bus events, subscribe to `outbound.message` events destined for it, and deliver those responses back through the platform. Adding a channel means writing one adapter plus a handful of small contributions — nothing in the core dispatch or agent layers changes.

> **Security boundary.** A channel adapter registers on the bus at the `channel` layer. That layer may **only** publish `inbound.message` / `inbound.reaction` and subscribe to `outbound.message`. It cannot invoke tools, read the knowledge graph, or trigger agent tasks. This is enforced by `src/bus/permissions.ts`, not by convention — a compromised adapter can flood inbound traffic but nothing more.

See [Adding a Tool](adding-a-tool.md) and [Adding an Agent](adding-an-agent.md) for the sibling guides.

---

## Quick Start

For a channel that both receives and sends (like Slack or Signal):

1. **Adapter** — create `src/channels/<name>/<name>-adapter.ts` implementing the `Channel` interface (`name`, `isToggleable`, `start()`, `stop()`).
2. **Catalog** — add a `ChannelDescriptor` to `src/channels/catalog.ts` (credential fields + required secret keys).
3. **Outbound request + principal rules** — add `src/channels/<name>/outbound-request.ts` (the channel's `OutboundSendRequest` variant + type guard) and `src/channels/<name>/principal-rules.ts` (`PrincipalChannelRules`: `identifiersEqual`, `extractRecipients`, optional Gate C `carveoutSkill`). Append the rules to `src/contacts/principal-channel-registry.ts`.
4. **Gateway wiring** — re-export the request variant into the `OutboundSendRequest` union in `src/skills/outbound-gateway.ts`, add the channel client to `OutboundGatewayConfig`, and add a `dispatch<Channel>()` method + a branch in `send()`.
5. **Trust & policy** — add a `channels.<name>` block to `config/channel-trust.yaml` (`trust`, `unknown_sender`, `threaded`) and any channel-specific settings to `config/default.yaml`.
6. **Bootstrap** — construct the client and adapter in `src/index.ts`, gated on the channel registry, and start it.
7. **Tests** — adapter, catalog, and conformance tests.

> **The channel starts disabled in the registry.** A newly added toggleable channel is registered at startup but **not enabled**. Enable it from the console (**Settings → Channels**) once its credentials are in the vault, then restart. `http` and `cli` are the exception — they are `isToggleable: false` and always start (an operator-lockout safeguard).

If your channel is **inbound-only or doesn't send externally**, skip steps 3–4's outbound pieces — but you still need a `principal-rules.ts` entry if inbound senders can be the principal (see [Principal rules](#principal-rules-adr-034--adr-035)).

---

## 1. The `Channel` interface

Every adapter implements the interface in `src/channels/channel.ts`:

```typescript
export interface Channel {
  /** Stable identifier: 'email' | 'signal' | 'slack' | 'sms' | 'http' | 'cli'. Matches the catalog + registry row. */
  readonly name: string;
  /** False for http and cli — they always start and cannot be disabled/uninstalled. */
  readonly isToggleable: boolean;
  start(): Promise<void>;   // connect, begin listening, subscribe to outbound.message
  stop(): Promise<void>;    // graceful, idempotent teardown (called on shutdown)
}
```

There is **no `send()` method**. Outbound delivery happens inside `start()`: the adapter subscribes to `outbound.message` and either routes the send through the shared `OutboundGateway` (email, Signal, Slack) or writes directly (CLI). Keep `stop()` idempotent — it is called on process shutdown and may run after a partial `start()`.

```
src/channels/<name>/
  <name>-adapter.ts       # implements Channel
  <name>-client.ts        # platform SDK / transport wrapper (optional)
  outbound-request.ts     # the channel's OutboundSendRequest variant (if it sends)
  principal-rules.ts      # PrincipalChannelRules contribution
  message-converter.ts    # platform event → normalized fields (optional)
  types.ts                # channel-local types (optional)
```

Use `src/channels/slack/` as the reference implementation for a full-featured, send-and-receive channel.

---

## 2. The catalog descriptor

The catalog (`src/channels/catalog.ts`) is the static, code-defined source of truth for which channels exist, whether each is toggleable, and what credentials it needs. The `channel_registry` table holds only mutable lifecycle state (enabled / install provenance); everything structural comes from here.

```typescript
{
  name: 'my-channel',
  description: 'My platform integration via …',
  isToggleable: true,
  credentialFields: [
    { key: 'api_token', label: 'API token', secret: true, envFallback: 'MY_CHANNEL_API_TOKEN' },
  ],
  requiredSecretKeys: ['api_token'],
}
```

Each credential is stored in the vault under `channel.<name>.<key>` — here, `channel.my-channel.api_token`. `envFallback` names a legacy env var checked during resolution (back-compat with pre-vault deployments). The registry will not let a channel be **enabled** until every `requiredSecretKeys` entry resolves in the vault (or its env fallback).

`getChannelDescriptor(name)` resolves a descriptor by name; the bootstrap iterates `CHANNEL_CATALOG` to reconcile the registry and decide what starts.

---

## 3. Handling inbound messages

When your platform delivers a message, normalize it and publish it on the bus using the factories from `src/bus/events.ts` — **do not** hand-build the event object:

```typescript
import { createInboundMessage } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';

const inbound = createInboundMessage({
  conversationId,          // stable per-thread id, prefixed with your channel: 'my-channel:<thread>'
  channelId: 'my-channel',
  senderId,                // the platform's sender id (e.g. a Slack U…, a phone number)
  content: sanitizeOutput(text, { maxLength: 10_000 }),
  metadata,                // channel-specific extras the dispatcher/reply path may use
});

await this.config.bus.publish('channel', inbound);
```

Note the shape: `bus.publish(layer, event)` takes the **layer** (`'channel'`) as the first argument. The payload fields are `channelId` / `senderId` / `content` — not `channel` / `sender` / `text`. For emoji reactions, use `createInboundReaction(...)` → `inbound.reaction` (see the Slack adapter's `handleReaction`).

> **Trust is not declared here.** The adapter does **not** put a trust level on the inbound payload. Channel trust is resolved by the dispatcher from `config/channel-trust.yaml` (see [step 5](#5-trust-and-policy-config)). Sanitize inbound text before publishing — `sanitizeOutput` strips tags that could be read as system instructions.

### Auto-creating the sender as a contact

Resolve (and, if new, create) a contact for the sender **before** publishing, so downstream trust scoring has a record to work with. Use `ContactService.ensureChannelContact` — a resolve-or-create-once helper (not an upsert):

```typescript
const existing = await this.contactService.resolveByChannelIdentity('my-channel', senderId);
if (!existing) {
  await this.contactService.ensureChannelContact({
    channel: 'my-channel',
    channelIdentifier: senderId,
    source: 'my_channel_participant',   // see below — must be an IdentitySource
    displayName,                        // resolved from a platform user lookup
    fallbackDisplayName: senderId,
    tier: 'unknown',                    // new senders land as tier=unknown
  });
}
```

Contact creation is **best-effort**: wrap it so a failure logs a warning but still lets the inbound message publish. Skip the lookup when the contact already exists (avoid a platform API round-trip per message).

If you want identities from your channel to be **auto-verified** (trusted as sourced from the transport, not from LLM-generated text), add a `<channel>_participant` value to `IdentitySource` in `src/contacts/types.ts` and to `AUTO_VERIFIED_SOURCES` in `src/contacts/contact-service.ts`. Only do this when the platform's sender id is a strong identity signal (Signal phone numbers and Slack workspace user ids qualify; a spoofable id does not).

---

## 4. Handling outbound messages

In `start()`, subscribe to `outbound.message` at the `channel` layer and handle only the events addressed to your channel:

```typescript
bus.subscribe('outbound.message', 'channel', async (event) => {
  const outbound = event as OutboundMessageEvent;
  if (outbound.payload.channelId !== 'my-channel') return;   // filter by channelId
  await this.handleOutbound(outbound);
});
```

For any channel that sends **externally**, route the send through the shared **`OutboundGateway`** — never call the platform API directly from the adapter. The gateway is the single choke-point that runs blocked-contact checks and content/PII filtering before anything leaves Curia:

```typescript
const result = await this.outboundGateway.send(
  { channel: 'my-channel', /* …your OutboundSendRequest fields… */, message: outbound.payload.content },
  { taskEventId: outbound.payload.taskEventId, conversationId: outbound.payload.conversationId, parentEventId: outbound.id },
);
```

(CLI is the exception — it has no external recipient and writes straight to stdout.)

Wiring the gateway to understand your channel is three small edits, per the checklist at the top of `src/skills/outbound-gateway.ts`:

1. **Define the request variant** in `src/channels/<name>/outbound-request.ts` — an interface with a `channel: '<name>'` discriminant, plus a type guard (`isMyChannelOutboundRequest`). Mark which fields are recipient identifiers and which are never (group/conversation ids).
2. **Re-export it into the union** — add it to `OutboundSendRequest` in `outbound-gateway.ts` (a public API surface) and add the channel client to `OutboundGatewayConfig`.
3. **Add delivery dispatch** — a private `dispatch<Channel>()` method and a branch in `send()` that calls it. The blocked-contact check and content filter in `send()` are channel-agnostic and already run for every channel before dispatch.

---

## Principal rules (ADR-034 / ADR-035)

Each channel contributes a `PrincipalChannelRules` object (`src/channels/<name>/principal-rules.ts`) and appends it to the single auditable registry in `src/contacts/principal-channel-registry.ts`. This is how Curia knows (a) whether an inbound/outbound identifier is the principal, and (b) how to project an outbound request onto recipient identifiers for principal tagging — **without** per-channel branches leaking into `principal-recipient.ts` or `outbound-gateway.ts`.

```typescript
export const myChannelPrincipalRules: PrincipalChannelRules = {
  channel: 'my-channel',

  // How this channel compares a candidate id to a stored verified identity.
  // (email folds case; Signal/Slack are exact.)
  identifiersEqual(a, b) {
    return a === b;
  },

  // Project an outbound request onto recipient identifiers for principal tagging.
  // Return null when `request` is not this channel's shape (fail closed).
  extractRecipients(request) {
    if (!isMyChannelOutboundRequest(request)) return null;
    return [{ identifier: request.userId, principalEligible: true }];
  },

  // carveoutSkill omitted ⇒ no Gate C principal carve-out (the conservative default).
};
```

Two fail-closed rules to internalize:

- **Group / conversation ids are never principal-eligible.** In `extractRecipients`, mark a shared conversation id (a Slack `C…`/`D…`, a Signal group id) with `principalEligible: false`. Only a per-human identifier (a Slack `U…`, a phone number, an email address) may be principal-eligible. Getting this wrong could let a group thread be treated as a private principal channel.
- **Omit `carveoutSkill` unless a send skill needs the Gate C principal-only carve-out.** Absent ⇒ the channel still gets identity matching for the outbound gateway, but fails closed for Gate C. When you do add `carveoutSkill`, its `parseRecipients` must fully model the skill's recipient-shaped input and return `null` on any unmodeled key.

The registry asserts channel ids and carve-out skill names are unique at load (`assertPrincipalChannelRegistryUnique`) — a duplicate is a hard startup failure, not a silent shadow. Reviewers audit the entire Gate C opt-in surface by reading this one file; that is the point of centralizing it. See `docs/adr/034-channel-contributed-principal-carveout-registry.md` and `docs/adr/035-channel-owned-outbound-recipient-projection.md`.

---

## 5. Trust and policy config

A channel's **trust level**, **unknown-sender policy**, and **threading** live in `config/channel-trust.yaml` — not in the adapter and not in the inbound payload:

```yaml
channels:
  my-channel:
    trust: medium          # high | medium | low — max sensitivity of actions via this channel
    unknown_sender: allow  # allow (route as tier=unknown) | ignore (silently drop)
    threaded: true         # true = native threads; false = enable context bridging
```

Pick `trust` from the identity guarantees the transport provides:

| Trust | When |
|---|---|
| `high` | Strong identity verification — local/SSH access, E2E encryption with phone verification |
| `medium` | Token / OAuth authentication (tokens can leak) |
| `low` | Weak guarantees — e.g. email From headers are spoofable |

The dispatcher reads this policy (`channelPolicies[channelId].trust`, default `low`) and combines the channel trust with the sender's contact confidence and injection-risk score to produce the message trust score. `threaded: false` opts the channel into **context bridging** (a compact context memo injected before each follow-up, since the platform has no native thread reference). Channel-specific runtime settings (e.g. an allowlist of channel ids) go in `config/default.yaml` under `channels.<name>`.

---

## 6. Bootstrap wiring

Wire the channel into `src/index.ts` following the Slack pattern:

- Construct the platform **client** early (it may be needed by the `OutboundGateway`), gated on the presence of its credentials.
- The bootstrap computes `channelShouldStart` from the registry: a toggleable channel starts only if it is **enabled in the DB and its required credentials currently resolve**. Non-toggleable channels always start. An enabled-but-uncredentialed channel logs a warning and is skipped — it never crashes boot.
- Construct the **adapter after the `OutboundGateway`** (it needs the gateway) and only when `channelShouldStart.has('<name>')`, then `start()` it with the rest of the system.

Because enable state is read at boot, toggling a channel on/off in the console is **restart-based** — the change takes effect on the next restart.

---

## What the dispatch layer handles for you

You do **not** implement any of these in the adapter — they run after your `inbound.*` event is published:

- **Contact resolution & trust scoring** — your channel-trust policy is combined with contact confidence and injection risk.
- **Rate limiting** — global and per-sender.
- **Prompt-injection scanning** — inbound text is checked against detection patterns.
- **PII redaction** — outbound messages are redacted per channel policy inside the gateway.
- **Reply routing & context bridging** — the dispatcher stamps the reply's `recipientId` and (for non-threaded channels) maintains the context memo.

---

## Tests

Cover, at minimum:

- **Inbound normalization** — platform event → `inbound.message` / `inbound.reaction` fields (including dedupe and allowlist filtering if your channel has them).
- **Outbound delivery** — `outbound.message` for your channel → the correct `OutboundGateway.send` request; other channels' events are ignored.
- **`extractRecipients`** — assert that group/conversation ids come back `principalEligible: false` and per-human ids come back `true`, and that a foreign request shape returns `null`.
- **Catalog** — the new descriptor is present with the right required keys (`catalog.test.ts`).
- **Conformance** — the adapter satisfies `channel-conformance.test.ts` (shared `Channel`-interface checks).

Integration tests should run through a real bus instance so events flow the full dispatch pipeline.

---

## Checklist Before Opening a PR

- [ ] Adapter implements `Channel` (`name`, `isToggleable`, idempotent `stop()`) and registers on the bus at the `channel` layer only
- [ ] `ChannelDescriptor` added to `catalog.ts` with correct `credentialFields` + `requiredSecretKeys`
- [ ] Inbound uses `createInboundMessage` / `createInboundReaction` + `bus.publish('channel', …)`; inbound text is sanitized
- [ ] Senders auto-create via `ensureChannelContact` (best-effort, non-fatal); `<channel>_participant` added to `IdentitySource` (+ `AUTO_VERIFIED_SOURCES` only if the id is a strong identity signal)
- [ ] Outbound routes through `OutboundGateway` (not a direct platform call), filtered by `channelId`
- [ ] `outbound-request.ts` variant + type guard; re-exported into the `OutboundSendRequest` union; client added to `OutboundGatewayConfig`; `dispatch<Channel>()` + `send()` branch added
- [ ] `principal-rules.ts` contributes `identifiersEqual` + `extractRecipients` (group/conversation ids `principalEligible: false`); appended to `principal-channel-registry.ts`; `carveoutSkill` omitted unless a send skill needs Gate C
- [ ] `channels.<name>` block in `config/channel-trust.yaml` (`trust`, `unknown_sender`, `threaded`); channel-specific settings in `config/default.yaml`
- [ ] Bootstrap wiring in `src/index.ts` (client + adapter, gated on `channelShouldStart`, adapter constructed after the gateway)
- [ ] If the channel is something a new user would set up, a matching entry exists in `skills/setup/tools/setup-status/catalog.yaml` with a `docs_url`, and a setup guide exists in the `curia-docs` repo
- [ ] Tests: inbound, outbound, `extractRecipients`, catalog, conformance
- [ ] Remember the channel starts **disabled** — enabling it is a restart-based registry action

---

## Related Docs

- [Architecture Overview](../specs/00-overview.md) — the five-layer bus model
- [Adding a Tool](adding-a-tool.md) / [Adding an Agent](adding-an-agent.md) — sibling guides
- `docs/adr/033-*` — Slack channel decision record
- `docs/adr/034-channel-contributed-principal-carveout-registry.md` — the principal-rules registry
- `docs/adr/035-channel-owned-outbound-recipient-projection.md` — `extractRecipients` / channel-owned request variants
- Public docs: `curia-docs` → **Channels → Building custom channels** (the user-facing version of this guide)
