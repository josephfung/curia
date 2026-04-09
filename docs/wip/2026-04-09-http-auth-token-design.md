# HTTP API Channel: Token-Based Authentication

**Issue:** josephfung/curia#189
**Date:** 2026-04-09

---

## Background

The HTTP API channel is how external clients (dashboards, mobile apps, integrations) send messages to Curia. Without authentication, any process that can reach the HTTP port can inject messages into the bus. The security spec assigns `medium` trust to this channel, contingent on tokens being secured.

Most of the implementation already exists: `validateBearerToken()` with timing-safe comparison, the `onRequest` auth hook returning 401, and `API_TOKEN` env var config. Three gaps remain.

---

## What's Missing

### 1. Failed auth logging

The `onRequest` hook in `http-adapter.ts` returns 401 silently — no log entry. The issue requires auth failures to be audit-logged with source IP, timestamp, and the failure reason (not the token value).

**Implementation:** Add a `logger.warn` call before the 401 reply with `{ ip: request.ip, route: routeUrl, reason: 'missing_token' | 'invalid_token' }`. Timestamp comes from pino automatically.

### 2. `trustLevel: 'medium'` in message metadata

Authenticated HTTP messages carry no trust signal in the bus event. The HTTP channel's structural trust level is `medium` (token-based auth, low spoofing risk when tokens are secured). Future work will compute `messageTrustScore` from `trustLevel` + `contactConfidence` + content risk; for now, the channel tags messages with its structural level.

**Implementation:** In `messages.ts`, pass `metadata: { trustLevel: 'medium' }` when calling `createInboundMessage`. Uses the existing optional `metadata: Record<string, unknown>` field on `InboundMessagePayload` — no schema changes required.

### 3. Integration test for auth middleware

The existing `http-api.test.ts` builds a raw Fastify app with just routes (no auth hook). Auth middleware is only in `HttpAdapter` and is untested end-to-end.

**Implementation:** Add a new `describe` block in `http-api.test.ts` using `HttpAdapter` directly (or a minimal Fastify app that registers the same `onRequest` hook). Test three cases:
- No `Authorization` header → 401
- Wrong token → 401
- Valid `Bearer <token>` → 200 (message accepted)

The test should skip `/api/health` (exempt from auth per existing code) to confirm the exemption still works.

---

## What's NOT changing

- `validateBearerToken()` — one change: added an empty-token guard (`if (!provided) return false`) to explicitly reject `"Bearer "` with no token value
- Token config — `API_TOKEN` env var already works; `config/default.yaml` doesn't store secrets (it's committed to git), so env var is the correct and only mechanism
- Auth-disabled path when `API_TOKEN` is unset — stays as-is for local dev
- No changes to `InboundMessagePayload` type or `createInboundMessage` factory — `metadata` already accepts arbitrary key/value pairs

---

## Files Affected

| File | Change |
|---|---|
| `src/channels/http/http-adapter.ts` | Add `logger.warn` on auth failure |
| `src/channels/http/routes/messages.ts` | Pass `metadata: { trustLevel: 'medium' }` |
| `tests/integration/http-api.test.ts` | Add auth test suite |
