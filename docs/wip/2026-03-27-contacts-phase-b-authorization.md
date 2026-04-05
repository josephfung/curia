# Contacts Phase B — Authorization Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic authorization enforcement to the contact system — contact status (confirmed/provisional/blocked), role-based permissions, per-contact overrides, channel trust gating, and 3 new skills.

**Architecture:** Authorization is a 3-layer deterministic check: per-contact overrides → role defaults → channel trust. The `AuthorizationService` evaluates permissions and injects the result into the coordinator's context. The execution layer enforces permissions on skill invocations. Email-created contacts start as `provisional` until the CEO confirms them.

**Tech Stack:** TypeScript/ESM, PostgreSQL (migration for status column), YAML configs (role-defaults, permissions), vitest

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/contacts/authorization.ts` | AuthorizationService — deterministic 3-layer permission check |
| `src/contacts/config-loader.ts` | Loads role-defaults.yaml + permissions.yaml at boot |
| `config/role-defaults.yaml` | Default permissions/denials per role |
| `config/permissions.yaml` | Permission registry with sensitivity levels |
| `config/channel-trust.yaml` | Channel → trust level mapping |
| `src/db/migrations/006_add_contact_status.sql` | Add `status` column to contacts table |
| `skills/contact-grant-permission/skill.json` | Manifest for grant-permission skill |
| `skills/contact-grant-permission/handler.ts` | Handler for grant-permission skill |
| `skills/contact-revoke-permission/skill.json` | Manifest for revoke-permission skill |
| `skills/contact-revoke-permission/handler.ts` | Handler for revoke-permission skill |
| `skills/contact-unlink-identity/skill.json` | Manifest for unlink-identity skill |
| `skills/contact-unlink-identity/handler.ts` | Handler for unlink-identity skill |
| `tests/unit/contacts/authorization.test.ts` | Unit tests for AuthorizationService |
| `tests/unit/contacts/config-loader.test.ts` | Unit tests for config loader |

### Modified files
| File | Changes |
|------|---------|
| `src/contacts/types.ts` | Add `ContactStatus`, `AuthorizationResult`, `RoleDefaults`, `PermissionDef`, config types |
| `src/contacts/contact-service.ts` | Add `status` field, `setStatus()`, `getAuthOverrides()`, `grantPermission()`, `revokePermission()`, `unlinkIdentity()` methods; backends updated |
| `src/contacts/contact-resolver.ts` | Include contact status + authorization result in SenderContext |
| `src/channels/email/email-adapter.ts` | Create contacts as `provisional` instead of implicitly confirmed |
| `src/agents/runtime.ts` | Include authorization context in coordinator prompt |
| `src/index.ts` | Load auth configs, create AuthorizationService, pass to resolver |
| `agents/coordinator.yaml` | Add authorization-aware prompt guidance |
| `src/db/migrations/005_create_contacts.sql` | No change — status added via 006 |

---

### Task 1: Types and Migration

**Files:**
- Modify: `src/contacts/types.ts`
- Create: `src/db/migrations/006_add_contact_status.sql`

- [ ] **Step 1: Add new types to `src/contacts/types.ts`**

Add the following types at the end of the file (after the existing `InboundSenderContext` type):

```typescript
// -- Contact status --
// confirmed: CEO has verified this contact
// provisional: system-created, awaiting CEO confirmation
// blocked: CEO explicitly rejected/blocked this sender
export type ContactStatus = 'confirmed' | 'provisional' | 'blocked';

// -- Authorization types --

export interface RolePermissions {
  description: string;
  defaultPermissions: string[];
  defaultDeny: string[];
}

export interface PermissionDef {
  description: string;
  sensitivity: 'high' | 'medium' | 'low';
}

export type TrustLevel = 'high' | 'medium' | 'low';

export interface AuthorizationResult {
  allowed: string[];
  denied: string[];
  /** Permissions that require escalation (not in role defaults, needs CEO decision) */
  escalate: string[];
  /** Channel trust level for this message's originating channel */
  channelTrust: TrustLevel;
  /** Permissions blocked by insufficient channel trust (allowed by role but channel too low) */
  trustBlocked: string[];
  contactStatus: ContactStatus;
}

export interface AuthConfig {
  roles: Record<string, RolePermissions>;
  permissions: Record<string, PermissionDef>;
  channelTrust: Record<string, TrustLevel>;
}
```

Also update the `Contact` interface to include `status`:

```typescript
export interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

And update `CreateContactOptions` to accept an optional status:

```typescript
export interface CreateContactOptions {
  displayName: string;
  role?: string;
  status?: ContactStatus;
  notes?: string;
  kgNodeId?: string;
  source: string;
}
```

Update `SenderContext` to include status and authorization:

```typescript
export interface SenderContext {
  resolved: true;
  contactId: string;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  verified: boolean;
  kgNodeId: string | null;
  knowledgeSummary: string;
  authorization: AuthorizationResult | null;
}
```

- [ ] **Step 2: Create migration `src/db/migrations/006_add_contact_status.sql`**

```sql
-- Up Migration

-- Add status column to contacts table.
-- 'confirmed' = CEO-verified, 'provisional' = auto-created awaiting confirmation, 'blocked' = rejected.
-- Existing contacts default to 'confirmed' since they were created before the status system.
ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';

-- Index for filtering by status (e.g., listing all provisional contacts for CEO review)
CREATE INDEX idx_contacts_status ON contacts (status) WHERE status != 'confirmed';
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Errors — other files reference `Contact` without the new `status` field. That's OK at this step; we'll fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/contacts/types.ts src/db/migrations/006_add_contact_status.sql
git commit -m "feat: add contact status types and migration"
```

---

### Task 2: Config Files and Loader

**Files:**
- Create: `config/role-defaults.yaml`
- Create: `config/permissions.yaml`
- Create: `config/channel-trust.yaml`
- Create: `src/contacts/config-loader.ts`
- Create: `tests/unit/contacts/config-loader.test.ts`

- [ ] **Step 1: Create `config/role-defaults.yaml`**

```yaml
# Role-based permission defaults.
# Each role defines which permissions are granted and denied by default.
# Per-contact overrides (in contact_auth_overrides table) take precedence.
# Roles are open-ended — the CEO can create new roles at any time.
# Unknown roles fall back to the 'unknown' entry.

roles:
  ceo:
    description: "Chief Executive Officer — full access"
    default_permissions:
      - "*"
    default_deny: []

  cfo:
    description: "Chief Financial Officer"
    default_permissions:
      - view_financial_reports
      - view_board_materials
      - request_action_items
      - schedule_meetings
    default_deny:
      - send_on_behalf
      - see_personal_calendar

  board_member:
    description: "Board of Directors member"
    default_permissions:
      - view_board_materials
      - request_meeting_notes
    default_deny:
      - view_financial_reports
      - access_internal_docs

  direct_report:
    description: "Direct report to CEO"
    default_permissions:
      - schedule_meetings
      - request_action_items
    default_deny:
      - view_board_materials
      - view_financial_reports

  advisor:
    description: "External advisor (legal, financial, strategic)"
    default_permissions:
      - schedule_meetings
    default_deny:
      - access_internal_docs
      - send_on_behalf

  investor:
    description: "Investor or board observer"
    default_permissions:
      - view_board_materials
      - request_meeting_notes
    default_deny:
      - view_financial_reports
      - access_internal_docs

  spouse:
    description: "Spouse or life partner"
    default_permissions:
      - see_personal_calendar
      - book_travel
      - manage_personal_appointments
    default_deny:
      - view_financial_reports
      - access_internal_docs

  family_member:
    description: "Family member"
    default_permissions:
      - see_personal_calendar
    default_deny:
      - "*"

  unknown:
    description: "Fallback for contacts with no assigned role"
    default_permissions: []
    default_deny:
      - "*"
```

- [ ] **Step 2: Create `config/permissions.yaml`**

```yaml
# Permission registry with sensitivity levels.
# Sensitivity maps to channel trust: high-sensitivity actions need high-trust channels.
# New permissions can be added at any time — the coordinator normalizes CEO requests
# to existing permission names when possible.

permissions:
  view_financial_reports:
    description: "Access quarterly reports, P&L, budgets"
    sensitivity: high
  view_board_materials:
    description: "Access board decks, minutes, resolutions"
    sensitivity: high
  see_personal_calendar:
    description: "View personal/non-work calendar events"
    sensitivity: medium
  book_travel:
    description: "Book flights, hotels, and transportation"
    sensitivity: medium
  schedule_meetings:
    description: "Schedule or reschedule meetings on CEO's calendar"
    sensitivity: low
  request_action_items:
    description: "Request action items from meetings or tasks"
    sensitivity: low
  request_meeting_notes:
    description: "Request notes or minutes from meetings"
    sensitivity: low
  send_on_behalf:
    description: "Send messages or emails as the CEO"
    sensitivity: high
  access_internal_docs:
    description: "Access internal company documents"
    sensitivity: medium
  manage_personal_appointments:
    description: "Create, modify, or cancel personal appointments"
    sensitivity: medium
```

- [ ] **Step 3: Create `config/channel-trust.yaml`**

```yaml
# Channel trust levels.
# Determines the maximum sensitivity of actions that can be performed via each channel.
# high: can do anything
# medium: can do medium and low sensitivity actions
# low: can only do low sensitivity actions (high/medium actions require trust escalation)

channels:
  cli: high
  signal: high
  telegram: medium
  http: medium
  email: low
```

- [ ] **Step 4: Write failing test for config loader**

Create `tests/unit/contacts/config-loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadAuthConfig } from '../../../src/contacts/config-loader.js';
import * as path from 'node:path';

const CONFIG_DIR = path.resolve(import.meta.dirname, '../../../config');

describe('loadAuthConfig', () => {
  it('loads role defaults from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.roles).toBeDefined();
    expect(config.roles.ceo).toBeDefined();
    expect(config.roles.ceo.defaultPermissions).toContain('*');
    expect(config.roles.unknown.defaultDeny).toContain('*');
  });

  it('loads permissions registry from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.permissions).toBeDefined();
    expect(config.permissions.view_financial_reports.sensitivity).toBe('high');
    expect(config.permissions.schedule_meetings.sensitivity).toBe('low');
  });

  it('loads channel trust levels from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.channelTrust).toBeDefined();
    expect(config.channelTrust.cli).toBe('high');
    expect(config.channelTrust.email).toBe('low');
  });

  it('includes the unknown role as fallback', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.roles.unknown).toBeDefined();
    expect(config.roles.unknown.defaultPermissions).toEqual([]);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run tests/unit/contacts/config-loader.test.ts`
Expected: FAIL — `loadAuthConfig` doesn't exist yet

- [ ] **Step 6: Implement config loader**

Create `src/contacts/config-loader.ts`:

```typescript
// src/contacts/config-loader.ts
//
// Loads authorization config from YAML files at boot time.
// Three files: role-defaults.yaml, permissions.yaml, channel-trust.yaml
// These are loaded once at startup and passed to the AuthorizationService.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AuthConfig, RolePermissions, PermissionDef, TrustLevel } from './types.js';

interface RawRoleEntry {
  description: string;
  default_permissions: string[];
  default_deny: string[];
}

interface RawPermissionEntry {
  description: string;
  sensitivity: string;
}

/**
 * Load authorization configuration from the config directory.
 * Reads role-defaults.yaml, permissions.yaml, and channel-trust.yaml.
 * Throws on missing files or invalid YAML — fail hard at startup.
 */
export function loadAuthConfig(configDir: string): AuthConfig {
  // Role defaults
  const rolesRaw = parseYaml(
    readFileSync(path.join(configDir, 'role-defaults.yaml'), 'utf-8'),
  ) as { roles: Record<string, RawRoleEntry> };

  const roles: Record<string, RolePermissions> = {};
  for (const [roleName, entry] of Object.entries(rolesRaw.roles)) {
    roles[roleName] = {
      description: entry.description,
      defaultPermissions: entry.default_permissions,
      defaultDeny: entry.default_deny,
    };
  }

  // Permissions registry
  const permsRaw = parseYaml(
    readFileSync(path.join(configDir, 'permissions.yaml'), 'utf-8'),
  ) as { permissions: Record<string, RawPermissionEntry> };

  const permissions: Record<string, PermissionDef> = {};
  for (const [permName, entry] of Object.entries(permsRaw.permissions)) {
    const sensitivity = entry.sensitivity as TrustLevel;
    if (!['high', 'medium', 'low'].includes(sensitivity)) {
      throw new Error(`Invalid sensitivity '${sensitivity}' for permission '${permName}'`);
    }
    permissions[permName] = {
      description: entry.description,
      sensitivity,
    };
  }

  // Channel trust levels
  const trustRaw = parseYaml(
    readFileSync(path.join(configDir, 'channel-trust.yaml'), 'utf-8'),
  ) as { channels: Record<string, string> };

  const channelTrust: Record<string, TrustLevel> = {};
  for (const [channel, level] of Object.entries(trustRaw.channels)) {
    if (!['high', 'medium', 'low'].includes(level)) {
      throw new Error(`Invalid trust level '${level}' for channel '${channel}'`);
    }
    channelTrust[channel] = level as TrustLevel;
  }

  return { roles, permissions, channelTrust };
}
```

- [ ] **Step 7: Install yaml dependency if not present**

Run: `pnpm add yaml` (check if already installed first — the agent loader may already use it)

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/unit/contacts/config-loader.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add config/role-defaults.yaml config/permissions.yaml config/channel-trust.yaml src/contacts/config-loader.ts tests/unit/contacts/config-loader.test.ts
git commit -m "feat: add authorization config files and loader"
```

---

### Task 3: AuthorizationService

**Files:**
- Create: `src/contacts/authorization.ts`
- Create: `tests/unit/contacts/authorization.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/contacts/authorization.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import type { AuthConfig, ContactStatus } from '../../../src/contacts/types.js';

// Minimal config for testing
const testConfig: AuthConfig = {
  roles: {
    ceo: {
      description: 'CEO',
      defaultPermissions: ['*'],
      defaultDeny: [],
    },
    cfo: {
      description: 'CFO',
      defaultPermissions: ['view_financial_reports', 'schedule_meetings'],
      defaultDeny: ['send_on_behalf'],
    },
    unknown: {
      description: 'Unknown',
      defaultPermissions: [],
      defaultDeny: ['*'],
    },
  },
  permissions: {
    view_financial_reports: { description: 'View financials', sensitivity: 'high' },
    schedule_meetings: { description: 'Schedule meetings', sensitivity: 'low' },
    send_on_behalf: { description: 'Send as CEO', sensitivity: 'high' },
    see_personal_calendar: { description: 'See personal calendar', sensitivity: 'medium' },
  },
  channelTrust: {
    cli: 'high',
    email: 'low',
    http: 'medium',
  },
};

describe('AuthorizationService', () => {
  let authService: AuthorizationService;

  beforeEach(() => {
    authService = new AuthorizationService(testConfig);
  });

  it('CEO gets all permissions', () => {
    const result = authService.evaluate({
      role: 'ceo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('*');
    expect(result.denied).toEqual([]);
    expect(result.contactStatus).toBe('confirmed');
  });

  it('provisional contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'provisional',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('provisional');
  });

  it('blocked contacts get no permissions', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'blocked',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
    expect(result.contactStatus).toBe('blocked');
  });

  it('applies role defaults for confirmed contacts', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.allowed).toContain('view_financial_reports');
    expect(result.allowed).toContain('schedule_meetings');
    expect(result.denied).toContain('send_on_behalf');
  });

  it('overrides take precedence over role defaults', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [
        { permission: 'send_on_behalf', granted: true },
        { permission: 'view_financial_reports', granted: false },
      ],
    });
    expect(result.allowed).toContain('send_on_behalf');
    expect(result.denied).toContain('view_financial_reports');
  });

  it('channel trust blocks high-sensitivity actions on low-trust channels', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    // view_financial_reports is high sensitivity, email is low trust
    expect(result.trustBlocked).toContain('view_financial_reports');
    // schedule_meetings is low sensitivity — should still be allowed
    expect(result.allowed).toContain('schedule_meetings');
  });

  it('unknown roles fall back to unknown defaults', () => {
    const result = authService.evaluate({
      role: 'some_new_role',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
    expect(result.allowed).toEqual([]);
  });

  it('null role uses unknown defaults', () => {
    const result = authService.evaluate({
      role: null,
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    expect(result.denied).toContain('*');
  });

  it('permissions not in role defaults or overrides go to escalate', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'cli',
      overrides: [],
    });
    // see_personal_calendar is not in cfo's defaults or deny list
    expect(result.escalate).toContain('see_personal_calendar');
  });

  it('returns correct channel trust level', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'email',
      overrides: [],
    });
    expect(result.channelTrust).toBe('low');
  });

  it('unknown channels default to low trust', () => {
    const result = authService.evaluate({
      role: 'cfo',
      status: 'confirmed',
      channel: 'telegram',
      overrides: [],
    });
    // telegram is not in our test config
    expect(result.channelTrust).toBe('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/contacts/authorization.test.ts`
Expected: FAIL — `AuthorizationService` doesn't exist

- [ ] **Step 3: Implement AuthorizationService**

Create `src/contacts/authorization.ts`:

```typescript
// src/contacts/authorization.ts
//
// Deterministic authorization evaluation. No LLM involved — this is pure logic.
//
// Three-layer check:
// 1. Contact status gate — provisional and blocked contacts get zero permissions
// 2. Per-contact overrides → role defaults → escalate (for permissions in neither)
// 3. Channel trust — high-sensitivity actions on low-trust channels are trust-blocked

import type {
  AuthConfig,
  AuthorizationResult,
  ContactStatus,
  TrustLevel,
} from './types.js';

interface AuthOverrideInput {
  permission: string;
  granted: boolean;
}

export interface AuthEvaluateInput {
  role: string | null;
  status: ContactStatus;
  channel: string;
  overrides: AuthOverrideInput[];
}

// Trust level numeric values for comparison.
// Higher number = more trusted. A permission with sensitivity 'high'
// requires channel trust >= 3 (high). 'medium' requires >= 2, 'low' >= 1.
const TRUST_RANK: Record<TrustLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Deterministic authorization service.
 *
 * Evaluates what a contact is allowed to do based on:
 * 1. Contact status (provisional/blocked → zero permissions)
 * 2. Per-contact overrides (explicit grants/denials from the CEO)
 * 3. Role defaults (from config/role-defaults.yaml)
 * 4. Channel trust (from config/channel-trust.yaml + config/permissions.yaml sensitivity)
 *
 * This is NOT an LLM decision — it's a deterministic function of config + data.
 */
export class AuthorizationService {
  constructor(private config: AuthConfig) {}

  evaluate(input: AuthEvaluateInput): AuthorizationResult {
    const channelTrust = this.config.channelTrust[input.channel] ?? 'low';

    // Gate 1: provisional and blocked contacts get zero permissions.
    // This is the hardest gate — no overrides or role defaults can bypass it.
    if (input.status !== 'confirmed') {
      return {
        allowed: [],
        denied: ['*'],
        escalate: [],
        channelTrust,
        trustBlocked: [],
        contactStatus: input.status,
      };
    }

    // Look up role defaults. Unknown roles (including null) fall back to 'unknown'.
    const roleName = input.role ?? 'unknown';
    const roleDefaults = this.config.roles[roleName] ?? this.config.roles.unknown;

    // Build override map for O(1) lookup
    const overrideMap = new Map<string, boolean>();
    for (const o of input.overrides) {
      overrideMap.set(o.permission, o.granted);
    }

    // Evaluate each known permission through the 3-layer stack
    const allowed: string[] = [];
    const denied: string[] = [];
    const escalate: string[] = [];
    const trustBlocked: string[] = [];

    // Check for wildcard permissions/denials in role defaults
    const roleAllowsAll = roleDefaults.defaultPermissions.includes('*');
    const roleDeniesAll = roleDefaults.defaultDeny.includes('*');

    for (const [permName, permDef] of Object.entries(this.config.permissions)) {
      // Layer 1: Check overrides first (highest precedence)
      if (overrideMap.has(permName)) {
        if (overrideMap.get(permName)) {
          // Override grants this permission — but check channel trust
          if (TRUST_RANK[channelTrust] >= TRUST_RANK[permDef.sensitivity]) {
            allowed.push(permName);
          } else {
            trustBlocked.push(permName);
          }
        } else {
          denied.push(permName);
        }
        continue;
      }

      // Layer 2: Check role defaults
      if (roleAllowsAll || roleDefaults.defaultPermissions.includes(permName)) {
        // Role allows — but check channel trust
        if (TRUST_RANK[channelTrust] >= TRUST_RANK[permDef.sensitivity]) {
          allowed.push(permName);
        } else {
          trustBlocked.push(permName);
        }
        continue;
      }

      if (roleDeniesAll || roleDefaults.defaultDeny.includes(permName)) {
        denied.push(permName);
        continue;
      }

      // Not in defaults or deny list — needs CEO decision
      escalate.push(permName);
    }

    // Carry through wildcard allow if CEO role
    if (roleAllowsAll && !allowed.includes('*')) {
      allowed.unshift('*');
    }

    return {
      allowed,
      denied,
      escalate,
      channelTrust,
      trustBlocked,
      contactStatus: input.status,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/contacts/authorization.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/contacts/authorization.ts tests/unit/contacts/authorization.test.ts
git commit -m "feat: add AuthorizationService with 3-layer deterministic check"
```

---

### Task 4: Update ContactService for Status and Auth Overrides

**Files:**
- Modify: `src/contacts/contact-service.ts`
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Update ContactService backend interface**

Read `src/contacts/contact-service.ts`. Add to the `ContactServiceBackend` interface:

```typescript
  unlinkIdentity(identityId: string): Promise<void>;
  getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>>;
  createAuthOverride(override: AuthOverride): Promise<void>;
  revokeAuthOverride(contactId: string, permission: string): Promise<void>;
```

Add these imports at the top:

```typescript
import type { AuthOverride, ContactStatus } from './types.js';
```

- [ ] **Step 2: Update contact creation to use status**

In `createContact()`, change the contact construction to include `status`:

```typescript
    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: options.displayName,
      role: options.role ?? null,
      status: options.status ?? 'confirmed',
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
```

- [ ] **Step 3: Add new service methods**

Add these methods to `ContactService`:

```typescript
  /** Update a contact's status. */
  async setStatus(contactId: string, status: ContactStatus): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }
    const updated: Contact = { ...contact, status, updatedAt: new Date() };
    await this.backend.updateContact(updated);
    return updated;
  }

  /** Remove a channel identity from a contact. */
  async unlinkIdentity(identityId: string): Promise<void> {
    await this.backend.unlinkIdentity(identityId);
  }

  /** Get active (non-revoked) auth overrides for a contact. */
  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    return this.backend.getAuthOverrides(contactId);
  }

  /** Grant or deny a specific permission for a contact. */
  async grantPermission(contactId: string, permission: string, granted: boolean): Promise<void> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }
    const override: AuthOverride = {
      id: randomUUID(),
      contactId,
      permission,
      granted,
      grantedBy: 'ceo',
      createdAt: new Date(),
      revokedAt: null,
    };
    await this.backend.createAuthOverride(override);
  }

  /** Revoke an auth override, restoring the role default for that permission. */
  async revokePermission(contactId: string, permission: string): Promise<void> {
    await this.backend.revokeAuthOverride(contactId, permission);
  }
```

- [ ] **Step 4: Update PostgresContactBackend**

Add the four new methods to `PostgresContactBackend`:

```typescript
  async unlinkIdentity(identityId: string): Promise<void> {
    this.logger.debug({ identityId }, 'Unlinking channel identity');
    await this.pool.query('DELETE FROM contact_channel_identities WHERE id = $1', [identityId]);
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    this.logger.debug({ contactId }, 'Getting auth overrides');
    const result = await this.pool.query<{ permission: string; granted: boolean }>(
      `SELECT permission, granted FROM contact_auth_overrides
       WHERE contact_id = $1 AND revoked_at IS NULL`,
      [contactId],
    );
    return result.rows;
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    this.logger.debug({ contactId: override.contactId, permission: override.permission }, 'Creating auth override');
    // Upsert: if an active override for this contact+permission exists, update it.
    // The UNIQUE(contact_id, permission) constraint means we need to handle the
    // case where a revoked override exists — we update it rather than inserting a new row.
    await this.pool.query(
      `INSERT INTO contact_auth_overrides (id, contact_id, permission, granted, granted_by, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (contact_id, permission)
       DO UPDATE SET granted = $4, granted_by = $5, created_at = $6, revoked_at = NULL`,
      [override.id, override.contactId, override.permission, override.granted, override.grantedBy, override.createdAt],
    );
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<void> {
    this.logger.debug({ contactId, permission }, 'Revoking auth override');
    await this.pool.query(
      `UPDATE contact_auth_overrides SET revoked_at = now()
       WHERE contact_id = $1 AND permission = $2 AND revoked_at IS NULL`,
      [contactId, permission],
    );
  }
```

Also update the Postgres `createContact` and `updateContact` methods to include the `status` column, and update `pgRowToContact` (or however contacts are read from rows) to include `status`.

- [ ] **Step 5: Update InMemoryContactBackend**

Add the four new methods and update contact creation/reading to include `status`:

```typescript
  async unlinkIdentity(identityId: string): Promise<void> {
    this.identities.delete(identityId);
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    return [...this.overrides.values()]
      .filter(o => o.contactId === contactId && o.revokedAt === null)
      .map(o => ({ permission: o.permission, granted: o.granted }));
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    // Upsert: find existing active override for this contact+permission
    for (const [id, existing] of this.overrides) {
      if (existing.contactId === override.contactId &&
          existing.permission === override.permission &&
          existing.revokedAt === null) {
        this.overrides.delete(id);
        break;
      }
    }
    this.overrides.set(override.id, override);
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<void> {
    for (const [id, override] of this.overrides) {
      if (override.contactId === contactId &&
          override.permission === permission &&
          override.revokedAt === null) {
        this.overrides.set(id, { ...override, revokedAt: new Date() });
        break;
      }
    }
  }
```

Add the `overrides` Map to the class:

```typescript
  private overrides = new Map<string, AuthOverride>();
```

- [ ] **Step 6: Add tests for new methods**

Add to `tests/unit/contacts/contact-service.test.ts`:

```typescript
  describe('contact status', () => {
    it('creates contacts with default confirmed status', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test' });
      expect(contact.status).toBe('confirmed');
    });

    it('creates contacts with provisional status', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test', status: 'provisional' });
      expect(contact.status).toBe('provisional');
    });

    it('updates contact status', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test', status: 'provisional' });
      const updated = await service.setStatus(contact.id, 'confirmed');
      expect(updated.status).toBe('confirmed');
    });
  });

  describe('auth overrides', () => {
    it('grants a permission override', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test' });
      await service.grantPermission(contact.id, 'send_on_behalf', true);
      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toEqual([{ permission: 'send_on_behalf', granted: true }]);
    });

    it('revokes a permission override', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test' });
      await service.grantPermission(contact.id, 'send_on_behalf', true);
      await service.revokePermission(contact.id, 'send_on_behalf');
      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toEqual([]);
    });

    it('upserts override for same contact+permission', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test' });
      await service.grantPermission(contact.id, 'send_on_behalf', true);
      await service.grantPermission(contact.id, 'send_on_behalf', false);
      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toEqual([{ permission: 'send_on_behalf', granted: false }]);
    });
  });

  describe('unlink identity', () => {
    it('removes a channel identity', async () => {
      const contact = await service.createContact({ displayName: 'Test', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'test@example.com',
        source: 'ceo_stated',
      });
      await service.unlinkIdentity(identity.id);
      const result = await service.getContactWithIdentities(contact.id);
      expect(result?.identities).toEqual([]);
    });
  });
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: PASS (fix any compilation errors from the `status` field addition)

- [ ] **Step 8: Commit**

```bash
git add src/contacts/contact-service.ts tests/unit/contacts/contact-service.test.ts
git commit -m "feat: add contact status, auth overrides, and unlink-identity to ContactService"
```

---

### Task 5: Wire Authorization into ContactResolver and Runtime

**Files:**
- Modify: `src/contacts/contact-resolver.ts`
- Modify: `src/agents/runtime.ts`
- Modify: `src/index.ts`
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Update ContactResolver to include authorization**

Read `src/contacts/contact-resolver.ts`. Update the constructor to accept an `AuthorizationService` and wire it into the resolve flow.

Add import:
```typescript
import type { AuthorizationService } from './authorization.js';
```

Update constructor:
```typescript
  constructor(
    private contactService: ContactService,
    private entityMemory: EntityMemory | undefined,
    private authService: AuthorizationService | undefined,
    private logger: Logger,
  ) {}
```

After resolving the contact (around line 48), add authorization evaluation:

```typescript
    // Evaluate authorization if auth service is available
    let authorization: import('./types.js').AuthorizationResult | null = null;
    if (this.authService) {
      const overrides = await this.contactService.getAuthOverrides(resolved.contactId);
      authorization = this.authService.evaluate({
        role: resolved.role,
        status: resolved.status,
        channel,
        overrides,
      });
    }
```

And include it in the returned `SenderContext`:

```typescript
    return {
      resolved: true,
      contactId: resolved.contactId,
      displayName: resolved.displayName,
      role: resolved.role,
      status: resolved.status,
      verified: resolved.verified,
      kgNodeId: resolved.kgNodeId,
      knowledgeSummary,
      authorization,
    };
```

Also update `ResolvedSender` type in `types.ts` to include `status: ContactStatus`.

Update the `resolveByChannelIdentity` query in both backends to include the `status` column.

The CLI shortcut should return `status: 'confirmed'` and `authorization: null` (CEO always has full access, no need to evaluate).

- [ ] **Step 2: Update runtime to include authorization in prompt**

Read `src/agents/runtime.ts`. Find the sender context injection block (around line 99-122). After the existing sender info line, add authorization context:

```typescript
      // Include authorization context so the coordinator knows what the sender can do
      if (senderCtx.authorization) {
        const auth = senderCtx.authorization;
        if (auth.contactStatus !== 'confirmed') {
          senderInfo += `\n\nAUTHORIZATION: This contact is ${auth.contactStatus}. They have NO permissions. Do not take any actions on their behalf until the CEO confirms them.`;
        } else {
          const allowedStr = auth.allowed.length > 0 ? auth.allowed.join(', ') : 'none';
          const deniedStr = auth.denied.length > 0 ? auth.denied.join(', ') : 'none';
          senderInfo += `\n\nAUTHORIZATION:`;
          senderInfo += `\n  Allowed: ${allowedStr}`;
          senderInfo += `\n  Denied: ${deniedStr}`;
          if (auth.trustBlocked.length > 0) {
            senderInfo += `\n  Blocked by channel trust (${auth.channelTrust}): ${auth.trustBlocked.join(', ')} — ask sender to use a higher-trust channel`;
          }
          if (auth.escalate.length > 0) {
            senderInfo += `\n  Needs CEO decision: ${auth.escalate.join(', ')}`;
          }
        }
      }
```

- [ ] **Step 3: Update bootstrap to create AuthorizationService**

Read `src/index.ts`. After the contact system initialization, add:

```typescript
  // Authorization config — load role defaults, permissions, and channel trust.
  // These YAML files are read once at startup.
  const configDir = path.resolve(import.meta.dirname, '../config');
  let authService: AuthorizationService | undefined;
  try {
    const authConfig = loadAuthConfig(configDir);
    authService = new AuthorizationService(authConfig);
    logger.info('Authorization config loaded');
  } catch (err) {
    logger.warn({ err }, 'Failed to load authorization config — authorization checks disabled');
  }
```

Update the `ContactResolver` constructor call to pass `authService`:

```typescript
  const contactResolver = new ContactResolver(contactService, entityMemory, authService, logger);
```

Add imports:
```typescript
import { loadAuthConfig } from './contacts/config-loader.js';
import { AuthorizationService } from './contacts/authorization.js';
```

- [ ] **Step 4: Update coordinator prompt**

Read `agents/coordinator.yaml`. Add to the Audience Awareness section:

```yaml
  ## Authorization Enforcement
  The system evaluates what each sender is allowed to do and tells you in the
  sender context. This is DETERMINISTIC — you do not decide permissions.

  - If a sender is "provisional", they have NO permissions. Respond politely but
    do not take any actions on their behalf. Inform the CEO (via CLI) that a new
    contact needs confirmation.
  - If a sender is "blocked", do not respond to them at all.
  - If a permission is in "Allowed", you may proceed with that action.
  - If a permission is in "Denied", you MUST refuse the request. Be polite but firm.
  - If a permission is in "Blocked by channel trust", tell the sender they need to
    use a more secure channel (e.g., "For security, I'd need you to confirm this
    via Signal or in person").
  - If a permission is in "Needs CEO decision", tell the sender you'll check with
    the CEO and get back to them. Then inform the CEO.
  - NEVER override the authorization system. Even if the request seems reasonable,
    if the system says "Denied", it's denied.
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS (may need to fix existing tests that construct ContactResolver with the old 3-arg signature)

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/contacts/contact-resolver.ts src/agents/runtime.ts src/index.ts agents/coordinator.yaml src/contacts/types.ts
git commit -m "feat: wire authorization into resolver, runtime prompt, and bootstrap"
```

---

### Task 6: Three New Skills

**Files:**
- Create: `skills/contact-unlink-identity/skill.json`
- Create: `skills/contact-unlink-identity/handler.ts`
- Create: `skills/contact-grant-permission/skill.json`
- Create: `skills/contact-grant-permission/handler.ts`
- Create: `skills/contact-revoke-permission/skill.json`
- Create: `skills/contact-revoke-permission/handler.ts`
- Modify: `agents/coordinator.yaml` (add to pinned_skills)

- [ ] **Step 1: Create contact-unlink-identity skill**

`skills/contact-unlink-identity/skill.json`:
```json
{
  "name": "contact-unlink-identity",
  "description": "Remove a channel identity from a contact. Use when the CEO says an email/phone is wrong or no longer valid for a contact.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "contact_id": "string",
    "identity_id": "string"
  },
  "outputs": {
    "removed": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

`skills/contact-unlink-identity/handler.ts`:
```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactUnlinkIdentityHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, identity_id } = ctx.input as {
      contact_id?: string;
      identity_id?: string;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!identity_id || typeof identity_id !== 'string') {
      return { success: false, error: 'Missing required input: identity_id (string)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. Is infrastructure: true set?' };
    }

    try {
      await ctx.contactService.unlinkIdentity(identity_id);
      ctx.log.info({ contactId: contact_id, identityId: identity_id }, 'Channel identity unlinked');
      return { success: true, data: { removed: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to unlink identity: ${message}` };
    }
  }
}
```

- [ ] **Step 2: Create contact-grant-permission skill**

`skills/contact-grant-permission/skill.json`:
```json
{
  "name": "contact-grant-permission",
  "description": "Grant or deny a specific permission for a contact, overriding their role defaults. Use when the CEO says 'Let X do Y' or 'Don't let X do Y'.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "infrastructure": true,
  "inputs": {
    "contact_id": "string",
    "permission": "string",
    "granted": "boolean"
  },
  "outputs": {
    "contact_id": "string",
    "permission": "string",
    "granted": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

`skills/contact-grant-permission/handler.ts`:
```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactGrantPermissionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, permission, granted } = ctx.input as {
      contact_id?: string;
      permission?: string;
      granted?: boolean;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!permission || typeof permission !== 'string') {
      return { success: false, error: 'Missing required input: permission (string)' };
    }
    if (typeof granted !== 'boolean') {
      return { success: false, error: 'Missing required input: granted (boolean)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. Is infrastructure: true set?' };
    }

    try {
      await ctx.contactService.grantPermission(contact_id, permission, granted);
      const action = granted ? 'granted' : 'denied';
      ctx.log.info({ contactId: contact_id, permission, granted }, `Permission ${action}`);
      return { success: true, data: { contact_id, permission, granted } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to set permission: ${message}` };
    }
  }
}
```

- [ ] **Step 3: Create contact-revoke-permission skill**

`skills/contact-revoke-permission/skill.json`:
```json
{
  "name": "contact-revoke-permission",
  "description": "Remove a permission override for a contact, restoring their role's default behavior for that permission. Use when the CEO says to undo a previous grant or denial.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "infrastructure": true,
  "inputs": {
    "contact_id": "string",
    "permission": "string"
  },
  "outputs": {
    "contact_id": "string",
    "permission": "string",
    "revoked": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

`skills/contact-revoke-permission/handler.ts`:
```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactRevokePermissionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, permission } = ctx.input as {
      contact_id?: string;
      permission?: string;
    };

    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!permission || typeof permission !== 'string') {
      return { success: false, error: 'Missing required input: permission (string)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'Contact service not available. Is infrastructure: true set?' };
    }

    try {
      await ctx.contactService.revokePermission(contact_id, permission);
      ctx.log.info({ contactId: contact_id, permission }, 'Permission override revoked');
      return { success: true, data: { contact_id, permission, revoked: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to revoke permission: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Add new skills to coordinator's pinned_skills**

In `agents/coordinator.yaml`, add to the `pinned_skills` list:

```yaml
  - contact-unlink-identity
  - contact-grant-permission
  - contact-revoke-permission
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Run typecheck + lint**

Run: `npx tsc --noEmit`
Run: `npx eslint src/ tests/ skills/`

- [ ] **Step 7: Commit**

```bash
git add skills/contact-unlink-identity/ skills/contact-grant-permission/ skills/contact-revoke-permission/ agents/coordinator.yaml
git commit -m "feat: add contact-unlink-identity, contact-grant-permission, contact-revoke-permission skills"
```

---

### Task 7: Update Email Adapter to Create Provisional Contacts

**Files:**
- Modify: `src/channels/email/email-adapter.ts`

- [ ] **Step 1: Update extractParticipants to create provisional contacts**

Read `src/channels/email/email-adapter.ts`. In the `extractParticipants` method (around line 225), change the `createContact` call to pass `status: 'provisional'`:

```typescript
        const contact = await contactService.createContact({
          displayName: p.name || p.email,
          source: 'email_participant',
          status: 'provisional',
        });
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/channels/email/email-adapter.ts
git commit -m "feat: email-created contacts start as provisional (not confirmed)"
```

---

### Task 8: Update Smoke Test Harness

**Files:**
- Modify: `tests/smoke/harness.ts`

- [ ] **Step 1: Update harness ContactResolver construction**

Read `tests/smoke/harness.ts`. Find where `ContactResolver` is constructed and add the new `authService` parameter (pass `undefined` — smoke tests don't need auth enforcement):

```typescript
const contactResolver = new ContactResolver(contactService, entityMemory, undefined, logger);
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/smoke/harness.ts
git commit -m "fix: update smoke test harness for new ContactResolver signature"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Lint**

Run: `npx eslint src/ tests/ skills/`
Expected: Clean

- [ ] **Step 4: Commit plan**

```bash
git add docs/superpowers/plans/
git commit -m "docs: add Phase B authorization implementation plan"
```
