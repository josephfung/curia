# ADR-013: signal-cli daemon socket mode for Signal integration

Date: 2026-04-07
Status: Accepted

## Context

ADR-010 established Signal as the high-trust messaging channel. This ADR covers the lower-level
question of *how* to integrate with Signal from Node.js, given that Signal offers no official
bot or developer API.

Three options were evaluated:

**Option A — signal-cli as a managed child process (stdio)**
spawn signal-cli as a Node.js child process and communicate over stdin/stdout. The Node process
owns the lifecycle; if Node restarts, signal-cli restarts too.

**Option B — signal-cli in daemon mode, connected via Unix socket**
signal-cli runs as its own persistent service (e.g., a Docker Compose service). It exposes a
JSON-RPC socket. Curia connects as a client, reconnecting if the socket drops. The two processes
have independent lifecycles.

**Option C — Unofficial Node.js Signal libraries**
Libraries like `@throneless/libsignal` implement the Signal protocol natively in Node.js,
eliminating the external process dependency.

## Decision

**Option B (signal-cli daemon + Unix socket)** is adopted.

**Rationale for B over A:**
- signal-cli is a JVM process with its own memory model and connection state. Coupling it to
  Node's lifecycle means a Node crash drops the Signal session and forces re-registration or
  session recovery — a non-trivial operation. As a separate service, it stays up across
  application restarts, configuration reloads, and deployments.
- In the Docker Compose deployment (ceo-deploy), signal-cli runs as a dedicated service sharing
  a socket volume with Curia. This is the standard production pattern and cleanly maps to the
  architecture.
- Reconnection on the Curia side is cheap: re-open the socket, resume the notification stream.
  Reconnect on the signal-cli side is expensive: involves Signal protocol handshake.

**Rationale for B over C:**
- Unofficial Node.js Signal libraries are not production-ready. As of 2026-04, no actively
  maintained library implements the full Signal protocol (sealed sender, storage service,
  group messaging v2) without gaps or known security issues.
- Implementing the Signal protocol from scratch in Node.js would take months and require deep
  expertise in the Signal Protocol cryptography — not a reasonable investment for a single
  channel adapter.
- signal-cli is actively maintained, widely used in self-hosted Signal automation, and has a
  stable JSON-RPC API with a documented schema.

**Socket type:** Unix socket (same host/container, lowest overhead). TCP socket is supported
by signal-cli and can be used for unusual Docker networking, but the standard deployment uses
a shared named volume.

## Consequences

- **Java runtime dependency**: ceo-deploy must include a signal-cli container. This is the only
  JVM in the stack. Accepted trade-off — the alternative (Option C) would have been much larger
  scope.
- **One-time phone number registration**: a real phone number (physical SIM, eSIM, or compatible
  VoIP number such as Fongo/TextNow) is required. Registration is a one-time CLI operation in
  the signal-cli container. The registration data must be persisted in a Docker volume.
- **Socket volume**: the signal-cli socket path must be shared between the signal-cli container
  and the Curia container via a named volume. This is standard Docker Compose practice.
- **Reconnect logic in Curia**: the `SignalRpcClient` implements exponential-backoff reconnection
  so transient socket drops (e.g., signal-cli container restart) are recovered transparently.
- **VoIP number caveat**: Signal's anti-abuse system occasionally rejects VoIP numbers during
  registration. If a VoIP number fails, a physical SIM is the reliable fallback.
