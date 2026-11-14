"""Read one menu photo and show everything extract_menu() returns.

Usage (from the repo root, venv active, VM server running, SSH tunnel open):
    python scripts/read_photo.py demo/my_menu.jpg
    python scripts/read_photo.py demo/my_menu.jpg --current-menu output/old_menu.json

Prints every item as a table and saves the full result, exactly as the agent
would receive it, to output/<photo name>.json.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config        # noqa: E402
from menu_reader.pipeline import extract_menu     # noqa: E402

OUT_DIR = REPO / "output"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("photo", help="path to the photo (jpg, png, heic, webp)")
    parser.add_argument("--current-menu", help="a JSON file saved by an earlier run, to fill in 'changes'")
    parser.add_argument("--profile", help="config.yaml profile (default: the default profile)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    photo = Path(args.photo)
    if not photo.exists():
        sys.exit(f"No such file: {photo}")
    test_ids = yaml.safe_load((REPO / "eval" / "splits.yaml").read_text(encoding="utf-8"))["test"]
    if photo.stem in test_ids:
        sys.exit(f"{photo.stem} is a test photo. Use: python scripts/run_reader.py --name final_test --final-test")

    current_menu = None
    if args.current_menu:
        current_menu = json.loads(Path(args.current_menu).read_text(encoding="utf-8"))

    config = load_config(args.profile)
    # Keep the model's raw answer (output/reads/), so a strange result can be traced.
    config["cache"] = {"reads_dir": "output/reads"}
    print(f"Reading {photo.name} (profile {config['profile']}, reader {config['reader']['name']}) ...")
    start = time.perf_counter()
    result = extract_menu(photo, current_menu=current_menu, config=config)
    wall = time.perf_counter() - start

    OUT_DIR.mkdir(exist_ok=True)
    out_path = OUT_DIR / f"{photo.stem}.json"
    out_path.write_text(json.dumps(result.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")

    if not result.readable:
        print(f"\nNOT READABLE: {result.reason}")
        print(f"Saved {out_path}")
        return

    print(f"\n{len(result.items)} items, overall confidence {result.confidence}, {wall:.1f} s")
    if result.hours:
        print(f"Hours: {result.hours}")
    # One item per line, nothing cut short: a shortened price list reads like a wrong price.
    section = object()
    for item in result.items:
        if item.section != section:
            section = item.section
            print(f"\n[{section or 'no section'}]")
        prices = ", ".join(f"{price.size + ' ' if price.size else ''}{price.usd:.2f}" for price in item.prices)
        print(f"  {item.item}  |  {prices or 'no price'}  |  {item.category}  |  confidence {item.confidence}")

    if current_menu is not None:
        changes = result.changes
        print(f"\nNew items: {changes.new_items or 'none'}")
        print("Price changes:")
        for change in changes.price_changes:
            size = f" ({change.size})" if change.size else ""
            print(f"  {change.item}{size}: {change.old_usd} -> {change.new_usd}")
        if not changes.price_changes:
            print("  none")
        print(f"In the current menu but not in this photo: {changes.missing_from_photo or 'none'}")

    print("\nSeconds per stage: " + ", ".join(f"{stage} {seconds:.1f}" for stage, seconds in result.timings.items()))
    print(f"Saved {out_path}")


if __name__ == "__main__":
    main()
