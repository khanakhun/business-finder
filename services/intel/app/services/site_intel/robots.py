"""robots.txt (RFC 9309) and the sitemap's latest `lastmod`, fetched through the SSRF guard."""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

from protego import Protego

from app.net.safe_fetch import FetchError, FetchPolicy, SafeFetcher
from app.services.site_intel.urls import path_key

_ROBOTS_POLICY = FetchPolicy(timeout_seconds=10, max_bytes=512 * 1024)
_SITEMAP_POLICY = FetchPolicy(timeout_seconds=10, max_bytes=2 * 1024 * 1024)
_LASTMOD = re.compile(rb"<lastmod>\s*([0-9T:+\-.Z]{10,40})\s*</lastmod>", re.IGNORECASE)
_MAX_DELAY_SECONDS = 5.0


@dataclass(slots=True)
class SiteRules:
    """What one origin's robots.txt allows our bot. `unreachable` (5xx): only the home page may be fetched."""

    origin: str = ""
    agent: str = "*"
    parser: Protego | None = None
    unreachable: bool = False
    crawl_delay: float = 0.0
    sitemaps: list[str] = field(default_factory=list)

    def allowed(self, url: str, home: str) -> bool:
        if self.unreachable:
            return path_key(url) == path_key(home)
        return self.parser is None or self.parser.can_fetch(url, self.agent)


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{(parts.netloc or '').lower()}"


def bot_token(user_agent: str) -> str:
    """The product token robots.txt groups name (`BusinessFinderBot` in `BusinessFinderBot/1.0 (+…)`).

    Rules are always evaluated for our configured bot, whatever User-Agent a caller sends: a site that
    disallows us cannot be crawled by announcing another name.
    """
    token = user_agent.strip().split("/", 1)[0].split(" ", 1)[0]
    return token or "*"


async def load_rules(
    fetcher: SafeFetcher, url: str, agent: str, policy: FetchPolicy | None = None
) -> SiteRules:
    origin = origin_of(url)
    robots_url = urljoin(origin + "/", "/robots.txt")
    try:
        result = await fetcher.fetch(robots_url, policy=policy or _ROBOTS_POLICY)
    except FetchError:
        # RFC 9309 §2.3.1.4: unreachable means "assume complete disallow"; we read the home page only (as for
        # a 5xx), which is what any visitor's single request would be.
        return SiteRules(origin, agent, unreachable=True)
    if result.status_code >= 500:
        return SiteRules(origin, agent, unreachable=True)
    if result.status_code >= 400:
        return SiteRules(origin, agent)
    parser = await asyncio.to_thread(Protego.parse, result.content.decode("utf-8", "replace"))
    delay = parser.crawl_delay(agent)
    return SiteRules(
        origin,
        agent,
        parser=parser,
        crawl_delay=min(float(delay), _MAX_DELAY_SECONDS) if delay else 0.0,
        sitemaps=[s for s in parser.sitemaps if s.startswith(("http://", "https://"))][:3],
    )


def _parse_date(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


async def sitemap_lastmod(
    fetcher: SafeFetcher, url: str, rules: SiteRules, now: datetime, policy: FetchPolicy | None = None
) -> datetime | None:
    """Latest `<lastmod>` of the first sitemap that answers (robots.txt `Sitemap:`, else /sitemap.xml)."""
    fallback = urljoin(origin_of(url) + "/", "/sitemap.xml")
    # The conventional location only where robots.txt lets us go (never when it could not be read).
    candidates = rules.sitemaps or ([fallback] if rules.allowed(fallback, url) else [])
    for candidate in candidates:
        try:
            result = await fetcher.fetch(candidate, policy=policy or _SITEMAP_POLICY)
        except FetchError:
            continue
        if result.status_code != 200:
            continue
        # Regex over bytes, never an XML parser: no entity expansion on untrusted input.
        found = await asyncio.to_thread(_LASTMOD.findall, result.content)
        dates = [d for d in (_parse_date(m.decode()) for m in found) if d and d <= now]
        if dates:
            return max(dates)
    return None
