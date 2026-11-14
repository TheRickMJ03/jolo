"""Step 1 of the two-step reader on its own: GLM-OCR copies out the text of DEV photos.

Usage (from the repo root, venv active, Ollama running):
    python scripts/transcribe.py --photos 787cafe_14 bluecafe_02 curiosity_07a
    python scripts/transcribe.py                      # every dev photo

Prints each transcript and saves it to eval/cache/transcripts/<photo_id>.txt
so you can compare it with the photo. The replies are cached, so the two-step
reader reuses them later without calling GLM-OCR again.
"""

import argparse
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config            # noqa: E402
from menu_reader.model_client import ModelError       # noqa: E402
from menu_reader.pipeline import prepare_image        # noqa: E402
from menu_reader.readers import transcribe_glm_ocr    # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--photos", nargs="*", help="dev photo_ids (default: all dev photos)")
    parser.add_argument("--profile", help="config.yaml profile (default: laptop_cpu)")
    parser.add_argument("--upscale", type=int, metavar="PX",
                        help="enlarge photos so the longest side is PX (overrides config.yaml)")
    parser.add_argument("--out", default="transcripts",
                        help="folder under eval/cache/ for the .txt files (default: transcripts)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    out_dir = REPO / "eval" / "cache" / args.out

    dev =yaml.safe_load((REPO / "eval" / "splits.yaml").read_text(encoding="utf-8"))["dev"]
    args.photos = args.photos or dev
    not_dev = [photo_id for photo_id in args.photos if photo_id not in dev]
    if not_dev:
        sys.exit(f"Not dev photos (test photos are off limits): {not_dev}")

    config = load_config(args.profile)
    config["cache"] = {"reads_dir": "eval/cache/reads"}
    if args.upscale:
        config["preprocess"]["upscale_long_side_px"] = args.upscale
    out_dir.mkdir(parents=True, exist_ok=True)

    for photo_id in args.photos:
        image, _, reason, _ = prepare_image(REPO / "eval" / "photos" / f"{photo_id}.heic", config)
        if image is None:
            print(f"{photo_id}: not usable ({reason})")
            continue
        try:
            reply = transcribe_glm_ocr(image, config, photo_id)
        except ModelError as error:
            sys.exit(f"{photo_id}: {error}")

        (out_dir / f"{photo_id}.txt").write_text(reply["text"], encoding="utf-8")
        cut_off = "  (CUT OFF at max_tokens)" if reply["finish_reason"] == "length" else ""
        print(f"\n===== {photo_id}: {reply['seconds']:.1f} s, {len(reply['text'])} characters{cut_off} =====")
        print(reply["text"])

    print(f"\nSaved to {out_dir}")


if __name__ == "__main__":
    main()
