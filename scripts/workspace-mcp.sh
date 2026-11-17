#!/bin/sh
# Launch the Google Workspace MCP server (workspace-mcp) at the version and dependency tree
# locked in workspace-mcp/requirements.txt, beside this script (#2010, #2657). Arguments
# pass through unchanged.
#
# In the Docker image the server is installed at build time to /opt/uv, from that lockfile
# with every hash checked, so it starts without touching PyPI. Anywhere else (pnpm dev,
# scripts/gdrive-auth.py) uvx fetches it with the lockfile as constraints: the same
# versions, but uvx does not check the hashes.
set -eu

VENDORED=/opt/uv/bin/workspace-mcp
if [ -x "$VENDORED" ]; then
  exec "$VENDORED" "$@"
fi

# The lockfile pins workspace-mcp itself too, so the bare name resolves to that version.
# --isolated: without it uvx would run a workspace-mcp installed with `uv tool install`,
# at whatever version that is, instead of resolving against the lockfile.
exec uvx --isolated --constraints "$(dirname "$0")/workspace-mcp/requirements.txt" workspace-mcp "$@"
