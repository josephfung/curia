# ADR-055: The phone app is an installable PWA, with paired device sessions and web push as a principal channel

Date: 2026-10-28
Status: Accepted

## Context

To reach Curia from a phone today, an operator sets up Signal, SMS or Slack. Email is easy to
set up. Signal and SMS need a phone number, which is the hardest step in onboarding, and Slack
is not much easier. About half of Curia's conversations are ones Curia starts: finished work,
approvals, follow-ups. So whatever replaces those channels has to let Curia reach the operator,
not just let the operator reach Curia.

The console's web chat could not do that (#2341):

- **Curia cannot start a web conversation.** Outbound messages go back only on the channel of
  the inbound message they answer, the outbound gateway has no `web` branch, approvals are
  limited to `signal | sms | slack | email`, and an SSE broadcast reaches only sockets connected
  at that moment.
- **Every browser has its own thread.** The client makes up a conversation ID on first send
  and keeps it in `localStorage`, so two computers show two different histories.
- **Sessions expire daily.** Sessions are stored hashed in Postgres and reloaded at boot, so
  they already survive restarts and deploys. But each lasts a fixed 24 hours with no renewal,
  which operators experience as "logged out again". There is no logout, device list or
  revocation.

Self-hosted deployments come in four shapes: a public VPS; local and reached over the LAN by
hostname or IP; local with port forwarding, reached by IP; and local with port forwarding and a
dynamic domain. Curia cannot tell which one it is running in.

Alternatives considered:

- **A native app in the App Store and Play Store, or a Capacitor wrapper.** Publishing an
  open-source project's client centrally raises trust and distribution questions, and it needs
  per-platform push credentials. It is also the only way to keep a call alive with the screen
  locked. Rejected for now. A PWA keeps the door open, since a later wrapper can reuse it.
- **A Curia-hosted relay for connectivity or notifications.** It would solve reachability for
  local installs, but it adds a service to run and pay for, and an outside party in the message
  path. Rejected. Reachability stays the operator's job, and we document the options.
- **A QR code that carries the session itself.** Simplest to build, but a photo or screenshot
  of the code would be a long-lived login. Rejected.
- **Stateless signed tokens (JWT or a signed cookie) instead of database sessions.** Nothing
  is gained: database sessions already survive deploys, and a stateless token can't be revoked
  per device without a deny-list, which is a sessions table again. Rejected.
- **A code-level router that picks the channel for every message to the principal.** This
  would enforce the operator's channel order exactly, but it reworks how every agent reaches
  the principal and overrides the standing preferences and per-message requests ("email me the
  report") that agents follow today. Since #2159, approvals deliberately let the agent choose
  one channel. Rejected in favour of adding one more channel agents can choose.

A Phase 0 spike on a real iPhone (iOS 18.7, installed to the home screen) settled the
platform questions. Results are in the #2341 comments and summarized under Decision.

## Decision

The phone app is the console, made installable and served by each Curia from its own origin.
It gets its own device session through a QR pairing, shares one server-owned chat thread with
every other device, and is reached through web push on a new principal-only `web` channel. The
agents keep choosing the channel. Code decides only whether the app is reachable.

1. **An installable PWA, on HTTPS only.** The console gets a web manifest, icons and a
   service worker at `/sw.js`, and the console CSP gains `manifest-src 'self'` and
   `worker-src 'self'`. Browsers allow service workers and push only on a trusted HTTPS
   origin (or `localhost`). So the full app works only on deployments with HTTPS and a
   hostname. Other deployments get the plain mobile site, and Curia **says so** before
   pairing, on the desktop, and again on the phone, after a capability check. It never fails
   silently. The service worker fetches the document network-first and the hashed assets
   cache-first, and never caches `/api` or `/auth`. A new build after a deploy shows an
   "updated · Reload" prompt rather than reloading mid-conversation. The spike confirmed this
   flow on iOS.

2. **Pairing by single-use code.** The desktop console mints a pairing code: single-use,
   expiring after 10 minutes, stored hashed and rate-limited. The QR code holds
   `https://<phone-origin>/pair#c=<token>`. The token sits in the URL fragment so it never
   reaches proxy or server logs. A short typable code covers manual entry. Redeeming either
   code creates a **device session** for that phone. The phone origin defaults to the desktop
   browser's origin or `APP_ORIGIN`, and the operator is asked for it when that is `localhost`,
   a private or bare IP, or `http://`. On iOS the session cookie set in Safari carried over to
   the home-screen app, but `localStorage` did not. So **pairing state lives only in the
   cookie**. The typed code stays as an in-app fallback for platforms where even the cookie
   does not carry over. Once the session and its audit are recorded, either credential caps
   the row's remaining life at two minutes, so a photographed QR and a still-valid short code
   are not both long-lived. The cap is a later update: releasing a credential after a failed
   sign-in leaves the original ten-minute window. The short code still works in that window
   when the cookie did not carry into the installed app, and that second redemption creates
   its own device session. The server logs it at warn level, and the `operator.session` pair
   event sets `secondCredential`. The desktop shows each credential's redemption on its own.
   Rate limiting stays keyed on `request.ip`, the same as `/auth`. `trustProxy` stays off,
   because turning it on would change the client address for every route. Behind a reverse
   proxy the pairing limit is therefore shared, and a 429 tells the operator to wait a few
   minutes.

3. **Sessions slide and are per device.** Every session, desktop and phone alike, expires
   after **90 days without use**. Each authenticated request pushes the expiry forward,
   throttled so it doesn't write to the database on every request. Sessions keep their storage
   model (a hashed random token in Postgres, mirrored in memory and reloaded at boot), so
   restarts and deploys never log anyone out. `sessions` gains a kind (`browser` or
   `paired_device`), a name and a user agent. The console gains logout, a device list with
   rename and revoke, and "sign out all other devices". Revoking a session also deletes its
   push subscriptions. The cookie stays `httpOnly`, `Secure` on HTTPS and `SameSite=Strict`.
   The spike confirmed that Strict survives QR → Safari, a notification tap → app, and the
   service worker's own `fetch`.

4. **One web thread, owned by the server.** The principal has a single web conversation,
   created and owned by the server. Every browser and paired phone shows it. The client
   fetches its ID instead of making one up. On upgrade, the most recently active `web`
   conversation becomes the shared thread. Other threads are not merged and age out under the
   working-memory TTL. The client keeps the SSE stream open while the chat is visible, rather
   than once per turn. The operator's own messages are echoed to the thread's other open
   devices, so every screen shows the same conversation live.

5. **Web push on a principal-only `web` channel.**
   - **Delivery.** Delivering on `web` does three things. It appends the message to the
     shared thread in working memory, so the coordinator has the context when the operator
     replies there. It broadcasts the message to open clients. And it pushes to every
     subscribed device of the principal, unless one of the principal's clients has the thread
     on screen right now. That suppression happens **on the server**, because every push that
     is sent must show a notification: iOS may revoke a subscription whose pushes show none.
     Curia's replies to messages sent from the app follow the same rule, so a reply that lands
     after the phone is locked still alerts.
   - **VAPID keys.** The keys are generated once and kept in the vault (ADR-020/021).
     Regenerating them on deploy would silently break every subscription. The VAPID subject is
     `APP_ORIGIN`, which must be `https://`. In the spike, Apple rejected every push with
     403 `BadJwtToken` while the subject was a placeholder `mailto:`, and accepted the
     `https://` origin.
   - **Content.** The notification shows the first ~100 characters of the message as plain
     text. An optional setting replaces it with "New message from Curia".
   - **Channel choice stays with the agents.** A principal-only `web-send` skill (using the
     `principal` alias, ADR-047) and a `web` option for `deliver-approval` make the app one more
     channel agents can choose. A default order, **Signal → SMS → App → Slack → email**, reaches
     the agents through runtime injection, not `system_prompt` text (ADR-046). The operator's
     standing preferences and explicit requests override it.
   - **What code enforces.** Code decides two things. One is **availability**: the App channel
     counts as reachable only with a live subscription or a client on screen. With neither,
     `web-send` returns a structured failure rather than "success". The other is **delivery
     failure handling**:
     - A 404/410 means the subscription is dead. The subscription is deleted. When none
       remain, that message goes out on the next channel in the order and the console says the
       phone stopped receiving notifications.
     - A 403 or other 4xx is a **setup error**, such as a bad VAPID subject. The subscription
       is kept, the message goes out on the next channel, and the console shows the push
       service's reason.
     - A 429 or 5xx is retried with backoff.
     - A 2xx counts as delivered. There are no receipts.

6. **Voice: paused, not dropped.** The existing LiveKit call runs unchanged in the installed
   app. The spike showed that when iOS backgrounds the app or the phone locks, the mic track is
   **muted, not ended**, while the peer connection stays connected. Audio resumes on return.
   So:
   - the console shows "Paused while Curia is in the background" while the mic is muted;
   - Curia does not speak into a muted call;
   - the server ends the call after a grace period (about 2 minutes), or when the participant
     disconnects, as happens when the app is swiped closed.
   A real Curia call worked over cellular in mobile Safari.

## Consequences

- **Operators can be reached without a phone number.** An operator on an HTTPS deployment can
  install Curia, pair by scanning a code, get notified when Curia messages them, reply, and
  call, with no Signal or SMS provisioning.
- **Fewer logouts.** Daily logouts end, and deploys never log anyone out. Revocation becomes
  possible per device, which the single shared access key could never offer.
- **One history everywhere.** Every device shows the same thread, and a message Curia starts
  has a home in the web chat.
- **HTTPS is required for the app.** Local installs over the LAN and bare-IP setups get the
  mobile site, not the app. We accept that and explain it rather than work around it. Getting
  HTTPS (a VPS, dynamic DNS with Caddy, Tailscale, Cloudflare Tunnel) is documented, not
  built.
- **Reaching the phone is still the operator's network's job.** A notification can arrive
  from a home-only Curia, because push goes out through Apple's and Google's services, but
  tapping it needs the phone to reach Curia. The app shows "Can't reach your Curia" instead of
  a blank page.
- **Push delivery is best effort.** A 2xx from the push service is the last signal we get.
  Dead subscriptions fall back to the next channel, and a notification the operator never
  sees, after a 2xx, goes unnoticed. Read receipts from the service worker are possible
  later.
- **Channel order is a default, not a guarantee.** Agents still choose, so a message can go
  out on a lower-ranked channel when the agent's reading of the operator's preferences says
  so. That keeps today's behaviour (#2159). Enforcing the order in code would be a separate
  decision.
- **No locked-screen calls.** Long locked-screen calls are not possible in a PWA. The call
  pauses, and it ends after the grace period. A native wrapper is the path if that becomes
  necessary.
- **Android is unverified.** Phase 0 tested iOS only. Android goes through the manual device
  matrix before the push and voice work ships.
- **More to keep in sync.** A long-lived SSE stream per open device is
  `GET /api/chat/stream`. ADR-057 removed `/api/messages/stream`, so the two
  streams no longer share clients. Proxies must not compress `/api/chat/stream`,
  so `curia-deploy`'s Caddyfile needs that exclusion. The old
  `@not_sse { not path /api/messages/stream* }` entry does not cover it.
