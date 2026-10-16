"""Social profiles linked from the site (recorded, never followed)."""

from typing import Any
from urllib.parse import urlsplit

from app.services.site_intel.page import Page

_NETWORKS = {
    "facebook.com": "facebook",
    "fb.com": "facebook",
    "instagram.com": "instagram",
    "tiktok.com": "tiktok",
    "linkedin.com": "linkedin",
    "x.com": "x",
    "twitter.com": "x",
    "youtube.com": "youtube",
    "pinterest.com": "pinterest",
    "tripadvisor.com": "tripadvisor",
    "tripadvisor.fr": "tripadvisor",
    "yelp.com": "yelp",
    "linktr.ee": "linktree",
    "threads.net": "threads",
}
# Share buttons, plugins and pixels are not the business's profile (first path segment, exact).
_IGNORED_SEGMENTS = frozenset(
    {"sharer", "sharer.php", "share", "share.php", "intent", "plugins", "dialog", "tr", "embed", "watch"}
)


def network_of(url: str) -> str | None:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.").removeprefix("m.")
    for domain, network in _NETWORKS.items():
        if host == domain or host.endswith(f".{domain}"):
            return network
    return None


def extract_socials(pages: list[Page], same_as: list[str]) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for url in [link.url for page in pages for link in page.links] + same_as:
        network = network_of(url)
        parts = urlsplit(url)
        segment = parts.path.strip("/").split("/")[0]
        if network is None or not segment or segment.lower() in _IGNORED_SEGMENTS:
            continue
        clean = f"{parts.scheme}://{parts.netloc}{parts.path}"[:2000]  # tracking queries dropped
        key = clean.rstrip("/").lower()
        if key not in found:
            handle = segment.lstrip("@")[:200] or None
            found[key] = {"network": network, "url": clean, "handle": handle}
    return sorted(found.values(), key=lambda s: (s["network"], s["url"]))[:30]
