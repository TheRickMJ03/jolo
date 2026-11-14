"""Confidence: how far a second, independent read of the photo backs each item.

The reader (a vision-language model) can misread or make things up. PP-OCRv6
reads the same photo on the CPU in a completely different way. An item whose
name and prices PP-OCR also sees is more likely to be right.

These numbers are a ranking aid, not a measured probability: 0.9 does not
mean "right 90% of the time". Nobody has calibrated them yet.
"""

import re

from rapidfuzz import fuzz

from menu_reader.compare import _key

UNCHECKED = 0.5          # no second read was made
NAME_SEEN_SCORE = 85     # RapidFuzz partial_ratio: the name appears inside an OCR line


def numbers_in_text(lines):
    """Every amount the OCR text could mean, as a set of floats.

    "4.50" -> 4.5.   "$11:00" -> 11.0.   "1599" -> 1599 and 15.99, because
    cents printed as small raised digits come out of OCR with no point.
    """
    amounts = set()
    for line in lines:
        for whole, cents in re.findall(r"(\d+)(?:[.,:](\d{1,2}))?", line):
            if cents:
                amounts.add(round(float(f"{whole}.{cents}"), 2))
            else:
                amounts.add(float(whole))
                if len(whole) >= 3:
                    amounts.add(round(int(whole) / 100, 2))
        for cents in re.findall(r"(?<!\d)\.(\d{1,2})(?!\d)", line):    # ".50" with no leading zero
            amounts.add(round(float(f"0.{cents}"), 2))
    return amounts


def score_items(items, ocr_lines=None):
    """Set item.confidence on every item; returns the overall confidence (the mean).

    ocr_lines: the text lines PP-OCR read from the same photo, or None when
    that check is switched off (every item then gets UNCHECKED).

    With the check on, an item scores
        0.4                       for being read at all
      + 0.3 if PP-OCR also sees its name
      + 0.3 x the share of its prices PP-OCR also sees
    An item with no price can only be backed by its name, so it gets the full
    0.6 for a name that is seen.
    """
    if not items:
        return 0.0
    if ocr_lines is None:
        for item in items:
            item.confidence = UNCHECKED
        return UNCHECKED

    line_keys = [_key(line) for line in ocr_lines]
    all_text = " ".join(line_keys)
    amounts = numbers_in_text(ocr_lines)

    for item in items:
        name = _key(item.item)
        name_seen = bool(name) and (
            name in all_text
            or any(fuzz.partial_ratio(name, line) >= NAME_SEEN_SCORE for line in line_keys if line)
        )
        if item.prices:
            seen = sum(1 for price in item.prices if round(price.usd, 2) in amounts)
            score = 0.4 + 0.3 * name_seen + 0.3 * seen / len(item.prices)
        else:
            score = 0.4 + 0.6 * name_seen
        item.confidence = round(score, 2)
    return round(sum(item.confidence for item in items) / len(items), 2)
