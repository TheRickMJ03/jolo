"""The only file that talks to model endpoints.

Every model is reached through an OpenAI-compatible /chat/completions endpoint:
Ollama on the laptop, vLLM on the VM, or a cloud API. Which one is a
config.yaml choice, never a code change.

Replies are cached on disk when config["cache"]["reads_dir"] is set, keyed by
everything that was sent (model, prompt, image, settings). The same question
is never asked twice, so validation code can change without calling a model.
"""

import base64
import hashlib
import json
import os
import time

import cv2
import requests

from menu_reader.config import REPO


class ModelError(RuntimeError):
    """The endpoint could not be reached, returned an error, or is not configured."""


def image_to_data_uri(image):
    """BGR image -> 'data:image/png;base64,...' (PNG is lossless, so no new artifacts)."""
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ModelError("Could not encode the image as PNG")
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def _resolve(config, model_key):
    """Look up a model in the profile. Returns (endpoint, model name, api key).

    In config.yaml a model is either just a name (it uses the profile's
    endpoint), or a block with its own endpoint and the name of the
    environment variable that holds its API key.
    """
    entry = (config.get("models") or {}).get(model_key)
    if isinstance(entry, str):
        entry = {"name": entry}
    if not entry or not entry.get("name"):
        raise ModelError(f"Profile {config.get('profile')!r} has no model configured for {model_key!r}")
    endpoint = entry.get("endpoint") or config.get("endpoint")
    if not endpoint:
        raise ModelError(f"Profile {config.get('profile')!r} has no endpoint for {model_key!r}")
    api_key = "not-needed"
    if entry.get("api_key_env"):
        api_key = os.environ.get(entry["api_key_env"])
        if not api_key:
            raise ModelError(f"Set {entry['api_key_env']} in the .env file (needed for {model_key!r})")
    return endpoint, entry["name"], api_key


def _chat(content, config, model_key, max_tokens, cache_label):
    """Send one user message. Returns {"text", "finish_reason", "seconds"}.

    finish_reason "length" means the reply was cut off at max_tokens.
    seconds is the model's time; on a cache hit it is the time of the original call.
    """
    endpoint, model, api_key = _resolve(config, model_key)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
        "temperature": config["reader"]["temperature"],
    }

    cache_path = None
    cache_dir = (config.get("cache") or {}).get("reads_dir")
    if cache_dir:
        digest = hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]
        cache_path = REPO / cache_dir / f"{cache_label or 'photo'}_{model_key}_{digest}.json"
        if cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))

    start = time.perf_counter()
    try:
        response = requests.post(
            endpoint.rstrip("/") + "/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=config["reader"]["timeout_seconds"],
        )
    except requests.RequestException as error:
        raise ModelError(f"Could not reach {endpoint}: {error}") from error
    if response.status_code != 200:
        raise ModelError(f"{endpoint} answered {response.status_code}: {response.text[:500]}")

    choice = response.json()["choices"][0]
    reply = {
        "text": choice["message"].get("content") or "",
        "finish_reason": choice.get("finish_reason"),
        "seconds": time.perf_counter() - start,
    }
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(reply, ensure_ascii=False, indent=2), encoding="utf-8")
    return reply


def ask_about_image(image, prompt, config, model_key, max_tokens, cache_label=None):
    """Send one image and one text prompt to a vision model."""
    content = [
        {"type": "image_url", "image_url": {"url": image_to_data_uri(image)}},
        {"type": "text", "text": prompt},
    ]
    return _chat(content, config, model_key, max_tokens, cache_label)


def ask_text(prompt, config, model_key, max_tokens, cache_label=None):
    """Send a text-only prompt to a language model."""
    return _chat(prompt, config, model_key, max_tokens, cache_label)
