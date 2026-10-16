# Setup Wizard Walkthrough

`pnpm e2e:setup-wizard` installs Curia from nothing and clicks through the `/setup` wizard in a real browser, the way a new operator would. It exists because the wizard is the first thing every install sees and nothing else exercises it: the unit tests cover its pure helpers, and the behavior suites (`pnpm smoke`, `pnpm scenarios`) start from an already-configured database. v0.37–v0.43 shipped a wizard that could not get past step 5 (#2146), and no suite noticed.

**When to run it:**

- Before every release cut. It is part of release pre-flight C in `CLAUDE.md`.
- Whenever you change the wizard (`apps/console/src/pages/WizardPage.tsx`, `wizard-utils.ts`), the `/setup` route in `apps/console/src/router.tsx`, the login page, or the setup and identity APIs (`src/channels/http/routes/setup.ts`, `identity.ts`).

---

## How It Works

1. Creates an **empty** database, `<name>_wizard_<pid>`, on the Postgres server in `DATABASE_URL`. It migrates the database and seeds the vault the same way `install.sh` does, with throwaway secrets: a fresh encryption key, bootstrap secret and API token, plus a placeholder Anthropic key.
2. Builds the console and boots Curia from source on port 3099. With no principal, Curia comes up in setup-required mode, like a new install.
3. Signs in with the bootstrap secret and completes all six steps. On each step it checks the URL (`?step=N`), the "Step N of 6" label and the heading, then checks the Review step lists what it entered.
4. Clicks **Confirm & save**. `/api/setup/restart` exits the process, and in production Docker's restart policy starts it again. Here the script acts as that supervisor and restarts Curia once. It then waits for the wizard to land on `/chat`.
5. Reads the saved state back over the API. Every value entered in steps 1–5 must have been saved, Curia must have left setup mode, and exactly one restart must have happened.

It exits `1` on any failure. It prints the step it could not reach, saves a full-page screenshot to `tests/setup-wizard/results/` (gitignored), and prints the server log path. The database is dropped afterwards, including on Ctrl-C.

Because the Anthropic key is a placeholder, the wizard's name suggestion and the first `/chat` kickoff message fail, and the server log shows those errors. That is expected. The wizard has to work without the suggestion, and the walkthrough only checks that `/chat` is reached, not what the agent says there. The run costs nothing in model calls.

---

## Running It

```bash
pnpm e2e:setup-wizard                   # build the console, run headless
pnpm e2e:setup-wizard --headed          # watch it in a visible browser
pnpm e2e:setup-wizard --skip-build      # reuse apps/console/dist (only if it's current)
pnpm e2e:setup-wizard --keep-db         # leave the database behind to inspect it
pnpm e2e:setup-wizard --port 3200       # if 3099 is taken
pnpm e2e:setup-wizard --chromium /path/to/chrome   # use a Chromium other than Playwright's download
```

`--allow-remote-db` lets it create the throwaway database on a server that is not on this machine. Without the flag it refuses, like `pnpm smoke`.

**Requirements:**

- A Postgres 16 server with pgvector, named by `DATABASE_URL` (read from `.env` when present). The dev compose stack's Postgres works. The role needs `CREATEDB`, and permission to `CREATE EXTENSION vector`.
- Playwright's Chromium: `pnpm exec playwright install chromium`, or pass `--chromium`.

A running dev instance can stay up. The walkthrough uses its own database, port and secrets, so it never touches the dev database.

---

## Keeping It Current

The walkthrough selects elements by their ids (`#w-principal-name`, `#w-timezone`, …), by the step headings, and by the "Step N of 6" label. When you add, remove or reorder a step, or rename a heading, update `tests/setup-wizard/cli.ts` in the same PR: the `EXPECTED_TOTAL_STEPS` constant, the step sequence in `walkThroughWizard()`, and the read-back in `verifySavedState()` for any new field. When a new step saves something, add a check that it was saved. That check is what catches a field the wizard collects but drops.
