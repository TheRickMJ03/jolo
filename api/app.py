"""The HTTP API Isaiah's iMessage service talks to.

Run it (from the repo root, venv active):
    python -m uvicorn api.app:create_app --factory --port 8080

    POST /messages   phone, text, photos (multipart form)  -> {"replies": [...]} to send now
    GET  /outbox     ?phone=...                            -> {"messages": [...]} that became ready later
    GET  /health                                           -> is the model server reachable, etc.
    POST /users      {"phone", "name", "role", "cafe_id"}  -> register a customer or an owner
    GET  /insights/{cafe_id}                               -> this week's counts, for the dashboard

A menu read takes 15 to 100 seconds, so POST /messages answers at once with
"Reading your menu…" and the result arrives through the outbox (or through
agent.api.callback_url, when that is set).

When JOLO_API_KEY is set, every request must send it as the X-Jolo-Key header.
Set it before binding to 0.0.0.0.
"""

import os
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from jolo_agent.brain import build_brain
from jolo_agent.insights import weekly_counts
from jolo_agent.store.models import User, hash_phone


class NewUser(BaseModel):
    phone: str
    name: str | None = None
    role: str = "customer"          # "customer" or "owner"
    cafe_id: str | None = None      # required for an owner


def create_app(brain=None):
    brain = brain or build_brain()
    key_name = brain.settings["api"]["api_key_env"]

    def check_key(x_jolo_key: str | None = Header(default=None)):
        expected = os.environ.get(key_name)
        if expected and x_jolo_key != expected:
            raise HTTPException(status_code=401, detail="Missing or wrong X-Jolo-Key header")

    app = FastAPI(title="JOLO agent", dependencies=[Depends(check_key)])
    app.state.brain = brain
    threading.Thread(target=brain.warm, daemon=True, name="warm-search").start()

    # Plain "def", not "async def": FastAPI runs these in a thread pool, so a
    # slow model call never blocks other phones' messages.
    @app.post("/messages")
    def post_message(phone: str = Form(...), text: str = Form(""), photos: list[UploadFile] = File(default=[])):
        try:
            hash_phone(phone)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
        images = [photo.file.read() for photo in photos]       # the original bytes, never resized
        return {"replies": brain.handle_message(phone, text, images)}

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
        phone_hash = hash_phone(user.phone)
        if user.role == "owner":
            cafe = brain.store.get_cafe(user.cafe_id or "")
            if cafe is None:
                raise HTTPException(status_code=404, detail=f"No café {user.cafe_id!r}")
            if cafe.owner_phone_hash and cafe.owner_phone_hash != phone_hash:
                raise HTTPException(status_code=409, detail="This café already has another owner")
            cafe.owner_phone_hash = phone_hash
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
