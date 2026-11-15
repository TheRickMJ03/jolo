"""Small guards for input that comes from outside: rate limits, text and name limits, and logs without phone numbers."""

import logging
import re
import threading
import time
from collections import defaultdict, deque

MAX_TEXT = 1000        # characters of an owner's or customer's message that reach the model
MAX_NAME = 80          # characters of an item or section name


# ---------- names and text ----------

def clean_text(text, limit=MAX_TEXT):
    """A message as the model sees it: no control characters, at most `limit` characters."""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", text or "")
    return text.strip()[:limit]


def clean_name(name, limit=MAX_NAME):
    """An item or section name from a photo or from the owner: one line, no control characters, short.
    Names go into the model's prompt, so a line break or a paragraph is how a "menu item" would try to give orders."""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", name or "")).strip()[:limit]


# ---------- rate limit ----------

class RateLimiter:
    """At most `limit` events per `per_seconds` for each key (a sender). A sliding window, in memory."""

    def __init__(self, limit, per_seconds, clock=time.monotonic):
        self.limit, self.per_seconds, self.clock = limit, per_seconds, clock
        self._events = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key):
        """True and the event is counted, or False and it isn't."""
        if not self.limit or self.limit <= 0:
            return True
        now = self.clock()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] >= self.per_seconds:
                events.popleft()
            if len(events) >= self.limit:
                return False
            events.append(now)
            if len(self._events) > 10_000:                      # forget idle senders
                for idle in [k for k, v in self._events.items() if not v or now - v[-1] >= self.per_seconds]:
                    del self._events[idle]
            return True

    def retry_after(self, key):
        """Seconds until this key can send again (0 when it can now)."""
        now = self.clock()
        with self._lock:
            events = self._events.get(key)
            if not events or len(events) < self.limit:
                return 0
            return max(0, int(self.per_seconds - (now - events[0])) + 1)


# ---------- logs ----------

PHONE = re.compile(r"(?<![\w.])\+?\d(?:[\s().-]{0,2}\d){8,14}(?![\w])")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def mask_private(text):
    """'texting +1 (609) 555-0100' -> 'texting <phone>'. Also emails (iMessage identifies some people by one)."""
    def phone(match):
        return "<phone>" if sum(char.isdigit() for char in match.group()) >= 9 else match.group()   # keeps dates

    return EMAIL.sub("<email>", PHONE.sub(phone, text))


_installed = False


def install_log_masking():
    """Every log line from now on, ours or uvicorn's, has phone numbers and emails replaced. Safe to call twice."""
    global _installed
    if _installed:
        return
    _installed = True
    previous = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = previous(*args, **kwargs)
        try:
            record.msg = mask_private(record.getMessage())
            record.args = ()
        except Exception:                                       # a bad format string must not lose the log line
            pass
        return record

    logging.setLogRecordFactory(factory)
