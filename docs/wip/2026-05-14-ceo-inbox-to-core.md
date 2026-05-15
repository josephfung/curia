# ceo-inbox Migration to Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `ceo-inbox` agent and its 9 associated skills from `curia-deploy/custom/` into the main curia skill tree so they are covered by curia's CI and type-checked against real types.

**Architecture:** Each skill `handler.ts` imports from two paths that change: `../_lib/types.js` → `../../src/skills/types.js` and `../_lib/nylas-client.js` → `../_shared/ceo-nylas-client.js`. The shared Nylas client (`_lib/nylas-client.ts`) is copied to `skills/_shared/ceo-nylas-client.ts` with no content changes. The agent YAML and all `skill.json` manifests are copied verbatim.

**Tech Stack:** TypeScript/ESM, Node 22, Vitest, pnpm

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core` (branch `feat/ceo-inbox-to-core`)

All commands use `pnpm --prefix <worktree>` and `git -C <worktree>`.

```
WORKTREE=/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core
DEPLOY=/Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy
```

---

### Task 1: Copy the shared Nylas client library

**Files:**
- Create: `skills/_shared/ceo-nylas-client.ts` (copy of `curia-deploy/custom/skills/_lib/nylas-client.ts`)

- [ ] **Step 1: Copy the file**

```bash
cp /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/_lib/nylas-client.ts \
   /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/_shared/ceo-nylas-client.ts
```

- [ ] **Step 2: Verify it landed correctly**

```bash
ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/_shared/
```

Expected output includes `ceo-nylas-client.ts` and `template-base.ts`.

- [ ] **Step 3: Run typecheck to confirm the file is valid on its own**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core typecheck
```

Expected: passes (the file has no imports that need updating — it uses only `fetch` and built-in types).

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add skills/_shared/ceo-nylas-client.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: add ceo-nylas-client to skills/_shared"
```

---

### Task 2: Migrate ceo-inbox-list (with tests)

**Files:**
- Create: `skills/ceo-inbox-list/skill.json`
- Create: `skills/ceo-inbox-list/handler.ts`
- Create: `skills/ceo-inbox-list/handler.test.ts`

- [ ] **Step 1: Copy the skill directory**

```bash
cp -r /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/ceo-inbox-list \
      /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/ceo-inbox-list
```

- [ ] **Step 2: Run the tests to confirm they fail on bad imports**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-list/handler.test.ts
```

Expected: fails with a module-not-found error for `../_lib/types.js` or `../_lib/nylas-client.js`.

- [ ] **Step 3: Update imports in handler.ts**

Open `skills/ceo-inbox-list/handler.ts` and replace the first two lines:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 4: Update imports in handler.test.ts**

Open `skills/ceo-inbox-list/handler.test.ts` and replace line 3:

```typescript
// Before:
import type { SkillContext } from '../_lib/types.js';

// After:
import type { SkillContext } from '../../src/skills/types.js';
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-list/handler.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add skills/ceo-inbox-list
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: migrate ceo-inbox-list skill to core"
```

---

### Task 3: Migrate ceo-inbox-draft-reply (with tests)

**Files:**
- Create: `skills/ceo-inbox-draft-reply/skill.json`
- Create: `skills/ceo-inbox-draft-reply/handler.ts`
- Create: `skills/ceo-inbox-draft-reply/handler.test.ts`

- [ ] **Step 1: Copy the skill directory**

```bash
cp -r /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/ceo-inbox-draft-reply \
      /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/ceo-inbox-draft-reply
```

- [ ] **Step 2: Run the tests to confirm they fail on bad imports**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-draft-reply/handler.test.ts
```

Expected: fails with a module-not-found error.

- [ ] **Step 3: Update imports in handler.ts**

Open `skills/ceo-inbox-draft-reply/handler.ts` and replace the first two lines:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient, type NylasParticipant } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 4: Update imports in handler.test.ts**

Open `skills/ceo-inbox-draft-reply/handler.test.ts` and replace line 3:

```typescript
// Before:
import type { SkillContext } from '../_lib/types.js';

// After:
import type { SkillContext } from '../../src/skills/types.js';
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-draft-reply/handler.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add skills/ceo-inbox-draft-reply
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: migrate ceo-inbox-draft-reply skill to core"
```

---

### Task 4: Migrate ceo-inbox-download-attachment (with tests)

**Files:**
- Create: `skills/ceo-inbox-download-attachment/skill.json`
- Create: `skills/ceo-inbox-download-attachment/handler.ts`
- Create: `skills/ceo-inbox-download-attachment/handler.test.ts`

- [ ] **Step 1: Copy the skill directory**

```bash
cp -r /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/ceo-inbox-download-attachment \
      /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/ceo-inbox-download-attachment
```

- [ ] **Step 2: Run the tests to confirm they fail on bad imports**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-download-attachment/handler.test.ts
```

Expected: fails with a module-not-found error.

- [ ] **Step 3: Update imports in handler.ts**

Open `skills/ceo-inbox-download-attachment/handler.ts` and replace lines 12–13:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 4: Update imports in handler.test.ts**

Open `skills/ceo-inbox-download-attachment/handler.test.ts` and replace line 3:

```typescript
// Before:
import type { SkillContext } from '../_lib/types.js';

// After:
import type { SkillContext } from '../../src/skills/types.js';
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test skills/ceo-inbox-download-attachment/handler.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add skills/ceo-inbox-download-attachment
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: migrate ceo-inbox-download-attachment skill to core"
```

---

### Task 5: Migrate the 6 remaining skills (no tests)

The 6 remaining skills (`ceo-inbox-read`, `ceo-inbox-archive`, `ceo-inbox-mark-read`, `ceo-inbox-label`, `ceo-inbox-search`, `ceo-inbox-update-folders`) have no test files. Each has the same two-line import update. We migrate all six in one task and verify with typecheck.

**Files (×6 each):**
- Create: `skills/<name>/skill.json`
- Create: `skills/<name>/handler.ts`

- [ ] **Step 1: Copy all six skill directories**

```bash
for skill in ceo-inbox-read ceo-inbox-archive ceo-inbox-mark-read ceo-inbox-label ceo-inbox-search ceo-inbox-update-folders; do
  cp -r /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/$skill \
        /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/skills/$skill
done
```

- [ ] **Step 2: Update imports in handler.ts for ceo-inbox-read**

Open `skills/ceo-inbox-read/handler.ts` and replace lines 1–2:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient, htmlToPlainText } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, htmlToPlainText } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 3: Update imports in handler.ts for ceo-inbox-archive**

Open `skills/ceo-inbox-archive/handler.ts` and replace lines 1–2:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 4: Update imports in handler.ts for ceo-inbox-mark-read**

Open `skills/ceo-inbox-mark-read/handler.ts` and replace lines 1–2:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 5: Update imports in handler.ts for ceo-inbox-label**

Open `skills/ceo-inbox-label/handler.ts` and replace lines 1–3:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';
import type { NylasFolder } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
import type { NylasFolder } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 6: Update imports in handler.ts for ceo-inbox-search**

Open `skills/ceo-inbox-search/handler.ts` and replace lines 1–2:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 7: Update imports in handler.ts for ceo-inbox-update-folders**

Open `skills/ceo-inbox-update-folders/handler.ts` and replace lines 1–2:

```typescript
// Before:
import type { SkillHandler, SkillContext, SkillResult } from '../_lib/types.js';
import { CeoNylasClient } from '../_lib/nylas-client.js';

// After:
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
```

- [ ] **Step 8: Run typecheck to verify all six files are clean**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core typecheck
```

Expected: passes with no errors.

- [ ] **Step 9: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add skills/ceo-inbox-read skills/ceo-inbox-archive skills/ceo-inbox-mark-read skills/ceo-inbox-label skills/ceo-inbox-search skills/ceo-inbox-update-folders
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: migrate remaining 6 ceo-inbox skills to core"
```

---

### Task 6: Copy the agent YAML

**Files:**
- Create: `agents/ceo-inbox.yaml`

- [ ] **Step 1: Copy the agent YAML**

```bash
cp /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/agents/ceo-inbox.yaml \
   /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/agents/ceo-inbox.yaml
```

- [ ] **Step 2: Verify it was copied correctly**

```bash
head -5 /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core/agents/ceo-inbox.yaml
```

Expected: first line is `name: ceo-inbox`.

- [ ] **Step 3: Run typecheck to confirm the startup validator accepts the new agent YAML**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add agents/ceo-inbox.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "feat: add ceo-inbox agent to curia core"
```

---

### Task 7: Delete ceo-inbox artifacts from curia-deploy

**Files (deleted from curia-deploy):**
- `curia-deploy/custom/skills/_lib/types.ts`
- `curia-deploy/custom/skills/_lib/nylas-client.ts`
- `curia-deploy/custom/skills/ceo-inbox-*/` (9 directories)
- `curia-deploy/custom/agents/ceo-inbox.yaml`

The `_lib/` directory itself should be removed once both files are deleted.

- [ ] **Step 1: Delete the skill directories**

```bash
for skill in ceo-inbox-list ceo-inbox-read ceo-inbox-archive ceo-inbox-draft-reply ceo-inbox-mark-read ceo-inbox-label ceo-inbox-search ceo-inbox-download-attachment ceo-inbox-update-folders; do
  rm -rf /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/$skill
done
```

- [ ] **Step 2: Delete the _lib directory**

```bash
rm -rf /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/_lib
```

- [ ] **Step 3: Delete the agent YAML**

```bash
rm /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/agents/ceo-inbox.yaml
```

- [ ] **Step 4: Verify curia-deploy/custom no longer has ceo-inbox artifacts**

```bash
ls /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/skills/
ls /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/agents/
```

Expected: no `ceo-inbox-*` directories in skills, no `ceo-inbox.yaml` in agents.

- [ ] **Step 5: Commit the deletion in curia-deploy**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy add -u custom/skills/ custom/agents/ceo-inbox.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy commit -m "chore: remove ceo-inbox skills and agent — moved to curia core"
```

---

### Task 8: Full test suite and final verification

- [ ] **Step 1: Run the full test suite**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core test
```

Expected: all tests pass (the 3 migrated test suites are now included automatically via `skills/**/*.test.ts`). If any fail, fix before continuing.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core typecheck
```

Expected: passes clean.

---

### Task 9: Update CHANGELOG and open the PR

- [ ] **Step 1: Update CHANGELOG.md**

Add under `## [Unreleased]` → `### Added`:

```markdown
- **`ceo-inbox` agent and 9 skills** — moved from `curia-deploy/custom/` into curia core; now covered by curia's CI and type-checked against real types. (#592)
```

- [ ] **Step 2: Commit the changelog**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core commit -m "chore: changelog for ceo-inbox migration to core (#592)"
```

- [ ] **Step 3: Push the branch**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-to-core push -u origin feat/ceo-inbox-to-core
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create \
  --repo josephfung/curia \
  --title "feat: move ceo-inbox agent and skills into curia core" \
  --base main \
  --head feat/ceo-inbox-to-core \
  --body "$(cat <<'EOF'
## Summary

Closes #592

- Copies `ceo-inbox.yaml` agent from `curia-deploy/custom/agents/` into `curia/agents/`
- Copies `_lib/nylas-client.ts` to `curia/skills/_shared/ceo-nylas-client.ts`
- Copies all 9 `ceo-inbox-*` skill directories into `curia/skills/`; updates two import lines per handler (types path + nylas client path)
- Deletes all migrated artifacts from `curia-deploy/custom/`
- Removes `_lib/types.ts` stub — superseded by `src/skills/types.ts`

## Test plan

- [ ] `pnpm typecheck` passes clean
- [ ] `pnpm test` passes (3 migrated test suites run via `skills/**/*.test.ts`)
- [ ] All 9 `ceo-inbox-*` skills appear in skill loader output at startup
- [ ] `ceo-inbox` agent appears in agent registry at startup
- [ ] 15-minute schedule is registered by the scheduler service
- [ ] `curia-deploy` no longer contains any `ceo-inbox-*` skill directories or `ceo-inbox.yaml`
EOF
)"
```
