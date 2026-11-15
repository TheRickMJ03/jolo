"""Is the brain up and able to work? For cron, a systemd timer or an uptime monitor.

Usage:
    python scripts/healthcheck.py                              # http://127.0.0.1:<agent.api.port>/health
    python scripts/healthcheck.py --url http://10.0.0.5:8080

Exit code 0 when the API answers, the model server is reachable and the store has cafés; 1 otherwise, with the
reason on stdout. Sends AGENT_TOKEN (or JOLO_API_KEY) from .env when one is set.
"""

import argparse
import os
import sys
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config            # noqa: E402


def check(url, headers, timeout=10):
    """(ok, one line saying what is wrong or right)."""
    try:
        response = requests.get(url.rstrip("/") + "/health", headers=headers, timeout=timeout)
    except requests.RequestException as error:
        return False, f"the API does not answer at {url}: {error}"
    if response.status_code != 200:
        return False, f"/health answered HTTP {response.status_code}"
    health = response.json()
    if not health.get("model_server"):
        return False, "the model server is not reachable (VM stopped or SSH tunnel down)"
    if not health.get("cafes"):
        return False, "the store has no cafés"
    search = health.get("search", {})
    mode = "with vectors" if search.get("vectors") else "keyword search only"
    return True, f"ok: {health['cafes']} cafés, {search.get('documents', 0)} search documents ({mode}), store={health.get('store')}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    args = parser.parse_args()
    api = load_config()["agent"]["api"]
    url = args.url or f"http://127.0.0.1:{api['port']}"
    headers = {}
    if os.environ.get(api["token_env"]):
        headers["Authorization"] = f"Bearer {os.environ[api['token_env']]}"
    elif os.environ.get(api["api_key_env"]):
        headers["X-Jolo-Key"] = os.environ[api["api_key_env"]]
    ok, message = check(url, headers)
    print(message)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
