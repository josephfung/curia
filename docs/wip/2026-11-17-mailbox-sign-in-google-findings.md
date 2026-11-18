# Mailbox sign-in: the two open Google questions (#2361)

Status: desk research done 2026-11-17; **real run still to do** (section 4).
Feeds #2361, and decides whether #2360 and #2362 need a different design before they're built.

The onboarding design (`2026-10-29-onboarding-journey-design.md`, *1b*) leaves two questions open:

1. Does Google keep allowing **restricted scopes on an unverified app in production**?
2. Do a **Workspace admin's controls** on unconfigured apps block it?

`gmail.modify` and `gmail.compose` are both restricted. `gmail.send` is only sensitive
([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Curia's own
Drive access uses the full `drive` scope, which is restricted too, so the same questions apply
to Curia's own Google account, not only the principal's.

## 1. What the vendor docs say

### Q1: unverified, External, In production, restricted scopes

**The docs say yes, behind a click-through warning, for up to 100 users per project for the life of the project.**

- Google's personal-use exception, on the restricted-scope verification page itself: verification
  isn't needed "if you are the only user of your app or if your app is used by only a few users,
  all of whom are known personally to you … You and your limited number of users might be
  comfortable with advancing through the unverified app screen"
  ([restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
- The OAuth policies (updated 2026-08-05) define a personal-use app as one "not shared with anyone
  else or … used by fewer than 100 people (all of whom are known personally to you)"
  ([policies](https://developers.google.com/identity/protocols/oauth2/policies)).
- The user cap counts "over the entire lifetime of the project, and it cannot be reset"
  ([Audience](https://support.google.com/cloud/answer/15549945)). It is per project, and one
  install uses at most two or three accounts, so the cap doesn't bind.
- No Google statement sets a deadline for verifying, or says these apps will be turned off.
  Nothing says the exception is time-limited either.

**Risks the docs do name:**

| Risk | Source | Effect on Curia |
|---|---|---|
| Tokens with restricted scopes can be revoked "at any time without notice" if the app "is no longer approved" | policies | A residual risk Curia can't remove. The health canary must catch it and offer a reconnect link, which #2361 already requires. |
| OAuth clients inactive for 6 months are deleted, with an email 30 days before | [cloud/15549257](https://support.google.com/cloud/answer/15549257) | Not a concern while Nylas uses the client daily. Worth a line in the guide for test installs. |
| New client secrets can be viewed **only once**, at creation (since June 2025) | same | The guide must say to copy the secret straight into Curia. |
| Refresh token rules: 6 months unused; a password change kills tokens with Gmail scopes; at most 100 tokens per account per client | [oauth2](https://developers.google.com/identity/protocols/oauth2) | A password change will invalidate the grant. Reconnect covers it, and the principal page should say so. |
| **Testing** status: refresh tokens expire after 7 days | oauth2 | Already ruled out in the design. Note that `docs/dev/google-drive.md:65` currently says Testing "can stay" for Curia's Drive client; that is wrong for long-lived use. |

**One conflicting source.** Nylas's "Fix Google access_denied" cookbook (updated 2026-10-07) says
restricted-scope apps are "blocked with `access_denied` for external users until it clears
both verification and a security assessment". The same page also describes the
Advanced → "Go to (app) (unsafe)" click-through, and Nylas's own verification guide says
"apps for personal use with fewer than 100 users skip verification". Forum reports of a hard
"This app is blocked" screen exist, but the causes aren't clear. **This conflict is why Q1
can't be closed on paper.**

### Q2: Workspace admin controls

**Default tenant: not blocked. Any admin can block it with one setting. And an admin can always
unblock it by marking the OAuth client ID Trusted.**

Sources: [S1: control which apps access Workspace data](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data)
and [S2: third-party & internal apps](https://knowledge.workspace.google.com/admin/apps/control-which-third-party-and-internal-apps-access-google-workspace-data),
both updated 2026-11-10.

- **Unconfigured third-party apps** have three options: allow all (the documented default), "basic sign-in info only", or
  "don't allow". The 2025 request-access workflow is on by default, so a blocked user can ask the admin
  from the error screen.
- **Restricted services:** if Gmail is set to Restricted, only apps marked Trusted or "Specific Google data" reach
  it, and existing untrusted tokens are revoked. The docs don't state the default; it's believed
  to be Unrestricted.
- **Trusted** "overrides a service restriction" and also works under "don't allow". An admin can trust a
  client ID **before anyone signs in** (Admin console → Security → Access and data control → API
  controls → Manage Third-Party App Access → Add app → OAuth App Name or Client ID → Trusted).
  It can take up to 24 hours to apply.
- **Unverified Gmail apps with more than 100 users** are blocked for new installs unless trusted
  ([authorize unverified apps](https://knowledge.workspace.google.com/admin/apps/authorize-unverified-third-party-apps)).
  This doesn't apply at our scale.
- **Internal apps** (project owned by the principal's org, user type Internal) need no verification
  and are exempt from the unverified-app limits. They can still be governed by the **Trust internal apps**
  checkbox, whose default isn't documented.
- **Advanced Protection Program:** "only verified third-party apps can access sensitive data". An
  enrolled principal can't use an unverified External app. Whether Trusted overrides that is unknown.
- **What the principal sees when blocked:** Google returns `Error 400: admin_policy_enforced`. The other errors are
  `org_internal` (an account outside the org tried an Internal client) and `access_denied`
  (the principal backed out of the unverified screen, or a hard block).

## 2. What changes if either answer is "no"

The answers don't change the *shape* of #2360 or #2362. They change two branches that both
issues need anyway, and they decide which Google setup the guide recommends.

| Outcome | #2361 | #2360 (first conversation) | #2362 (deep dive) |
|---|---|---|---|
| Q1 yes, Q2 yes (expected) | Guide as designed | As designed | As designed |
| **Q1 no** (hard block on unverified restricted scopes) | Gmail-account principals have no free route. The options are the Nylas shared app (Pro annual + Accelerator, about $2,400/yr), a CASA assessment, or a Workspace org with an Internal app. The guide must say so, and Setup must check it before onboarding. | The connect step can't be "one click on the day" for a gmail.com principal. Setup has to settle it before **Start onboarding**. | Unchanged once connected. |
| **Q2 no** (admin blocks, and the principal isn't the admin) | The callback must recognise `admin_policy_enforced` and `org_internal` and say what to ask the admin, naming the client ID to trust. Setup offers an "admin pre-trust" step. | The in-session connect step needs a **blocked-by-admin exit**: Curia explains, tells the operator, and onboarding goes on without the mailbox (style, autonomy and preferences don't need it). "What to expect" and the triage switch wait for the connection. | The deep dive starts later, when the "connected" event arrives. It already starts from that event, so no change is needed. |

So whatever the answers, #2360 should have an **"I couldn't connect yet"** path that keeps the
first conversation going. The real run decides whether that path is an edge case or the main route.

## 3. Curia's own mailbox in the same flow

Today both registries take a pasted grant id:

- `email_accounts`, for Curia's mailboxes (`src/channels/http/routes/email-accounts.ts`);
- `principal_mailboxes` (`src/channels/http/routes/principal-mailboxes.ts`).

The setup catalog tells the operator to copy grant ids from the Nylas dashboard
(`skills/setup/tools/setup-status/catalog.yaml:45-65`). Note that the flat `ceo_nylas_grant_id`
named in #2361 is now migrated into the registry on boot, so the callback should write a
**registry row**, not the flat key.

**What a Nylas API key alone allows** (developer.nylas.com, checked 2026-11-17):

- `GET /v3/applications` returns the application id. That id *is* the hosted-auth `client_id`. The
  call also returns the region and the registered callback URIs.
- `POST /v3/applications/redirect-uris` registers Curia's callback.
- `POST /v3/connectors` creates the Google connector from the GCP client id and secret. This isn't
  allowed on Sandbox apps.
- `/v3/connect/auth` and `/v3/connect/token` run hosted auth, with the **API key as `client_secret`**.
- `GET /v3/grants?email=` and `DELETE /v3/grants/{id}` find and remove grants.
- The region can be found by probing `GET /v3/applications` on US, then EU. Today the
  clients are hardcoded to US (`ceo-nylas-client.ts:14`, and the SDK default).

So the operator flow can be: **paste the Nylas API key** (Curia finds the region and client id, and
registers its callback) → **paste the GCP client id and secret** once, and Curia creates the connector
→ **"Add mailbox"** buttons for Curia's mailbox and the principal's. Each one runs the same hosted-auth
link and callback, and the callback writes the matching registry row. No grant ids are copied anywhere.

Things only a person can do: create the Nylas application and API key in the dashboard, and all the Google Cloud
work. That means the project, the consent screen, the OAuth web client with redirect
`https://api.{us|eu}.nylas.com/v3/connect/callback`, and the Pub/Sub topic for mail notifications.

**Curia's own mailbox** uses the **same hosted-auth flow** as the principal's, through the same Google
connector. The callback's target (`email_accounts` or `principal_mailboxes`) is a parameter of the
minted link, and the operator clicks the link instead of the principal. The restricted-scope
questions apply to Curia's Google account too, so the real run below covers both.

*Decided 2026-11-17:* no Nylas Agent Accounts. They save nothing for a personal Google mailbox and
tie Curia more closely to Nylas. **Region:** selectable in setup, with discovery by probing
`GET /v3/applications` as a convenience.

## 4. The real run (needed to close the acceptance criterion)

Everything above is from documentation. The acceptance criterion asks for a real run. The Nylas
dashboard's own "Connect account" button runs hosted auth through the same connector and GCP
client, so **no Curia code is needed** to answer Q1 and Q2.

**Setup (once):**

1. A non-Sandbox Nylas app, with a Google connector built from a new GCP project's **Web** OAuth client.
2. On the consent screen: External, **In production** (not Testing), unverified. Scopes: `gmail.modify`,
   `gmail.compose`, `calendar`, `calendar.events`.

**Accounts:**

- (a) a consumer gmail.com account that isn't the project owner;
- (b) a non-admin user in a Workspace trial tenant;
- (c) the admin of that tenant.

| # | Account and setting | Record |
|---|---|---|
| R1 | (a), External prod unverified | Warning with Advanced → Go to (unsafe), or a hard block? Screens shown; scopes on the grant |
| R2 | (b), tenant out of the box | Same as R1. Also record the tenant's default for unconfigured apps and for Trust internal apps |
| R3 | (b), unconfigured apps set to "Don't allow" | The error code Nylas sends back to the redirect; whether request-access is offered |
| R4 | (b), Gmail set to Restricted | Blocked? Is the grant from R2 revoked, and does `grant_status` go `invalid`? |
| R5 | (b), R3 + R4 with the client ID **Trusted** | Does it work? How long until it applies? |
| R6 | (b), Internal project inside the tenant | No warning? Then repeat with R3 to see what Trust internal apps changes |
| R7 | (a) and (b) on **day 8 or later** | Grants still valid, and a Gmail list and a calendar list both succeed (rules out a 7-day expiry) |
| R8 | (a), untick calendar on granular consent | Does the grant's `scope` show the gap? (an acceptance criterion of #2361) |

Optional: an Advanced Protection user, with and without Trusted.

**Already partly answered?** If Curia's own Drive OAuth client in prod is External, published and
unverified, and its token has lasted more than 7 days, that answers R1 and R7 for a consumer account
with a restricted scope (`drive`).
