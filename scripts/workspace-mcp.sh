#!/bin/sh
# Launch the Google Workspace MCP server (workspace-mcp) at the version pinned in
# workspace-mcp.pin, beside this script (#2010). Arguments pass through unchanged.
#
# In the Docker image the server is installed at build time to /opt/uv, so it starts
# without touching PyPI. Anywhere else (pnpm dev, scripts/gdrive-auth.py) uvx fetches
# the pinned version, with its dependency tree frozen at the pinned cutoff.
set -eu

VENDORED=/opt/uv/bin/workspace-mcp
if [ -x "$VENDORED" ]; then
  exec "$VENDORED" "$@"
fi

. "$(dirname "$0")/workspace-mcp.pin"
exec uvx --exclude-newer "$WORKSPACE_MCP_EXCLUDE_NEWER" "workspace-mcp==$WORKSPACE_MCP_VERSION" "$@"
