"""How recently the site was looked after: copyright year, Last-Modified, sitemap lastmod, latest dated
content.
"""

import re
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from app.services.site_intel.page import Page

_COPYRIGHT = re.compile(r"(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-\u2013]\s*)?(\d{4})", re.IGNORECASE)
_ISO_DATE = re.compile(r"\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b")
_EU_DATE = re.compile(r"\b(0[1-9]|[12]\d|3[01])[/.](0[1-9]|1[0-2])[/.](20\d{2})\b")


def _valid(year: int, month: int, day: int, today: date) -> date | None:
    try:
        value = date(year, month, day)
    except ValueError:
        return None
    return value if value <= today else None


def latest_dated_content(pages: list[Page], today: date) -> date | None:
    dates: list[date] = []
    for page in pages:
        for y, m, d in _ISO_DATE.findall(page.text):
            if value := _valid(int(y), int(m), int(d), today):
                dates.append(value)
        for d, m, y in _EU_DATE.findall(page.text):
            if value := _valid(int(y), int(m), int(d), today):
                dates.append(value)
    return max(dates) if dates else None


def extract_freshness(pages: list[Page], sitemap_lastmod: datetime | None, now: datetime) -> dict[str, Any]:
    years = [
        int(y) for page in pages for y in _COPYRIGHT.findall(page.text) if 1990 <= int(y) <= now.year + 1
    ]
    last_modified: datetime | None = None
    if pages and (header := pages[0].headers.get("last-modified")):
        try:
            last_modified = parsedate_to_datetime(header).astimezone(UTC)
        except (TypeError, ValueError):
            last_modified = None
    latest = latest_dated_content(pages, now.date())
    return {
        "copyrightYear": max(years) if years else None,
        "httpLastModified": last_modified.isoformat().replace("+00:00", "Z") if last_modified else None,
        "sitemapLastmod": sitemap_lastmod.isoformat().replace("+00:00", "Z") if sitemap_lastmod else None,
        "latestDatedContent": latest.isoformat() if latest else None,
    }
