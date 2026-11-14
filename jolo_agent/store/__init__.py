"""Pick the store backend from config["agent"]["store"]."""

import os

from menu_reader.config import REPO
from jolo_agent.store.base import Store
from jolo_agent.store.memory import MemoryStore
from jolo_agent.store.models import (Cafe, Correction, Draft, Event, MenuVersion, User, hash_handle, hash_phone,
                                     to_e164, utcnow)

__all__ = ["Store", "MemoryStore", "Cafe", "Correction", "Draft", "Event", "MenuVersion", "User",
           "hash_handle", "hash_phone", "to_e164", "utcnow", "open_store"]


def open_store(config):
    settings = config["agent"]["store"]
    if settings["backend"] == "memory":
        return MemoryStore(REPO / settings["path"])
    if settings["backend"] == "firestore":
        from jolo_agent.store.firestore import FirestoreStore
        return FirestoreStore(os.environ.get(settings["firestore_credentials_env"]))
    raise ValueError(f"Unknown store backend {settings['backend']!r}. Choose memory or firestore.")
