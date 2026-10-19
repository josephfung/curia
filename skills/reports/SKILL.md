---
name: reports
description: >
  The principal's digest queue — file "act, then tell" items, and list and acknowledge them when building a digest. Also spot checks: list-spot-checks gives a digest its numbered spot-check block, and record-spot-check records the principal's "N good" / "N bad" verdicts.
version: "0.3.0"
tools:
  - report-to-principal
  - list-principal-reports
  - ack-principal-reports
  - list-spot-checks
  - record-spot-check
---
