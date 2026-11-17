"""Build-time check that the installed workspace-mcp serves tools for each service.

Usage: probe.py <workspace-mcp executable> <service> [<service> ...]

Starts the server once per service, as Curia does (stdio, --tool-tier complete,
--tools <service>), and asks for its tool list over MCP. A service with no tools
fails the build: workspace-mcp skips a service whose module fails to import and
still starts, so without this a broken dependency would ship as missing tools.

Only the MCP protocol is used, never workspace-mcp's internal module names, so an
upstream reorganisation does not break the build. No Google credentials are
needed to list tools; dummy OAuth client values satisfy its startup checks.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

TIMEOUT_SECONDS = 60


def list_tools(executable: str, service: str) -> list[str]:
    home = tempfile.mkdtemp(prefix="workspace-mcp-probe-")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": home,
        "GOOGLE_OAUTH_CLIENT_ID": "probe",
        "GOOGLE_OAUTH_CLIENT_SECRET": "probe",
    }
    proc = subprocess.Popen(
        [executable, "--tool-tier", "complete", "--tools", service],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    # A server that never answers must fail the build, not hang it.
    timer = threading.Timer(TIMEOUT_SECONDS, proc.kill)
    timer.start()
    try:
        def send(message: dict) -> None:
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()

        def receive(request_id: int) -> dict:
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue  # stray non-protocol output on stdout
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(f"{service}: {message['error']}")
                    return message["result"]
            raise RuntimeError(
                f"{service}: server exited or timed out before answering request {request_id}; "
                f"stderr:\n{proc.stderr.read()[-2000:]}"
            )

        send({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "curia-build-probe", "version": "0"},
            },
        })
        receive(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        return [tool["name"] for tool in receive(2)["tools"]]
    finally:
        timer.cancel()
        proc.kill()
        proc.wait()
        shutil.rmtree(home, ignore_errors=True)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    executable, services = sys.argv[1], sys.argv[2:]
    failed = False
    for service in services:
        tools = list_tools(executable, service)
        print(f"workspace-mcp probe: {service}: {len(tools)} tools")
        if not tools:
            print(f"workspace-mcp probe: {service} serves no tools", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
