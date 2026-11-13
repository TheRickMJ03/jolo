"""Load and validate the eval data: photos.csv, ground_truth.csv, splits.yaml.

Usage (from the repo root, venv active):
    python -m eval.check_data

Prints every problem it finds, then counts per split and category.
Exits with code 1 if there are errors.
"""

import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import yaml

EVAL_DIR = Path(__file__).resolve().parent
CATEGORIES = ("drink", "food", "modifier")


# ---------- loading ----------

def read_csv(path):
    """Read a CSV into a list of dicts. Every value stays a string."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_photos():
    return read_csv(EVAL_DIR / "photos.csv")


def load_splits():
    """Returns {"dev": [photo_id, ...], "test": [photo_id, ...]}."""
    return yaml.safe_load((EVAL_DIR / "splits.yaml").read_text(encoding="utf-8"))


def parse_price(text):
    """'' -> None (menu shows no price). '4.5' -> 4.5. Anything else raises ValueError."""
    text = text.strip()
    if text == "":
        return None
    price = float(text)
    if price < 0 or price != price:  # negative or NaN
        raise ValueError(f"bad price: {text!r}")
    return price


def parse_flavors(notes):
    """'flavors: Mango/Peach; CHECK names' -> ['Mango', 'Peach']. No flavors -> [].

    A few notes say "flavors Mango/Peach" with no colon. Those count too, but
    only when a "/" list follows, so "up to 2 flavors" is not mistaken for one.
    """
    match = re.search(r"flavors:\s*([^;]*)", notes, flags=re.IGNORECASE)
    if not match:
        match = re.search(r"flavors\s+([^;]*/[^;]*)", notes, flags=re.IGNORECASE)
    if not match:
        return []
    return [flavor.strip() for flavor in match.group(1).split("/") if flavor.strip()]


def load_ground_truth():
    """Returns {photo_id: [row, ...]} with typed rows.

    Each row: {"item", "size", "price" (float or None), "category", "flavors" (list)}.
    Raises ValueError on a bad price; run check_data first to see all problems.
    """
    by_photo = defaultdict(list)
    for raw in read_csv(EVAL_DIR / "ground_truth.csv"):
        row = {
            "item": raw["item"].strip(),
            "size": raw["size"].strip(),
            "price": parse_price(raw["price"]),
            "category": raw["category"].strip(),
            "flavors": parse_flavors(raw["notes"]),
            "notes": raw["notes"],
        }
        by_photo[raw["photo_id"].strip()].append(row)

    # "same flavors" in the notes means: same list as the other size of this item.
    for rows in by_photo.values():
        for row in rows:
            if not row["flavors"] and "same flavors" in row["notes"].lower():
                for other in rows:
                    if other["item"] == row["item"] and other["flavors"]:
                        row["flavors"] = list(other["flavors"])
                        break
    return dict(by_photo)


# ---------- validation ----------

def validate():
    """Returns (errors, warnings), each a list of strings."""
    errors, warnings = [], []

    photos = load_photos()
    photo_ids = [row["photo_id"].strip() for row in photos]
    known = set(photo_ids)
    cafe_of = {row["photo_id"].strip(): row["cafe_name"].strip() for row in photos}

    for photo_id, count in Counter(photo_ids).items():
        if count > 1:
            errors.append(f"photos.csv: {photo_id} is listed {count} times")
    for photo_id in photo_ids:
        if not (EVAL_DIR / "photos" / f"{photo_id}.heic").exists():
            errors.append(f"photos.csv: no file eval/photos/{photo_id}.heic")
    for path in sorted((EVAL_DIR / "photos").glob("*.heic")):
        if path.stem not in known:
            errors.append(f"eval/photos/{path.name} is not listed in photos.csv")

    # Splits
    splits = load_splits()
    split_of = {}
    for split_name, ids in splits.items():
        for photo_id in ids:
            if photo_id not in known:
                errors.append(f"splits.yaml: unknown photo_id {photo_id} in {split_name}")
            if photo_id in split_of:
                errors.append(f"splits.yaml: {photo_id} is in both {split_of[photo_id]} and {split_name}")
            split_of[photo_id] = split_name
    for photo_id in photo_ids:
        if photo_id not in split_of:
            errors.append(f"splits.yaml: {photo_id} is in no split")
    cafe_splits = defaultdict(set)
    for photo_id, split_name in split_of.items():
        cafe_splits[cafe_of.get(photo_id, photo_id)].add(split_name)
    for cafe, names in cafe_splits.items():
        if len(names) > 1:
            errors.append(f"splits.yaml: café {cafe} is in more than one split: {sorted(names)}")

    # Ground truth (line numbers match the CSV file: the header is line 1)
    truth = read_csv(EVAL_DIR / "ground_truth.csv")
    seen_rows = Counter()
    photos_with_rows = set()
    for line_number, row in enumerate(truth, start=2):
        where = f"ground_truth.csv line {line_number}"
        photo_id = row["photo_id"].strip()
        photos_with_rows.add(photo_id)
        if photo_id not in known:
            errors.append(f"{where}: unknown photo_id {photo_id!r}")
        if not row["item"].strip():
            errors.append(f"{where}: empty item")
        if row["category"].strip() not in CATEGORIES:
            errors.append(f"{where}: bad category {row['category']!r}")
        try:
            parse_price(row["price"])
        except ValueError:
            errors.append(f"{where}: bad price {row['price']!r}")
        for column in ("photo_id", "item", "size", "price", "category"):
            if row[column] != row[column].strip():
                warnings.append(f"{where}: extra spaces around {column} {row[column]!r}")
        seen_rows[(photo_id, row["item"], row["size"], row["price"], row["category"])] += 1
    for key, count in seen_rows.items():
        if count > 1:
            warnings.append(f"ground_truth.csv: {count} identical rows {key}")
    for photo_id in photo_ids:
        if photo_id not in photos_with_rows:
            warnings.append(f"ground_truth.csv: no rows for {photo_id}")

    return errors, warnings


# ---------- report ----------

def print_counts():
    splits = load_splits()
    truth = read_csv(EVAL_DIR / "ground_truth.csv")
    split_of = {photo_id: name for name, ids in splits.items() for photo_id in ids}

    counts = defaultdict(Counter)       # split -> category -> rows
    no_price = Counter()                # split -> rows with empty price
    for row in truth:
        split_name = split_of.get(row["photo_id"].strip(), "(no split)")
        counts[split_name][row["category"].strip()] += 1
        if not row["price"].strip():
            no_price[split_name] += 1

    print(f"{'split':<10} {'photos':>6} {'rows':>6} {'drink':>6} {'food':>6} {'modifier':>8} {'no price':>8}")
    total = Counter()
    for split_name in sorted(counts):
        c = counts[split_name]
        rows = sum(c.values())
        n_photos = len(splits.get(split_name, []))
        print(f"{split_name:<10} {n_photos:>6} {rows:>6} {c['drink']:>6} {c['food']:>6} "
              f"{c['modifier']:>8} {no_price[split_name]:>8}")
        total.update(c)
        total["photos"] += n_photos
        total["rows"] += rows
        total["no_price"] += no_price[split_name]
    print(f"{'total':<10} {total['photos']:>6} {total['rows']:>6} {total['drink']:>6} {total['food']:>6} "
          f"{total['modifier']:>8} {total['no_price']:>8}")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    errors, warnings = validate()
    for message in warnings:
        print(f"WARNING  {message}")
    for message in errors:
        print(f"ERROR    {message}")
    print(f"\n{len(errors)} errors, {len(warnings)} warnings\n")
    print_counts()
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
