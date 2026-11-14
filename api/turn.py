"""POST /v1/turn: the contract Isaiah's iMessage bridge speaks (docs/contracts.md section 2).

The bridge sends one structured event per message and words every reply itself;
this adapter turns each event into a call on the brain and returns actions.

    message  (customer, or owner without photos)  -> say
    message  (owner, with photos)                 -> ask_scope at once; the read runs in the background
    scope    -> waits for the read, then          -> confirm_changes | unreadable_photo | reader_down
    correction -> applies the fix, then           -> (say) + confirm_changes
    confirm  true / false                         -> menu_updated | cancelled

Who may change a menu is decided by sender.handle alone ("role" is only what
the person said about themselves): any photo, scope, correction or confirm from
a handle that owns no café gets not_owner and changes nothing.

The menu-update state lives in the brain's draft (jolo_agent/flow.py), the same
one the plain-text /messages API uses, so the bridge's pending question and the
draft can't drift apart: the bridge asks, the draft answers.
"""

import base64
import binascii
import logging
import time
from typing import Annotated, Literal, Union

from fastapi import HTTPException
from pydantic import BaseModel, Field

from jolo_agent import messages
from jolo_agent.store.models import hash_handle

log = logging.getLogger("jolo.turn")

MAX_PHOTOS = 5
MAX_PHOTO_BYTES = 10 * 1024 * 1024


class Photo(BaseModel):
    name: str = ""
    mime_type: str = ""
    data_base64: str


class Sender(BaseModel):
    handle: str
    name: str | None = None
    role: Literal["owner", "customer"] | None = None      # never trusted; see the module docstring


class MessageEvent(BaseModel):
    type: Literal["message"]
    text: str = ""
    photos: list[Photo] = Field(default_factory=list)


class ScopeEvent(BaseModel):
    type: Literal["scope"]
    scope: Literal["full", "partial"]


class ConfirmEvent(BaseModel):
    type: Literal["confirm"]
    confirmed: bool


class CorrectionEvent(BaseModel):
    type: Literal["correction"]
    text: str


class TurnRequest(BaseModel):
    conversation_id: str
    platform: str = ""
    sender: Sender
    event: Annotated[Union[MessageEvent, ScopeEvent, ConfirmEvent, CorrectionEvent], Field(discriminator="type")]


def say(text):
    return {"type": "say", "text": text}


class TurnHandler:
    def __init__(self, brain, wait_seconds=280.0, poll_seconds=0.5):
        """wait_seconds: how long to wait for a photo read; keep it under the bridge's AGENT_TIMEOUT_MS (300 s)."""
        self.brain = brain
        self.store = brain.store
        self.flow = brain.flow
        self.wait_seconds = wait_seconds
        self.poll_seconds = poll_seconds

    # ---------- entry point ----------

    def handle(self, request):
        handle = request.sender.handle.strip()
        try:
            phone_hash = hash_handle(handle)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
        event = request.event
        outbox = self.brain.outbox
        outbox.register(phone_hash, handle)
        outbox.drain(handle)            # late texts of the plain-text API; this caller never reads them
        try:
            if isinstance(event, MessageEvent) and not event.photos:
                return self._message(handle, event.text)
            cafe = self.store.find_cafe_by_owner(phone_hash)
            if cafe is None:
                return [{"type": "not_owner"}]
            if isinstance(event, MessageEvent):
                return self._photos(phone_hash, cafe, event)
            if isinstance(event, ScopeEvent):
                return self._scope(phone_hash, cafe, event)
            if isinstance(event, CorrectionEvent):
                return self._correction(handle, phone_hash, cafe, event)
            return self._confirm(phone_hash, cafe, event)
        finally:
            outbox.drain(handle)

    # ---------- events ----------

    def _message(self, handle, text):
        """A customer's question, or an owner's words with no photo: the brain answers."""
        replies = [reply for reply in self.brain.handle_message(handle, text, []) if reply and reply.strip()]
        return [say(reply) for reply in replies] or [say(messages.EMPTY_MESSAGE)]

    def _photos(self, phone_hash, cafe, event):
        photos = self._decode(event.photos)
        for photo in photos:
            self.flow.start_read(phone_hash, photo)
        draft = self.store.get_draft(phone_hash)
        if draft is not None and draft.scope is None:
            return [{"type": "ask_scope"}]       # the read carries on in the background
        # Another photo of a menu whose scope is already known: wait and propose the merged result.
        return self._after_read(phone_hash, cafe)

    def _scope(self, phone_hash, cafe, event):
        if self.store.get_draft(phone_hash) is None:
            return self._outcome(phone_hash)
        self.flow.set_scope(phone_hash, event.scope)
        return self._after_read(phone_hash, cafe)

    def _correction(self, handle, phone_hash, cafe, event):
        draft = self._wait(phone_hash)
        if draft is None:
            return self._outcome(phone_hash)
        actions = [say(text) for text in self.brain.apply_correction(handle, event.text)]
        return actions + self._proposal(phone_hash, cafe)

    def _confirm(self, phone_hash, cafe, event):
        if not event.confirmed:
            self.flow.cancel(phone_hash)
            return [{"type": "cancelled"}]
        before = cafe.current_version
        text = self.flow.confirm(phone_hash)
        after = self.store.get_cafe(cafe.cafe_id).current_version
        if after > before:
            return [{"type": "menu_updated", "cafe_name": cafe.name, "version": after}]
        if text == messages.ASK_SCOPE:
            return [{"type": "ask_scope"}]
        return [say(text)]

    # ---------- helpers ----------

    def _decode(self, photos):
        if len(photos) > MAX_PHOTOS:
            raise HTTPException(status_code=422, detail=f"At most {MAX_PHOTOS} photos per message")
        decoded = []
        for photo in photos:
            if photo.mime_type and not photo.mime_type.lower().startswith("image/"):
                raise HTTPException(status_code=422, detail=f"{photo.name or 'a file'} is not an image")
            try:
                data = base64.b64decode(photo.data_base64, validate=True)
            except (binascii.Error, ValueError):
                raise HTTPException(status_code=422, detail=f"{photo.name or 'a photo'} is not valid base64")
            if not data or len(data) > MAX_PHOTO_BYTES:
                raise HTTPException(status_code=422, detail=f"{photo.name or 'a photo'} is empty or over 10 MB")
            decoded.append(data)
        return decoded

    def _wait(self, phone_hash):
        """The draft once no photo of it is still being read (None: the update ended, see _outcome)."""
        deadline = time.monotonic() + self.wait_seconds
        while True:
            with self.flow.lock(phone_hash):
                draft = self.store.get_draft(phone_hash)
            if draft is None or draft.state != "reading":
                return draft
            if time.monotonic() >= deadline:
                # The bridge keeps its pending question, so the owner can answer again once the read is done.
                raise HTTPException(status_code=504, detail="The menu is still being read")
            time.sleep(self.poll_seconds)

    def _after_read(self, phone_hash, cafe):
        draft = self._wait(phone_hash)
        if draft is None:
            return self._outcome(phone_hash)
        if draft.scope is None:
            return [{"type": "ask_scope"}]
        return self._proposal(phone_hash, cafe)

    def _proposal(self, phone_hash, cafe):
        proposal = self.flow.proposal(phone_hash)
        if proposal is None:
            return [say(messages.NOTHING_TO_CONFIRM)]
        return [{
            "type": "confirm_changes",
            "cafe_name": cafe.name,
            "changes": {
                "added": [item.model_dump(mode="json") for item in proposal["added"]],
                "price_changes": [change.model_dump(mode="json") for change in proposal["price_changes"]],
                "removed": proposal["removed"],
            },
        }]

    def _outcome(self, phone_hash):
        """The update is over without a proposal: say why, as the flow recorded it."""
        outcome = self.flow.outcomes.pop(phone_hash, None)
        if outcome is None:
            return [say(messages.NOTHING_TO_CONFIRM)]
        if outcome["kind"] == "reader_down":
            return [{"type": "reader_down"}]
        if outcome["kind"] == "unreadable":
            return [{"type": "unreadable_photo", **({"reason": outcome["reason"]} if outcome.get("reason") else {})}]
        return [say(messages.NO_CHANGES)]
