"""The grounding check: a reply may only state prices, times and distances
that appear in this turn's tool results (or in what the user just wrote).

Qwen3.5-9B was measured at an 80% hallucination rate on knowledge questions
(docs/model-plan.md), so café facts must never come from the model's memory.

What this check can't see: a real price attached to the wrong item passes,
because only the number is compared. It catches invented numbers, not mix-ups.
"""

import re

PRICE = re.compile(r"\$\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:dollars|bucks|usd)\b", re.IGNORECASE)
DISTANCE = re.compile(r"(\d+(?:\.\d+)?)\s?-?\s?(?:miles?|mi|km|kilometers?|blocks?|minutes?|mins?|min)\b", re.IGNORECASE)
TIME_12H = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b", re.IGNORECASE)
TIME_24H = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?[ap]\.?m)", re.IGNORECASE)
NUMBER = re.compile(r"\d+(?:\.\d+)?")


def _times(text):
    """Every clock time in the text, as minutes after midnight: '3pm' and '15:00' are both 900."""
    minutes = set()
    for hour, minute, half in TIME_12H.findall(text):
        hour = int(hour) % 12 + (12 if half.lower() == "p" else 0)
        minutes.add(hour * 60 + int(minute or 0))
    for hour, minute in TIME_24H.findall(text):
        minutes.add(int(hour) * 60 + int(minute))
    return minutes


def _numbers(text):
    return {round(float(number), 2) for number in NUMBER.findall(text)}


def ungrounded_facts(reply, evidence):
    """The prices, times and distances in reply that the evidence doesn't contain.

    evidence: the texts the reply may draw on (tool results, the user's message).
    Returns a list such as ["$4.75", "3pm"]; empty means the reply is grounded.
    """
    source = "\n".join(evidence)
    known_numbers = _numbers(source)
    known_times = _times(source)
    problems = []

    for match in PRICE.finditer(reply):
        if round(float(match.group(1) or match.group(2)), 2) not in known_numbers:
            problems.append(match.group(0).strip())
    for match in DISTANCE.finditer(reply):
        if round(float(match.group(1)), 2) not in known_numbers:
            problems.append(match.group(0).strip())
    for match in list(TIME_12H.finditer(reply)) + list(TIME_24H.finditer(reply)):
        if not _times(match.group(0)) <= known_times:
            problems.append(match.group(0).strip())
    return list(dict.fromkeys(problems))
