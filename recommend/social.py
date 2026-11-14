"""Reddit, and TikTok when a ScrapFly key is set, through the Scraper_test app.

Scraper_test (~/Scraper_test, or SCRAPER_TEST_PATH) already searches each
platform and normalizes the posts. This module asks it about one drink niche
and keeps only what JOLO needs: the post title, its link, and how much
engagement it got. Usernames and media are dropped before anything is stored.

Reddit runs through a local camofox-browser server (CAMOFOX_BASE_URL,
default http://localhost:9377). TikTok needs SCRAPFLY_KEY and is skipped
without it. One platform failing never stops the other.

    python -m recommend.social "oat milk latte"
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Awaitable, Callable

DEFAULT_SCRAPER = os.path.expanduser("~/Scraper_test")
PLATFORMS = ("reddit", "tiktok")


def scraper_path() -> str:
    return os.environ.get("SCRAPER_TEST_PATH", DEFAULT_SCRAPER)


@dataclass
class SocialDeps:
    """One search function per platform: niche -> normalized posts. Tests pass fakes."""

    search: dict[str, Callable[[str], Awaitable[list[dict]]]] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)


def load_scraper_deps() -> SocialDeps:
    path = scraper_path()
    if not os.path.isdir(os.path.join(path, "app", "scrapers")):
        return SocialDeps(skipped={p: f"Scraper_test is not at {path}" for p in PLATFORMS})
    if path not in sys.path:
        sys.path.insert(0, path)
    from app.normalize import normalize_reddit, normalize_tiktok
    from app.scrapers import reddit

    async def search_reddit(niche: str) -> list[dict]:
        return [normalize_reddit(item) for item in await reddit.search_reddit(niche)]

    deps = SocialDeps(search={"reddit": search_reddit})
    if os.environ.get("SCRAPFLY_KEY"):
        from app.scrapers import tiktok

        async def search_tiktok(niche: str) -> list[dict]:
            return [normalize_tiktok(item) for item in await tiktok.scrape_search(keyword=niche)]

        deps.search["tiktok"] = search_tiktok
    else:
        deps.skipped["tiktok"] = "off: no SCRAPFLY_KEY"
    return deps


_ABBREVIATED = re.compile(r"^([\d.,]+)\s*([KMB]?)$", re.I)


def engagement_count(value) -> int:
    """'1.8K' -> 1800, 42 -> 42, None -> 0. Reddit's page only shows abbreviated counts."""
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    match = _ABBREVIATED.match(str(value).strip())
    if not match:
        return 0
    number = float(match.group(1).replace(",", ""))
    scale = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[match.group(2).upper()]
    return int(number * scale)


def slim_post(post: dict, platform: str) -> dict | None:
    """Title, link and one engagement number. No author, media or raw payload."""
    title = " ".join(str(post.get("text") or "").split())[:200]
    if not title:
        return None
    engagement = post.get("engagement") or {}
    score = max(
        engagement_count(engagement.get("upvotes")),
        engagement_count(engagement.get("likes")),
    ) + engagement_count(engagement.get("comments"))
    return {"title": title, "url": post.get("url"), "source": platform, "engagement": score}


async def _run(niche: str, deps: SocialDeps) -> dict:
    async def one(platform: str) -> tuple[str, dict]:
        try:
            posts = await deps.search[platform](niche)
        except Exception as error:  # a blocked or offline platform is reported, not raised
            return platform, {"ok": False, "error": str(error)[:200], "posts": []}
        slim = [p for p in (slim_post(post, platform) for post in posts) if p]
        return platform, {"ok": True, "error": None, "posts": slim}

    results = dict(await asyncio.gather(*(one(p) for p in deps.search)))
    for platform, reason in deps.skipped.items():
        results.setdefault(platform, {"ok": False, "error": reason, "posts": []})
    return results


def scrape_social(niche: str, *, deps: SocialDeps | None = None) -> dict:
    """{platform: {ok, error, posts: [{title, url, source, engagement}]}} for one niche."""
    return asyncio.run(_run(niche, deps or load_scraper_deps()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Search Reddit (and TikTok) for one drink niche.")
    parser.add_argument("niche")
    args = parser.parse_args(argv)
    for platform, result in scrape_social(args.niche).items():
        status = "ok" if result["ok"] else f"error: {result['error']}"
        print(f"{platform}: {len(result['posts'])} posts ({status})")
        for post in result["posts"][:10]:
            print(f"  {post['engagement']:>6}  {post['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
