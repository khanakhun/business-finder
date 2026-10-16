"""Contact points a site publishes: e-mails (incl. common obfuscations), phones, WhatsApp links, contact
forms.
"""

import re
from typing import Any
from urllib.parse import unquote, urlsplit

import phonenumbers
from bs4 import Tag

from app.services.site_intel.page import Page
from app.services.site_intel.urls import absolute, registrable_suffix

_EMAIL = re.compile(r"(?<![\w.+-])([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24})(?![\w-])")
# Bracketed tokens — `name [at] domain [dot] com`, `name (at) domain.co (dot) uk`, `name{at}domain{dot}com`
# — or the plain-word form with both tokens as words: `name at domain dot com`. Never `point` as a plain word,
# and the result must end in a real public suffix: prose ("great food dot com", "point de vente") yields
# nothing.


def _bracketed(token: str) -> str:
    """`[at]`, `(at)` or `{at}` — the same bracket on both sides."""
    return rf"(?:\[\s*{token}\s*\]|\(\s*{token}\s*\)|\{{\s*{token}\s*\}})"


_AT, _DOT_TOKEN = _bracketed("(?:at|arobase)"), _bracketed("(?:dot|point)")
_BRACKETED = re.compile(
    rf"(?<![\w.+-])([A-Za-z0-9._%+-]{{1,64}})\s*{_AT}\s*"
    rf"([A-Za-z0-9-]{{1,63}}(?:\.[A-Za-z0-9-]{{1,63}})*(?:\s*{_DOT_TOKEN}\s*[A-Za-z0-9-]{{1,63}}){{1,4}})",
    re.IGNORECASE,
)
_PLAIN = re.compile(
    r"(?<![\w.+-])([A-Za-z0-9._%+-]{2,64}) at ([A-Za-z0-9-]{2,63}(?: dot [A-Za-z0-9-]{2,63}){1,3})\b",
    re.IGNORECASE,
)
_DOT = re.compile(rf"\s*(?:{_DOT_TOKEN}| dot )\s*", re.IGNORECASE)
_ASSET_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js")
_WHATSAPP_HOSTS = ("wa.me", "api.whatsapp.com", "web.whatsapp.com", "chat.whatsapp.com")
_MAX_EMAILS = 50
_MAX_PHONES = 30


def decode_cfemail(encoded: str) -> str | None:
    """Cloudflare's e-mail obfuscation: first byte is the XOR key for the rest (hex)."""
    try:
        data = bytes.fromhex(encoded)
    except ValueError:
        return None
    if len(data) < 2:
        return None
    key = data[0]
    decoded = bytes(b ^ key for b in data[1:]).decode("utf-8", "replace")
    return decoded if _EMAIL.fullmatch(decoded) else None


def _plausible(email: str) -> bool:
    lower = email.lower()
    return not lower.endswith(_ASSET_SUFFIXES) and "example@" not in lower and not lower.startswith("u00")


def extract_emails(pages: list[Page], jsonld_emails: list[tuple[str, Page]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}

    def add(email: str, source: str, page: Page) -> None:
        email = email.strip().strip(".").lower()
        if not _EMAIL.fullmatch(email) or not _plausible(email) or email in seen or len(seen) >= _MAX_EMAILS:
            return
        seen[email] = {
            "email": email,
            "source": source,
            "pageUrl": page.url,
            "onContactPage": page.kind == "contact",
        }

    for page in pages:
        for anchor in page.soup.find_all("a", href=True):
            href = str(anchor.get("href", "")) if isinstance(anchor, Tag) else ""
            if href.lower().startswith("mailto:"):
                add(unquote(href[7:].split("?", 1)[0]).split(",")[0], "mailto", page)
        for node in page.soup.select("[data-cfemail]"):
            if isinstance(node, Tag) and (email := decode_cfemail(str(node.get("data-cfemail")))):
                add(email, "cfemail", page)
        for match in _EMAIL.finditer(page.text):
            add(match.group(1), "text", page)
        for pattern in (_BRACKETED, _PLAIN):
            for match in pattern.finditer(page.text):
                email = f"{match.group(1)}@{_DOT.sub('.', match.group(2))}"
                if registrable_suffix(email.rsplit("@", 1)[1]):
                    add(email, "obfuscated", page)
    for email, source_page in jsonld_emails:
        add(email, "jsonld", source_page)
    return sorted(seen.values(), key=lambda e: (not e["onContactPage"], e["email"]))


def whatsapp_links(pages: list[Page]) -> list[str]:
    links = {
        link.url
        for page in pages
        for link in page.links
        if (urlsplit(link.url).hostname or "") in _WHATSAPP_HOSTS
    }
    return sorted(links)[:20]


def _whatsapp_numbers(links: list[str]) -> set[str]:
    numbers: set[str] = set()
    for link in links:
        parts = urlsplit(link)
        candidate = parts.path.strip("/") if parts.hostname == "wa.me" else ""
        if not candidate:
            candidate = dict(p.split("=", 1) for p in parts.query.split("&") if "=" in p).get("phone", "")
        digits = re.sub(r"\D", "", unquote(candidate))
        if digits:
            numbers.add(f"+{digits}")
    return numbers


def extract_phones(
    pages: list[Page], regions: list[str], whatsapp: list[str], extra: list[tuple[str, Page]]
) -> list[dict[str, Any]]:
    """Valid numbers only (libphonenumber), as E.164. National formats are read in each candidate region in
    turn (the business's country first): `0590 27 12 34` is only valid as a Saint-Barthélemy number."""
    regions = [*dict.fromkeys(r for r in regions if r in phonenumbers.SUPPORTED_REGIONS)] or ["FR"]
    wa_numbers = _whatsapp_numbers(whatsapp)
    found: dict[str, dict[str, Any]] = {}

    def parse(raw: str) -> str | None:
        for region in regions:
            try:
                number = phonenumbers.parse(raw, region)
            except phonenumbers.NumberParseException:
                continue
            if phonenumbers.is_valid_number(number):
                return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)
            if raw.strip().startswith("+"):
                return None  # international format: the region does not matter
        return None

    def add(raw: str, page: Page, *, whatsapp_only: bool = False) -> None:
        e164 = parse(raw)
        if e164 is None or e164 in found or len(found) >= _MAX_PHONES:
            return
        found[e164] = {
            "e164": e164,
            "raw": " ".join(raw.split())[:60],
            "pageUrl": page.url[:2000],
            "isWhatsApp": whatsapp_only or e164 in wa_numbers,
        }

    for page in pages:
        for anchor in page.soup.find_all("a", href=True):
            href = str(anchor.get("href", "")) if isinstance(anchor, Tag) else ""
            if href.lower().startswith("tel:"):
                add(unquote(href[4:]), page)
        for region in regions:
            matcher = phonenumbers.PhoneNumberMatcher(page.text, region, leniency=phonenumbers.Leniency.VALID)
            for match in matcher:
                add(match.raw_string, page)
    for raw, source_page in extra:
        add(raw, source_page)
    if pages:
        for number in sorted(wa_numbers):
            add(number, pages[0], whatsapp_only=True)
    return sorted(found.values(), key=lambda p: p["e164"])


def contact_forms(pages: list[Page]) -> list[dict[str, Any]]:
    forms: list[dict[str, Any]] = []
    for page in pages:
        for form in page.soup.find_all("form"):
            if not isinstance(form, Tag):
                continue
            fields = {
                str(i.get("name") or i.get("type") or "").lower()
                for i in form.find_all(["input", "textarea"])
                if isinstance(i, Tag)
            }
            has_message = bool(form.find("textarea")) or any("message" in f for f in fields)
            if has_message and (any("mail" in f for f in fields) or "email" in fields):
                action = form.get("action")
                forms.append(
                    {"pageUrl": page.url, "action": absolute(str(action), page.url) if action else None}
                )
    return forms[:20]
