"""The store interface. Everything the agent knows about cafés goes through it.

A backend only supplies five document operations (_get, _set, _delete, _list,
_find); the rules (menu versions, drafts, events) live here once.
"""

import threading
import uuid
from abc import ABC, abstractmethod

from menu_reader.schema import Changes, MenuItem
from jolo_agent.store.models import Cafe, Correction, Draft, Event, MenuVersion, User, utcnow


def versions_path(cafe_id):
    return f"cafes/{cafe_id}/menu_versions"


class StaleMenu(Exception):
    """The café's menu changed (in the app, say) after the update was prepared."""


class Store(ABC):
    def __init__(self):
        self._lock = threading.RLock()

    # ---------- what a backend implements ----------

    @abstractmethod
    def _get(self, collection, doc_id):
        """The document as a dict, or None."""

    @abstractmethod
    def _set(self, collection, doc_id, data):
        """Create or replace the document."""

    @abstractmethod
    def _delete(self, collection, doc_id):
        """Delete the document; no error when it is not there."""

    @abstractmethod
    def _list(self, collection):
        """Every document in the collection, as dicts."""

    def _find(self, collection, field, value):
        """Documents whose field equals value."""
        return [doc for doc in self._list(collection) if doc.get(field) == value]

    # ---------- cafés ----------

    def get_cafe(self, cafe_id):
        doc = self._get("cafes", cafe_id)
        return Cafe.model_validate(doc) if doc else None

    def list_cafes(self):
        return sorted((Cafe.model_validate(doc) for doc in self._list("cafes")), key=lambda cafe: cafe.cafe_id)

    def upsert_cafe(self, cafe):
        self._set("cafes", cafe.cafe_id, cafe.model_dump())

    def find_cafe_by_owner(self, phone_hash):
        docs = self._find("cafes", "owner_phone_hash", phone_hash)
        return Cafe.model_validate(docs[0]) if docs else None

    # ---------- users ----------

    def get_user(self, phone_hash):
        doc = self._get("users", phone_hash)
        return User.model_validate(doc) if doc else None

    def upsert_user(self, user):
        self._set("users", user.phone_hash, user.model_dump())

    # ---------- menu versions ----------

    def get_menu_version(self, cafe_id, version):
        doc = self._get(versions_path(cafe_id), str(version))
        return MenuVersion.model_validate(doc) if doc else None

    def get_current_menu(self, cafe_id):
        """The café's current MenuVersion, or None when it has no menu yet."""
        cafe = self.get_cafe(cafe_id)
        if cafe is None or cafe.current_version == 0:
            return None
        return self.get_menu_version(cafe_id, cafe.current_version)

    def list_menu_versions(self, cafe_id):
        versions = [MenuVersion.model_validate(doc) for doc in self._list(versions_path(cafe_id))]
        return sorted(versions, key=lambda version: version.version)

    def _new_version(self, cafe, items, hours, source, scope, changes, previous=None):
        """The next MenuVersion and the café document that points at it.

        previous: the version being replaced. Items the owner marked sold out in the app stay sold out."""
        items = [item if isinstance(item, MenuItem) else MenuItem.model_validate(item) for item in items]
        names = {item.item for item in items}
        version = MenuVersion(
            cafe_id=cafe.cafe_id,
            version=cafe.current_version + 1,
            items=items,
            hours=hours,
            source=source,
            scope=scope,
            changes=changes or Changes(),
            sold_out=[name for name in (previous.sold_out if previous else []) if name in names],
        )
        cafe = cafe.model_copy(update={"current_version": version.version, "updated_at": version.created_at})
        if hours:
            cafe.hours_text = hours
        return version, cafe

    def save_menu_version(self, cafe_id, items, hours=None, source="photo", scope=None, changes=None,
                          expected_version=None):
        """Write version n+1 and make it current. Version n stays as history.

        expected_version: the version the update was prepared against. When the café has moved on since,
        nothing is written and StaleMenu is raised."""
        with self._lock:
            cafe = self.get_cafe(cafe_id)
            if cafe is None:
                raise KeyError(f"No café {cafe_id!r}")
            if expected_version is not None and cafe.current_version != expected_version:
                raise StaleMenu(cafe_id)
            previous = self.get_menu_version(cafe_id, cafe.current_version) if cafe.current_version else None
            version, cafe = self._new_version(cafe, items, hours, source, scope, changes, previous)
            self._set(versions_path(cafe_id), str(version.version), version.model_dump())
            self._set("cafes", cafe_id, cafe.model_dump())
            return version

    def menu_versions(self):
        """{cafe_id: current menu version} for every café: a cheap way to see which menus changed."""
        return {cafe.cafe_id: cafe.current_version for cafe in self.list_cafes()}

    # ---------- drafts ----------

    def get_draft(self, phone_hash):
        doc = self._get("drafts", phone_hash)
        return Draft.model_validate(doc) if doc else None

    def save_draft(self, draft):
        draft.updated_at = utcnow()
        self._set("drafts", draft.phone_hash, draft.model_dump())

    def delete_draft(self, phone_hash):
        self._delete("drafts", phone_hash)

    # ---------- corrections and events ----------

    def add_correction(self, cafe_id, phone_hash, op, before=None, after=None):
        correction = Correction(id=uuid.uuid4().hex, cafe_id=cafe_id, phone_hash=phone_hash,
                                op=op, before=before, after=after)
        self._set("corrections", correction.id, correction.model_dump())
        return correction

    def list_corrections(self, cafe_id=None):
        docs = self._find("corrections", "cafe_id", cafe_id) if cafe_id else self._list("corrections")
        return sorted((Correction.model_validate(doc) for doc in docs), key=lambda c: c.created_at)

    def add_event(self, kind, cafe_id=None, phone_hash=None, data=None, created_at=None):
        event = Event(id=uuid.uuid4().hex, kind=kind, cafe_id=cafe_id, phone_hash=phone_hash, data=data or {})
        if created_at:
            event.created_at = created_at
        self._set("events", event.id, event.model_dump())
        return event

    def list_events(self, kind=None, since=None):
        """Events, oldest first. since is an ISO timestamp (inclusive)."""
        docs = self._find("events", "kind", kind) if kind else self._list("events")
        events = [Event.model_validate(doc) for doc in docs]
        if since:
            events = [event for event in events if event.created_at >= since]
        return sorted(events, key=lambda event: event.created_at)
