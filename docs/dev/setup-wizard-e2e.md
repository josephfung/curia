# Setup Page Walkthrough

`pnpm e2e:setup-wizard` installs Curia from nothing and clicks through the `/setup` page in a real browser, the way a new operator would. It exists because the Setup page is the first thing every install sees and nothing else exercises it: the unit tests cover its pure helpers, and the scenario suite (`pnpm scenarios`) starts from an already-configured database. v0.37–v0.43 shipped a setup wizard that could not get past step 5 (#2146), and no suite noticed. The Setup page replaced that wizard in #2358; the script keeps its name.

**When to run it:**

- Before every release cut. It is part of release pre-flight C in `CLAUDE.md`.
- Whenever you change the Setup page (`apps/console/src/pages/setup/`, `wizard-utils.ts`), the `/setup` route or the first-load gate in `apps/console/src/router.tsx`, the login page, or the setup and identity APIs (`src/channels/http/routes/setup.ts`, `identity.ts`).

---

## How It Works

1. Creates an **empty** database, `<name>_wizard_<pid>`, on the Postgres server in `DATABASE_URL`. It migrates the database and seeds the vault the same way `install.sh` does, with throwaway secrets: a fresh encryption key, bootstrap secret and API token, plus a placeholder Anthropic key.
2. Builds the console and boots Curia from source on port 3099. With no principal, Curia comes up in setup-required mode, like a new install.
3. Signs in with the bootstrap secret; the first-load gate sends it to the Setup page. It walks the eight steps with **Save and continue**, checking each step's URL (`?step=<id>`), "Step N of 8" label and heading: Who it's for (someone else, with the operator's details and the principal's name, title, email, timezone and pronouns), Curia's name, then the channel steps' inline forms: a Nylas key on Email; Text message for messaging, with fake Telnyx keys (the channel turns on) and the principal's mobile; fake Deepgram and Cartesia keys on Voice (it stays off: LiveKit's keys come with a real install, #2689).
4. Clicks **Apply and restart**. `/api/system/restart` ends the process cleanly, and in production Docker's restart policy starts it again. Here the script acts as that supervisor and restarts Curia once. It waits for the page to say every step was checked again.
5. Checks **Start onboarding** is locked and lists what's left: the channel steps can't pass on a plain-http install with no keys. Then it reads the saved state back over the API: the Setup fields, the principal, Curia's name, the checklist (Who it's for and Curia's name done, Setup not complete), the vault keys, the SMS channel on and voice off, the principal's mobile linked, Curia still in Setup but out of setup-required mode, and exactly one restart. Curia must also come back from the restart with the SMS channel on its fake keys.

It exits `1` on any failure. It prints the step it could not reach, saves a full-page screenshot to `tests/setup-wizard/results/` (gitignored), and prints the server log path. The database is dropped afterwards, including on Ctrl-C. If a run is killed outright, the next run drops the database it left behind.

Because the Anthropic key is a placeholder, Curia's name suggestion fails and the server log shows the error. That is expected: the page has to work without it. The run costs nothing in model calls.

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

`--allow-remote-db` lets it create the throwaway database on a server that is not on this machine. Without the flag it refuses, so it never creates or drops databases on a real server by mistake.

**Requirements:**

- A Postgres 16 server with pgvector, named by `DATABASE_URL` (read from `.env` when present). The dev compose stack's Postgres works. The role needs `CREATEDB`, and permission to `CREATE EXTENSION vector`.
- Playwright's Chromium: `pnpm exec playwright install chromium`, or pass `--chromium`.

A running dev instance can stay up. The walkthrough uses its own database, port and secrets, so it never touches the dev database.

---

## Keeping It Current

The walkthrough selects elements by their labels and a few ids (`#setup-principal-name`, `#setup-curia-name`, …), by the step headings, and by the "Step N of 8" label. When you add, remove or reorder a step, or rename a heading, update `tests/setup-wizard/cli.ts` in the same PR: the `EXPECTED_TOTAL_STEPS` constant, the step sequence in `walkThroughSetup()`, and the read-back in `verifySavedState()` for any new field. When a new step saves something, add a check that it was saved. That check is what catches a field the page collects but drops.
