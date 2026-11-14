"""Check the model server and warm it up with one photo, before a demo.

Usage (from the repo root, venv active, VM server running, SSH tunnel open):
    python scripts/warmup.py                      # uses a dev photo
    python scripts/warmup.py path/to/photo.jpg    # any photo of yours

Prints whether the server answers, what extract_menu() returns and how long
each stage took. The first request after a server start is the slow one, so
run this once a few minutes before showing anything live.
"""

import argparse
import sys
import time
from pathlib import Path

import requests
import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config        # noqa: E402
from menu_reader.pipeline import extract_menu     # noqa: E402

DEFAULT_PHOTO = REPO / "eval" / "photos" / "bluecafe_02.heic"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("photo", nargs="?", default=str(DEFAULT_PHOTO), help="photo to read")
    parser.add_argument("--profile", help="config.yaml profile (default: the default profile)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    photo = Path(args.photo)
    test_ids = yaml.safe_load((REPO / "eval" / "splits.yaml").read_text(encoding="utf-8"))["test"]
    if photo.stem in test_ids:
        sys.exit(f"{photo.stem} is a test photo: off limits until the final test.")
    if not photo.exists():
        sys.exit(f"No such file: {photo}")

    config = load_config(args.profile)
    print(f"Profile {config['profile']}, reader {config['reader']['name']}, endpoint {config['endpoint']}")

    # 1. Is the server there, and does it serve the model we ask for?
    try:
        reply = requests.get(config["endpoint"].rstrip("/") + "/models", timeout=10)
        served = [model["id"] for model in reply.json()["data"]]
    except (requests.RequestException, ValueError, KeyError) as error:
        sys.exit(f"The model server is not answering at {config['endpoint']}.\n"
                 f"Is the VM server running and the SSH tunnel open?\n({error})")
    print(f"Server is up. It serves: {', '.join(served)}")

    # 2. One real read. No cache: this must reach the model.
    start = time.perf_counter()
    result = extract_menu(photo, config=config)
    wall = time.perf_counter() - start

    if not result.readable:
        sys.exit(f"NOT READABLE: {result.reason}")
    print(f"\nRead {photo.name}: {len(result.items)} items, confidence {result.confidence}, {wall:.1f} s in total")
    for stage, seconds in result.timings.items():
        print(f"  {stage:<11}{seconds:6.1f} s")
    print("\nFirst items:")
    for item in result.items[:8]:
        prices = ", ".join(f"{price.size + ' ' if price.size else ''}{price.usd:g}" for price in item.prices)
        print(f"  {item.item}  |  {prices or 'no price'}  |  {item.category}  |  confidence {item.confidence}")
    print("\nThe server is warm.")


if __name__ == "__main__":
    main()
