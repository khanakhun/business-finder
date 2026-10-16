"""schema.org JSON-LD (`LocalBusiness` and subtypes): the typed facts a site declares about itself."""

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from bs4 import Tag

from app.services.site_intel.page import Page

# Types that describe the business itself (Organization and LocalBusiness subtypes are many: match by name).
_BUSINESS_HINTS = (
    "business",
    "organization",
    "store",
    "shop",
    "restaurant",
    "cafe",
    "hotel",
    "salon",
    "spa",
    "agency",
    "lodging",
    "bakery",
    "bar",
    "clinic",
    "dentist",
    "gym",
    "center",
    "service",
)
_MAX_ITEMS = 10
_MAX_DEPTH = 6
_MAX_NODES = 500
_MAX_SCRIPT_CHARS = 500_000


@dataclass(frozen=True, slots=True)
class JsonLdItem:
    """One business node, the page that declared it and its country (ISO alpha-2, when given as a code)."""

    page: Page
    data: dict[str, Any]
    country: str | None


def _nodes(value: object) -> Iterator[dict[str, Any]]:
    """Top-level nodes and `@graph` members, iteratively and bounded (hostile JSON can nest arbitrarily)."""
    stack: list[tuple[object, int]] = [(value, 0)]
    yielded = 0
    while stack and yielded < _MAX_NODES:
        item, depth = stack.pop()
        if depth > _MAX_DEPTH:
            continue
        if isinstance(item, list):
            stack.extend((child, depth + 1) for child in reversed(item[:_MAX_NODES]))
        elif isinstance(item, dict):
            yielded += 1
            yield item
            if "@graph" in item:
                stack.append((item["@graph"], depth + 1))


def _types(node: dict[str, Any]) -> list[str]:
    value = node.get("@type")
    return [str(v) for v in value] if isinstance(value, list) else [str(value)] if value else []


def _text(value: object, limit: int) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("name") or value.get("@id")
    if value is None or isinstance(value, (dict, list)):
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def _address(value: object) -> str | None:
    if isinstance(value, dict):
        parts = [
            value.get(k)
            for k in ("streetAddress", "postalCode", "addressLocality", "addressRegion", "addressCountry")
        ]
        return (
            ", ".join(str(p if not isinstance(p, dict) else p.get("name", "")) for p in parts if p)[:500]
            or None
        )
    return _text(value, 500)


def _geo(value: object) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        lat, lng = float(value["latitude"]), float(value["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    return {"lat": lat, "lng": lng} if -90 <= lat <= 90 and -180 <= lng <= 180 else None


def _strings(value: object, limit: int, size: int) -> list[str]:
    items = value if isinstance(value, list) else [value] if value else []
    return [s for s in (_text(item, size) for item in items) if s][:limit]


def _hours(node: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    specs = node.get("openingHoursSpecification")
    for spec in specs if isinstance(specs, list) else [specs] if isinstance(specs, dict) else []:
        if not isinstance(spec, dict):
            continue
        days = spec.get("dayOfWeek")
        day_list = days if isinstance(days, list) else [days] if days else []
        names = ",".join(str(d).rsplit("/", 1)[-1] for d in day_list)
        lines.append(f"{names} {spec.get('opens', '')}-{spec.get('closes', '')}".strip()[:200])
    lines.extend(_strings(node.get("openingHours"), 30, 200))
    return lines[:30]


def _country(value: object) -> str | None:
    country = value.get("addressCountry") if isinstance(value, dict) else None
    if isinstance(country, dict):
        country = country.get("name") or country.get("identifier")
    code = str(country).strip().upper() if isinstance(country, str) else ""
    return code if len(code) == 2 and code.isalpha() else None


def extract_jsonld(pages: list[Page]) -> list[JsonLdItem]:
    found: list[JsonLdItem] = []
    seen: set[tuple[object, ...]] = set()
    for page in pages:
        for script in page.soup.find_all("script", type="application/ld+json"):
            if not isinstance(script, Tag):
                continue
            try:
                data = json.loads((script.get_text() or "null")[:_MAX_SCRIPT_CHARS], strict=False)
            except (ValueError, RecursionError):
                continue
            for node in _nodes(data):
                types = _types(node)
                if not any(hint in t.lower() for t in types for hint in _BUSINESS_HINTS):
                    continue
                item = {
                    "type": types[0][:100],
                    "name": _text(node.get("name"), 300),
                    "telephone": _text(node.get("telephone"), 60),
                    "email": (_text(node.get("email"), 254) or "").removeprefix("mailto:") or None,
                    "address": _address(node.get("address")),
                    "geo": _geo(node.get("geo")),
                    "openingHours": _hours(node),
                    "priceRange": _text(node.get("priceRange"), 50),
                    "sameAs": [s for s in _strings(node.get("sameAs"), 30, 2000) if s.startswith("http")],
                    "servesCuisine": _strings(node.get("servesCuisine"), 20, 100),
                }
                # The same business repeated on every page is one item.
                identity = (item["type"], item["name"], item["telephone"], item["address"])
                if identity in seen:
                    continue
                seen.add(identity)
                found.append(JsonLdItem(page, item, _country(node.get("address"))))
                if len(found) >= _MAX_ITEMS:
                    return found
    return found
