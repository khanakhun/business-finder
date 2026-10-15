""" "Do not solicit us" statements (compliance, outreach-compliance.md §3): phrase lists come from
@bf/contracts.
"""

import re
import unicodedata
from typing import Any

from app.contracts.no_solicitation import NO_SOLICITATION_PHRASES
from app.services.site_intel.page import Page

_SNIPPET_WORDS = 30


def _fold(text: str) -> str:
    """Lowercase, apostrophes unified, whitespace collapsed (accents kept: they are part of the phrases)."""
    text = unicodedata.normalize("NFC", text).replace("\u2019", "'").lower()
    return " ".join(text.split())


def detect_no_solicitation(pages: list[Page]) -> dict[str, Any]:
    phrases = [(p, _fold(p)) for items in NO_SOLICITATION_PHRASES.values() for p in items]
    matched: list[str] = []
    first: tuple[Page, int, int] | None = None
    for page in pages:
        text = _fold(page.text)
        for phrase, folded in phrases:
            index = text.find(folded)
            if index >= 0 and phrase not in matched:
                matched.append(phrase)
                if first is None:
                    first = (page, index, index + len(folded))
    if first is None:
        return {"checked": bool(pages), "detected": False, "phrases": [], "pageUrl": None, "snippet": None}
    page, start, end = first
    text = _fold(page.text)
    before = text[:start].split()[-10:]
    words = [*before, *text[start:end].split()]
    after = text[end:].split()[: max(0, _SNIPPET_WORDS - len(words))]
    snippet = re.sub(r"\s+", " ", " ".join([*words, *after]))[:400]
    return {
        "checked": True,
        "detected": True,
        "phrases": sorted(matched)[:20],
        "pageUrl": page.url,
        "snippet": snippet,
    }
