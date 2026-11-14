"""Score menu predictions against the ground truth.

Usage (from the repo root, venv active):
    python -m eval.run_eval --source ground_truth      # sanity check: must score 100%
    python -m eval.run_eval --source empty             # sanity check: must score 0 recall
    python -m eval.run_eval --source file --predictions path/to/predictions.jsonl --name glm_ocr

Each line of a predictions file is one photo:
    {"photo_id": "barbaras_01", "valid_json": true, "seconds": 4.2, "result": {...MenuResult...}}

Every run writes eval/results/<timestamp>_<name>/ with predictions.jsonl,
metrics.json, summary.md and failures.csv.

Test photos are refused unless you pass --split test --final-test.
"""

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np
import yaml
from rapidfuzz import fuzz
from scipy.optimize import linear_sum_assignment

from eval.check_data import CATEGORIES, load_ground_truth, load_splits

REPO = Path(__file__).resolve().parent.parent
RESULTS_DIR = REPO / "eval" / "results"

# Trap checks: things a careless reader gets wrong. Each one is always reported.
#   ("absent", name):            no predicted row may have exactly this name
#   ("category", name, wanted):  every predicted row with this name must have this category
TRAPS = {
    "mattarello_17": ("absent", "Piña Colada"),      # it's a pastry flavor
    "vicentes_04a": ("absent", "Latte"),             # it's wall decor
    "curiosity_07a": ("absent", "Unadon"),           # crossed out on the menu
    "minas_03": ("category", "Americano", "food"),   # it's a hot dog
}


# ---------- normalization ----------

def normalize_name(text):
    """Lowercase, strip accents and punctuation, collapse spaces."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("'", "").replace("’", "")   # Barbara's -> barbaras
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


# Different spellings of the same size. A reader that writes "Small" where the
# menu prints "SM" has read the menu correctly, so the scorer treats them alike.
SIZE_ALIASES = {
    "s": "small", "sm": "small", "sml": "small",
    "m": "medium", "md": "medium", "med": "medium",
    "l": "large", "lg": "large", "lrg": "large",
    "xl": "extralarge", "xlarge": "extralarge", "xlg": "extralarge",
}


def normalize_size(text):
    """Like names, but spaces are dropped too: '12 oz' and '12oz' are the same size.
    Common abbreviations are spelled out: 'Sm' and 'Small' are the same size."""
    size = normalize_name(text).replace(" ", "")
    return SIZE_ALIASES.get(size, size)


def prices_equal(a, b):
    """Both empty counts as equal. One empty and one not is a mismatch."""
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < 0.005


# ---------- turning a MenuResult into ground-truth-style rows ----------

def flatten_menu_result(result):
    """One row per (item, size, price). Add-ons become modifier rows.

    An item with no prices becomes one row with an empty price.
    """
    rows = []
    if not result or not result.get("readable", True):
        return rows
    for item in result.get("items") or []:
        category = item.get("category") or ""
        prices = item.get("prices") or []
        if not prices:
            rows.append({"item": item["item"], "size": "", "price": None, "category": category})
        for price in prices:
            rows.append({"item": item["item"], "size": price.get("size") or "",
                         "price": price.get("usd"), "category": category})
        for add_on in item.get("add_ons") or []:
            rows.append({"item": add_on["name"], "size": "",
                         "price": add_on.get("usd"), "category": "modifier"})
    return rows


# ---------- matching one photo ----------

def sizes_compatible(truth_size, pred_size, truth_is_single, pred_is_single):
    """Exact match after normalization. An empty size also matches a single-size item."""
    if truth_size == pred_size:
        return True
    if truth_size == "":
        return pred_is_single
    if pred_size == "":
        return truth_is_single
    return False


def score_photo(truth_rows, pred_rows, threshold):
    """Match predicted rows to ground-truth rows for one photo.

    Returns a dict:
        pairs:           [(truth_row, pred_row), ...] true positives
        missing:         ground-truth rows nobody predicted (false negatives)
        extra:           predicted rows that match nothing (false positives)
        absorbed:        extra flavors of a flavor group (not counted at all)
    """
    truth_names = [normalize_name(row["item"]) for row in truth_rows]
    pred_names = [normalize_name(row["item"]) for row in pred_rows]
    truth_sizes = [normalize_size(row["size"]) for row in truth_rows]
    pred_sizes = [normalize_size(row["size"]) for row in pred_rows]
    truth_name_counts = Counter(truth_names)
    pred_name_counts = Counter(pred_names)

    # Step 1: one-to-one assignment (Hungarian algorithm).
    # weight 0 = this pair is not allowed. Otherwise the weight says how good
    # the pair is: name score first, then tie-breakers (whole-name similarity,
    # same price, same category) so that "Latte" pairs with "Latte" and not
    # with "Iced Latte" when both score 100 on token_set_ratio.
    matched_truth, matched_pred = {}, {}
    if truth_rows and pred_rows:
        weights = np.zeros((len(truth_rows), len(pred_rows)))
        for i, truth in enumerate(truth_rows):
            for j, pred in enumerate(pred_rows):
                name_score = fuzz.token_set_ratio(truth_names[i], pred_names[j])
                if name_score < threshold:
                    continue
                if not sizes_compatible(truth_sizes[i], pred_sizes[j],
                                        truth_name_counts[truth_names[i]] == 1,
                                        pred_name_counts[pred_names[j]] == 1):
                    continue
                weights[i, j] = (
                    1_000_000                      # any allowed pair beats no pair
                    + name_score * 1000
                    + fuzz.ratio(truth_names[i], pred_names[j])
                    + (5 if prices_equal(truth["price"], pred["price"]) else 0)
                    + (1 if truth["category"] == pred["category"] else 0)
                )
        for i, j in zip(*linear_sum_assignment(weights, maximize=True)):
            if weights[i, j] > 0:
                matched_truth[i] = j
                matched_pred[j] = i

    # Step 2: flavor groups. A leftover predicted row that names one flavor of
    # a ground-truth group, at the group's price, counts for that group:
    # the first one is the true positive, the rest are ignored (not false positives).
    absorbed = []
    for j, pred in enumerate(pred_rows):
        if j in matched_pred:
            continue
        for i, truth in enumerate(truth_rows):
            if not truth.get("flavors") or not prices_equal(truth["price"], pred["price"]):
                continue
            if any(fuzz.token_set_ratio(normalize_name(flavor), pred_names[j]) >= threshold
                   for flavor in truth["flavors"]):
                if i in matched_truth:
                    absorbed.append(pred)
                else:
                    matched_truth[i] = j
                matched_pred[j] = i
                break

    absorbed_ids = {id(row) for row in absorbed}
    return {
        "pairs": [(truth_rows[i], pred_rows[j]) for i, j in sorted(matched_truth.items())],
        "missing": [row for i, row in enumerate(truth_rows) if i not in matched_truth],
        "extra": [row for j, row in enumerate(pred_rows) if j not in matched_pred],
        "absorbed": [row for row in pred_rows if id(row) in absorbed_ids],
    }


def check_trap(photo_id, pred_rows):
    """Returns 'pass' or a string starting with 'FAIL' or 'CHECK BY EYE'."""
    trap = TRAPS[photo_id]
    wanted_name = normalize_name(trap[1])
    hits = [row for row in pred_rows if normalize_name(row["item"]) == wanted_name]
    if trap[0] == "absent":
        if hits:
            return f"FAIL: predicted an item named {trap[1]!r}"
        # A longer name that contains the trap name as whole words, like
        # "Unadon (grilled eel)", may be the trap or a real item ("Iced Latte"
        # is not "Latte"). The harness can't tell, so a person has to look.
        near = sorted({row["item"] for row in pred_rows
                       if f" {wanted_name} " in f" {normalize_name(row['item'])} "})
        return "pass" if not near else f"CHECK BY EYE: predicted {near}, which contains {trap[1]!r}"
    if not hits:
        return f"FAIL: no item named {trap[1]!r} was predicted"
    wrong = sorted({row["category"] for row in hits if row["category"] != trap[2]})
    return "pass" if not wrong else f"FAIL: {trap[1]!r} has category {wrong}, expected {trap[2]!r}"


# ---------- metrics ----------

def new_counts():
    return {"tp": 0, "fn": 0, "fp": 0, "price_correct": 0, "category_correct": 0}


def finish(counts):
    """Turn raw counts into recall, precision, F1 and accuracies. None = nothing to measure."""
    tp, fn, fp = counts["tp"], counts["fn"], counts["fp"]
    recall = tp / (tp + fn) if tp + fn else None
    precision = tp / (tp + fp) if tp + fp else None
    if tp + fn + fp == 0:
        f1 = None
    else:
        f1 = 2 * tp / (2 * tp + fn + fp)
    return {
        **counts,
        "recall": recall,
        "precision": precision,
        "f1": f1,
        "price_exact_match": counts["price_correct"] / tp if tp else None,
        "category_accuracy": counts["category_correct"] / tp if tp else None,
    }


def evaluate(truth_by_photo, predictions, photo_ids, threshold):
    """Score a set of photos.

    predictions: {photo_id: {"rows": [...], "valid_json": bool, "seconds": float or None}}
    A photo with no prediction counts as invalid JSON with no rows.
    Returns (metrics, failures): a dict for metrics.json and a list of rows for failures.csv.
    """
    overall = new_counts()
    by_category = {category: new_counts() for category in CATEGORIES}
    by_photo = {}
    failures = []
    valid_json = 0
    seconds = []

    def add(counts_list, key, amount=1):
        for counts in counts_list:
            counts[key] += amount

    def failure(photo_id, kind, truth=None, pred=None):
        row = {"photo_id": photo_id, "kind": kind}
        for prefix, source in (("expected", truth), ("predicted", pred)):
            for field in ("item", "size", "price", "category"):
                value = source[field] if source else ""
                row[f"{prefix}_{field}"] = "" if value is None else value
        failures.append(row)

    for photo_id in photo_ids:
        truth_rows = truth_by_photo.get(photo_id, [])
        prediction = predictions.get(photo_id) or {"rows": [], "valid_json": False, "seconds": None}
        pred_rows = prediction["rows"]
        if prediction.get("valid_json"):
            valid_json += 1
        if prediction.get("seconds") is not None:
            seconds.append(prediction["seconds"])

        result = score_photo(truth_rows, pred_rows, threshold)
        photo = new_counts()

        for truth, pred in result["pairs"]:
            groups = [overall, photo]
            if truth["category"] in by_category:
                groups.append(by_category[truth["category"]])
            add(groups, "tp")
            if prices_equal(truth["price"], pred["price"]):
                add(groups, "price_correct")
            else:
                failure(photo_id, "wrong_price", truth, pred)
            if truth["category"] == pred["category"]:
                add(groups, "category_correct")
            else:
                failure(photo_id, "wrong_category", truth, pred)
        for truth in result["missing"]:
            groups = [overall, photo]
            if truth["category"] in by_category:
                groups.append(by_category[truth["category"]])
            add(groups, "fn")
            failure(photo_id, "missing", truth=truth)
        for pred in result["extra"]:
            groups = [overall, photo]
            if pred["category"] in by_category:
                groups.append(by_category[pred["category"]])
            add(groups, "fp")
            failure(photo_id, "extra", pred=pred)

        by_photo[photo_id] = finish(photo)
        by_photo[photo_id]["seconds"] = prediction.get("seconds")
        by_photo[photo_id]["valid_json"] = bool(prediction.get("valid_json"))

    traps = {}
    for photo_id in TRAPS:
        if photo_id not in photo_ids:
            traps[photo_id] = "not in this run"
        elif not (predictions.get(photo_id) or {}).get("valid_json"):
            traps[photo_id] = "FAIL: no valid prediction for this photo"
        else:
            traps[photo_id] = check_trap(photo_id, predictions[photo_id]["rows"])

    metrics = {
        "photos": len(photo_ids),
        "name_match_threshold": threshold,
        "overall": finish(overall),
        "valid_json_rate": valid_json / len(photo_ids) if photo_ids else None,
        "seconds_per_photo": sum(seconds) / len(seconds) if seconds else None,
        "by_category": {category: finish(counts) for category, counts in by_category.items()},
        "by_photo": by_photo,
        "traps": traps,
    }
    return metrics, failures


# ---------- reading and writing ----------

def load_predictions_file(path):
    """Read a predictions.jsonl file into the shape evaluate() wants."""
    predictions = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            record = json.loads(line)
            if "rows" in record:
                rows = record["rows"]
            else:
                rows = flatten_menu_result(record.get("result"))
            predictions[record["photo_id"]] = {
                "rows": rows,
                "valid_json": bool(record.get("valid_json", record.get("result") is not None)),
                "seconds": record.get("seconds"),
            }
    return predictions


def fmt(value, percent=True):
    if value is None:
        return "n/a"
    return f"{value * 100:.1f}%" if percent else f"{value:.2f}"


def write_summary(path, name, split, metrics):
    o = metrics["overall"]
    lines = [
        f"# Eval run: {name}",
        "",
        f"Split: **{split}**, {metrics['photos']} photos, name match threshold {metrics['name_match_threshold']}",
        "",
        "| Item F1 | Recall | Precision | Price exact match | Category accuracy | Valid JSON | Seconds per photo |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        f"| {fmt(o['f1'])} | {fmt(o['recall'])} | {fmt(o['precision'])} | {fmt(o['price_exact_match'])} "
        f"| {fmt(o['category_accuracy'])} | {fmt(metrics['valid_json_rate'])} "
        f"| {fmt(metrics['seconds_per_photo'], percent=False)} |",
        "",
        "## By category",
        "",
        "| Category | Ground-truth rows | F1 | Recall | Precision | Price exact match |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for category, c in metrics["by_category"].items():
        lines.append(f"| {category} | {c['tp'] + c['fn']} | {fmt(c['f1'])} | {fmt(c['recall'])} "
                     f"| {fmt(c['precision'])} | {fmt(c['price_exact_match'])} |")
    lines += ["", "## By photo", "",
              "| Photo | Ground-truth rows | F1 | Recall | Precision | Price exact match | Seconds |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for photo_id, c in metrics["by_photo"].items():
        lines.append(f"| {photo_id} | {c['tp'] + c['fn']} | {fmt(c['f1'])} | {fmt(c['recall'])} "
                     f"| {fmt(c['precision'])} | {fmt(c['price_exact_match'])} "
                     f"| {fmt(c['seconds'], percent=False)} |")
    lines += ["", "## Trap checks", ""]
    for photo_id, status in metrics["traps"].items():
        lines.append(f"- {photo_id}: {status}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_run(name, split, predictions, metrics, failures):
    run_dir = RESULTS_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{name}"
    run_dir.mkdir(parents=True)

    with open(run_dir / "predictions.jsonl", "w", encoding="utf-8") as f:
        for photo_id, prediction in predictions.items():
            f.write(json.dumps({"photo_id": photo_id, **prediction}, ensure_ascii=False) + "\n")

    (run_dir / "metrics.json").write_text(
        json.dumps({"name": name, "split": split, **metrics}, indent=2), encoding="utf-8")

    write_summary(run_dir / "summary.md", name, split, metrics)

    columns = ["photo_id", "kind"] + [f"{prefix}_{field}" for prefix in ("expected", "predicted")
                                      for field in ("item", "size", "price", "category")]
    with open(run_dir / "failures.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(failures)
    return run_dir


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="dev", choices=["dev", "test"])
    parser.add_argument("--final-test", action="store_true", help="required to score the test split")
    parser.add_argument("--source", required=True, choices=["ground_truth", "empty", "file"])
    parser.add_argument("--predictions", help="predictions.jsonl (with --source file)")
    parser.add_argument("--photos", nargs="*", help="only score these photo_ids")
    parser.add_argument("--name", help="run name, used in the results folder name")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.split == "test" and not args.final_test:
        sys.exit("Refusing to score the test split without --final-test.")

    photo_ids = load_splits()[args.split]
    if args.photos:
        unknown = [photo_id for photo_id in args.photos if photo_id not in photo_ids]
        if unknown:
            sys.exit(f"Not in the {args.split} split: {unknown}")
        photo_ids = args.photos

    config = yaml.safe_load((REPO / "config.yaml").read_text(encoding="utf-8"))
    threshold = config["common"]["eval"]["name_match_threshold"]
    truth = load_ground_truth()

    if args.source == "ground_truth":
        predictions = {
            photo_id: {"rows": [{k: row[k] for k in ("item", "size", "price", "category")}
                                for row in truth.get(photo_id, [])],
                       "valid_json": True, "seconds": None}
            for photo_id in photo_ids
        }
    elif args.source == "empty":
        predictions = {photo_id: {"rows": [], "valid_json": True, "seconds": None}
                       for photo_id in photo_ids}
    else:
        if not args.predictions:
            sys.exit("--source file needs --predictions path/to/predictions.jsonl")
        predictions = load_predictions_file(args.predictions)

    name = args.name or args.source
    metrics, failures = evaluate(truth, predictions, photo_ids, threshold)
    run_dir = write_run(name, args.split, predictions, metrics, failures)

    o = metrics["overall"]
    print(f"Run:               {name} on {args.split} ({metrics['photos']} photos)")
    print(f"Ground-truth rows: {o['tp'] + o['fn']}")
    print(f"Item F1:           {fmt(o['f1'])}   (recall {fmt(o['recall'])}, precision {fmt(o['precision'])})")
    print(f"Price exact match: {fmt(o['price_exact_match'])}")
    print(f"Category accuracy: {fmt(o['category_accuracy'])}")
    print(f"Valid JSON:        {fmt(metrics['valid_json_rate'])}")
    print(f"Seconds per photo: {fmt(metrics['seconds_per_photo'], percent=False)}")
    print(f"Failure rows:      {len(failures)}")
    print("Trap checks:")
    for photo_id, status in metrics["traps"].items():
        print(f"  {photo_id}: {status}")
    print(f"Written to:        {run_dir}")


if __name__ == "__main__":
    main()
