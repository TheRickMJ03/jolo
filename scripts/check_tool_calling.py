"""Does the model server return structured tool calls?

Usage (from the repo root, venv active, VM server running, SSH tunnel open):
    python scripts/check_tool_calling.py

vLLM only returns tool calls when it was started with --enable-auto-tool-choice
and a --tool-call-parser. scripts/vm/serve_qwen_vision.sh has neither, so this
is the first thing to check before the agent relies on tools.

Prints one of:
    NATIVE TOOL CALLS WORK      set agent.tool_mode to native (or leave auto)
    NATIVE TOOL CALLS REFUSED   the server needs the two flags; json mode still works
    JSON MODE WORKS / FAILED    whether the plain-text fallback gets a usable action
"""

import json
import sys
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config        # noqa: E402

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_menu",
        "description": "Get the current menu of one café.",
        "parameters": {
            "type": "object",
            "properties": {"cafe_id": {"type": "string", "description": "The café's id"}},
            "required": ["cafe_id"],
        },
    },
}]
QUESTION = "What is on the menu at the café with id barbaras?"
JSON_PROMPT = (
    "You can call one tool: get_menu(cafe_id: string), which returns the menu of one café.\n"
    'Answer with one JSON object and nothing else: {"tool": "get_menu", "args": {"cafe_id": "..."}}\n\n'
    + QUESTION
)


def post(endpoint, payload, timeout):
    return requests.post(endpoint.rstrip("/") + "/chat/completions", json=payload,
                         headers={"Authorization": "Bearer not-needed"}, timeout=timeout)


def main():
    config = load_config()
    agent = config["agent"]
    endpoint = agent["endpoint"] or config["endpoint"]
    base = {"model": agent["model"], "temperature": 0, "max_tokens": 200}
    print(f"Server {endpoint}, model {agent['model']}")

    try:
        requests.get(endpoint.rstrip("/") + "/models", timeout=10)
    except requests.RequestException as error:
        sys.exit(f"The model server is not answering at {endpoint}.\n"
                 f"Is the VM server running and the SSH tunnel open?\n({error})")

    # 1. Native tool calling.
    reply = post(endpoint, {**base, "messages": [{"role": "user", "content": QUESTION}],
                            "tools": TOOLS, "tool_choice": "auto"}, agent["timeout_seconds"])
    if reply.status_code != 200:
        print(f"NATIVE TOOL CALLS REFUSED ({reply.status_code}): {reply.text[:300]}")
        print("Ask for --enable-auto-tool-choice and a --tool-call-parser in serve_qwen_vision.sh.")
    else:
        message = reply.json()["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        if calls:
            call = calls[0]["function"]
            print(f"NATIVE TOOL CALLS WORK: {call['name']}({call['arguments']})")
        else:
            print("NATIVE TOOL CALLS REFUSED: the server answered, but with text instead of a tool call:")
            print("  " + (message.get("content") or "")[:300].replace("\n", " "))

    # 2. The fallback: a JSON action written as plain text.
    reply = post(endpoint, {**base, "messages": [{"role": "user", "content": JSON_PROMPT}]},
                 agent["timeout_seconds"])
    if reply.status_code != 200:
        sys.exit(f"JSON MODE FAILED ({reply.status_code}): {reply.text[:300]}")
    text = reply.json()["choices"][0]["message"].get("content") or ""
    try:
        action = json.loads(text[text.index("{"):text.rindex("}") + 1])
        ok = action.get("tool") == "get_menu" and "cafe_id" in (action.get("args") or {})
    except ValueError:
        ok = False
    print(("JSON MODE WORKS: " if ok else "JSON MODE FAILED: ") + text[:300].replace("\n", " "))


if __name__ == "__main__":
    main()
