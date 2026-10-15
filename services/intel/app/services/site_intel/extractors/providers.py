"""Third-party tools a site uses: booking, ordering, chat, analytics. Matched on hosts of scripts, iframes and
links (never on page text, which anyone can write).
"""

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from bs4 import Tag

from app.services.site_intel.page import Page


@dataclass(frozen=True, slots=True)
class Provider:
    name: str
    hosts: tuple[str, ...]


BOOKING = (
    Provider("Planity", ("planity.com",)),
    Provider("Fresha", ("fresha.com",)),
    Provider("Treatwell", ("treatwell.fr", "treatwell.co.uk", "treatwell.com", "treatwell.nl")),
    Provider("Booksy", ("booksy.com",)),
    Provider("Calendly", ("calendly.com",)),
    Provider("SimplyBook", ("simplybook.me", "simplybook.it")),
    Provider("Square Appointments", ("squareup.com/appointments", "book.squareup.com")),
    Provider("Mindbody", ("mindbodyonline.com", "mindbody.io")),
    Provider("Zenchef", ("zenchef.com", "bookings.zenchef.com")),
    Provider("TheFork", ("thefork.com", "thefork.fr", "lafourchette.com")),
    Provider("OpenTable", ("opentable.com",)),
    Provider("SevenRooms", ("sevenrooms.com",)),
    Provider("Resy", ("resy.com",)),
    Provider("Lodgify", ("lodgify.com",)),
    Provider("Guesty", ("guesty.com", "guestybookings.com")),
    Provider("Hostaway", ("hostaway.com", "holidayfuture.com")),
    Provider("Airbnb", ("airbnb.com", "airbnb.fr")),
    Provider("Booking.com", ("booking.com",)),
)
ORDERING = (
    Provider("Uber Eats", ("ubereats.com",)),
    Provider("Deliveroo", ("deliveroo.fr", "deliveroo.co.uk", "deliveroo.com")),
    Provider("Just Eat", ("just-eat.fr", "just-eat.co.uk", "justeat.com", "thuisbezorgd.nl")),
    Provider("DoorDash", ("doordash.com",)),
    Provider("Toast", ("toasttab.com",)),
    Provider("ChowNow", ("chownow.com",)),
    Provider("Square Online", ("square.site",)),
)
CHAT = (
    Provider("Tawk.to", ("tawk.to",)),
    Provider("Intercom", ("intercom.io", "intercomcdn.com")),
    Provider("Crisp", ("crisp.chat",)),
    Provider("Tidio", ("tidio.co", "tidiochat.com")),
    Provider("Zendesk Chat", ("zopim.com", "zdassets.com")),
    Provider("LiveChat", ("livechatinc.com",)),
    Provider("HubSpot Chat", ("js.usemessages.com",)),
    Provider("WhatsApp widget", ("getbutton.io", "elfsight.com/whatsapp", "wa.me/message")),
)
_OTHER_ANALYTICS = (
    ("Matomo", ("matomo.js", "piwik.js", "matomo.cloud")),
    ("Plausible", ("plausible.io",)),
    ("Hotjar", ("hotjar.com",)),
    ("Microsoft Clarity", ("clarity.ms",)),
    ("LinkedIn Insight", ("snap.licdn.com",)),
    ("Pinterest Tag", ("s.pinimg.com/ct",)),
    ("Snap Pixel", ("sc-static.net",)),
)


_GA4_ID = re.compile(r"\bG-[A-Z0-9]{6,12}\b")
_BOOKING_WORDS = re.compile(r"r[ée]serv|book|rendez|appointment|disponibilit|availability", re.IGNORECASE)
_DATE_FIELDS = re.compile(
    r"date|arriv|check.?in|depart|nights|nuits|guests|personnes|couverts", re.IGNORECASE
)


def booking_forms(pages: list[Page]) -> list[dict[str, Any]]:
    """The site's own booking form: date-like fields, and booking words on the form or its page kind."""
    for page in pages:
        for form in page.soup.find_all("form"):
            if not isinstance(form, Tag):
                continue
            fields = [
                " ".join(str(i.get(a) or "") for a in ("type", "name", "id", "placeholder"))
                for i in form.find_all(["input", "select"])
                if isinstance(i, Tag)
            ]
            dated = any(_DATE_FIELDS.search(f) for f in fields)
            worded = page.kind == "booking" or bool(_BOOKING_WORDS.search(form.get_text(" ")[:2000]))
            if dated and worded:
                parts = urlsplit(page.url)
                return [{"name": "Booking form", "evidence": f"{parts.hostname or ''}{parts.path}"[:300]}]
    return []


def _references(pages: list[Page]) -> list[str]:
    refs: list[str] = []
    for page in pages:
        refs.extend(page.script_sources())
        refs.extend(str(f.get("src")) for f in page.soup.find_all("iframe", src=True) if isinstance(f, Tag))
        refs.extend(link.url for link in page.links)
    return refs


def _matches(ref: str, needle: str) -> bool:
    host = (urlsplit(ref if "//" in ref else f"//{ref}").hostname or "").lower()
    if "/" in needle:
        return needle in ref.lower()
    return host == needle or host.endswith(f".{needle}")


def detect(pages: list[Page], catalog: tuple[Provider, ...]) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for ref in _references(pages):
        for provider in catalog:
            if provider.name not in found and any(_matches(ref, needle) for needle in provider.hosts):
                parts = urlsplit(ref)
                found[provider.name] = {
                    "name": provider.name,
                    "evidence": f"{parts.hostname or ''}{parts.path}"[:300],
                }
    return sorted(found.values(), key=lambda p: p["name"])


def detect_analytics(pages: list[Page]) -> dict[str, Any]:
    raw = " ".join([*_references(pages), *(script for page in pages for script in page.inline_scripts())])
    both = raw.lower()
    others = sorted(name for name, needles in _OTHER_ANALYTICS if any(n in both for n in needles))
    return {
        # Measurement IDs are upper case: `g-` in lower-cased text would match any hyphenated word.
        "ga4": bool(_GA4_ID.search(raw)) and "gtag" in both,
        "gtm": "googletagmanager.com/gtm.js" in both
        or bool(re.search(r"\bGTM-[A-Z0-9]{4,}\b", both.upper())),
        "metaPixel": "connect.facebook.net" in both and "fbq(" in both,
        "tiktokPixel": "analytics.tiktok.com" in both or "ttq.load" in both,
        "others": others,
    }
