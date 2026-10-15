"""Which pages of a site matter: contact, about, services, menu, booking — by link text and URL (FR/EN)."""

import re
import unicodedata
from urllib.parse import unquote, urlsplit

from app.services.site_intel.page import Link
from app.services.site_intel.urls import path_key, same_site

# Order = priority when the page budget is short.
_KINDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "contact",
        ("contact", "nous contacter", "contactez", "nous joindre", "acces", "plan d acces", "find us"),
    ),
    # Where French and Dutch sites put "pas de démarchage" / "geen acquisitie": always worth one page.
    (
        "legal",
        (
            "mentions legales",
            "legal",
            "legal notice",
            "impressum",
            "cgv",
            "conditions generales",
            "colofon",
            "disclaimer",
            "algemene voorwaarden",
        ),
    ),
    ("booking", ("reservation", "reserver", "booking", "book", "rendez vous", "rdv", "prendre rendez")),
    ("services", ("services", "prestations", "nos soins", "soins", "tarifs", "prices", "pricing", "offres")),
    ("menu", ("menu", "carte", "notre carte", "la carte", "food", "drinks")),
    ("about", ("about", "a propos", "qui sommes nous", "notre histoire", "our story", "equipe", "team")),
)
_SKIP = re.compile(
    r"\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$|/(wp-admin|wp-login|cart|panier|checkout)(/|$)",
    re.I,
)


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", unquote(text)).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def classify(url: str, text: str) -> str:
    path = _fold(urlsplit(url).path)
    label = _fold(text)
    for kind, words in _KINDS:
        for word in words:
            if re.search(rf"\b{word}\b", label) or re.search(rf"\b{word}\b", path):
                return kind
    return "other"


def key_pages(home_url: str, links: list[Link], budget: int) -> list[tuple[str, str]]:
    """Up to `budget` same-site pages worth reading, as (url, kind), most important first."""
    seen = {path_key(home_url)}
    ranked: list[tuple[int, int, str, str]] = []
    order = {kind: index for index, (kind, _) in enumerate(_KINDS)}
    for position, link in enumerate(links):
        if not same_site(link.url, home_url) or _SKIP.search(urlsplit(link.url).path):
            continue
        key = path_key(link.url)
        if key in seen:
            continue
        seen.add(key)
        kind = classify(link.url, link.text)
        if kind != "other":
            ranked.append((order[kind], position, link.url, kind))
    ranked.sort()
    # The first page of each kind before a second of any: a short budget still reaches the legal notice.
    firsts: dict[str, tuple[int, int, str, str]] = {}
    for entry in ranked:
        firsts.setdefault(entry[3], entry)
    chosen = [*firsts.values(), *(entry for entry in ranked if entry not in firsts.values())]
    return [(url, kind) for _, _, url, kind in chosen[: max(0, budget)]]
