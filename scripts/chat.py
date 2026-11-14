"""Text JOLO from the terminal, through the same API Isaiah's iMessage service uses.

Start the API first, in another terminal:
    python -m uvicorn api.app:create_app --factory --port 8080

Then:
    python scripts/chat.py                       # as a customer
    python scripts/chat.py --phone +16095550100  # as that phone (an owner, if seeded with --owner)

Type a message and press Enter. To send a photo, start the line with its path:
    demo/menu.jpg here is my full menu
Late replies (a finished menu read) are polled from GET /outbox and printed as they arrive.
Ctrl+C to quit.
"""

import argparse
import os
import sys
import threading
import time
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config        # noqa: E402

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".heic", ".webp"}


def split_photo(line):
    """'demo/menu.jpg full menu' -> (Path('demo/menu.jpg'), 'full menu'). No photo -> (None, line)."""
    lowered = line.lower()
    for extension in IMAGE_TYPES:
        end = lowered.find(extension)
        if end != -1:
            path = Path(line[:end + len(extension)].strip().strip('"'))
            if path.exists():
                return path, line[end + len(extension):].strip()
    return None, line


def main():
    config = load_config()
    api = config["agent"]["api"]
    parser = argparse.ArgumentParser()
    parser.add_argument("--phone", default="+16095550199", help="the phone number to text as")
    parser.add_argument("--url", default=f"http://127.0.0.1:{api['port']}", help="where the API runs")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    key = os.environ.get(api["api_key_env"])
    headers = {"X-Jolo-Key": key} if key else {}

    try:
        health = requests.get(args.url + "/health", headers=headers, timeout=10).json()
    except requests.RequestException as error:
        sys.exit(f"The API is not answering at {args.url}. Start it first (see the top of this file).\n({error})")
    print(f"Connected as {args.phone}. Model server up: {health['model_server']}. Cafés: {health['cafes']}.")
    if not health["model_server"]:
        print("The model server is down: only plain answers (yes, full, cancel) will work.")

    def poll():
        while True:
            time.sleep(2)
            try:
                waiting = requests.get(args.url + "/outbox", params={"phone": args.phone},
                                       headers=headers, timeout=10).json()["messages"]
            except requests.RequestException:
                continue
            for text in waiting:
                print(f"\nJOLO (later): {text}\n> ", end="", flush=True)

    threading.Thread(target=poll, daemon=True).start()

    while True:
        try:
            line = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        photo, text = split_photo(line)
        files = [("photos", (photo.name, photo.read_bytes()))] if photo else None
        try:
            reply = requests.post(args.url + "/messages", data={"phone": args.phone, "text": text},
                                  files=files, headers=headers, timeout=300)
            reply.raise_for_status()
        except requests.RequestException as error:
            print(f"(request failed: {error})")
            continue
        for message in reply.json()["replies"]:
            print(f"JOLO: {message}")


if __name__ == "__main__":
    main()
