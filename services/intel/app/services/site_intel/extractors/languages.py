"""Languages a site declares (html lang, hreflang) and uses (a small, deterministic stop-word vote)."""

import re
from collections import Counter
from typing import Any

from bs4 import Tag

from app.services.site_intel.page import Page
from app.services.site_intel.urls import absolute

_STOPWORDS = {
    "fr": {
        "le",
        "la",
        "les",
        "des",
        "et",
        "est",
        "une",
        "pour",
        "dans",
        "avec",
        "vous",
        "nous",
        "sur",
        "du",
        "au",
    },
    "en": {"the", "and", "is", "are", "for", "with", "you", "our", "your", "to", "of", "in", "on", "we", "a"},
    "nl": {"de", "het", "een", "en", "van", "voor", "met", "wij", "uw", "is", "op", "naar", "niet", "wordt"},
    "es": {"el", "la", "los", "las", "y", "para", "con", "usted", "nuestro", "en", "es", "una", "del", "por"},
    "de": {
        "der",
        "die",
        "das",
        "und",
        "ist",
        "für",
        "mit",
        "sie",
        "wir",
        "ein",
        "eine",
        "zu",
        "auf",
        "nicht",
    },
}
_WORD = re.compile(r"[a-zà-ÿ]+", re.IGNORECASE)
_MIN_HITS = 5
_SWITCHER = re.compile(r"(lang|language|langue|switcher)", re.IGNORECASE)


def detect_languages(pages: list[Page]) -> list[str]:
    detected: Counter[str] = Counter()
    for page in pages:
        words = [w.lower() for w in _WORD.findall(page.text)]
        scores = {lang: sum(1 for w in words if w in stop) for lang, stop in _STOPWORDS.items()}
        best = max(scores, key=lambda lang: scores[lang])
        if scores[best] >= _MIN_HITS:
            detected[best] += 1
    return [lang for lang, _ in sorted(detected.items(), key=lambda item: (-item[1], item[0]))][:5]


def extract_languages(pages: list[Page]) -> dict[str, Any]:
    declared = sorted({p.lang.lower() for p in pages if p.lang})[:10]
    hreflang: dict[str, str] = {}
    switcher = False
    for page in pages:
        for link in page.soup.find_all("link", hreflang=True):
            if isinstance(link, Tag) and (url := absolute(str(link.get("href", "")), page.url)):
                hreflang.setdefault(str(link.get("hreflang"))[:35].lower(), url)
        for node in page.soup.find_all(class_=_SWITCHER):
            if isinstance(node, Tag) and len(node.find_all("a")) >= 2:
                switcher = True
        if (
            len(
                {str(a.get("hreflang")) for a in page.soup.find_all("a", hreflang=True) if isinstance(a, Tag)}
            )
            >= 2
        ):
            switcher = True
    return {
        "declared": declared,
        "detected": detect_languages(pages),
        "hreflang": [{"lang": lang, "url": url} for lang, url in sorted(hreflang.items())][:30],
        "hasLanguageSwitcher": switcher,
    }
