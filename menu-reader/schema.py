"""The contract with the team: what extract_menu() returns.

Don't rename fields here without asking Ricardo; teammates build against them.
"""

from typing import Literal

from pydantic import BaseModel, Field


class Price(BaseModel):
    size: str | None = None      # "8 oz", "Small", "min"/"max" for ranges; None when the menu shows no size
    usd: float


class AddOn(BaseModel):
    name: str
    usd: float | None = None     # None when the menu shows no price for it


class MenuItem(BaseModel):
    section: str | None = None
    item: str
    category: Literal["drink", "food", "modifier"]
    prices: list[Price] = Field(default_factory=list)   # empty when the menu shows no price
    add_ons: list[AddOn] = Field(default_factory=list)
    variants: list[str] = Field(default_factory=list)   # flavors that share one price
    tags: list[str] = Field(default_factory=list)
    confidence: float = 0.0


class PriceChange(BaseModel):
    item: str
    size: str | None = None
    old_usd: float | None = None
    new_usd: float | None = None


class Changes(BaseModel):
    new_items: list[str] = Field(default_factory=list)
    price_changes: list[PriceChange] = Field(default_factory=list)
    missing_from_photo: list[str] = Field(default_factory=list)


class MenuResult(BaseModel):
    readable: bool
    reason: str | None = None
    confidence: float = 0.0
    hours: str | None = None
    items: list[MenuItem] = Field(default_factory=list)
    changes: Changes = Field(default_factory=Changes)
    timings: dict[str, float] = Field(default_factory=dict)
