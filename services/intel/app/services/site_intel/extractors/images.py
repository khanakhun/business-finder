"""Logo and content image candidates (BF-038 downloads and licenses them; here only URLs and hints)."""

import re
from typing import Any

from bs4 import Tag

from app.services.site_intel.page import Page
from app.services.site_intel.urls import absolute

_LOGO_HINT = re.compile(r"logo", re.IGNORECASE)
_ICON_RELS = ("icon", "shortcut icon", "apple-touch-icon")
_MIN_CONTENT_SIDE = 400


def _int(value: object) -> int | None:
    try:
        number = int(str(value).strip().removesuffix("px"))
    except (TypeError, ValueError):
        return None
    return number if 0 < number < 100_000 else None


def logo_candidates(home: Page) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}

    def add(href: object, source: str, width: object = None, height: object = None) -> None:
        url = absolute(str(href or ""), home.url)
        if url and url not in found and len(found) < 10:
            found[url] = {"url": url, "source": source, "width": _int(width), "height": _int(height)}

    for img in home.soup.find_all("img"):
        if not isinstance(img, Tag):
            continue
        hints = " ".join(
            [
                str(img.get("alt", "")),
                " ".join(img.get("class") or []),
                str(img.get("id", "")),
                str(img.get("src", "")),
            ]
        )
        if _LOGO_HINT.search(hints):
            add(img.get("src"), "img-logo", img.get("width"), img.get("height"))
    if og := home.meta("og:image"):
        add(og, "og:image")
    for link in home.soup.find_all("link", href=True):
        if isinstance(link, Tag) and " ".join(link.get("rel") or []).lower() in _ICON_RELS:
            sizes = str(link.get("sizes", ""))
            width = sizes.split("x", maxsplit=1)[0] if "x" in sizes else None
            add(link.get("href"), "link-icon", width, width)
    return list(found.values())


def image_candidates(pages: list[Page], limit: int = 20) -> list[dict[str, Any]]:
    """Large content images (declared size), biggest first; logos and icons excluded."""
    found: dict[str, dict[str, Any]] = {}
    for page in pages:
        for img in page.soup.find_all("img"):
            if not isinstance(img, Tag):
                continue
            url = absolute(str(img.get("src") or img.get("data-src") or ""), page.url)
            width, height = _int(img.get("width")), _int(img.get("height"))
            alt = str(img.get("alt") or "").strip()[:300] or None
            if not url or url in found or _LOGO_HINT.search(f"{alt or ''} {url}"):
                continue
            if width is not None and width < _MIN_CONTENT_SIDE:
                continue
            found[url] = {"url": url, "alt": alt, "width": width, "height": height}
    ranked = sorted(found.values(), key=lambda i: -((i["width"] or 0) * (i["height"] or 0)))
    return ranked[:limit]
