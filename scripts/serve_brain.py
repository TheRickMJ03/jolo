"""Run the brain's API the way it should run on a server: the host and port from config.yaml, secrets from .env,
and a refusal to listen on the network without a token.

Usage (from the repo root, venv active):
    python scripts/serve_brain.py

Equivalent to `python -m uvicorn api.app:create_app --factory --port 8080`, plus one check: when agent.api.host
is not localhost (0.0.0.0 to let Isaiah's Mac reach it), AGENT_TOKEN or JOLO_API_KEY must be set, or it exits.
JOLO_HOST and JOLO_PORT override the config for one run. See docs/deploy.md.
"""

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config            # noqa: E402  (also reads .env into the environment)

LOCAL = {"127.0.0.1", "localhost", "::1"}


def main():
    api = load_config()["agent"]["api"]
    host = os.environ.get("JOLO_HOST", api["host"])
    port = int(os.environ.get("JOLO_PORT", api["port"]))
    if host not in LOCAL and not (os.environ.get(api["token_env"]) or os.environ.get(api["api_key_env"])):
        sys.exit(f"Refusing to listen on {host}:{port} without a secret. Set {api['token_env']} (the bridge's token) "
                 f"or {api['api_key_env']} in .env, or bind to 127.0.0.1.")
    import uvicorn
    uvicorn.run("api.app:create_app", factory=True, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
