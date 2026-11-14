"""Drink templates for blog-finder.

blog-finder's own templates look for forums, associations, and guest-post
pages. Those find sites, not something a café can pour. This list is what
`build_queries` returns instead. Outreach stays off.
"""
from __future__ import annotations

DRINK_TEMPLATES = (
    "{niche}",
    "{niche} recipe",
    "best {niche}",
    "{niche} café menu",
    "{niche} trend",
    "how to order {niche}",
)


def build_queries(niche: str, outreach: bool = False, use_llm: bool = False) -> tuple[list[str], str]:
    """Same signature as blog-finder's build_queries. Outreach and the LLM are ignored."""
    del outreach, use_llm
    name = niche.strip()
    return [template.format(niche=name) for template in DRINK_TEMPLATES], "template"


def drink_queries(niche: str) -> list[str]:
    queries, _source = build_queries(niche)
    return queries
