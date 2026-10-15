"""Parked or for-sale domains, and "websites" that are only a social profile or a link page."""

import re

from app.services.site_intel.extractors.socials import network_of
from app.services.site_intel.page import Page
from app.services.site_intel.urls import host_of

_PARKING_HOSTS = (
    "sedoparking.com",
    "sedo.com",
    "parkingcrew.net",
    "bodis.com",
    "above.com",
    "dan.com",
    "afternic.com",
    "hugedomains.com",
    "parklogic.com",
    "domainmarket.com",
    "sav.com",
)
# Statements about the domain itself, never "domaine à vendre" alone (a villa agency sells estates).
_FOR_SALE = re.compile(
    r"\b(this domain(?: name)? (?:is|may be) for sale|buy this domain|"
    r"this domain has been (?:registered|parked)|"
    r"(?:ce|le) (?:nom de )?domaine(?: \S+)? est à vendre|nom de domaine à vendre|"
    r"deze domeinnaam is te koop|dit domein is te koop)\b",
    re.IGNORECASE,
)
# A parking page says little; a real site that mentions domains has more to say.
_PARKED_MAX_WORDS = 150


def _parking_host(ref: str) -> bool:
    host = host_of(ref if "//" in ref else f"//{ref}")
    return any(host == h or host.endswith(f".{h}") for h in _PARKING_HOSTS)


def is_parked(home: Page) -> bool:
    if home.word_count >= _PARKED_MAX_WORDS:
        return False
    if any(_parking_host(ref) for ref in [*home.script_sources(), *(link.url for link in home.links)]):
        return True
    return bool(_FOR_SALE.search(f"{home.title or ''} {home.text[:5000]}"))


def is_social_only(url: str) -> bool:
    return network_of(url) is not None
