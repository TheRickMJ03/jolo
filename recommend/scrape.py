"""Run blog-finder for one drink niche and return drink names, not HTML.

Search, site scoring, the feed scraper, and trend stats stay in blog-finder.
This module only swaps in the drink queries, skips outreach, and throws the
page text away after the drink names are copied out.

    python -m recommend.scrape "oat milk espresso drinks"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from typing import Callable

from recommend.extract import extract_drinks
from recommend.queries import build_queries

DEFAULT_FINDER = os.path.expanduser("~/Scraper_test/blog-finder")
SINCE_DAYS = 30
MIN_SCORE = 4
SCRAPE_SITES = 3


@dataclass
class ScrapeDeps:
    """The blog-finder calls this niche scrape needs. Tests pass fakes."""

    collect: Callable
    analyze_site: Callable
    niche_terms: Callable
    posted_within: Callable
    launch: Callable
    output_name: str = "scraped.json"


def finder_path() -> str:
    return os.environ.get("BLOG_FINDER_PATH", DEFAULT_FINDER)


def load_finder():
    path = finder_path()
    if not os.path.isdir(path):
        raise RuntimeError(
            f"blog-finder is not at {path}. Set BLOG_FINDER_PATH to the checkout that contains main.py."
        )
    if path not in sys.path:
        sys.path.insert(0, path)
    import analyzer
    import main as finder_main
    import scraper as finder_scraper
    import search

    return finder_main, analyzer, finder_scraper, search


def blog_finder_deps(
    *,
    backend: str = "ddg",
    per_query: int = 5,
    posts_per_site: int = 8,
    workers: int = 4,
    use_llm: bool = False,
    since_days: int = SINCE_DAYS,
) -> ScrapeDeps:
    finder_main, analyzer, finder_scraper, search = load_finder()
    backend_obj = search.get_backend(backend)

    def collect(niche: str, queries: list[str]):
        sites, _roundups, _stats = finder_main.collect(niche, backend_obj, per_query, queries)
        return list(sites.values())

    def launch(job_dir: str, niche: str, sites: list):
        return finder_scraper.launch(
            job_dir,
            niche,
            sites,
            posts_per_site,
            workers,
            use_llm=use_llm,
            since_days=since_days,
        )

    return ScrapeDeps(
        collect=collect,
        analyze_site=analyzer.analyze_site,
        niche_terms=analyzer.niche_terms,
        posted_within=finder_main.posted_within,
        launch=launch,
        output_name=finder_scraper.OUTPUT_FILE,
    )


def scrape_niche(
    niche: str,
    *,
    deps: ScrapeDeps | None = None,
    since_days: int = SINCE_DAYS,
    min_score: int = MIN_SCORE,
    scrape_sites: int = SCRAPE_SITES,
) -> dict:
    """Trends for one niche. Page text stays in a temp dir and is deleted."""
    deps = deps or blog_finder_deps(since_days=since_days)
    queries, _source = build_queries(niche)
    found = deps.collect(niche, queries)
    terms = deps.niche_terms(niche)
    analyzed = [deps.analyze_site(site, terms) for site in found]
    kept = [
        site
        for site in analyzed
        if not getattr(site, "error", None) and getattr(site, "score", 0) >= min_score
    ]
    kept.sort(key=lambda site: (site.score, getattr(site, "last_post", None) or ""), reverse=True)
    kept = list(deps.posted_within(kept, since_days))[:scrape_sites]
    if not kept:
        return {"top_phrases": [], "top_words": [], "momentum": None, "ai": None, "titles": []}

    with tempfile.TemporaryDirectory(prefix="jolo-drink-") as job_dir:
        process = deps.launch(job_dir, niche, kept)
        code = process.wait()
        output = os.path.join(job_dir, deps.output_name)
        if code != 0 or not os.path.exists(output):
            raise RuntimeError(f"blog-finder scraper failed for {niche!r} (exit {code})")
        with open(output, encoding="utf-8") as handle:
            payload = json.load(handle)

    trends = dict(payload.get("trends") or {})
    titles = []
    posts = []
    for site in payload.get("sites") or []:
        for post in site.get("posts") or []:
            title = (post.get("title") or "").strip()
            if title:
                titles.append(title)
                posts.append({"title": title[:200], "url": post.get("url"), "source": "blogs"})
    trends["titles"] = titles
    # Title and link only: the page text stays in the deleted temp dir.
    trends["posts"] = posts
    return trends


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scrape one drink niche and print the drink names.")
    parser.add_argument("niche", help='for example "oat milk espresso drinks"')
    parser.add_argument("--since-days", type=int, default=SINCE_DAYS)
    parser.add_argument("--min-score", type=int, default=MIN_SCORE)
    parser.add_argument("--scrape", type=int, default=SCRAPE_SITES, help="how many sites to scrape")
    parser.add_argument("--backend", choices=["ddg", "brave"], default="ddg")
    args = parser.parse_args(argv)

    trends = scrape_niche(
        args.niche,
        deps=blog_finder_deps(backend=args.backend, since_days=args.since_days),
        since_days=args.since_days,
        min_score=args.min_score,
        scrape_sites=args.scrape,
    )
    drinks = extract_drinks(trends)
    if not drinks:
        print(f"No drink names in {args.niche!r}.")
        return 0
    for drink in drinks:
        print(f"{drink['momentum']}\t{drink['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
