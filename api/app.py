"""The HTTP API Isaiah's iMessage service talks to.

Run it (from the repo root, venv active):
    python -m uvicorn api.app:create_app --factory --port 8080

    POST /v1/turn    the iMessage bridge's contract (api/turn.py, docs/contracts.md section 2)
    POST /messages   phone, text, photos (multipart form)  -> {"replies": [...]} to send now
    GET  /outbox     ?phone=...                            -> {"messages": [...]} that became ready later
    GET  /health                                           -> is the model server reachable, etc.
    POST /users      {"phone", "name", "role", "cafe_id"}  -> register a customer or an owner
    GET  /insights/{cafe_id}                               -> this week's counts, for the dashboard

A menu read takes 15 to 100 seconds, so POST /messages answers at once with
"Reading your menu…" and the result arrives through the outbox (or through
agent.api.callback_url, when that is set).

When JOLO_API_KEY or AGENT_TOKEN is set, every request must send one of them: the key as the
X-Jolo-Key header, or the token as "Authorization: Bearer <token>" (what the bridge sends).
Set one before binding to 0.0.0.0.
"""

import hmac
import os
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from api.turn import TurnHandler, TurnRequest
from jolo_agent.brain import build_brain
from jolo_agent.insights import weekly_counts
from jolo_agent.safety import RateLimiter, install_log_masking
from jolo_agent.store.models import User, hash_handle, hash_phone, to_e164


class NewUser(BaseModel):
    phone: str
    name: str | None = None
    role: str = "customer"          # "customer" or "owner"
    cafe_id: str | None = None      # required for an owner


def create_app(brain=None):
    brain = brain or build_brain()
    api_settings = brain.settings["api"]
    key_name = api_settings["api_key_env"]
    token_name = api_settings.get("token_env", "AGENT_TOKEN")

    def check_key(x_jolo_key: str | None = Header(default=None), authorization: str | None = Header(default=None)):
        """Open when neither JOLO_API_KEY nor AGENT_TOKEN is set (localhost). Otherwise the caller must send
        the key as X-Jolo-Key, or the bridge's token as "Authorization: Bearer <AGENT_TOKEN>"."""
        key, token = os.environ.get(key_name), os.environ.get(token_name)
        if not key and not token:
            return
        if key and x_jolo_key is not None and hmac.compare_digest(x_jolo_key, key):
            return
        if token and authorization is not None and hmac.compare_digest(authorization, f"Bearer {token}"):
            return
        raise HTTPException(status_code=401, detail="Missing or wrong X-Jolo-Key / Authorization header")

    install_log_masking()
    messages_limit = RateLimiter(api_settings.get("rate_limit_messages", 30), api_settings.get("rate_limit_window_seconds", 60))
    photos_limit = RateLimiter(api_settings.get("rate_limit_photos", 12), api_settings.get("rate_limit_photo_window_seconds", 3600))

    def check_rate(sender, photo_count=0):
        """429 when this sender is sending too fast; the bridge treats it like any failed call and keeps its question."""
        if not messages_limit.allow(sender):
            raise HTTPException(status_code=429, detail="Too many messages. Wait a minute.",
                                headers={"Retry-After": str(messages_limit.retry_after(sender))})
        for _ in range(photo_count):
            if not photos_limit.allow(sender):
                raise HTTPException(status_code=429, detail="Too many photos this hour.",
                                    headers={"Retry-After": str(photos_limit.retry_after(sender))})

    app = FastAPI(title="JOLO agent", dependencies=[Depends(check_key)])
    app.state.brain = brain
    turns = TurnHandler(brain, wait_seconds=api_settings.get("turn_timeout_seconds", 280),
                        poll_seconds=api_settings.get("turn_poll_seconds", 0.5))
    threading.Thread(target=brain.warm, daemon=True, name="warm-search").start()
    if brain.settings["store"]["backend"] == "firestore":          # only the app edits menus behind the brain's back
        brain.start_refresher(brain.settings["search"].get("refresh_seconds", 0))

    # Plain "def", not "async def": FastAPI runs these in a thread pool, so a
    # slow model call never blocks other phones' messages.
    @app.post("/messages")
    def post_message(phone: str = Form(...), text: str = Form(""), photos: list[UploadFile] = File(default=[])):
        try:
            hash_phone(phone)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
        check_rate(phone, len(photos))
        images = [photo.file.read() for photo in photos]       # the original bytes, never resized
        return {"replies": brain.handle_message(phone, text, images)}

    @app.post("/v1/turn")
    def post_turn(request: TurnRequest):
        """The iMessage bridge's endpoint (docs/contracts.md section 2): one event in, actions out."""
        event = request.event
        check_rate(request.sender.handle.strip(), len(getattr(event, "photos", None) or []))
        return {"actions": turns.handle(request)}

    @app.get("/outbox")
    def get_outbox(phone: str):
        return {"messages": brain.outbox.drain(phone)}

    @app.get("/health")
    def get_health():
        return brain.health()

    @app.post("/users")
    def post_user(user: NewUser):
        if user.role not in ("customer", "owner"):
            raise HTTPException(status_code=422, detail="role must be customer or owner")
        phone_hash = hash_handle(user.phone)
        if user.role == "owner":
            cafe = brain.store.get_cafe(user.cafe_id or "")
            if cafe is None:
                raise HTTPException(status_code=404, detail=f"No café {user.cafe_id!r}")
            if cafe.owner_phone_hash and cafe.owner_phone_hash != phone_hash:
                raise HTTPException(status_code=409, detail="This café already has another owner")
            cafe.owner_phone_hash = phone_hash
            cafe.owner_phone = to_e164(user.phone) or user.phone.strip()
            brain.store.upsert_cafe(cafe)
        brain.store.upsert_user(User(phone_hash=phone_hash, name=user.name, role=user.role,
                                     cafe_id=user.cafe_id if user.role == "owner" else None))
        return {"phone_hash": phone_hash, "role": user.role, "cafe_id": user.cafe_id}

    @app.get("/insights/{cafe_id}")
    def get_insights(cafe_id: str):
        if brain.store.get_cafe(cafe_id) is None:
            raise HTTPException(status_code=404, detail=f"No café {cafe_id!r}")
        return weekly_counts(brain.store, cafe_id)

    return app
