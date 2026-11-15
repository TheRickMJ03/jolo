"""Load config.yaml and pick a profile (laptop_cpu or vm)."""

import copy
import os
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent


def _merge(base, override):
    """Copy of base with override's values on top, section by section."""
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _load_dotenv():
    """Read KEY=value lines from the .env file (API keys) into the environment.

    .env is in .gitignore: keys never go in Git. Variables already set in the
    shell win over the file.
    """
    path = REPO / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def load_config(profile=None):
    """Returns the "common" settings with the chosen profile's settings on top.

    Profile order: the argument, then the JOLO_PROFILE environment variable,
    then default_profile in config.yaml.
    """
    _load_dotenv()
    raw = yaml.safe_load((REPO / "config.yaml").read_text(encoding="utf-8"))
    profile = profile or os.environ.get("JOLO_PROFILE") or raw["default_profile"]
    if profile not in raw["profiles"]:
        raise ValueError(f"Unknown profile {profile!r}. Choose from {sorted(raw['profiles'])}.")
    config = _merge(raw["common"], raw["profiles"][profile])
    config["profile"] = profile
    # Docker: the model server is not on localhost inside a container.
    if os.environ.get("JOLO_MODEL_ENDPOINT"):
        config["endpoint"] = os.environ["JOLO_MODEL_ENDPOINT"]
    return config
