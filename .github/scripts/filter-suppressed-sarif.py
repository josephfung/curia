#!/usr/bin/env python3
"""Drop already-suppressed results from a SARIF file, in place.

GitHub code scanning ignores SARIF ``suppressions``. Semgrep honours an in-tree
``# nosemgrep`` comment — it excludes the finding from its console output and emits it
with ``"suppressions": [{"state": "accepted"}]`` — but ``upload-sarif`` surfaces it as an
OPEN alert regardless. Every deliberately-accepted finding therefore has to be dismissed
by hand in the Security tab, and that dismissal is keyed to the finding's fingerprint: edit
a comment near the suppressed line and the alert comes back as a fresh, undismissed one.
That is exactly how alert #192 returned as #262 on ``pnpm-workspace.yaml``.

Running this between the scan and the upload makes the ``# nosemgrep`` comment the single
source of truth for what is accepted — in the tree, in code review, next to the reason —
instead of a click in a web UI that silently evaporates. It does not decide anything on its
own: the scanner has already classified these findings as suppressed, and this only forwards
that classification to a consumer that would otherwise discard it.

Nothing is dropped quietly. Every removed finding is printed with its rule ID and location.

Fail closed. A missing, unparseable, or non-SARIF input exits non-zero so the workflow step
fails loudly. Exiting 0 on a broken file would hand a stale or truncated SARIF to
``upload-sarif``, which reads "no findings" as "everything was fixed" and would close real
alerts across the repo.

Usage: filter-suppressed-sarif.py <path-to-sarif>
"""

import json
import sys


def is_suppressed(result):
    """True when the scanner marked this result suppressed.

    Semgrep writes ``"suppressions": []`` on findings it did NOT suppress, so the emptiness
    of the list is the signal, not the presence of the key. Treating the key as a boolean
    would delete every finding in the file.
    """
    return bool(result.get("suppressions"))


def describe(result):
    """A short human-readable identifier for the job log."""
    rule = result.get("ruleId", "<no ruleId>")
    locations = result.get("locations") or []
    if not locations:
        return rule
    physical = locations[0].get("physicalLocation", {})
    uri = physical.get("artifactLocation", {}).get("uri", "<no file>")
    line = physical.get("region", {}).get("startLine")
    return "{} at {}{}".format(rule, uri, ":{}".format(line) if line else "")


def main(argv):
    if len(argv) != 2:
        print("usage: filter-suppressed-sarif.py <path-to-sarif>", file=sys.stderr)
        return 1

    path = argv[1]

    try:
        with open(path, encoding="utf-8") as handle:
            sarif = json.load(handle)
    except OSError as err:
        print("cannot read SARIF file {}: {}".format(path, err), file=sys.stderr)
        return 1
    except ValueError as err:
        print("{} is not valid JSON: {}".format(path, err), file=sys.stderr)
        return 1

    runs = sarif.get("runs") if isinstance(sarif, dict) else None
    if not isinstance(runs, list):
        print("{} has no 'runs' array — not a SARIF document".format(path), file=sys.stderr)
        return 1

    dropped = []
    for run in runs:
        results = run.get("results")
        if not isinstance(results, list):
            # A run may legitimately omit `results`; nothing to filter there.
            continue
        kept = [r for r in results if not is_suppressed(r)]
        dropped.extend(r for r in results if is_suppressed(r))
        run["results"] = kept

    if not dropped:
        # Leave the file untouched rather than round-tripping it through the JSON encoder,
        # so the common case uploads exactly the bytes the scanner produced.
        print("no suppressed findings in {}; SARIF left unchanged".format(path))
        return 0

    for result in dropped:
        print("dropping suppressed finding: {}".format(describe(result)))

    with open(path, "w", encoding="utf-8") as handle:
        json.dump(sarif, handle)

    print("dropped {} suppressed finding(s) from {}".format(len(dropped), path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
