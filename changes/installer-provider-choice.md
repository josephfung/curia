### Added

- **Installer model provider** — both installers offer OpenRouter or AWS Bedrock besides Anthropic, with per-tier model picks. (#2749)

### Changed

- **`config/local.yaml` mount** — `docker-compose.yml` mounts it into the curia container; the container won't start without it. (#2749)
