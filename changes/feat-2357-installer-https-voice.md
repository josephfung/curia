### Added

- **Installer voice** — fresh installs start LiveKit with generated keys and seed its vault values. (#2357)

### Changed

- **Installer topology** — HTTPS is the recommended default; proxy installs give their public address. (#2357)
- **Setup Voice check** — reports LiveKit not running or rejecting keys instead of done. (#2357)

### Fixed

- **Voice calls** — Curia joins rooms over the internal LiveKit address, so local calls work. (#2357)
- **Installer upgrades** — `install.sh` replaces an older `setup-common.sh` it finds on disk. (#2357)

### Security

- **Installer database password** — fresh installs generate a real password instead of keeping the shipped placeholder. (#2357)
