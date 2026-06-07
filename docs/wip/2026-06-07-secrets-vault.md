# Encrypted Secrets Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an application-encrypted (AES-256-GCM) secrets vault stored in PostgreSQL that backs `ctx.secret()`, with env-var fallback for incremental migration.

**Architecture:** A new `src/secrets/` module with two units — `crypto.ts` (pure AES-256-GCM + key loading) and `secrets-service.ts` (DB-backed CRUD over an encrypted `secrets` table). The execution layer pre-warms each skill's declared secrets into a per-invocation map at the top of `invoke()`, so the existing synchronous `ctx.secret(name): string` API is preserved. Vault reads take precedence; missing entries fall back to `process.env`. The `secret.accessed` audit event gains an optional `source: 'vault' | 'env'` tag.

**Tech Stack:** TypeScript (ESM, Node 22+), `node:crypto`, raw `pg`, node-pg-migrate, Vitest. Spec: [docs/wip/2026-06-07-secrets-vault-design.md](2026-06-07-secrets-vault-design.md). Issue [#542](https://github.com/josephfung/curia/issues/542).

**Working directory:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault` (branch `feat/secrets-vault`). Run all `pnpm`/`git` via `--prefix` / `-C` against this path.

**Conventions to honor (from CLAUDE.md):**
- Run `pnpm --prefix <worktree> run typecheck` before each commit that touches `.ts`.
- ESM: `.js` extensions on all relative imports; `import.meta.dirname`; no `any`.
- Parameterized SQL only. No `console.log` (use the injected pino `logger`). No empty catches.
- Array element access (`rows[0]`) is `T | undefined` under strict null checks — guard or `!`.
- Commit messages: `feat:` / `fix:` / `chore:` style, **no Co-Authored-By, no Claude attribution**.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/secrets/crypto.ts` (create) | Pure AES-256-GCM `encrypt`/`decrypt`; `loadEncryptionKey()` |
| `src/secrets/crypto.test.ts` (create) | Unit tests for crypto + key loading (no DB) |
| `src/secrets/secrets-service.ts` (create) | DB-backed encrypted CRUD: `get`/`getJSON`/`set`/`setJSON`/`delete` |
| `tests/integration/secrets-service.test.ts` (create) | Integration tests (real Postgres, `describeIf(DATABASE_URL)`) |
| `src/db/migrations/050_create_secrets_vault.sql` (create) | `secrets` table |
| `src/bus/events.ts` (modify) | Add optional `source` to `SecretAccessedPayload` |
| `src/skills/execution.ts` (modify) | Add `secretsService` option; pre-warm cache; sync `ctx.secret` from cache |
| `src/skills/execution.test.ts` (modify) | Unit tests for pre-warm / fallback / audit-source |
| `src/index.ts` (modify) | Load key (hard-fail), construct + inject `SecretsService` |
| `scripts/setup.sh` (modify) | Auto-generate `SECRET_ENCRYPTION_KEY` |
| `.env.example` (modify) | Document `SECRET_ENCRYPTION_KEY` |
| `scripts/rotate-secret-key.ts` (create) | Re-encrypt all rows with a new key |
| `docs/adr/NNN-secrets-vault.md` (create) | ADR for the encryption approach |
| `docs/adr/README.md` (modify) | ADR index row |
| `CHANGELOG.md` (modify) | Unreleased entries |

---

## Task 1: Crypto module (pure, no DB)

**Files:**
- Create: `src/secrets/crypto.ts`
- Test: `src/secrets/crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/secrets/crypto.test.ts`:

```typescript
// Unit tests for the pure crypto layer — no DB, no env mutation beyond a local object.
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadEncryptionKey } from './crypto.js';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32);

describe('encrypt/decrypt', () => {
  it('round-trips plaintext', () => {
    const { ciphertext, iv } = encrypt('hunter2', KEY);
    expect(decrypt(ciphertext, iv, KEY)).toBe('hunter2');
  });

  it('round-trips unicode and long values', () => {
    const value = '🔐 '.repeat(1000);
    const { ciphertext, iv } = encrypt(value, KEY);
    expect(decrypt(ciphertext, iv, KEY)).toBe(value);
  });

  it('uses a fresh IV per call (same plaintext encrypts differently)', () => {
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws on decrypt with the wrong key (does not return garbage)', () => {
    const { ciphertext, iv } = encrypt('secret', KEY);
    expect(() => decrypt(ciphertext, iv, randomBytes(32))).toThrow();
  });

  it('throws on tampered ciphertext (GCM auth failure)', () => {
    const { ciphertext, iv } = encrypt('secret', KEY);
    const raw = Buffer.from(ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff; // flip a bit
    expect(() => decrypt(raw.toString('base64'), iv, KEY)).toThrow();
  });
});

describe('loadEncryptionKey', () => {
  it('returns a 32-byte Buffer for a valid base64 key', () => {
    const env = { SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    expect(loadEncryptionKey(env).length).toBe(32);
  });

  it('throws with a generate hint when the key is missing', () => {
    expect(() => loadEncryptionKey({})).toThrow(/openssl rand -base64 32/);
  });

  it('throws when the key does not decode to exactly 32 bytes', () => {
    const env = { SECRET_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64') };
    expect(() => loadEncryptionKey(env)).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run src/secrets/crypto.test.ts`
Expected: FAIL — `Cannot find module './crypto.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/secrets/crypto.ts`:

```typescript
// Pure AES-256-GCM encryption helpers and key loading for the secrets vault.
// No DB, no logging, no global state — deliberately trivial to unit-test.
//
// Wire format for `encrypted_value`: base64( ciphertext-bytes || 16-byte GCM auth tag ).
// The IV is stored separately (base64) and is a fresh 12 random bytes per write.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;        // 96-bit nonce — the standard/recommended size for GCM
const AUTH_TAG_BYTES = 16;  // 128-bit GCM tag
const GENERATE_HINT = 'Generate one with: openssl rand -base64 32';

/** Encrypt a UTF-8 string. Returns base64 ciphertext (with appended auth tag) and base64 IV. */
export function encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** Decrypt. Throws on a wrong key or tampered ciphertext (GCM auth failure) — never returns garbage. */
export function decrypt(ciphertext: string, iv: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, 'base64');
  // Split the appended auth tag off the end.
  const authTag = data.subarray(data.length - AUTH_TAG_BYTES);
  const encrypted = data.subarray(0, data.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Load the master encryption key from the environment. Required at startup —
 * a missing or malformed key is a hard failure (fail closed). The vault stores
 * a 32-byte AES-256 key as base64.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(`SECRET_ENCRYPTION_KEY environment variable is required. ${GENERATE_HINT}`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ${GENERATE_HINT}`,
    );
  }
  return key;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run src/secrets/crypto.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/secrets/crypto.ts src/secrets/crypto.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: AES-256-GCM crypto helpers for secrets vault (#542)"
```

---

## Task 2: Migration — `secrets` table

**Files:**
- Create: `src/db/migrations/050_create_secrets_vault.sql`

- [ ] **Step 1: Verify 050 is the next free prefix**

Run: `ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault/src/db/migrations/ | sort | tail -3`
Expected: highest existing is `049_promote_agent_tasks_to_tasks.sql`. If a `050_*` already exists (rebase landed one), use the next free number and update every `050` reference in this plan.

- [ ] **Step 2: Write the migration**

Create `src/db/migrations/050_create_secrets_vault.sql`:

```sql
-- Up Migration
-- Encrypted secrets vault (spec: docs/wip/2026-06-07-secrets-vault-design.md, #542).
-- Values are AES-256-GCM ciphertext written by the application layer; the DB never
-- sees plaintext. `value_format` is structural (how to decode), not semantic — an
-- OAuth token set or a browser session is simply a 'json' value owned by its consumer.

CREATE TABLE secrets (
  name            TEXT PRIMARY KEY,
  value_format    TEXT NOT NULL CHECK (value_format IN ('string', 'json')),
  encrypted_value TEXT NOT NULL,  -- base64( AES-256-GCM ciphertext || 16-byte auth tag )
  iv              TEXT NOT NULL,  -- base64, fresh 12 bytes per write
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE secrets;
```

- [ ] **Step 3: Apply the migration locally**

The migration runs automatically at app startup, but apply it now so the Task 3 integration test has the table. With the worktree `.env` providing `DATABASE_URL` and the Postgres container up:

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run migrate`
Expected: log line showing `050_create_secrets_vault` applied. (If `run migrate` is not a script, check `package.json` scripts for the migrate command and use that.)

Verify: `psql "$DATABASE_URL" -c '\d secrets'` (or any DB client) shows the table.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/db/migrations/050_create_secrets_vault.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: add secrets vault table migration (#542)"
```

---

## Task 3: SecretsService (DB-backed CRUD)

**Files:**
- Create: `src/secrets/secrets-service.ts`
- Test: `tests/integration/secrets-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/secrets-service.test.ts`:

```typescript
// Integration tests — require a live Postgres with migrations applied.
// Skips automatically when DATABASE_URL is unset (CI without Postgres).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { SecretsService } from '../../src/secrets/secrets-service.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
const KEY = randomBytes(32);

describeIf('SecretsService', () => {
  let pool: pg.Pool;
  let service: SecretsService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM secrets LIMIT 0'); // sanity: migration applied
    service = new SecretsService(pool, KEY, logger);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM secrets WHERE name LIKE 'test_%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  it('set then get round-trips a string', async () => {
    await service.set('test_api_key', 'tok-123');
    expect(await service.get('test_api_key')).toBe('tok-123');
  });

  it('stores ciphertext, not plaintext', async () => {
    await service.set('test_api_key', 'tok-123');
    const { rows } = await pool.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM secrets WHERE name = $1', ['test_api_key']);
    expect(rows[0]!.encrypted_value).not.toContain('tok-123');
  });

  it('get returns null for a missing secret', async () => {
    expect(await service.get('test_absent')).toBeNull();
  });

  it('setJSON then getJSON round-trips an OAuth-shaped object', async () => {
    const tokens = { access_token: 'a', refresh_token: 'r', expiry: 123, scope: 's' };
    await service.setJSON('test_oauth', tokens);
    expect(await service.getJSON('test_oauth')).toEqual(tokens);
  });

  it('setJSON then getJSON round-trips a browser-session-shaped object', async () => {
    const state = { cookies: [{ name: 'sid', value: 'x' }], origins: [] };
    await service.setJSON('test_session', state);
    expect(await service.getJSON('test_session')).toEqual(state);
  });

  it('get on a json row returns the serialized text', async () => {
    await service.setJSON('test_json', { a: 1 });
    expect(await service.get('test_json')).toBe('{"a":1}');
  });

  it('getJSON on a string row throws a format mismatch', async () => {
    await service.set('test_str', 'plain');
    await expect(service.getJSON('test_str')).rejects.toThrow(/expected 'json'/);
  });

  it('set overwrites an existing secret (upsert) with a fresh IV', async () => {
    await service.set('test_rot', 'v1');
    const first = await pool.query<{ iv: string }>('SELECT iv FROM secrets WHERE name = $1', ['test_rot']);
    await service.set('test_rot', 'v2');
    const second = await pool.query<{ iv: string }>('SELECT iv FROM secrets WHERE name = $1', ['test_rot']);
    expect(await service.get('test_rot')).toBe('v2');
    expect(second.rows[0]!.iv).not.toBe(first.rows[0]!.iv);
  });

  it('delete removes the row', async () => {
    await service.set('test_del', 'x');
    await service.delete('test_del');
    expect(await service.get('test_del')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run tests/integration/secrets-service.test.ts`
Expected: FAIL — `Cannot find module '../../src/secrets/secrets-service.js'`. (If `DATABASE_URL` is unset the suite is skipped — set it / start Postgres so the test actually runs.)

- [ ] **Step 3: Write the implementation**

Create `src/secrets/secrets-service.ts`:

```typescript
// secrets-service.ts — DB-backed, application-encrypted secrets store.
//
// Values are AES-256-GCM encrypted before write and decrypted on read; the DB
// never holds plaintext. `value_format` is structural (how to decode the value),
// never semantic — OAuth token sets and browser sessions are just 'json' secrets
// whose shape is a convention owned by their consumer. The service does NOT fire
// audit events; the execution-layer ctx.secret() closure remains the audit boundary.
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { encrypt, decrypt } from './crypto.js';

export type ValueFormat = 'string' | 'json';

export class SecretsService {
  constructor(
    private readonly pool: DbPool,
    private readonly key: Buffer,
    private readonly logger: Logger,
  ) {}

  /** Decrypt and return the raw string value, or null if no such secret. Works for any format. */
  async get(name: string): Promise<string | null> {
    const result = await this.pool.query<{ encrypted_value: string; iv: string }>(
      'SELECT encrypted_value, iv FROM secrets WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    // A decrypt failure (wrong key / corrupt row) is a real, loud problem — let it propagate.
    return decrypt(row.encrypted_value, row.iv, this.key);
  }

  /** Decrypt + JSON.parse a 'json' secret. Throws if the row is not 'json'. Null if missing. */
  async getJSON<T>(name: string): Promise<T | null> {
    const result = await this.pool.query<{ encrypted_value: string; iv: string; value_format: ValueFormat }>(
      'SELECT encrypted_value, iv, value_format FROM secrets WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.value_format !== 'json') {
      throw new Error(`Secret '${name}' has value_format '${row.value_format}', expected 'json'`);
    }
    return JSON.parse(decrypt(row.encrypted_value, row.iv, this.key)) as T;
  }

  /** Encrypt and upsert a string secret. */
  async set(name: string, value: string): Promise<void> {
    const { ciphertext, iv } = encrypt(value, this.key);
    await this.upsert(name, 'string', ciphertext, iv);
  }

  /** JSON-serialize, encrypt, and upsert a structured secret. */
  async setJSON(name: string, obj: unknown): Promise<void> {
    const { ciphertext, iv } = encrypt(JSON.stringify(obj), this.key);
    await this.upsert(name, 'json', ciphertext, iv);
  }

  /** Remove a secret. No error if it does not exist. */
  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM secrets WHERE name = $1', [name]);
  }

  private async upsert(name: string, format: ValueFormat, ciphertext: string, iv: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO secrets (name, value_format, encrypted_value, iv, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (name) DO UPDATE
         SET value_format = EXCLUDED.value_format,
             encrypted_value = EXCLUDED.encrypted_value,
             iv = EXCLUDED.iv,
             updated_at = now()`,
      [name, format, ciphertext, iv],
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run tests/integration/secrets-service.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/secrets/secrets-service.ts tests/integration/secrets-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: SecretsService encrypted CRUD over secrets table (#542)"
```

---

## Task 4: Add `source` to the `secret.accessed` event

**Files:**
- Modify: `src/bus/events.ts:459-464` (the `SecretAccessedPayload` interface)

- [ ] **Step 1: Add the optional field**

In `src/bus/events.ts`, change the `SecretAccessedPayload` interface (currently lines 459-464) to add `source`:

```typescript
interface SecretAccessedPayload {
  skillName: string;
  secretName: string;     // the declared key name — never the resolved value
  agentId?: string;       // agent that invoked the skill
  taskEventId?: string;   // causal chain: the agent.task that triggered this invocation
  // Where the value was resolved from. Optional for backward compatibility; lets the
  // audit trail show migration progress as secrets move from env to the vault (#542).
  source?: 'vault' | 'env';
}
```

No change to `createSecretAccessed()` is needed — it spreads the whole payload, so the new optional field flows through automatically.

- [ ] **Step 2: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors (the field is optional; existing callers compile unchanged).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: add optional source tag to secret.accessed event (#542)"
```

---

## Task 5: Execution-layer pre-warm cache + sync `ctx.secret`

This is the only change to the existing hot path. It (a) adds a `secretsService` constructor option, (b) pre-warms declared secrets into a per-invocation map, and (c) reads `ctx.secret()` from that map synchronously, preserving exact current throw semantics including lazy-throw-on-access.

**Files:**
- Modify: `src/skills/execution.ts` (field + constructor option ~lines 81-162; pre-warm + closure ~lines 488-524)
- Test: `src/skills/execution.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `src/skills/execution.test.ts`. Add `SecretsService` to imports at the top first:

```typescript
import type { SecretsService } from '../secrets/secrets-service.js';
```

Then append this block at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// secret resolution: vault-first with env fallback + audit source tag
// ---------------------------------------------------------------------------
describe('ctx.secret resolution', () => {
  // Manifest that declares a secret and a handler that reads it.
  function makeSecretManifest(name: string, secretKey: string): SkillManifest {
    return { ...makeManifest(name), secrets: [secretKey] };
  }
  function makeSecretReadingHandler(secretKey: string): { handler: SkillHandler; read: () => string | undefined } {
    let read: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        read = (ctx as SkillContext).secret(secretKey);
        return { success: true, data: 'ok' };
      }),
    };
    return { handler, read: () => read };
  }
  // publish must return a resolved promise — the closure calls .catch() on it.
  function makeBus(): EventBus {
    return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
  }

  it('reads from the vault when present and tags source=vault', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('vault-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue('from-vault') } as unknown as SecretsService;
    const bus = makeBus();
    const layer = new ExecutionLayer(registry, logger, { bus, secretsService });

    const result = await layer.invoke('vault-skill', {}, undefined, { agentId: 'agent-1' });

    expect(result.success).toBe(true);
    expect(read()).toBe('from-vault');
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[1]).find(e => e.type === 'secret.accessed');
    expect(event.payload.source).toBe('vault');
  });

  it('falls back to env when the vault has no entry and tags source=env', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('env-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue(null) } as unknown as SecretsService;
    const bus = makeBus();
    process.env.TAVILY_API_KEY = 'from-env';
    try {
      const layer = new ExecutionLayer(registry, logger, { bus, secretsService });
      const result = await layer.invoke('env-skill', {});
      expect(result.success).toBe(true);
      expect(read()).toBe('from-env');
      const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
        .map(c => c[1]).find(e => e.type === 'secret.accessed');
      expect(event.payload.source).toBe('env');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('works with no secretsService wired (env-only, current behavior)', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('legacy-skill', 'tavily_api_key'), handler);
    process.env.TAVILY_API_KEY = 'legacy-env';
    try {
      const layer = new ExecutionLayer(registry, logger, { bus: makeBus() });
      const result = await layer.invoke('legacy-skill', {});
      expect(result.success).toBe(true);
      expect(read()).toBe('legacy-env');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('throws (in-handler) when an undeclared secret is requested', async () => {
    const registry = new SkillRegistry();
    let caught: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        try { (ctx as SkillContext).secret('not_declared'); }
        catch (e) { caught = (e as Error).message; }
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeSecretManifest('decl-skill', 'tavily_api_key'), handler);
    const layer = new ExecutionLayer(registry, logger, { bus: makeBus() });
    await layer.invoke('decl-skill', {});
    expect(caught).toMatch(/not declared in the manifest/);
  });

  it('throws (in-handler) when a declared secret is set nowhere', async () => {
    const registry = new SkillRegistry();
    let caught: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        try { (ctx as SkillContext).secret('tavily_api_key'); }
        catch (e) { caught = (e as Error).message; }
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeSecretManifest('missing-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue(null) } as unknown as SecretsService;
    delete process.env.TAVILY_API_KEY;
    const layer = new ExecutionLayer(registry, logger, { bus: makeBus(), secretsService });
    await layer.invoke('missing-skill', {});
    expect(caught).toMatch(/declared but not set/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run src/skills/execution.test.ts -t "ctx.secret resolution"`
Expected: FAIL — `secretsService` is not a valid option / source is undefined.

- [ ] **Step 3: Add the field and constructor option**

In `src/skills/execution.ts`, add a private field near the other service fields (after line 81 `autonomyService`):

```typescript
  private secretsService?: import('../secrets/secrets-service.js').SecretsService;
```

Add to the constructor `options` type (after `autonomyService?: AutonomyService;`, ~line 115):

```typescript
    secretsService?: import('../secrets/secrets-service.js').SecretsService;
```

Add the assignment in the constructor body (after `this.autonomyService = options?.autonomyService;`, ~line 145):

```typescript
    this.secretsService = options?.secretsService;
```

- [ ] **Step 4: Add the pre-warm cache and rewrite the closure**

In `src/skills/execution.ts`, replace the block that currently builds `declaredSecrets` and the `secret:` closure (currently lines 490-524). Replace from:

```typescript
    const declaredSecrets = new Set(manifest.secrets);
    const ctx: SkillContext = {
      input,
      secret: (name: string): string => {
```
...through the end of that closure (the `return value;\n      },` at line 524) with:

```typescript
    const declaredSecrets = new Set(manifest.secrets);

    // Pre-warm declared secrets into a synchronous-access map so ctx.secret() can
    // remain synchronous while the underlying vault read is async (#542). Vault
    // takes precedence; missing entries fall back to process.env during the
    // migration period. A vault read error is captured and re-thrown only if the
    // skill actually accesses that secret — eagerly throwing here would abort the
    // invocation over a declared-but-unused secret, changing the lazy-throw contract.
    type SecretEntry = { value: string; source: 'vault' | 'env' } | { error: Error };
    const secretCache = new Map<string, SecretEntry>();
    for (const name of manifest.secrets) {
      try {
        const vaultValue = this.secretsService ? await this.secretsService.get(name) : null;
        if (vaultValue !== null) {
          secretCache.set(name, { value: vaultValue, source: 'vault' });
          continue;
        }
      } catch (err) {
        skillLogger.error({ err, secretName: name }, 'vault read failed for declared secret; deferring error to access time');
        secretCache.set(name, { error: err instanceof Error ? err : new Error(String(err)) });
        continue;
      }
      // Env vars are uppercase by convention; manifest keys are lowercase.
      // e.g. manifest "tavily_api_key" → reads process.env.TAVILY_API_KEY
      const envValue = process.env[name.toUpperCase()];
      if (envValue) {
        secretCache.set(name, { value: envValue, source: 'env' });
      }
      // Missing in both vault and env → not added; ctx.secret() throws lazily on access.
    }

    const ctx: SkillContext = {
      input,
      secret: (name: string): string => {
        if (!declaredSecrets.has(name)) {
          throw new Error(`Secret '${name}' is not declared in the manifest for skill '${skillName}'`);
        }
        const entry = secretCache.get(name);
        if (!entry) {
          // Declared but resolved nowhere (vault + env both empty) — unchanged message.
          throw new Error(`Secret '${name}' is declared but not set in the environment`);
        }
        if ('error' in entry) {
          throw entry.error; // deferred vault read failure
        }
        // Audit log — fire-and-forget so ctx.secret() stays synchronous.
        // Records skill name, secret name, source, and causal IDs — never the secret value.
        // Falls back to debug-only logging if the bus is not wired (e.g. test environments).
        if (this.bus) {
          this.bus.publish('execution', createSecretAccessed({
            skillName,
            secretName: name,
            agentId: options?.agentId,
            taskEventId: options?.taskEventId,
            source: entry.source,
          })).catch((err) => {
            skillLogger.error(
              { err, secretName: name, skillName, agentId: options?.agentId, taskEventId: options?.taskEventId },
              'AUDIT FAILURE: secret.accessed event could not be published — secret was returned but access may not be recorded',
            );
          });
        }
        skillLogger.debug({ secretName: name, source: entry.source }, 'Secret accessed');
        return entry.value;
      },
```

Leave the rest of the `ctx` object (from `log: skillLogger,` onward) unchanged.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run src/skills/execution.test.ts -t "ctx.secret resolution"`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full execution test file (no regressions)**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec vitest run src/skills/execution.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/skills/execution.ts src/skills/execution.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: vault-first secret resolution with env fallback in execution layer (#542)"
```

---

## Task 6: Startup wiring (load key, construct + inject SecretsService)

**Files:**
- Modify: `src/index.ts` (imports; key load + service construction near lines 219-223; inject into ExecutionLayer at ~line 1324)

- [ ] **Step 1: Add imports**

In `src/index.ts`, near the other imports (e.g. after the `createPool` import at line 25), add:

```typescript
import { loadEncryptionKey } from './secrets/crypto.js';
import { SecretsService } from './secrets/secrets-service.js';
```

- [ ] **Step 2: Load the key (hard-fail) and construct the service**

In `src/index.ts`, immediately after the DB connection probe succeeds and before `new AutonomyService` (currently around line 220-223), insert:

```typescript
  // Secrets vault — load the master key (fail closed) and construct the service (#542).
  // A missing/malformed SECRET_ENCRYPTION_KEY is a hard startup failure: the vault is a
  // core security primitive, so we never boot in a half-initialized, can't-decrypt state.
  let secretEncryptionKey: Buffer;
  try {
    secretEncryptionKey = loadEncryptionKey();
  } catch (err) {
    logger.fatal({ err }, 'SECRET_ENCRYPTION_KEY is missing or invalid');
    process.exit(1);
  }
  const secretsService = new SecretsService(pool, secretEncryptionKey, logger);
```

- [ ] **Step 3: Inject into ExecutionLayer**

In `src/index.ts`, find the `new ExecutionLayer(...)` call (currently line 1324). Add `secretsService` to the options object (place it next to `autonomyService,`):

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, secretsService, executiveProfileService, officeIdentityService, browserService, bullpenService, approvalTrigger, actionLogRepo, taskRepo, confidencePipeline, tempFileStore, infraLlmService, outboundContextService, timezone: config.timezone, selfEmail: resolvedEmailAccounts[0]?.selfEmail, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength, defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs });
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors.

- [ ] **Step 5: Smoke-test startup behavior**

Confirm the hard-fail works. With the worktree `.env` temporarily missing the key:

Run: `SECRET_ENCRYPTION_KEY= pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault exec tsx src/index.ts`
Expected: process logs a fatal `SECRET_ENCRYPTION_KEY is missing or invalid` and exits non-zero. (Stop it if it somehow proceeds.)

Then confirm a valid key boots past that point (the worktree `.env` is symlinked to the main checkout; ensure it has a `SECRET_ENCRYPTION_KEY` — add one with `openssl rand -base64 32` to the main `.env` if absent; do NOT edit `repos/curia` via this worktree). Booting fully is not required — reaching past the key check is enough; Ctrl-C after.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: require SECRET_ENCRYPTION_KEY at startup and wire SecretsService (#542)"
```

---

## Task 7: Setup script + `.env.example`

**Files:**
- Modify: `scripts/setup.sh` (`generate_secrets()` ~line 109; `write_env()` ~line 124)
- Modify: `.env.example` (near `API_TOKEN`, line 33)

- [ ] **Step 1: Generate the key in `generate_secrets()`**

In `scripts/setup.sh`, inside `generate_secrets()` (after the `WEB_APP_BOOTSTRAP_SECRET` line, ~line 113), add. Note `-base64` (the loader expects base64-decoded 32 bytes), not `-hex`:

```bash
    SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

- [ ] **Step 2: Template it in `write_env()`**

In `scripts/setup.sh`, inside `write_env()` (in the `sed` list, after the `WEB_APP_BOOTSTRAP_SECRET` substitution, ~line 132), add a substitution line. Use `|` delimiters as the surrounding lines do (base64 can contain `/` and `+` but not `|`):

```bash
        -e "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}|" \
```

- [ ] **Step 3: Add the var to `.env.example`**

In `.env.example`, after the `API_TOKEN` line (line 33), add:

```bash

# Secrets vault master key — encrypts all stored secrets (AES-256-GCM). REQUIRED.
# 32 random bytes, base64-encoded. Generate: openssl rand -base64 32
# `pnpm run setup` fills this in automatically.
SECRET_ENCRYPTION_KEY=replace-with-output-of-openssl-rand-base64-32
```

- [ ] **Step 4: Verify the setup script is syntactically valid**

Run: `bash -n /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault/scripts/setup.sh`
Expected: no output (valid syntax).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add scripts/setup.sh .env.example
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "chore: auto-generate SECRET_ENCRYPTION_KEY in setup (#542)"
```

---

## Task 8: Key rotation script + runbook

**Files:**
- Create: `scripts/rotate-secret-key.ts`
- Reference: check `scripts/` for an existing `.ts` script's shebang/run convention before finalizing.

- [ ] **Step 1: Write the rotation script**

Create `scripts/rotate-secret-key.ts`:

```typescript
// Re-encrypt every row in the `secrets` table from an OLD key to a NEW key.
//
// Usage:
//   SECRET_ENCRYPTION_KEY_OLD=<base64> SECRET_ENCRYPTION_KEY_NEW=<base64> \
//     DATABASE_URL=<url> pnpm exec tsx scripts/rotate-secret-key.ts
//
// Runs in a single transaction: if anything fails, nothing changes — rerun safely.
// After it succeeds, set SECRET_ENCRYPTION_KEY to the NEW value and restart.
import pg from 'pg';
import { encrypt, decrypt } from '../src/secrets/crypto.js';

function loadKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required (base64-encoded 32 bytes)`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes, got ${key.length}`);
  return key;
}

async function main(): Promise<void> {
  const oldKey = loadKey('SECRET_ENCRYPTION_KEY_OLD');
  const newKey = loadKey('SECRET_ENCRYPTION_KEY_NEW');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ name: string; encrypted_value: string; iv: string }>(
      'SELECT name, encrypted_value, iv FROM secrets FOR UPDATE',
    );
    for (const row of rows) {
      const plaintext = decrypt(row.encrypted_value, row.iv, oldKey);
      const reencrypted = encrypt(plaintext, newKey);
      await client.query(
        'UPDATE secrets SET encrypted_value = $1, iv = $2, updated_at = now() WHERE name = $3',
        [reencrypted.ciphertext, reencrypted.iv, row.name],
      );
    }
    await client.query('COMMIT');
    // eslint-disable-next-line no-console -- standalone CLI script, not the app runtime
    console.log(`Rotated ${rows.length} secret(s). Update SECRET_ENCRYPTION_KEY to the new value and restart.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- standalone CLI script
  console.error('Key rotation failed:', err);
  process.exit(1);
});
```

Note: if the repo's lint config forbids `console` even in `scripts/`, check how existing `scripts/*.ts` emit output and match that (some use `process.stdout.write`). Adjust the two `console` lines accordingly.

- [ ] **Step 2: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Expected: no errors.

- [ ] **Step 3: Add a runbook note**

Append a "Rotating the secrets vault key" subsection to `docs/dev/configuration.md` (the file that documents env vars — confirm it exists; if not, add to `docs/dev/setup.md`):

```markdown
## Rotating the secrets vault key

`SECRET_ENCRYPTION_KEY` encrypts all stored secrets. To rotate it:

1. Generate a new key: `openssl rand -base64 32`
2. Re-encrypt existing rows (single transaction, safe to rerun):
   ```bash
   SECRET_ENCRYPTION_KEY_OLD="$CURRENT_KEY" \
   SECRET_ENCRYPTION_KEY_NEW="$NEW_KEY" \
   DATABASE_URL="$DATABASE_URL" \
   pnpm exec tsx scripts/rotate-secret-key.ts
   ```
3. Set `SECRET_ENCRYPTION_KEY` to the new value in `.env`.
4. Restart the app.

If the process is interrupted, the transaction rolls back — the old key still
decrypts everything, so just rerun.
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add scripts/rotate-secret-key.ts docs/dev/configuration.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "feat: secrets vault key rotation script + runbook (#542)"
```

---

## Task 9: ADR

**Files:**
- Create: `docs/adr/NNN-secrets-vault.md` (next free number)
- Modify: `docs/adr/README.md` (index row)

- [ ] **Step 1: Determine the next ADR number and read the template**

Run: `ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault/docs/adr/ | sort`
Read `docs/adr/template.md` and the most recent ADR to match the format. Use the next free `NNN`.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/NNN-secrets-vault.md` following the template. Capture, in the project's ADR style:
- **Context:** env-var-per-secret can't rotate without redeploy, can't hold runtime OAuth tokens; plaintext secrets on disk flagged as a real exposure.
- **Decision:** application-layer AES-256-GCM vault in PostgreSQL, single `SECRET_ENCRYPTION_KEY`; **structural** value typing (`string`|`json`), not semantic (no `oauth` type); synchronous `ctx.secret()` preserved via per-invocation pre-warm; env fallback for incremental migration.
- **Alternatives rejected:** external KMS/HashiCorp Vault (heavier ops, deferred — interface keeps it swappable); a dedicated `oauth_tokens` table and an `oauth` type (bakes consumer semantics into storage; every new structured secret would need a migration); making `ctx.secret()` async (breaks ~15 skills); envelope/multi-key encryption (unneeded for a single-operator deploy).
- **Consequences:** one env var unlocks everything (documented rotation path); a DB dump without the key reveals nothing; `secret.accessed` gains a `source` tag; migrating existing secrets is a follow-up (#911).

- [ ] **Step 3: Add the index row**

Add a row for the new ADR to `docs/adr/README.md`, matching the existing table format.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add docs/adr/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "docs: ADR for encrypted secrets vault (#542)"
```

---

## Task 10: Changelog + full verification

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Add changelog entries**

Under `## [Unreleased]` in `CHANGELOG.md`, add (creating the **Added**/**Changed** subsections if absent):

```markdown
### Added
- **Secrets vault** — encrypted (AES-256-GCM) secrets storage in PostgreSQL backing `ctx.secret()`, with env-var fallback for incremental migration. `SECRET_ENCRYPTION_KEY` is required at startup and auto-generated by setup. (#542)

### Changed
- **`secret.accessed` event** — gains an optional `source` (`vault`|`env`) field showing where each secret resolved from. Public bus-event surface. (#542)
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault test`
Expected: all pass (integration tests need `DATABASE_URL` + migrations applied; otherwise they skip — ensure the vault integration test actually ran, not skipped).

- [ ] **Step 3: Final typecheck + migration-order check**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault run typecheck`
Run: `ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault/src/db/migrations/ | sort` — confirm every numeric prefix is unique (no duplicate `050`).
Expected: no type errors; unique migration prefixes.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-secrets-vault commit -m "docs: changelog for secrets vault (#542)"
```

---

## Pre-PR review (per global CLAUDE.md)

Before opening the PR, run in parallel and address high-priority findings:
- `pr-review-toolkit:code-reviewer` (branch vs `main`)
- `pr-review-toolkit:silent-failure-hunter`
- Security review (this touches encryption + credential storage) — required here.

Then open the PR with `Closes #542` in the Summary. Confirm CI started (`gh run list --branch feat/secrets-vault --limit 1`) and report the PR URL + CI status.

---

## Self-Review (plan author)

**Spec coverage:** secrets table ✓(T2); AES-256-GCM encrypt/decrypt ✓(T1); key required at startup ✓(T1 loader, T6 wiring + smoke); `ctx.secret` vault-first + env fallback ✓(T5); structural `value_format` not `oauth` type ✓(T2/T3); JSON secrets store OAuth/browser shapes ✓(T3); audit `source` tag ✓(T4/T5); rotation script + doc ✓(T8); setup auto-gen ✓(T7); ADR ✓(T9); changelog ✓(T10). OAuth refresh logic — intentionally out of scope per spec ✓.

**Placeholder scan:** `NNN` for ADR/migration numbers is a deliberate "compute the next free number" instruction with an exact command, not a vague TODO. No "add error handling"-style hand-waving — every code step shows the code.

**Type consistency:** `loadEncryptionKey`, `encrypt`, `decrypt`, `SecretsService.{get,getJSON,set,setJSON,delete}`, `ValueFormat`, the `SecretEntry` union, and the `source` field name are used identically across Tasks 1, 3, 4, 5, 6, and 8.
