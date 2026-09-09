#!/usr/bin/env bash
# Tests for .github/scripts/filter-suppressed-sarif.py (curia#1754).
#
# Why the script exists: GitHub code scanning ignores SARIF `suppressions`. Semgrep
# honours an in-tree `# nosemgrep` comment and emits the finding with
# `"suppressions": [{"state": "accepted"}]`, but GitHub uploads it as an OPEN alert
# anyway, so every suppressed finding has to be hand-dismissed in the UI. That
# dismissal is keyed to the finding's fingerprint, so editing a comment near the
# suppressed line resurrects it as a fresh, undismissed alert — which is exactly how
# alert #192 came back as #262 on pnpm-workspace.yaml.
#
# The script drops already-suppressed results before upload so the `# nosemgrep`
# comment is the single reviewable source of truth. These tests pin the behaviour
# that matters: unsuppressed findings must survive untouched, and a malformed or
# missing SARIF must fail loudly rather than silently uploading nothing.
#
# Run: bash tests/ci/test-filter-suppressed-sarif.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/filter-suppressed-sarif.py"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

check_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# Build a SARIF file with one run whose results are the given JSON array literal.
write_sarif() { # path results_json
  cat > "$1" <<JSON
{
  "version": "2.1.0",
  "runs": [
    {
      "tool": { "driver": { "name": "Semgrep OSS" } },
      "results": $2
    }
  ]
}
JSON
}

SUPPRESSED='{"ruleId":"r.suppressed","suppressions":[{"kind":"inSource","state":"accepted"}],
  "locations":[{"physicalLocation":{"artifactLocation":{"uri":"pnpm-workspace.yaml"},
  "region":{"startLine":50}}}]}'
LIVE='{"ruleId":"r.live",
  "locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/a.ts"},
  "region":{"startLine":7}}}]}'
# Semgrep emits `"suppressions": []` for a finding it did NOT suppress. An empty
# array must be treated as "not suppressed" — reading it as truthy would delete
# every real finding in the file.
EMPTY_SUPP='{"ruleId":"r.empty-array",
  "suppressions":[],
  "locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/b.ts"},
  "region":{"startLine":9}}}]}'

results_of() { # sarif_path -> newline-separated ruleIds
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print("\n".join(r.get("ruleId","") for run in d["runs"] for r in run["results"]))' "$1"
}

echo "filter-suppressed-sarif"

# --- drops suppressed, keeps everything else ------------------------------------
f="$tmpdir/mixed.sarif"
write_sarif "$f" "[$SUPPRESSED, $LIVE, $EMPTY_SUPP]"
out="$(python3 "$SCRIPT" "$f" 2>&1)"
check_eq "exits 0 on a well-formed SARIF" "0" "$?"
check_eq "keeps the unsuppressed results" "r.live
r.empty-array" "$(results_of "$f")"
if printf '%s' "$out" | grep -q "pnpm-workspace.yaml:50"; then
  ok "names each dropped finding in its output"
else
  bad "names each dropped finding in its output (got: $out)"
fi

# --- a file with nothing suppressed is left exactly as-is ------------------------
f="$tmpdir/clean.sarif"
write_sarif "$f" "[$LIVE]"
before="$(cat "$f")"
python3 "$SCRIPT" "$f" >/dev/null 2>&1
check_eq "leaves a SARIF with no suppressions byte-identical" "$before" "$(cat "$f")"

# --- every result suppressed -> valid empty-results SARIF, still exit 0 ----------
f="$tmpdir/all.sarif"
write_sarif "$f" "[$SUPPRESSED]"
python3 "$SCRIPT" "$f" >/dev/null 2>&1
check_eq "exits 0 when every result is suppressed" "0" "$?"
check_eq "leaves an empty results array, not a broken file" "" "$(results_of "$f")"

# --- multiple runs are each filtered independently -------------------------------
f="$tmpdir/multirun.sarif"
cat > "$f" <<JSON
{"version":"2.1.0","runs":[
  {"tool":{"driver":{"name":"a"}},"results":[$SUPPRESSED,$LIVE]},
  {"tool":{"driver":{"name":"b"}},"results":[$LIVE]}
]}
JSON
python3 "$SCRIPT" "$f" >/dev/null 2>&1
check_eq "filters every run, not just the first" "r.live
r.live" "$(results_of "$f")"

# --- fail closed -----------------------------------------------------------------
# A missing, unparseable, or non-SARIF file must fail the step. Exiting 0 here would
# hand a truncated or stale SARIF to upload-sarif and quietly shrink the Security tab.
python3 "$SCRIPT" "$tmpdir/does-not-exist.sarif" >/dev/null 2>&1
check_eq "fails on a missing file" "1" "$?"

printf 'not json at all' > "$tmpdir/bad.sarif"
python3 "$SCRIPT" "$tmpdir/bad.sarif" >/dev/null 2>&1
check_eq "fails on unparseable JSON" "1" "$?"

printf '{"version":"2.1.0"}' > "$tmpdir/noruns.sarif"
python3 "$SCRIPT" "$tmpdir/noruns.sarif" >/dev/null 2>&1
check_eq "fails on JSON that is not SARIF (no runs)" "1" "$?"

python3 "$SCRIPT" >/dev/null 2>&1
check_eq "fails when given no path" "1" "$?"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
