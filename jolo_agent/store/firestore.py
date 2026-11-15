"""The store on Firestore: the source of truth that Isaiah's app and bridge also use.

The app and the bridge already write their own document shapes (docs/contracts.md section 1), so this
backend translates between them and the brain's models. Only this file knows the difference.

    cafes/{id}                     the app's café document. The brain reads name, address, location, hours,
                                   ownerPhone, currentMenuVersion, menuUpdatedAt, and writes only
                                   ownerPhone, currentMenuVersion, menuUpdatedAt, hoursText and (for demo
                                   data) vibe, summary, demoData. Everything else is left as the app wrote it.
    cafes/{id}/menuVersions/{n}    immutable versions, written in a transaction
    agentUsers, agentDrafts, agentCorrections, agentEvents
                                   the brain's own collections. The rules deny them to every client, so
                                   only the Admin SDK (this code) can read or write them.

Credentials: the path to a service-account key in GOOGLE_APPLICATION_CREDENTIALS (in .env, never in Git).
With FIRESTORE_EMULATOR_HOST set, no key is needed and the emulator is used.
"""

import logging
import os
import re
import time
from datetime import datetime, timezone

from menu_reader.compare import _key
from menu_reader.schema import Changes, MenuItem, PriceChange
from jolo_agent.store.base import StaleMenu, Store
from jolo_agent.store.models import DAYS, Cafe, MenuVersion, hash_handle

log = logging.getLogger("jolo.store")

APP_DAYS = dict(zip(DAYS, ("mo", "tu", "we", "th", "fr", "sa", "su")))
AGENT_COLLECTIONS = {"users": "agentUsers", "drafts": "agentDrafts",
                     "corrections": "agentCorrections", "events": "agentEvents"}


# ---------- translation: pure functions, tested without a client ----------

def to_datetime(value):
    """An ISO string from the brain's models -> the timezone-aware datetime Firestore stores as a Timestamp."""
    if value is None or isinstance(value, datetime):
        return value
    moment = datetime.fromisoformat(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def to_iso(value):
    """A Timestamp (a datetime) or a string -> an ISO string in UTC, as the brain's models keep times."""
    if value is None:
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat(timespec="seconds")
    return str(value)


def hours_from_app(app_hours):
    """{"mo": [{"open": "07:00", "close": "11:00"}], "tu": []} -> {"mon": ["07:00", "11:00"]}.
    A day without spans is left out (closed)."""
    hours = {}
    for day, short in APP_DAYS.items():
        flat = []
        for span in (app_hours or {}).get(short) or []:
            if isinstance(span, dict) and span.get("open") and span.get("close"):
                flat += [str(span["open"]), str(span["close"])]
        if flat:
            hours[day] = flat
    return hours


def hours_to_app(hours):
    """The reverse of hours_from_app; every day is present, closed days as []."""
    out = {}
    for day, short in APP_DAYS.items():
        flat = hours.get(day) or []
        out[short] = [{"open": flat[i], "close": flat[i + 1]} for i in range(0, len(flat) - 1, 2)]
    return out


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def cafe_from_doc(cafe_id, doc):
    """The app's café document -> Cafe. Tolerates missing fields: a café the bridge just created has only
    a name, an owner and currentMenuVersion 0."""
    location = doc.get("location") or {}
    owner_phone = (doc.get("ownerPhone") or "").strip() or None
    version = doc.get("currentMenuVersion")
    return Cafe(
        cafe_id=cafe_id,
        name=doc.get("name") or cafe_id,
        owner_phone=owner_phone,
        owner_phone_hash=hash_handle(owner_phone) if owner_phone else None,
        address=doc.get("address"),
        lat=_number(location.get("lat")),
        lng=_number(location.get("lng")),
        hours=hours_from_app(doc.get("hours")),
        hours_text=doc.get("hoursText"),
        vibe=doc.get("vibe"),
        summary=doc.get("summary"),
        current_version=int(version) if isinstance(version, (int, float)) else 0,
        updated_at=to_iso(doc.get("menuUpdatedAt")),
        demo_data=bool(doc.get("demoData")),
    )


def cafe_to_doc(cafe, with_version=False):
    """The fields the brain may write, for a merge. Only fields it has a value for are included, so the
    app's own fields (hours it edited, photos, amenities) are never overwritten with blanks.

    with_version: also write currentMenuVersion and menuUpdatedAt. Only for a café that doesn't exist yet;
    after that, save_menu_version is the only thing that moves them."""
    doc = {"name": cafe.name}
    if cafe.owner_phone:
        doc["ownerPhone"] = cafe.owner_phone
    if cafe.address:
        doc["address"] = cafe.address
    if cafe.lat is not None and cafe.lng is not None:
        doc["location"] = {"lat": cafe.lat, "lng": cafe.lng}
    if cafe.hours:
        doc["hours"] = hours_to_app(cafe.hours)
    if cafe.hours_text:
        doc["hoursText"] = cafe.hours_text
    if cafe.vibe:
        doc["vibe"] = cafe.vibe
    if cafe.summary:
        doc["summary"] = cafe.summary
    if cafe.demo_data:
        doc["demoData"] = True
    if with_version:
        doc["currentMenuVersion"] = cafe.current_version
        if cafe.updated_at:
            doc["menuUpdatedAt"] = to_datetime(cafe.updated_at)
    return doc


def version_from_doc(cafe_id, doc, fallback_number=0):
    """menuVersions/{n} -> MenuVersion. Items the app marked available: false become sold_out.
    Items that don't fit the reader's shape are skipped rather than breaking the whole menu."""
    items, sold_out = [], []
    for raw in doc.get("items") or []:
        try:
            items.append(MenuItem.model_validate(raw))
        except Exception:
            log.warning("Skipping an item in %s version %s that doesn't fit the menu format: %r",
                        cafe_id, doc.get("version", fallback_number), raw)
            continue
        if raw.get("available") is False:
            sold_out.append(items[-1].item)
    recorded = doc.get("changes") or {}
    added = [entry.get("item") if isinstance(entry, dict) else entry for entry in recorded.get("added") or []]
    price_changes = []
    for entry in recorded.get("price_changes") or []:
        try:
            price_changes.append(PriceChange.model_validate(entry))
        except Exception:
            continue
    source = doc.get("agentSource") or ("app" if doc.get("source") == "app" else "photo")
    return MenuVersion(
        cafe_id=cafe_id,
        version=int(doc.get("version", fallback_number)),
        items=items,
        hours=doc.get("hoursText"),
        source=source,
        scope=doc.get("scope") if doc.get("scope") in ("full", "partial") else None,
        changes=Changes(new_items=[name for name in added if name], price_changes=price_changes,
                        missing_from_photo=list(recorded.get("removed") or [])),
        sold_out=sold_out,
        created_at=to_iso(doc.get("createdAt")) or to_iso(datetime.now(timezone.utc)),
    )


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "item"


def version_to_doc(version, previous_doc=None, owner_phone=None):
    """MenuVersion -> the menuVersions document of the contract. Items get an id (kept from the previous
    version when the name is the same, so the app's references stay valid) and available."""
    known = {}
    for raw in (previous_doc or {}).get("items") or []:
        if isinstance(raw, dict) and raw.get("id") and raw.get("item"):
            known.setdefault((_key(raw["item"]), raw.get("category")), raw["id"])
    taken = set(known.values())
    sold_out = {_key(name) for name in version.sold_out}
    items = []
    for item in version.items:
        identity = (_key(item.item), item.category)       # a Latte the drink and a Latte the dish are two items
        item_id = known.get(identity)
        if item_id is None:
            base, number = slug(item.item), 1
            item_id = base
            while item_id in taken:
                number += 1
                item_id = f"{base}-{number}"
            taken.add(item_id)
            known[identity] = item_id
        items.append({**item.model_dump(), "id": item_id, "available": _key(item.item) not in sold_out})
    return {
        "version": version.version,
        "basedOn": version.version - 1,
        "scope": version.scope,
        "source": "app" if version.source == "app" else "imessage",
        "agentSource": version.source,          # the brain's finer label: photo, owner_text, seed, public_menu, inferred
        "createdAt": to_datetime(version.created_at),
        "createdBy": {"phone": owner_phone if version.source not in ("seed", "public_menu", "inferred") else None, "uid": None},
        "items": items,
        "hoursText": version.hours,
        "changes": {
            "added": list(version.changes.new_items),
            "price_changes": [change.model_dump() for change in version.changes.price_changes],
            "changed": [],
            # Items missing from a photo are only removed when the owner said the photo was the full menu.
            "removed": list(version.changes.missing_from_photo) if version.scope == "full" else [],
        },
    }


# ---------- the store ----------

def make_client(credentials_path=None):
    """A Firestore client: the emulator when FIRESTORE_EMULATOR_HOST is set, else the project of the key."""
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import firestore
        return firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-jolo"),
                                credentials=AnonymousCredentials())
    import firebase_admin
    from firebase_admin import credentials, firestore
    try:
        app = firebase_admin.get_app()
    except ValueError:
        credential = credentials.Certificate(credentials_path) if credentials_path else credentials.ApplicationDefault()
        app = firebase_admin.initialize_app(credential)
    return firestore.client(app)


class FirestoreStore(Store):
    def __init__(self, credentials_path=None, client=None, transactional=None, cache_seconds=20.0):
        """client: a ready client (tests); otherwise one is made. transactional: wraps a function so it runs
        in a transaction (tests pass a stand-in; the default is Firestore's own)."""
        super().__init__()
        self.db = client if client is not None else make_client(credentials_path)
        self._transactional = transactional
        self.cache_seconds = cache_seconds
        self._cafes = None            # (loaded at, [Cafe]): search lists every café for every question
        self._owners = None           # (loaded at, {phone hash: café id})

    # ---------- the document operations of Store, for the brain's own collections ----------

    def _collection(self, name):
        return self.db.collection(AGENT_COLLECTIONS.get(name, name))

    def _get(self, collection, doc_id):
        snapshot = self._collection(collection).document(doc_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def _set(self, collection, doc_id, data):
        self._collection(collection).document(doc_id).set(data)

    def _delete(self, collection, doc_id):
        self._collection(collection).document(doc_id).delete()

    def _list(self, collection):
        return [snapshot.to_dict() for snapshot in self._collection(collection).stream()]

    def _find(self, collection, field, value):
        from google.cloud.firestore_v1.base_query import FieldFilter
        query = self._collection(collection).where(filter=FieldFilter(field, "==", value))
        return [snapshot.to_dict() for snapshot in query.stream()]

    def list_events(self, kind=None, since=None):
        """Events, oldest first. With since, one range query on the time (no composite index needed) and the
        kind is filtered here."""
        if since:
            from google.cloud.firestore_v1.base_query import FieldFilter
            query = self._collection("events").where(filter=FieldFilter("created_at", ">=", since))
            docs = [snapshot.to_dict() for snapshot in query.stream()]
            if kind:
                docs = [doc for doc in docs if doc.get("kind") == kind]
            return sorted((self._event(doc) for doc in docs), key=lambda event: event.created_at)
        return super().list_events(kind, since)

    @staticmethod
    def _event(doc):
        from jolo_agent.store.models import Event
        return Event.model_validate(doc)

    # ---------- cafés ----------

    def _cafe_ref(self, cafe_id):
        return self.db.collection("cafes").document(cafe_id)

    def _forget(self):
        self._cafes = None
        self._owners = None

    def get_cafe(self, cafe_id):
        snapshot = self._cafe_ref(cafe_id).get()
        return cafe_from_doc(cafe_id, snapshot.to_dict() or {}) if snapshot.exists else None

    def list_cafes(self):
        loaded = self._cafes
        if loaded is None or time.monotonic() - loaded[0] > self.cache_seconds:
            cafes = sorted((cafe_from_doc(snapshot.id, snapshot.to_dict() or {})
                            for snapshot in self.db.collection("cafes").stream()), key=lambda cafe: cafe.cafe_id)
            loaded = self._cafes = (time.monotonic(), cafes)
        return list(loaded[1])

    def upsert_cafe(self, cafe):
        if cafe.owner_phone_hash and not cafe.owner_phone:
            log.warning("Café %s has an owner hash but no phone number: Firestore keeps ownerPhone, so the "
                        "owner can't be saved. Set cafe.owner_phone.", cafe.cafe_id)
        ref = self._cafe_ref(cafe.cafe_id)
        ref.set(cafe_to_doc(cafe, with_version=not ref.get().exists), merge=True)
        self._forget()

    def find_cafe_by_owner(self, phone_hash):
        """The café whose ownerPhone hashes to phone_hash. The owners are kept for a few seconds; a number
        we haven't seen reloads them (at most every 5 seconds), so a newly linked owner is found quickly."""
        now = time.monotonic()
        if self._owners is None or now - self._owners[0] > self.cache_seconds:
            self._owners = (now, self._load_owners())
        cafe_id = self._owners[1].get(phone_hash)
        if cafe_id is None and now - self._owners[0] > 5.0:
            self._owners = (now, self._load_owners())
            cafe_id = self._owners[1].get(phone_hash)
        cafe = self.get_cafe(cafe_id) if cafe_id else None
        # Re-checked on the live document, so a café whose ownerPhone just changed is never matched by the old number.
        return cafe if cafe and cafe.owner_phone_hash == phone_hash else None

    def _load_owners(self):
        from google.cloud.firestore_v1.base_query import FieldFilter
        query = self.db.collection("cafes").where(filter=FieldFilter("ownerPhone", ">", "")).select(["ownerPhone"])
        owners = {}
        for snapshot in query.stream():
            phone = ((snapshot.to_dict() or {}).get("ownerPhone") or "").strip()
            if phone:
                owners.setdefault(hash_handle(phone), snapshot.id)
        return owners

    def menu_versions(self):
        query = self.db.collection("cafes").select(["currentMenuVersion"])
        out = {}
        for snapshot in query.stream():
            version = (snapshot.to_dict() or {}).get("currentMenuVersion")
            out[snapshot.id] = int(version) if isinstance(version, (int, float)) else 0
        return out

    # ---------- weekly insights ----------

    def save_insight(self, cafe_id, report):
        """cafes/{id}/insights/{weekStart}: what the app's dashboard reads (generatedAt as a Timestamp)."""
        doc = {**report, "generatedAt": to_datetime(report["generatedAt"])}
        self._cafe_ref(cafe_id).collection("insights").document(report["weekStart"]).set(doc)

    def get_insight(self, cafe_id, week_start):
        snapshot = self._cafe_ref(cafe_id).collection("insights").document(week_start).get()
        if not snapshot.exists:
            return None
        doc = snapshot.to_dict() or {}
        return {**doc, "generatedAt": to_iso(doc.get("generatedAt"))}

    # ---------- menu versions ----------

    def get_menu_version(self, cafe_id, version):
        snapshot = self._cafe_ref(cafe_id).collection("menuVersions").document(str(version)).get()
        return version_from_doc(cafe_id, snapshot.to_dict() or {}, int(version)) if snapshot.exists else None

    def list_menu_versions(self, cafe_id):
        snapshots = self._cafe_ref(cafe_id).collection("menuVersions").stream()
        versions = [version_from_doc(cafe_id, snapshot.to_dict() or {}, int(snapshot.id)) for snapshot in snapshots]
        return sorted(versions, key=lambda version: version.version)

    def save_menu_version(self, cafe_id, items, hours=None, source="photo", scope=None, changes=None,
                          expected_version=None):
        """Write version n+1 and move currentMenuVersion, in one transaction: the app may be editing the same
        café. With expected_version, a café that moved on raises StaleMenu and nothing is written."""
        cafe_ref = self._cafe_ref(cafe_id)
        versions = cafe_ref.collection("menuVersions")

        def write(transaction):
            snapshot = cafe_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise KeyError(f"No café {cafe_id!r}")
            cafe = cafe_from_doc(cafe_id, snapshot.to_dict() or {})
            if expected_version is not None and cafe.current_version != expected_version:
                raise StaleMenu(cafe_id)
            previous_doc = previous = None
            if cafe.current_version:
                found = versions.document(str(cafe.current_version)).get(transaction=transaction)
                if found.exists:
                    previous_doc = found.to_dict() or {}
                    previous = version_from_doc(cafe_id, previous_doc, cafe.current_version)
            version, _cafe = self._new_version(cafe, items, hours, source, scope, changes, previous)
            transaction.set(versions.document(str(version.version)),
                            version_to_doc(version, previous_doc, cafe.owner_phone))
            moved = {"currentMenuVersion": version.version, "menuUpdatedAt": to_datetime(version.created_at)}
            if hours:
                moved["hoursText"] = hours
            transaction.set(cafe_ref, moved, merge=True)
            return version

        if self._transactional is None:
            from google.cloud import firestore
            self._transactional = firestore.transactional
        version = self._transactional(write)(self.db.transaction())
        self._forget()
        return version
