# Curia Framework — Architecture Overview

**Date:** 2026-03-24
**Status:** Approved

## Spec Index

| # | Document | Scope |
|---|----------|-------|
| 00 | This file | Architecture, layers, bus, message flow, design principles |
| 01 | [Memory System](01-memory-system.md) | Knowledge graph, entity memory, working memory, Bullpen, embeddings |
| 02 | [Agent System](02-agent-system.md) | Agent definition, lifecycle, state, execution modes, LLM providers |
| 03 | [Skills & Execution](03-skills-and-execution.md) | Local skills, MCP, discovery, secrets, permissions |
| 04 | [Channels](04-channels.md) | Adapter interface, launch channels, message normalization |
| 05 | [Error Recovery](05-error-recovery.md) | Error budgets, state continuity, pattern detection, failure model |
| 06 | [Audit & Security](06-audit-and-security.md) | Audit log, redaction, tool sanitization, intent drift, security |
| 07 | [Scheduler](07-scheduler.md) | Job model, persistent tasks, burst execution |
| 08 | [Operations](08-operations.md) | Config, deployment, health checks, logging, project structure |

---

## Context

After auditing four open-source agent frameworks (agentsystems, Daemora, ForgeAI, Edict), all were found to be high-risk for production use — single-maintainer projects with no code review, thin tests, and immature architectures. The decision is to build a minimal custom framework ("Curia") purpose-built for a long-running, VPS-hosted executive assistant system.

The framework replaces the existing Zora dependency entirely (clean break). It lives in the `curia` repo (currently an empty scaffold) and deploys via the existing `ceo-deploy` infrastructure (Hetzner VPS, Docker Compose, Caddy).

**Zora migration:** No data migration. Zora's audit logs, policies, and dashboard state are discarded. The existing Zora container in `ceo-deploy` will be replaced with the new framework container. This is a conscious decision — Zora was an evaluation, not a production system with accumulated data worth preserving.

---

## Design Principles

1. **Hard security boundaries** — layers are physically prevented from unauthorized actions, not just organizationally separated
2. **Everything is auditable** — every event, decision, and inter-agent exchange is logged and traceable
3. **Memory-first** — sophisticated knowledge graph with temporal awareness, not just conversation logs
4. **Extensible by design** — new channels, skills, and agents added without touching core code
5. **Restart-safe** — all state lives in Postgres, no in-process state that dies with the process
6. **Single-tenant simplicity** — no multi-tenant complexity; deploy multiple VPS instances for multiple users
7. **Errors are recoverable** — agents resume with full context, not from scratch; failures are learning opportunities
8. **Observable by default** — structured logging, health endpoints, and audit trails from day one, not bolted on later

---

## Architecture: Message Bus Pattern

All communication flows through a central in-process message bus backed by Postgres for persistence. Each layer is a separate module that subscribes to and publishes typed messages. The bus enforces which event types each layer can publish.

```
┌─────────────────────────────────────────────────────┐
│                    Channel Layer                     │
│  (Signal, Telegram, Email, CLI, HTTP API)            │
│  Can ONLY publish: inbound.message, inbound.event    │
│  Can ONLY subscribe: outbound.message, outbound.event│
└──────────────────────┬──────────────────────────────┘
                       │ message bus
┌──────────────────────▼──────────────────────────────┐
│                   Dispatch Layer                     │
│  Routes inbound messages → correct agent             │
│  Routes agent.response → outbound.message            │
│  Enforces policy (rate limits, permissions, blocks)  │
│  Publishes: agent.task, outbound.message             │
│  Subscribes: inbound.message, agent.response         │
└──────────────────────┬──────────────────────────────┘
                       │ message bus
┌──────────────────────▼──────────────────────────────┐
│                    Agent Layer                       │
│  Executes tasks using LLM + skills                   │
│  Publishes: skill.invoke, memory.store, memory.query │
│  Publishes: agent.discuss, agent.response            │
│  Subscribes: agent.task, skill.result, agent.discuss │
└──────────────────────┬──────────────────────────────┘
                       │ message bus
┌──────────────────────▼──────────────────────────────┐
│                  Execution Layer                     │
│  Skills, tool runners, MCP clients                   │
│  Subscribes: skill.invoke                            │
│  Publishes: skill.result                             │
└─────────────────────────────────────────────────────┘

Cross-cutting subscribers (see ALL events):
  - Audit Logger → appends every event to audit_log table
  - Memory Engine → handles memory.store/query events
  - Scheduler → handles schedule.create/trigger events
```

### Bus Security Enforcement

The bus validates publisher authorization at registration time. A module registered as `layer: "channel"` can only publish event types in the channel allowlist (`inbound.message`, `inbound.event`). Attempting to publish `skill.invoke` throws an error. This is the hard security boundary — it's architectural, not policy.

### Event Routing (complete message flow)

Full round-trip for an inbound message:
1. Channel adapter publishes `inbound.message`
2. Dispatch layer (subscribed to `inbound.message`) evaluates policy, publishes `agent.task`
3. Agent (subscribed to `agent.task`) calls LLM, may publish `skill.invoke`
4. Execution layer (subscribed to `skill.invoke`) runs skill, publishes `skill.result`
5. Agent (subscribed to `skill.result`) incorporates result, publishes `agent.response`
6. Dispatch layer (subscribed to `agent.response`) translates to `outbound.message`
7. Channel adapter (subscribed to `outbound.message`) sends via platform API

Bullpen flow: Agent publishes `agent.discuss` → target agent (subscribed to `agent.discuss`) responds in the same thread.

### Bus Delivery Guarantees

**Write-ahead audit logging.** The audit logger writes events to Postgres *before* delivering to other subscribers. If the process crashes after audit write but before subscriber delivery, the event is logged but unprocessed — on restart, the system can replay unacknowledged events from the audit log. This gives at-least-once delivery for all events and exactly-once audit recording.

For launch, the replay mechanism is manual (operator can query unprocessed events). Automatic replay on startup is a future enhancement.

### Event Type Registry

All event types are defined as a TypeScript discriminated union — no `any` payloads, no string-typed event names without compile-time checking. Each event carries: `id` (UUID), `timestamp`, `type` (discriminant), `source_layer`, `source_id`, `parent_event_id?`, and a typed `payload`.

---

## Tech Stack

- **Runtime:** Node.js 22+ with TypeScript (ESM)
- **Database:** PostgreSQL 16+ with pgvector extension
- **LLM SDKs:** @anthropic-ai/sdk, openai, ollama
- **MCP:** @modelcontextprotocol/sdk (client)
- **HTTP:** Fastify (for HTTP API channel + dashboard endpoints)
- **Testing:** Vitest
- **Build:** tsup
- **Config:** YAML (js-yaml) with env var interpolation
- **Logging:** pino (structured JSON)
- **Migrations:** node-pg-migrate (plain SQL migrations, no ORM coupling)
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions), pgvector HNSW index

---

## What Is NOT In Scope (Launch)

- Multi-tenancy
- Web dashboard UI (HTTP API is ready for it, but no frontend yet)
- Memory decay engine (schema supports it, logic deferred)
- Voice/telephony channel
- Secrets vault (env vars behind ctx.secret() interface for now)
- Skill marketplace or versioning
- Automatic event replay on startup (manual query for now)
