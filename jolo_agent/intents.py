"""Answers so plain that asking the model would only add delay and risk:
"yes", "just part of it", "cancel", "more". Anything else goes to the model.
"""

import re

CONFIRM = {"yes", "y", "yep", "yeah", "yup", "correct", "all correct", "yes all correct", "looks good",
           "all good", "save", "save it", "yes save it", "yes please", "confirm", "thats right",
           "that is right", "thats correct", "yes thats right", "yes thats correct", "perfect", "go ahead"}
CANCEL = {"cancel", "cancel it", "never mind", "nevermind", "discard", "forget it", "stop"}
MORE = {"more", "show more", "more please", "next", "show me more"}
PARTIAL = ("part", "partial", "some", "half", "section", "not all", "not the full", "not full",
           "not everything", "not the whole")
FULL = ("full", "whole", "entire", "everything", "complete", "all")


def _plain(text):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", "", (text or "").lower().replace("'", ""))).strip()


def _has(text, phrases):
    return any(re.search(rf"\b{phrase}\b", text) for phrase in phrases)


def quick_intent(text, draft):
    """("confirm" | "cancel" | "more" | "scope", value) or None. draft: the open update, or None."""
    if draft is None:
        return None
    plain = _plain(text)
    if not plain:
        return None
    if plain in CANCEL:
        return ("cancel", None)
    if draft.scope is None and len(plain.split()) <= 8:
        if _has(plain, PARTIAL):            # checked first: "not the full menu" is partial
            return ("scope", "partial")
        if _has(plain, FULL):
            return ("scope", "full")
    if draft.state == "awaiting_confirmation":
        if plain in CONFIRM:
            return ("confirm", None)
        if plain in MORE:
            return ("more", None)
    return None
