"""Fetch the real cafés around Princeton, NJ from OpenStreetMap and write data/cafes_osm.yaml.

Usage (from the repo root):
    python scripts/import_osm_cafes.py                    # 3.5 km around Palmer Square
    python scripts/import_osm_cafes.py --radius 5000
    python scripts/import_osm_cafes.py --center 40.3504,-74.6612 --out data/cafes_osm.yaml

No key or account needed (Overpass API, OpenStreetMap data, ODbL licence: credit "(c) OpenStreetMap
contributors" if you publish it). The output has the same shape as data/cafes.yaml, so the real
fields (name, address, lat, lng, hours) are filled in only when OpenStreetMap has them, and
`vibe` / `summary` are left blank for you to write. Check the hours of the cafés you will demo
against Google Maps: OpenStreetMap hours are sometimes missing or stale.
"""

import argparse
import re
import sys
from pathlib import Path

import requests
import yaml

REPO = Path(__file__).resolve().parent.parent
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_INDEX = {d: i for i, d in enumerate(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])}


def fetch(lat, lng, radius):
    query = f'[out:json][timeout:50];(nwr["amenity"="cafe"](around:{radius},{lat},{lng}););out center tags;'
    last = None
    for url in OVERPASS:
        try:
            response = requests.post(url, data={"data": query}, timeout=90,
                                     headers={"User-Agent": "cafe-demo-importer/0.1", "Accept": "application/json"})
            response.raise_for_status()
            return response.json()["elements"]
        except (requests.RequestException, ValueError, KeyError) as error:
            last = error
    sys.exit(f"Could not reach Overpass: {last}")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def parse_hours(text):
    """OpenStreetMap opening_hours -> {"mon": ["07:00", "15:00"]}. Only the common simple forms
    ("Mo-Fr 07:00-15:00; Sa,Su 08:00-14:00", "Mo-Su 07:00-19:00"); anything fancier returns {}."""
    if not text or any(word in text for word in ("PH", "SH", "week", "sunrise", "sunset", "off")):
        return {}
    hours = {}
    try:
        for rule in text.split(";"):
            rule = rule.strip()
            if not rule:
                continue
            match = re.match(r"^([A-Za-z,\- ]+?)\s+((?:\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\s*)?)+)$", rule)
            if not match:
                return {}
            days = []
            for part in match.group(1).split(","):
                part = part.strip()
                if "-" in part:
                    start, end = [DAY_INDEX[p] for p in part.split("-")]
                    days += [i % 7 for i in range(start, end + (7 if end < start else 0) + 1)]
                else:
                    days.append(DAY_INDEX[part])
            spans = []
            for span in match.group(2).split(","):
                open_, close = span.strip().split("-")
                spans += [f"{int(open_.split(':')[0]):02d}:{open_.split(':')[1]}",
                          f"{int(close.split(':')[0]):02d}:{close.split(':')[1]}"]
            for day in days:
                hours[DAYS[day]] = spans
    except (KeyError, ValueError):
        return {}
    return hours


def to_cafe(element):
    tags = element.get("tags", {})
    name = tags.get("name")
    if not name:
        return None
    lat = element.get("lat") or element.get("center", {}).get("lat")
    lng = element.get("lon") or element.get("center", {}).get("lon")
    street = " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")]))
    address = ", ".join(filter(None, [street, tags.get("addr:city") or "Princeton"]))
    def yes_no(value):
        return None if value is None else value in ("yes", "wlan", "wifi", "free")
    cafe = {"name": name, "address": address, "lat": lat, "lng": lng,
            "hours": parse_hours(tags.get("opening_hours")),
            "vibe": "", "summary": "",
            "osm": {"id": f"{element['type']}/{element['id']}",
                    "opening_hours": tags.get("opening_hours"), "website": tags.get("website"),
                    "cuisine": tags.get("cuisine"), "phone": tags.get("phone") or tags.get("contact:phone"),
                    "brand": tags.get("brand"),
                    "municipality": tags.get("addr:city") or "Princeton",
                    "wifi": yes_no(tags.get("internet_access")),
                    "outdoor_seating": yes_no(tags.get("outdoor_seating")),
                    "drive_through": yes_no(tags.get("drive_through"))}}
    return cafe


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--center", default="40.3504,-74.6612", help="lat,lng (default: Palmer Square)")
    parser.add_argument("--radius", type=int, default=3500, help="metres")
    parser.add_argument("--out", default="data/cafes_osm.yaml")
    args = parser.parse_args()
    lat, lng = (float(x) for x in args.center.split(","))

    cafes = {}
    for element in fetch(lat, lng, args.radius):
        cafe = to_cafe(element)
        if cafe is None:
            continue
        key = slug(cafe["name"])
        if key in cafes:                     # chains / duplicate mapping: keep the first, suffix the rest
            key = f"{key}_{element['id']}"
        cafes[key] = cafe

    header = ("# Real cafés near Princeton, NJ, from OpenStreetMap (c) OpenStreetMap contributors, ODbL.\n"
              "# Generated by scripts/import_osm_cafes.py. Fill in `vibe` and `summary` by hand, and check\n"
              "# `hours` against Google Maps for the cafés you will demo. Empty hours = unknown.\n\n")
    out = REPO / args.out
    out.write_text(header + yaml.safe_dump({"cafes": cafes}, sort_keys=True, allow_unicode=True), encoding="utf-8")
    with_hours = sum(1 for c in cafes.values() if c["hours"])
    print(f"{len(cafes)} named cafés within {args.radius} m -> {out.relative_to(REPO)} ({with_hours} with parsed hours)")
    for key, cafe in sorted(cafes.items()):
        print(f"  {cafe['name']:<34} {cafe['address']:<34} {'hours' if cafe['hours'] else '-'}")


if __name__ == "__main__":
    main()
