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


INSIGHTS = (r"\binsights?\b",
            r"\bhow(?:'s| did| is| are| was) (my|our|the) (caf\w*|shop|business|place)\b",
            r"\bhow (am|are) (i|we) doing\b",
            r"\b(weekly|week'?s) (update|report|summary|numbers)\b",
            r"\bhow many (people|customers|folks|times)\b.*\b(ask|search|view|look|pick|suggest|came|visit)",
            r"\bhow (did|was) (this|last) week\b")
AFFIRM_BUT = re.compile(r"^(yes|yeah|yep|yup|ok|okay|sure|correct|right|good)\b[\s,.!:;-]*"
                        r"(but|except|however|though|although|just|only|also|and|then|now|apart from)\b", re.I)


def wants_insights(text):
    """The owner is asking how the café did lately. Answered from the counts, so the model never guesses."""
    lowered = (text or "").lower().replace("\u2019", "'")
    return any(re.search(pattern, lowered) for pattern in INSIGHTS)


def is_yes_but(text):
    """\"yes but the mocha is 6.50\": a fix, not a confirmation. Saving needs a clean yes."""
    return bool(AFFIRM_BUT.match((text or "").strip()))


def is_plain_yes(text):
    """A bare "yes" or "save it". With no update open there is nothing for it to confirm."""
    return _plain(text) in CONFIRM


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
