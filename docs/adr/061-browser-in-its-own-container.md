# ADR-061: The web browser runs in its own container, driven by Patchright

Date: 2026-11-10
Status: Accepted

## Context

The `web` bundle is on by default and pinned to the coordinator, but the published core image has no browser and no Xvfb. On a vanilla `docker compose up` every `web-browser` call failed with `browserService is not available`, health reported the browser as `skipped`, and the setup wizard said nothing. Pages that need JavaScript, sign-ins or forms were out of reach (#2541).

A fresh install should have a working browser without making the core image bigger for everyone, and without running Chrome next to Curia's secrets: #2521 turned on Chrome's sandbox, but in-process Chrome still inherits Curia's environment, shares its container and network, and needs a seccomp profile that relaxes the whole container.

Alternatives considered:

- **Chromium in the core image.** About 1 GB more for every install, and Chrome beside the secrets.
- **A `-browser` variant of the core image.** The same isolation problem, plus two images to choose between.
- **A hosted browser service** (Browserless and the like). Needs an account or a key, so not a default.
- **Downloading Chromium at first boot.** Its system libraries need root, and the download bypasses image signing.
- **Stock Playwright for the vanilla install and Patchright elsewhere.** Two behaviours to maintain, and the vanilla one would get no production use.

## Decision

Ship the browser as its own image, `ghcr.io/josephfung/curia-browser`, and run it as the `browser` service in the shipped `docker-compose.yml`. Curia attaches over the DevTools protocol (`connectOverCDP`) at `BROWSER_CDP_URL`.

- **The image** holds Patchright's Chromium, downloaded for the `patchright` version in `pnpm-lock.yaml`, with Xvfb, openbox and tint2. `docker-publish.yml` builds it from the same commit and under the same tags as the core image, signs it and attests an SBOM; `trivy.yml` scans it.
- **Isolation.** Non-root, no capabilities, `no-new-privileges`, read-only root, Chrome's sandbox on under `docker/seccomp-chrome.json`, and none of Curia's environment. It joins only a `browser` network shared with Curia, so it has no route to Postgres. The relaxed seccomp profile now applies to this container alone.
- **Access control is the network.** DevTools has no authentication, so its port is never published. Chrome serves it on loopback only when headful, so socat forwards it inside the container, through a gate that admits only peers on the container's own subnet other than its gateway (on Linux, any host user can reach a bridge IP, arriving from the gateway). Curia connects by IP because Chrome refuses a DevTools request whose `Host` is a hostname, and only to a private address, so a container that is down cannot be impersonated through outside DNS.
- **Egress.** Chrome sends every request through an egress proxy in the container that resolves each host once and refuses private, loopback and link-local addresses, then connects to the address it checked (#2521). `BROWSER_PROXY` is its upstream. Curia's HTTP server refuses requests from the container's address.
- **Availability.** Curia boots whether or not the container is up, reports `browser: fail` until it attaches, and reconnects with backoff after a restart or a crash.
- **Engine.** Stay on Patchright as the only driver. It changes the driver, not the browser: the Chromium is the build Playwright downloads. Only `src/browser/browser-service.ts` imports it at runtime, so leaving is cheap. Because the driver runs inside Curia's process with its secrets and has one npm maintainer, Patchright bumps are held for human review and excluded from automatic Dependabot merging (curia-deploy's `hold_dependencies`). Switch to stock Playwright if Patchright goes unmaintained, lags Playwright by weeks, or causes another Patchright-only outage like #2255.
- **In-process launch stays** for running from source and for images built on the core image, until they move. It is what runs when `BROWSER_CDP_URL` is unset.

Real Google Chrome stays out of the default image: its Linux build has no arm64. A deployment can build its own image on top of this one.

## Consequences

- A vanilla install gets a working `web-browser` on amd64 and arm64 with no setup, and the core image is unchanged in size.
- A browser compromise or crash no longer reaches Curia's process, environment or database, and the `curia` container returns to Docker's default seccomp profile.
- Two images must stay in step. They are published together under one tag, and a mismatch would surface as CDP protocol drift; `CURIA_IMAGE_TAG` sets both in the shipped compose file.
- The container's profile, locale, window and proxy are set by its launch command rather than by Curia's `browser.*` config. A proxy with credentials is not supported there, because Chrome's `--proxy-server` cannot carry them; Curia refuses `browser.proxy` with a container rather than egress directly.
- The container's Chrome flags copy the ones Patchright passes when it launches Chromium itself; `tests/unit/browser/browser-entrypoint.test.ts` fails when a Patchright bump changes them.
- Existing installs keep their old `docker-compose.yml` (the installer never overwrites it) and must add the service by hand to get the container.
- Bot-protected sites may still block bundled Chromium, especially from a datacenter IP. A residential egress (`BROWSER_PROXY`) is the lever, not the engine.
