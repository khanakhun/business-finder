"""Technology fingerprints from the vendored webappanalyzer database (GPL-3.0 data, app/vendor).

Patterns are matched against what the crawl observed: response headers, cookie names, meta tags, script URLs,
the HTML, page URLs, JavaScript globals and CSS selectors (both evaluated in the page from the database's own
lists, never from page content). Patterns are JavaScript regular expressions; the few Python cannot compile
are skipped.
"""

import json
import time
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import regex

VENDOR = Path(__file__).resolve().parents[3] / "vendor" / "webappanalyzer"
# Bounded work on untrusted input (as Wappalyzer does): at most 3000 lines of 2000 columns of HTML, each regex
# search given a short time limit and the whole identification a budget; a pattern that runs out simply does
# not match.
_HTML_LINES = 3_000
_HTML_COLUMNS = 2_000
_SEARCH_TIMEOUT_SECONDS = 0.02
_BUDGET_SECONDS = 3.0
_DEFAULT_CONFIDENCE = 100


@dataclass(frozen=True, slots=True)
class Pattern:
    regex: regex.Pattern[str]
    version: str
    confidence: int


@dataclass(slots=True)
class Technology:
    name: str
    categories: list[str]
    headers: dict[str, list[Pattern]] = field(default_factory=dict)
    cookies: dict[str, list[Pattern]] = field(default_factory=dict)
    meta: dict[str, list[Pattern]] = field(default_factory=dict)
    js: dict[str, list[Pattern]] = field(default_factory=dict)
    script_src: list[Pattern] = field(default_factory=list)
    html: list[Pattern] = field(default_factory=list)
    url: list[Pattern] = field(default_factory=list)
    dom: list[str] = field(default_factory=list)
    implies: list[str] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)
    excludes: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class Observations:
    """What the crawler saw, lowercased where the database expects it."""

    headers: dict[str, str]
    cookies: dict[str, str]
    meta: dict[str, list[str]]
    script_src: list[str]
    html: str
    urls: list[str]
    js: dict[str, str]
    dom: set[str]


def _parse(value: str) -> Pattern | None:
    parts = value.split("\\;")
    try:
        compiled = regex.compile(parts[0], regex.IGNORECASE)
    except (regex.error, ValueError, OverflowError):
        return None
    version, confidence = "", _DEFAULT_CONFIDENCE
    for part in parts[1:]:
        key, _, rest = part.partition(":")
        if key == "version":
            version = rest
        elif key == "confidence" and rest.isdigit():
            confidence = int(rest)
    return Pattern(compiled, version, confidence)


def _patterns(value: object) -> list[Pattern]:
    items = value if isinstance(value, list) else [value]
    return [p for p in (_parse(str(item)) for item in items if isinstance(item, (str, int, float))) if p]


def _keyed(value: object) -> dict[str, list[Pattern]]:
    if not isinstance(value, dict):
        return {}
    return {str(k).lower(): _patterns(v) for k, v in value.items()}


def _list(value: object) -> list[str]:
    items = value if isinstance(value, list) else [value] if value else []
    return [str(i).split("\\;")[0] for i in items]


@cache
def load_database(directory: Path = VENDOR) -> tuple[Technology, ...]:
    categories = {
        str(k): str(v["name"]) for k, v in json.loads((directory / "categories.json").read_text()).items()
    }
    technologies: list[Technology] = []
    for path in sorted((directory / "technologies").glob("*.json")):
        for name, spec in json.loads(path.read_text(encoding="utf-8")).items():
            dom = spec.get("dom")
            technologies.append(
                Technology(
                    name=name,
                    categories=[categories.get(str(c), str(c)) for c in spec.get("cats", [])][:10],
                    headers=_keyed(spec.get("headers")),
                    cookies=_keyed(spec.get("cookies")),
                    meta=_keyed(spec.get("meta")),
                    js={str(k): _patterns(v) for k, v in (spec.get("js") or {}).items()},
                    script_src=_patterns(spec.get("scriptSrc", [])),
                    html=_patterns(spec.get("html", [])),
                    url=_patterns(spec.get("url", [])),
                    dom=_list(dom) if isinstance(dom, (list, str)) else list((dom or {}).keys()),
                    implies=_list(spec.get("implies")),
                    requires=_list(spec.get("requires")),
                    excludes=_list(spec.get("excludes")),
                )
            )
    return tuple(technologies)


def js_paths(database: tuple[Technology, ...]) -> list[str]:
    """Every JavaScript global the database knows (evaluated in the page with this fixed list)."""
    return sorted({path for tech in database for path in tech.js})


def dom_selectors(database: tuple[Technology, ...]) -> list[str]:
    return sorted({selector for tech in database for selector in tech.dom})


def _version(pattern: Pattern, match: regex.Match[str]) -> str | None:
    if not pattern.version:
        return None
    version = pattern.version
    for index, group in enumerate(match.groups(), start=1):
        version = version.replace(f"\\{index}", group or "")
    version = regex.sub(r"\\\d", "", version).strip()
    if "?" in version:  # ternary `\1?a:b` — keep the simple cases only
        return None
    return version[:50] or None


class _Budget:
    def __init__(self, seconds: float) -> None:
        self.deadline = time.monotonic() + seconds

    @property
    def spent(self) -> bool:
        return time.monotonic() >= self.deadline


def _check(
    patterns: list[Pattern], values: list[str], budget: _Budget, *, presence: bool = False
) -> tuple[int, str | None] | None:
    """The first pattern matching a value. `presence`: the thing exists (a cookie, a JS global) — that alone
    counts only when the database gives no value pattern or the page value cannot be compared (not a string).
    """
    for pattern in patterns:
        for value in values:
            if budget.spent:
                return None
            try:
                match = pattern.regex.search(value, timeout=_SEARCH_TIMEOUT_SECONDS)
            except TimeoutError:
                continue
            if match:
                return pattern.confidence, _version(pattern, match)
    if presence and (not patterns or all(p.regex.pattern == "" for p in patterns) or values == [""]):
        return _DEFAULT_CONFIDENCE, None
    return None


def capped_html(html: str) -> str:
    return "\n".join(line[:_HTML_COLUMNS] for line in html.splitlines()[:_HTML_LINES])


def _checks(
    tech: Technology, observations: Observations, html: str, budget: _Budget
) -> list[tuple[int, str | None] | None]:
    checks: list[tuple[int, str | None] | None] = []
    for name, patterns in tech.headers.items():
        if name in observations.headers:
            checks.append(_check(patterns, [observations.headers[name]], budget))
    for name, patterns in tech.cookies.items():
        if name in observations.cookies:
            checks.append(_check(patterns, [observations.cookies[name]], budget, presence=True))
    for name, patterns in tech.meta.items():
        if name in observations.meta:
            checks.append(_check(patterns, observations.meta[name], budget))
    for path, patterns in tech.js.items():
        if path in observations.js:
            checks.append(_check(patterns, [observations.js[path]], budget, presence=True))
    checks.append(_check(tech.script_src, observations.script_src, budget) if tech.script_src else None)
    checks.append(_check(tech.html, [html], budget) if tech.html else None)
    checks.append(_check(tech.url, observations.urls, budget) if tech.url else None)
    if any(selector in observations.dom for selector in tech.dom):
        checks.append((_DEFAULT_CONFIDENCE, None))
    return checks


def identify(
    observations: Observations, database: tuple[Technology, ...] | None = None
) -> list[dict[str, Any]]:
    database = database if database is not None else load_database()
    html = capped_html(observations.html)
    budget = _Budget(_BUDGET_SECONDS)
    found: dict[str, dict[str, Any]] = {}

    def hit(tech: Technology, confidence: int, version: str | None) -> None:
        entry = found.setdefault(
            tech.name, {"name": tech.name, "version": None, "categories": tech.categories, "confidence": 0}
        )
        entry["confidence"] = min(100, entry["confidence"] + confidence)
        if version and not entry["version"]:
            entry["version"] = version

    for tech in database:
        for result in _checks(tech, observations, html, budget):
            if result is not None:
                hit(tech, *result)

    by_name = {tech.name: tech for tech in database}
    # Implied technologies (WordPress → PHP), transitively.
    pending = list(found)
    while pending:
        implying = by_name.get(pending.pop())
        for implied in implying.implies if implying else []:
            if implied in by_name and implied not in found:
                found[implied] = {
                    "name": implied,
                    "version": None,
                    "categories": by_name[implied].categories,
                    "confidence": 50,
                }
                pending.append(implied)
    # Requirements and exclusions until nothing changes (removing one can invalidate another).
    changed = True
    while changed:
        changed = False
        for name in list(found):
            known = by_name.get(name)
            if known and (
                any(r not in found for r in known.requires) or any(e in found for e in known.excludes)
            ):
                del found[name]
                changed = True
    return sorted(found.values(), key=lambda t: (-t["confidence"], t["name"]))[:100]
