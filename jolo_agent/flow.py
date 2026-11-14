"""The owner's menu update, as a state machine in code.

    idle -> reading -> awaiting_scope -> awaiting_confirmation -> saved

The model only works out what the owner means; the rules are here, where a
9B model can't forget them:
  - the read runs in a worker thread, so the message loop never waits for it
  - nothing is saved until the owner confirms
  - items missing from the photo are only removed when the owner says the
    photo shows the full menu, and even then they are listed first
  - the owner sees the least certain items first
"""

import logging
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

from menu_reader.compare import _key
from menu_reader.merge import merge_results
from menu_reader.schema import MenuResult
from jolo_agent import messages
from jolo_agent.menu_ops import (EditError, apply_op, changes_between, check_priority, final_items,
                                 has_generic_sizes, items_to_check, replay_ops)
from jolo_agent.store.models import Draft

log = logging.getLogger("jolo.flow")


class MenuUpdateFlow:
    def __init__(self, store, config, reader=None, send=None, executor=None, on_saved=None):
        """
        reader: photo bytes -> MenuResult. Default: the menu reader's extract_menu().
        send: (phone_hash, text) for messages that arrive later, when a read finishes.
        executor: where reads run. Default: a thread pool.
        on_saved: (cafe_id) called after a version is saved, to re-index the café.
        """
        self.store = store
        self.settings = config["agent"]
        if reader is None:
            from menu_reader.pipeline import extract_menu
            reader = lambda photo: extract_menu(photo, config=config)     # noqa: E731
        self.reader = reader
        self.send = send or (lambda phone_hash, text: None)
        self.executor = executor or ThreadPoolExecutor(max_workers=self.settings["reads"]["workers"],
                                                       thread_name_prefix="menu-read")
        self.on_saved = on_saved
        self._locks = defaultdict(threading.RLock)
        # Why an update ended without a proposal (a read failed, nothing changed), for
        # callers that word the answer themselves. Cleared when a new photo arrives.
        self.outcomes = {}

    def lock(self, phone_hash):
        """One owner's messages and finished reads are handled one at a time."""
        return self._locks[phone_hash]

    # ---------- helpers ----------

    def _current_items(self, cafe_id):
        version = self.store.get_current_menu(cafe_id)
        return list(version.items) if version else []

    def _threshold(self):
        return self.settings["confirm"]["name_match_threshold"]

    def _preview(self, draft):
        """(stored items, the menu that would be saved, changes against the stored menu)."""
        current = self._current_items(draft.cafe_id)
        new_items = final_items(current, draft.items, draft.scope or "partial", draft.ops)
        return current, new_items, changes_between(current, new_items)

    def _check_batch(self, draft, new_items, changes, first_menu):
        """The next few items for the owner to check; moves draft.shown forward."""
        to_check = items_to_check(new_items, changes, first_menu)
        size = self.settings["confirm"]["items_per_message"]
        batch = to_check[draft.shown:draft.shown + size]
        start = draft.shown
        draft.shown += len(batch)
        return batch, start, draft.shown < len(to_check), to_check

    def _present(self, draft):
        """The confirmation message for a draft whose scope is known. Saves the draft."""
        current, new_items, changes = self._preview(draft)
        first_menu = not current
        if not (changes.new_items or changes.price_changes or changes.missing_from_photo):
            self.store.delete_draft(draft.phone_hash)
            self.outcomes[draft.phone_hash] = {"kind": "no_changes"}
            return messages.NO_CHANGES
        draft.state = "awaiting_confirmation"
        draft.shown = 0
        batch, start, more_left, to_check = self._check_batch(draft, new_items, changes, first_menu)
        self.store.save_draft(draft)
        return messages.summary(found=len(draft.items), changes=changes, first_menu=first_menu,
                                to_check=batch, check_start=start, more_left=more_left,
                                sizes_note=has_generic_sizes(to_check), full_scope=draft.scope == "full")

    # ---------- photos ----------

    def start_read(self, phone_hash, photo):
        """A menu photo arrived. Returns the replies to send now; the result follows through send()."""
        with self.lock(phone_hash):
            cafe = self.store.find_cafe_by_owner(phone_hash)
            if cafe is None:
                return [messages.NOT_AN_OWNER]
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                draft = Draft(phone_hash=phone_hash, cafe_id=cafe.cafe_id)
            elif draft.source == "owner_text":
                # Fixes typed before the photo are kept and applied to what the photo shows.
                draft.source, draft.scope = "photo", None
            draft.pending_reads += 1
            draft.state = "reading"
            self.outcomes.pop(phone_hash, None)
            self.store.save_draft(draft)
            replies = [messages.READING] + ([messages.ASK_SCOPE] if draft.scope is None else [])
            token = draft.created_at
        self.executor.submit(self._read, phone_hash, photo, token)
        return replies

    def _read(self, phone_hash, photo, token):
        """Runs in a worker thread: 15 to 100 seconds for a real photo."""
        try:
            result = self.reader(photo)
        except Exception as error:      # the reader promises not to raise; don't lose the draft if it does
            log.exception("The menu reader raised")
            result = MenuResult(readable=False, reason=f"reader_crashed: {error}")
        try:
            with self.lock(phone_hash):
                draft = self.store.get_draft(phone_hash)
                if draft is None or draft.created_at != token:
                    return                  # the owner cancelled while the photo was being read
                draft.results.append(result)
                draft.pending_reads -= 1
                if draft.pending_reads > 0:
                    self.store.save_draft(draft)
                    return                  # wait for the other photos, then merge once
                texts = self._finish_reading(draft)
            for text in texts:
                self.send(phone_hash, text)
        except Exception:
            log.exception("Could not finish a menu read")
            self.outcomes[phone_hash] = {"kind": "reader_down", "reason": "reader_crashed"}
            self.send(phone_hash, messages.READER_DOWN)

    def _finish_reading(self, draft):
        """Every photo of the draft has been read: merge them and tell the owner."""
        failed = [result for result in draft.results if not result.readable or not result.items]
        reader_down = any((result.reason or "").startswith(("model_error", "reader_crashed")) for result in failed)
        draft.results = [result for result in draft.results if result.readable and result.items]

        if not draft.results:
            self.store.delete_draft(draft.phone_hash)
            reason = next((result.reason for result in failed if result.reason), None)
            self.outcomes[draft.phone_hash] = {"kind": "reader_down" if reader_down else "unreadable", "reason": reason}
            return [messages.READER_DOWN if reader_down else messages.PHOTO_UNREADABLE]

        # Each photo was read without the current menu; the comparison is made once, on the merged menu.
        merged = merge_results(draft.results)
        current = self._current_items(draft.cafe_id)
        draft.items = replay_ops([item.model_copy(deep=True) for item in merged.items],
                                 current, draft.ops, self._threshold())
        draft.hours = merged.hours
        texts = [messages.photos_failed(len(failed), reader_down)] if failed else []
        if draft.scope is None:
            draft.state = "awaiting_scope"
            self.store.save_draft(draft)
            return texts + [messages.read_done_need_scope(len(draft.items))]
        return texts + [self._present(draft)]

    # ---------- the owner's answers ----------

    def set_scope(self, phone_hash, scope):
        """scope: "full" (the photo shows the whole menu) or "partial"."""
        if scope not in ("full", "partial"):
            return messages.ASK_SCOPE
        with self.lock(phone_hash):
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                return messages.NOTHING_TO_CONFIRM
            draft.scope = scope
            if draft.state == "reading":
                self.store.save_draft(draft)
                return messages.scope_set(scope, still_reading=True)
            return messages.scope_set(scope, still_reading=False) + "\n" + self._present(draft)

    def edit(self, phone_hash, op):
        """Apply one fix from the owner (see menu_ops.apply_op for the ops).

        Without an open draft this starts one from the owner's words alone,
        so "the cortado is $4.75 now" works without a photo.
        """
        with self.lock(phone_hash):
            cafe = self.store.find_cafe_by_owner(phone_hash)
            if cafe is None:
                return messages.NOT_AN_OWNER
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                draft = Draft(phone_hash=phone_hash, cafe_id=cafe.cafe_id, source="owner_text",
                              scope="partial", state="awaiting_confirmation")
            if draft.state == "reading":
                return messages.STILL_READING
            try:
                text, before, after = apply_op(draft.items, self._current_items(cafe.cafe_id), op, self._threshold())
            except EditError as error:
                return str(error)
            draft.ops.append(op)
            self.store.save_draft(draft)
            if draft.source == "photo":
                # What the reader said against what the owner says: kept for a future fine-tune.
                self.store.add_correction(cafe.cafe_id, phone_hash, op, before, after)
            return text

    def show_more(self, phone_hash):
        with self.lock(phone_hash):
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                return messages.NOTHING_TO_CONFIRM
            if draft.state != "awaiting_confirmation":
                return messages.STILL_READING if draft.state == "reading" else messages.ASK_SCOPE
            current, new_items, changes = self._preview(draft)
            batch, start, more_left, _all = self._check_batch(draft, new_items, changes, not current)
            self.store.save_draft(draft)
            return messages.more_items(batch, start, more_left) if batch else messages.NO_MORE + " " + messages.REPLY_YES

    def proposal(self, phone_hash):
        """The open update as data, for callers that word it themselves (the iMessage bridge).

        None unless the update is waiting for confirmation. "removed" is only
        ever filled when the owner said the photo shows the full menu, because
        that is the only way final_items drops anything.
        """
        with self.lock(phone_hash):
            draft = self.store.get_draft(phone_hash)
            if draft is None or draft.state != "awaiting_confirmation":
                return None
            _current, new_items, changes = self._preview(draft)
            by_name = {_key(item.item): item for item in new_items}
            added = [by_name[_key(name)] for name in changes.new_items if _key(name) in by_name]
            return {
                "cafe_id": draft.cafe_id,
                # The bridge sorts by confidence with a stable sort, so on a tie this order is what the owner sees.
                "added": sorted(added, key=check_priority),
                "price_changes": list(changes.price_changes),
                "removed": list(changes.missing_from_photo),
            }

    def status(self, phone_hash):
        """One line on what the owner should do next, or None when no update is open."""
        with self.lock(phone_hash):
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                return None
            if draft.state == "reading":
                return messages.STILL_READING
            if draft.scope is None:
                return messages.ASK_SCOPE
            return messages.pending(self._preview(draft)[2])

    def confirm(self, phone_hash):
        """The only place a menu version is saved."""
        with self.lock(phone_hash):
            draft = self.store.get_draft(phone_hash)
            if draft is None:
                return messages.NOTHING_TO_CONFIRM
            if draft.state == "reading":
                return messages.STILL_READING
            if draft.scope is None:
                return messages.ASK_SCOPE
            current, new_items, changes = self._preview(draft)
            if not (changes.new_items or changes.price_changes or changes.missing_from_photo):
                self.store.delete_draft(phone_hash)
                return messages.NO_CHANGES
            if not new_items:
                return messages.EMPTY_MENU
            version = self.store.save_menu_version(draft.cafe_id, new_items, hours=draft.hours,
                                                   source=draft.source, scope=draft.scope, changes=changes)
            self.store.add_event("menu_update", draft.cafe_id, phone_hash, {
                "version": version.version, "new_items": len(changes.new_items),
                "price_changes": len(changes.price_changes), "removed": len(changes.missing_from_photo)})
            self.store.delete_draft(phone_hash)
        if self.on_saved:
            try:
                self.on_saved(version.cafe_id)
            except Exception:
                log.exception("Saved the menu, but re-indexing %s failed", version.cafe_id)
        return messages.saved(version.version, changes, not current, len(new_items))

    def cancel(self, phone_hash):
        with self.lock(phone_hash):
            if self.store.get_draft(phone_hash) is None:
                return messages.NOTHING_TO_CONFIRM
            self.store.delete_draft(phone_hash)
            return messages.CANCELLED
