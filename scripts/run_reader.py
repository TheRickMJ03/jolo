"""Run extract_menu() on DEV photos and save the predictions for run_eval.

Usage (from the repo root, venv active, model server running):
    python scripts/run_reader.py --name glm_ocr_cpu --photos 787cafe_14 bluecafe_02 curiosity_07a
    python scripts/run_reader.py --name glm_ocr_cpu            # every dev photo

Writes eval/cache/predictions/<name>.jsonl and every raw model reply under
eval/cache/reads/. Running it again reuses saved replies, so it
only calls the model for photos (or settings) it hasn't seen.
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

INVALID_REASONS = ("model_output_not_json", "model_output_cut_off")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="run name, e.g. glm_ocr_cpu")
    parser.add_argument("--photos", nargs="*", help="dev photo_ids (default: all dev photos)")
    parser.add_argument("--profile", help="config.yaml profile (default: laptop_cpu)")
    parser.add_argument("--reader", help="reader name from readers.py (default: reader.name in config.yaml)")
    parser.add_argument("--upscale", type=int, metavar="PX",
                        help="enlarge photos so the longest side is PX (overrides config.yaml)")
    parser.add_argument("--final-test", action="store_true",
                        help="read the TEST photos. Once, at the very end, when Ricardo says so.")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    splits = yaml.safe_load((REPO / "eval" / "splits.yaml").read_text(encoding="utf-8"))
    dev = splits["dev"]
    if args.final_test:
        if args.photos:
            sys.exit("--final-test reads every test photo: don't pass --photos with it.")
        photos = splits["test"]
        print("FINAL TEST: reading the test photos. Change nothing in the reader after this.")
    else:
        photos = args.photos or dev
        not_dev = [photo_id for photo_id in photos if photo_id not in dev]
        if not_dev:
            sys.exit(f"Not dev photos (test photos are off limits): {not_dev}")

    config = load_config(args.profile)
    config["cache"] = {"reads_dir": "eval/cache/reads"}
    if args.upscale:
        config["preprocess"]["upscale_long_side_px"] = args.upscale
    if args.reader:
        from menu_reader.readers import READERS
        if args.reader not in READERS:
            sys.exit(f"Unknown reader {args.reader!r}. Choose from {sorted(READERS)}.")
        config["reader"]["name"] = args.reader
    print(f"Profile {config['profile']}, endpoint {config['endpoint']}, "
          f"reader {config['reader']['name']}, crop {config['crop']['mode']}")

    out_path = REPO / "eval" / "cache" / "predictions" / f"{args.name}.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as out:
        for photo_id in photos:
            print(f"{photo_id} ... ", end="", flush=True)
            start = time.perf_counter()
            result = extract_menu(REPO / "eval" / "photos" / f"{photo_id}.heic", config=config)
            wall = time.perf_counter() - start

            if result.reason and result.reason.startswith("model_error"):
                print(f"\n{result.reason}")
                sys.exit("Stopping: the model server is not answering. Nothing was saved for this photo.")

            record = {
                "photo_id": photo_id,
                "valid_json": result.reason not in INVALID_REASONS,
                # Model time is the saved one on a cache hit, so this stays honest.
                "seconds": sum(result.timings.values()),
                "result": result.model_dump(),
            }
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            status = f"{len(result.items)} items" if result.readable else f"NOT READABLE ({result.reason})"
            print(f"{status}, model {result.timings.get('read', 0):.1f} s, this run {wall:.1f} s")

    print(f"\nSaved {out_path}")
    print("Score it with:")
    which = "--split test --final-test" if args.final_test else f"--photos {' '.join(photos)}"
    print(f"  python -m eval.run_eval --source file --predictions {out_path.relative_to(REPO).as_posix()} "
          f"--name {args.name} {which}")


if __name__ == "__main__":
    main()
