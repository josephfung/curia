"""
One-time Google Workspace OAuth flow for workspace-mcp.

Run this script once per deployment (or after token revocation) to authenticate
Curia's Gmail account with the google-workspace MCP server. Tokens are cached
locally and copied to the VPS — after that, no re-auth is needed unless revoked.

Usage:
  GOOGLE_OAUTH_CLIENT_ID=<id> GOOGLE_OAUTH_CLIENT_SECRET=<secret> \\
  CURIA_GOOGLE_EMAIL=<curia-gmail> \\
    uv run --with mcp scripts/gdrive-auth.py

After it completes, copy the tokens to the VPS — see docs/dev/google-drive.md.
"""
import asyncio
import os
import re
import sys
import webbrowser

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Authenticate all five services so the full tool set is available.
SERVICES = ["gmail", "drive", "calendar", "docs", "sheets"]


async def auth_service(session: ClientSession, service: str, email: str) -> None:
    print(f"  Authenticating {service}...")
    result = await session.call_tool("start_google_auth", {
        "service_name": service,
        "user_google_email": email,
    })

    url = None
    for content in result.content:
        text = getattr(content, "text", "")
        if not text:
            continue
        match = re.search(r"https://accounts\.google\.com[^\s'\"<>]+", text)
        if match:
            url = match.group(0).rstrip(".,;:!?)\"'")
            break
        print(f"  {text}")

    if url is None:
        sys.exit(
            f"ERROR: no OAuth URL returned for service '{service}'. "
            "Check the output above for error details."
        )

    print(f"  Opening browser for {service}: {url}\n")
    webbrowser.open(url)
    input(f"  Complete the {service} login in your browser, then press Enter to continue...")


async def main() -> None:
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    email = os.environ.get("CURIA_GOOGLE_EMAIL", "")

    missing = [k for k, v in [
        ("GOOGLE_OAUTH_CLIENT_ID", client_id),
        ("GOOGLE_OAUTH_CLIENT_SECRET", client_secret),
        ("CURIA_GOOGLE_EMAIL", email),
    ] if not v]
    if missing:
        raise SystemExit(f"ERROR: Set these env vars before running: {', '.join(missing)}")

    params = StdioServerParameters(
        command="uvx",
        args=["workspace-mcp", "--single-user"],
        env={
            "GOOGLE_OAUTH_CLIENT_ID": client_id,
            "GOOGLE_OAUTH_CLIENT_SECRET": client_secret,
            "HOME": os.environ["HOME"],
            "PATH": os.environ["PATH"],
        },
    )

    print(f"Starting workspace-mcp and authenticating {email}...\n")
    print("You will be prompted to log in once per service.")
    print("Use the browser that opens — log in as Curia's Gmail account.\n")

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for service in SERVICES:
                await auth_service(session, service, email)

    print("\nAll services authenticated.")
    print(f"Tokens saved to: ~/.google_workspace_mcp/credentials/{email}.json")
    print("\nNext step — copy tokens to the VPS (see docs/dev/google-drive.md Step 5).")


asyncio.run(main())
