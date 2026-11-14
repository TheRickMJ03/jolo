"""Distance and opening hours, worked out in code. The model never does this arithmetic."""

import math
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import yaml
from rapidfuzz import fuzz, process

from menu_reader.compare import _key
from menu_reader.config import REPO
from jolo_agent.store.models import DAYS

PLACES_FILE = REPO / "data" / "cafes.yaml"
PLACE_MATCH_THRESHOLD = 85


def load_places(path=PLACES_FILE):
    """{'nassau hall': (lat, lng), ...} from data/cafes.yaml."""
    if not path.exists():
        return {}
    places = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("places") or {}
    return {_key(name): (float(lat), float(lng)) for name, (lat, lng) in places.items()}


def miles_between(a, b):
    """Great-circle distance in miles between two (lat, lng) points."""
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def resolve_location(text, cafes=(), places=None):
    """Where is "Nassau Hall", "40.35, -74.66" or "Barbara's"? (lat, lng) or None.

    There is no geocoder: only coordinates, the landmarks in data/cafes.yaml
    and café names are understood. None means "ask the customer".
    """
    if not text:
        return None
    match = re.fullmatch(r"\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*", text)
    if match:
        return float(match.group(1)), float(match.group(2))
    known = dict(load_places() if places is None else places)
    for cafe in cafes:
        if cafe.lat is not None and cafe.lng is not None:
            known[_key(cafe.name)] = (cafe.lat, cafe.lng)
    if not known:
        return None
    best = process.extractOne(_key(text), list(known), scorer=fuzz.WRatio)
    return known[best[0]] if best and best[1] >= PLACE_MATCH_THRESHOLD else None


def local_now(timezone):
    return datetime.now(ZoneInfo(timezone))


def is_open(hours, moment):
    """hours: {"mon": ["07:00", "15:00"], ...}. True, False, or None when no hours are stored."""
    if not hours:
        return None
    today = hours.get(DAYS[moment.weekday()])
    if not today:
        return False
    return today[0] <= moment.strftime("%H:%M") < today[1]
