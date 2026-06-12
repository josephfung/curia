# Channel policy issue — FILED as #962

> Spun out of #543 (channel registry). This captures the **channel policy** concern
> deliberately deferred from that issue.
> **Filed:** https://github.com/josephfung/curia/issues/962

**Suggested title:** `feat: DB-backed channel policy (trust / unknown_sender / threaded) with yaml defaults`

**Suggested labels:** `channels`, `autonomy`, `governance`, `enhancement`, `web-ui`, `P4`, `size:L`

**Suggested milestone:** _(none — schedule after #543 lands)_

---

## Summary

Move channel **policy** settings — currently static defaults in
`config/channel-trust.yaml` — into a runtime-configurable model: yaml provides the
default, an optional DB value overrides it, and (for `trust` / `unknown_sender`) the web
console can edit it. Split `threaded` out as an adapter *capability* expressed on the
`Channel` interface rather than as policy.

This complements the channel **registry** (#543), which handles channel *lifecycle*
(install/enable) and *credentials*. Policy is a separate, dispatch-layer concern and was
intentionally kept out of the registry.

## Motivation

`config/channel-trust.yaml` defines, per channel:

- `trust` — caps the maximum sensitivity of actions a message from this channel can trigger.
- `unknown_sender` — what to do with messages from unrecognized senders
  (`allow` / `hold_and_notify` / `ignore`).
- `threaded` — whether the channel renders replies as threads.

These are consumed in the **dispatch layer** (`src/contacts/config-loader.ts` →
`src/dispatch/trust-scorer.ts`, `src/dispatch/dispatcher.ts`). Today they can only be
changed by editing yaml and restarting. Operators have no runtime control and no audit
trail of policy changes.

## Design sketch

### 1. `threaded` → `Channel` interface (do this first)

`threaded` is a property of the adapter/channel capability, not a security policy. Add
`readonly threaded: boolean` to the `Channel` interface (introduced in #543) and source
it from the adapter, removing `threaded` from the policy concern.

### 2. Policy resolution: yaml default ▸ DB override

- Keep `config/channel-trust.yaml` as the **default** source.
- Add a `channel_policy` store (table) holding only operator overrides:
  `channel_name`, `trust?`, `unknown_sender?`, `updated_at`, `updated_by`.
- Resolution: DB override (if present) wins over yaml default, per field.
- Membership note: `channel-trust.yaml` includes `web` (the KG app, authenticated by the
  bootstrap secret) which has **no startable adapter** and is **not** in the registry
  catalog. Policy membership ≠ registry membership — the policy store must cover `web`
  too.

### 3. Security: trust is sensitive — write an ADR

Making `trust` runtime-editable means a console compromise could **escalate** a channel's
trust level and, with it, the maximum action sensitivity reachable from that channel.
Before building this:

- Write an ADR (`docs/adr/`) covering the trust-escalation threat, who may edit policy,
  and the required audit trail.
- Every policy change must emit an audit event (actor, channel, field, old → new).
- Consider whether `trust` edits need a stricter gate than `unknown_sender` (e.g. an
  approval step, or read-only in the UI with edits only via a privileged path).

### 4. Web console

Add policy controls to the channel detail drawer (built in #543): per-channel `trust`
and `unknown_sender` selectors showing the effective value and its source (yaml default
vs DB override), with a reset-to-default action.

## Acceptance criteria

- [ ] `threaded` moved to the `Channel` interface; `config/channel-trust.yaml` no longer carries it; dispatch reads it from the adapter/channel.
- [ ] `channel_policy` store created via migration, holding per-channel `trust` / `unknown_sender` overrides.
- [ ] Policy resolution = DB override ▸ yaml default, per field; covers `web` as well as the four adapters.
- [ ] Dispatch layer (`trust-scorer.ts`, `dispatcher.ts`) reads resolved policy, not raw yaml.
- [ ] Every policy change emits an audit event (actor, channel, field, old → new value).
- [ ] ADR written documenting the trust-escalation threat model and the chosen edit/gate model.
- [ ] Web console drawer shows effective `trust` / `unknown_sender` + source, with edit + reset-to-default.
- [ ] Existing deployments behave identically until an operator sets an override (yaml defaults preserved).

## Out of scope

- Per-sender or per-contact policy overrides (channel-level only).
- Changing the trust-scoring algorithm itself.
- Channel lifecycle / credentials (covered by #543).
