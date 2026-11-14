"""What is stored, collection by collection.

Isaiah's app reads and edits the same documents, so don't rename fields here
without telling him. Menu items are exactly the reader's MenuItem.
"""

import hashlib
import os
import re
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from menu_reader.schema import Changes, MenuItem, MenuResult

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_phone(phone, salt=None):
    """'+1 (609) 555-0100' -> a salted hash. The raw number is never stored.

    The salt comes from JOLO_PHONE_SALT. Isaiah's app must use the same salt
    and this same function to find a user's documents.
    """
    salt = salt if salt is not None else os.environ.get("JOLO_PHONE_SALT", "jolo-dev")
    text = (phone or "").strip()
    if "@" in text:
        # iMessage identifies some people by Apple ID email instead of a number.
        identity = "email:" + text.lower()
    else:
        identity = re.sub(r"\D", "", text)
        if len(identity) == 10:
            identity = "1" + identity        # US number written without the country code
        if not identity:
            raise ValueError(f"Not a phone number: {phone!r}")
    return hashlib.sha256(f"{salt}:{identity}".encode()).hexdigest()[:32]


def hash_handle(handle, salt=None):
    """Who is texting, as the bridge reports it: a phone number, an Apple ID email, or (on the
    terminal platform) a plain name like "terminal-user". Phone numbers hash exactly as hash_phone does."""
    text = (handle or "").strip()
    if not text:
        raise ValueError("Empty sender handle")
    if "@" in text or len(re.sub(r"\D", "", text)) >= 7:
        return hash_phone(text, salt)
    salt = salt if salt is not None else os.environ.get("JOLO_PHONE_SALT", "jolo-dev")
    return hashlib.sha256(f"{salt}:handle:{text.lower()}".encode()).hexdigest()[:32]


class Cafe(BaseModel):
    """cafes/{cafe_id}"""
    cafe_id: str
    name: str
    owner_phone_hash: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    hours: dict[str, list[str]] = Field(default_factory=dict)   # {"mon": ["07:00", "15:00"]}; no key = closed
    hours_text: str | None = None      # hours as printed on the last menu photo, if any
    vibe: str | None = None
    summary: str | None = None
    current_version: int = 0           # 0 = no menu yet
    updated_at: str | None = None
    demo_data: bool = False            # True when address, hours and vibe are invented for the demo


class MenuVersion(BaseModel):
    """cafes/{cafe_id}/menu_versions/{version}. Old versions are kept as history."""
    cafe_id: str
    version: int
    items: list[MenuItem] = Field(default_factory=list)
    hours: str | None = None
    source: Literal["photo", "owner_text", "app", "seed"] = "photo"
    scope: Literal["full", "partial"] | None = None
    changes: Changes = Field(default_factory=Changes)    # against the version before
    created_at: str = Field(default_factory=utcnow)


class User(BaseModel):
    """users/{phone_hash}"""
    phone_hash: str
    name: str | None = None
    role: Literal["owner", "customer"] = "customer"
    cafe_id: str | None = None


class Draft(BaseModel):
    """drafts/{phone_hash}: a menu update the owner has not confirmed yet.

    States: idle (no draft) -> reading -> awaiting_scope -> awaiting_confirmation
    -> saved (draft deleted). Only reading, awaiting_scope and
    awaiting_confirmation are ever stored.
    """
    phone_hash: str
    cafe_id: str
    state: Literal["reading", "awaiting_scope", "awaiting_confirmation"] = "reading"
    source: Literal["photo", "owner_text"] = "photo"
    scope: Literal["full", "partial"] | None = None
    pending_reads: int = 0
    results: list[MenuResult] = Field(default_factory=list)   # one per photo, as the reader returned it
    items: list[MenuItem] = Field(default_factory=list)       # the merged read with the owner's fixes applied
    hours: str | None = None
    ops: list[dict] = Field(default_factory=list)             # the owner's fixes, replayed after a new photo
    shown: int = 0                                            # how many items the owner was asked to check
    created_at: str = Field(default_factory=utcnow)
    updated_at: str = Field(default_factory=utcnow)


class Correction(BaseModel):
    """corrections/{id}: what the reader said and what the owner changed it to.

    Nothing trains on these yet; they are kept for a future reader fine-tune.
    """
    id: str
    cafe_id: str
    phone_hash: str
    op: dict
    before: dict | None = None
    after: dict | None = None
    created_at: str = Field(default_factory=utcnow)


class Event(BaseModel):
    """events/{id}: searches, suggestions shown, picks, menu views and updates."""
    id: str
    kind: Literal["search", "pick", "menu_view", "menu_update"]
    cafe_id: str | None = None
    phone_hash: str | None = None
    data: dict = Field(default_factory=dict)
    created_at: str = Field(default_factory=utcnow)
