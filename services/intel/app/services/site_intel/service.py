"""SiteIntelService: crawl a business website politely and safely, and say what it shows (BF-026).

One request = robots.txt → home page (rendered, desktop) → up to `maxPages - 1` key pages → mobile render →
bounded link checks → sitemap → extractors → artifacts (screenshots, page markdown) in object storage. Every
byte comes through the SSRF guard (browser.py). Content is data: nothing from a page is ever executed by us or
read as an instruction (the browser runs the page's own scripts in its sandbox, as any visitor's would).

One deadline (`timeoutSeconds`) covers everything that talks to the site; it starts once a browser slot is
free, so time spent queueing behind other requests is not charged to this one.
"""

import asyncio
import hashlib
import io
import math
import ssl
import time
from collections import OrderedDict
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, NamedTuple
from urllib.parse import urlsplit

import phonenumbers
import structlog
from bs4 import Tag
from markdownify import markdownify
from PIL import Image
from playwright.async_api import BrowserContext, Response
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page as BrowserPage
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from app.contracts.site_intel import SiteIntel
from app.contracts.site_intel_request import SiteIntelRequest
from app.net.safe_fetch import FetchError, FetchPolicy, FetchResult, ResponseTooLargeError, SafeFetcher
from app.services.site_intel import robots
from app.services.site_intel.browser import BrowserPool, NetworkLog, failure_kind
from app.services.site_intel.discovery import key_pages
from app.services.site_intel.extractors import (
    contacts,
    freshness,
    images,
    jsonld,
    languages,
    parked,
    providers,
    socials,
)
from app.services.site_intel.extractors import no_solicitation as solicitation
from app.services.site_intel.extractors import tech as tech_db
from app.services.site_intel.page import MAX_HTML_CHARS, Page
from app.services.site_intel.storage import ArtifactStore, ArtifactStoreError
from app.services.site_intel.urls import MAX_URL, absolute, host_of, path_key, same_site, with_scheme

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.site_intel")

DESKTOP = (1440, 900)
MOBILE = (390, 844)
FULL_PAGE_MAX_HEIGHT = 6000
_WEBP_QUALITY = 80
_LINK_CHECKS = 10
_LINK_CHECK_BYTES = 64 * 1024
_PAGE_TIMEOUT_MS = 20_000
_LOAD_GRACE_MS = 5_000
_CACHE_SECONDS = 600
_CACHE_SIZE = 200
_WARNING_CHARS = 300
_MAX_WARNINGS = 50
_REGIONS = {"fr": "FR", "en": "US", "nl": "NL", "es": "ES", "de": "DE"}
_REGION_ALIASES = {"UK": "GB"}  # `.uk` and a common `addressCountry`; not an ISO 3166 code
#: Answers that may be different a minute later: never served from the cache.
_TRANSIENT = frozenset({"timeout", "server_error"})
_ROBOTS_BYTES = 512 * 1024
_SITEMAP_BYTES = 2 * 1024 * 1024
_BLOCKED_STATUSES = frozenset({401, 403, 429, 451})
_MIXED_SOURCES = (("img", "src"), ("script", "src"), ("iframe", "src"), ("source", "src"), ("embed", "src"))

_JS_GLOBALS = """(paths) => {
  const out = {};
  for (const path of paths) {
    try {
      let value = window;
      for (const part of path.split('.')) { if (value == null) { value = undefined; break; } value =
      value[part]; }
      if (value === undefined || value === null) continue;
      const t = typeof value;
      out[path] = (t === 'string' || t === 'number' || t === 'boolean') ? String(value).slice(0, 200) : '';
    } catch (e) { /* a throwing getter is simply absent */ }
  }
  return out;
}"""
_DOM_MATCHES = """(selectors) => selectors.filter((s) => { try { return document.querySelector(s) !== null; }
  catch (e) { return false; } })"""
_DOM_CONTENT_LOADED = """() => { const n = performance.getEntriesByType('navigation')[0];
  return n ? Math.round(n.domContentLoadedEventEnd - n.startTime) : null; }"""
_SMALL_TEXT = """() => { let small = 0, total = 0;
  for (const el of document.querySelectorAll('p, li, a, span, td, label')) {
    if (!el.textContent || !el.textContent.trim()) continue;
    total++; if (parseFloat(getComputedStyle(el).fontSize) < 12) small++;
    if (total >= 400) break;
  }
  return total ? small / total > 0.25 : null; }"""
_SCROLL_HEIGHT = "() => document.documentElement.scrollHeight"
# Through the reader the init script captured (browser.INIT_SCRIPT): bounded, and not the page's to patch.
_READ_HTML = "(limit) => window.__bfReadHtml(limit)"
_HIDDEN = '[hidden], [aria-hidden="true"]'


class Analysis(NamedTuple):
    intel: SiteIntel
    #: Served from the 10-minute cache (no new crawl happened).
    cached: bool


@dataclass(slots=True)
class Crawl:
    """Everything gathered for one request before extraction."""

    pages: list[Page] = field(default_factory=list)
    final_url: str | None = None
    status: int | None = None
    reachability: str = "ok"
    social_only: bool = False
    certificate: dict[str, object] | None = None
    tls_error: bool = False
    rules: robots.SiteRules | None = None
    #: robots.txt of other origins of the same site (`shop.x.com` next to `www.x.com`), read when needed.
    other_rules: dict[str, robots.SiteRules] = field(default_factory=dict)
    #: The deadline or a browser failure cut the crawl short: the answer is partial, so it is not cached.
    incomplete: bool = False
    js: dict[str, str] = field(default_factory=dict)
    dom: set[str] = field(default_factory=set)
    cookies: dict[str, str] = field(default_factory=dict)
    request_count: int | None = None
    page_bytes: int | None = None
    dom_content_loaded_ms: int | None = None
    mixed_content: bool = False
    font_size_issues: bool | None = None
    internal_links: int = 0
    broken_links: int = 0
    sitemap: datetime | None = None
    markdown_keys: list[str | None] = field(default_factory=list)
    screenshots: dict[str, str | None] = field(
        default_factory=lambda: {"desktopKey": None, "mobileKey": None, "fullPageKey": None}
    )
    warnings: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        if len(self.warnings) < _MAX_WARNINGS:
            self.warnings.append(message[:_WARNING_CHARS])


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _webp(png: bytes) -> bytes:
    buffer = io.BytesIO()
    with Image.open(io.BytesIO(png)) as image:
        image.save(buffer, "WEBP", quality=_WEBP_QUALITY)
    return buffer.getvalue()


def _regions(url: str, country: str | None, declared: list[str], locales: list[str]) -> list[str]:
    """Where national phone formats are read, most specific first: the caller's country, the countries the
    site declares (JSON-LD), its ccTLD, its languages; France last (the primary deployment)."""
    regions: list[str] = [country] if country else []
    regions.extend(declared)
    tld = host_of(url).rsplit(".", 1)[-1]
    if len(tld) == 2 and tld.isalpha():
        regions.append(tld.upper())
    regions.extend(_REGIONS[h] for h in locales if h in _REGIONS)
    known = (_REGION_ALIASES.get(r, r) for r in [*regions, "FR"])
    return [*dict.fromkeys(r for r in known if r in phonenumbers.SUPPORTED_REGIONS)]


def _certificate_expiry(certificate: dict[str, object] | None) -> str | None:
    not_after = certificate.get("notAfter") if certificate else None
    if not isinstance(not_after, str):
        return None
    try:
        return _iso(datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), UTC))
    except (ValueError, OverflowError):
        return None


def _certificate_issuer(certificate: dict[str, object] | None) -> str | None:
    issuer = certificate.get("issuer") if certificate else None
    if not isinstance(issuer, tuple):
        return None
    names = {k: v for rdn in issuer for (k, v) in rdn}
    return (names.get("organizationName") or names.get("commonName") or "")[:300] or None


def _markdown(page: Page) -> str:
    """What a visitor reads, as markdown: no scripts, styles, templates or hidden elements (hidden text is
    where prompt injection likes to sit; whoever feeds this to a model still wraps it as untrusted data)."""
    document = Page(page.url, page.html).visible
    for node in document.select(_HIDDEN):
        node.decompose()
    body = document.body or document
    return str(markdownify(str(body), heading_style="ATX", strip=["svg", "img"])).strip()


def _number(value: object) -> float | None:
    """A number the page reported (it controls what `evaluate` returns): finite, or nothing."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _html(value: object) -> tuple[str, bool] | None:
    """The page's HTML as the reader returned it: (html, truncated), or None if it is not that shape."""
    if not (isinstance(value, list) and len(value) == 2 and isinstance(value[1], str)):
        return None
    length = _number(value[0])
    return value[1][:MAX_HTML_CHARS], length is None or length > MAX_HTML_CHARS


def _static_mixed_content(page: Page) -> bool:
    """HTTP subresources declared in an HTTPS page's HTML (the browser may have blocked them, unseen)."""
    if not page.url.startswith("https://"):
        return False
    for tag, attribute in (*_MIXED_SOURCES, ("link", "href")):
        for node in page.soup.find_all(tag, attrs={attribute: True}):
            if not isinstance(node, Tag):
                continue
            if tag == "link" and "stylesheet" not in " ".join(node.get("rel") or []).lower():
                continue
            if str(node.get(attribute)).strip().lower().startswith("http://"):
                return True
    return False


def _none() -> list[dict[str, Any]]:
    return []


def _section[T](name: str, crawl: Crawl, default: T, compute: Callable[[], T]) -> T:
    """One extractor's output; a failure (a page no rule anticipated) costs that section only."""
    try:
        return compute()
    except Exception as error:  # every extractor reads hostile input; the rest of the answer still stands
        # Type only: the message or traceback could quote page text.
        logger.error("site-intel extractor failed", extractor=name, error=type(error).__name__)  # noqa: TRY400
        crawl.warn(f"extractor: {name} could not be read from this site")
        return default


class SiteIntelService:
    def __init__(
        self,
        *,
        browsers: BrowserPool,
        fetcher: SafeFetcher,
        store: ArtifactStore,
        user_agent: str,
        fetch_policy: FetchPolicy,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._browsers = browsers
        self._fetcher = fetcher
        self._store = store
        self._user_agent = user_agent
        #: robots.txt groups are matched against our bot, whatever User-Agent a caller asks for.
        self._agent = robots.bot_token(user_agent)
        self._policy = fetch_policy
        self._clock = clock
        self._cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()

    async def analyse(self, request: SiteIntelRequest) -> Analysis:
        """Identical requests within 10 minutes share one crawl (the artifacts already exist)."""
        key = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        cached = self._cache.get(key)
        if cached and cached[0] > time.monotonic():
            self._cache.move_to_end(key)
            return Analysis(SiteIntel.model_validate(cached[1]), cached=True)
        bundle, complete = await self._analyse(request)
        if complete and bundle["reachability"] not in _TRANSIENT:
            self._cache[key] = (time.monotonic() + _CACHE_SECONDS, bundle)
            while len(self._cache) > _CACHE_SIZE:
                self._cache.popitem(last=False)
        logger.info(
            "site analysed",
            host=host_of(bundle["finalUrl"] or bundle["requestedUrl"]),
            reachability=bundle["reachability"],
            pages=len(bundle["pages"]),
            warnings=len(bundle["warnings"]),
            duration_ms=bundle["durationMs"],
        )
        return Analysis(SiteIntel.model_validate(bundle), cached=False)

    async def _analyse(self, request: SiteIntelRequest) -> tuple[dict[str, Any], bool]:
        """The answer, and whether it is complete (worth caching)."""
        started = time.monotonic()
        now = self._clock()
        url = with_scheme(request.url)
        crawl = Crawl()
        if parked.is_social_only(url):
            crawl.social_only = True
            crawl.warn("social_only: the website is a social profile; it was not crawled")
        elif absolute(url, url) is None:
            crawl.reachability = "blocked"
            crawl.warn("invalid_url: only http and https websites are analysed")
        else:
            async with self._browsers.slot():
                try:
                    async with asyncio.timeout(request.timeoutSeconds):
                        await self._run(request, url, now, crawl)
                except PlaywrightError as error:
                    # The browser failed (crashed, retired under us): keep what was read, never cache it.
                    logger.warning("browser failed during the analysis", error=type(error).__name__)
                    crawl.incomplete = True
                    crawl.warn("browser: the analysis stopped early (browser failure)")
                    if not crawl.pages:
                        crawl.reachability = "server_error"
                except TimeoutError:
                    crawl.incomplete = True
                    crawl.warn(f"timeout: the analysis stopped after {request.timeoutSeconds} s")
                    if not crawl.pages:
                        crawl.reachability = "timeout"
            if crawl.pages:
                crawl.markdown_keys = await self._put_markdown(request, crawl)
        bundle = await asyncio.to_thread(self._bundle, request=request, url=url, now=now, crawl=crawl)
        bundle["durationMs"] = int((time.monotonic() - started) * 1000)
        return bundle, not crawl.incomplete

    async def _run(self, request: SiteIntelRequest, url: str, now: datetime, crawl: Crawl) -> None:
        """Everything that talks to the site, in order of value: what is left when the deadline hits is the
        least useful part (link checks, sitemap)."""
        rules = await robots.load_rules(self._fetcher, url, self._agent, self._robots_policy)
        if not rules.allowed(url, url):
            crawl.reachability = "blocked"
            crawl.warn("robots: robots.txt disallows our crawler on this site")
            return
        crawl.rules = rules
        await self._crawl(request, url, crawl)
        if crawl.pages and crawl.rules is not None:
            home = crawl.final_url or url
            crawl.internal_links, crawl.broken_links = await self._check_links(crawl, crawl.rules, home)
            crawl.sitemap = await robots.sitemap_lastmod(
                self._fetcher, home, crawl.rules, now, replace(self._policy, max_bytes=_SITEMAP_BYTES)
            )

    @property
    def _robots_policy(self) -> FetchPolicy:
        return replace(self._policy, max_bytes=_ROBOTS_BYTES)

    async def _put_markdown(self, request: SiteIntelRequest, crawl: Crawl) -> list[str | None]:
        """Each page as markdown under the caller's prefix (not inline: too large for the response), stored
        concurrently. A page that cannot be converted (hostile nesting) costs its markdown only."""

        async def one(index: int, page: Page) -> str | None:
            key = f"{request.artifactPrefix}/pages/{index:02d}-{page.kind}.md"
            try:
                text = await asyncio.to_thread(_markdown, page)
            except Exception as error:  # hostile HTML (e.g. nesting deep enough to exhaust recursion)
                logger.warning("markdown conversion failed", error=type(error).__name__)
                crawl.warn(f"markdown: {urlsplit(page.url).path or '/'} could not be converted")
                return None
            return await self._put(crawl, key, text.encode("utf-8"), "text/markdown; charset=utf-8")

        return list(await asyncio.gather(*(one(i, p) for i, p in enumerate(crawl.pages))))

    async def _put(self, crawl: Crawl, key: str, data: bytes, content_type: str) -> str | None:
        try:
            await self._store.put(key, data, content_type)
        except ArtifactStoreError as error:
            logger.warning("artifact not stored", key=key, error=str(error))
            crawl.warn(f"storage: {key.rsplit('/', 1)[-1]} could not be stored")
            return None
        return key

    async def _crawl(self, request: SiteIntelRequest, url: str, crawl: Crawl) -> None:
        locale = request.localesHint[0].root if request.localesHint else "fr"
        user_agent = request.userAgent or self._user_agent
        async with self._browsers.context(
            user_agent=user_agent, locale=locale, viewport=DESKTOP, site=url
        ) as (context, log):
            home = await self._open(context, log, url, "home", crawl, first=True, request=request)
            if home is None:
                return
            log.site = home.url  # the site that answered: its own requests are same-site from here on
            if crawl.reachability in ("blocked", "not_found", "server_error"):
                return  # an error page: its "key pages" are the error page's links
            if parked.is_parked(home):
                crawl.reachability = "parked"
                return
            if not await self._follow_origin(home, crawl):
                return
            for target, kind in key_pages(home.url, home.links, request.maxPages - 1):
                rules = await self._rules_for(target, crawl)
                if not rules.allowed(target, home.url):
                    crawl.warn(f"robots: skipped {urlsplit(target).path}")
                    continue
                if rules.crawl_delay:
                    await asyncio.sleep(rules.crawl_delay)
                await self._open(context, log, target, kind, crawl, first=False, request=request)
            if log.over_budget:
                crawl.warn("budget: the site asked for too many resources; some were not loaded")
        if request.screenshots.mobile:
            await self._mobile(request, user_agent, locale, crawl, home.url)

    async def _rules_for(self, url: str, crawl: Crawl) -> robots.SiteRules:
        """The robots.txt that governs `url`: its own origin's (read once per origin)."""
        rules = crawl.rules or robots.SiteRules()
        origin = robots.origin_of(url)
        if origin == rules.origin:
            return rules
        if origin not in crawl.other_rules:
            crawl.other_rules[origin] = await robots.load_rules(
                self._fetcher, url, self._agent, self._robots_policy
            )
        return crawl.other_rules[origin]

    async def _follow_origin(self, home: Page, crawl: Crawl) -> bool:
        """The home page redirected to another origin (`http://x` → `https://www.x`): its own robots.txt
        governs from here on. False when that robots.txt does not allow us there."""
        if crawl.rules is None or robots.origin_of(home.url) == crawl.rules.origin:
            return True
        crawl.rules = await robots.load_rules(self._fetcher, home.url, self._agent, self._robots_policy)
        if crawl.rules.allowed(home.url, home.url):
            return True
        crawl.pages.clear()
        crawl.screenshots = {"desktopKey": None, "mobileKey": None, "fullPageKey": None}
        crawl.reachability = "blocked"
        crawl.warn("robots: robots.txt of the redirected site disallows our crawler")
        return False

    async def _goto(self, page: BrowserPage, url: str, crawl: Crawl) -> Response | None:
        """The document and its DOM first; then up to a few seconds for the rest (`load`) — a page whose
        last tracker never answers is still read."""
        response = await page.goto(url, wait_until="domcontentloaded", timeout=_PAGE_TIMEOUT_MS)
        try:
            await page.wait_for_load_state("load", timeout=_LOAD_GRACE_MS)
        except PlaywrightTimeoutError:
            crawl.warn(f"slow: {urlsplit(url).path or '/'} did not finish loading")
        return response

    async def _prefetch(
        self, url: str, crawl: Crawl, *, first: bool, revisit: bool = False
    ) -> FetchResult | None:
        """The document, redirects resolved here (each hop through the guard); Chromium then loads it."""
        try:
            document = await self._fetcher.fetch(url, policy=self._browsers.navigation_policy)
        except FetchError as error:
            if first:
                reason = failure_kind(error)
                crawl.tls_error = reason == "tls_error"
                known = ("blocked", "dns_error", "tls_error", "timeout")
                crawl.reachability = reason if reason in known else "server_error"
                crawl.warn(f"unreachable: the home page could not be read ({crawl.reachability})")
            return None
        if len(document.url) > MAX_URL:
            if first:
                crawl.reachability = "blocked"
                crawl.warn("unreachable: the home page redirected to an over-long URL")
            return None
        if not first and (document.status_code >= 400 or not same_site(document.url, crawl.final_url or url)):
            return None  # a missing key page, or one redirecting off-site, is not this business's page
        if not (first or revisit) and path_key(document.url) in {path_key(p.url) for p in crawl.pages}:
            return None  # redirects to a page already read (`/contact` → `/`): not read twice
        return document

    async def _open(
        self,
        context: BrowserContext,
        log: NetworkLog,
        url: str,
        kind: str,
        crawl: Crawl,
        *,
        first: bool,
        request: SiteIntelRequest,
    ) -> Page | None:
        document = await self._prefetch(url, crawl, first=first)
        if document is None:
            return None
        log.prefetched[document.url] = document
        try:
            page = await context.new_page()
        except PlaywrightError:
            crawl.warn(f"browser: {urlsplit(url).path or '/'} could not be opened")
            return None
        try:
            try:
                response = await self._goto(page, document.url, crawl)
            except PlaywrightError:
                response = None
            if response is None:
                if first:
                    crawl.reachability = self._failure(log, url)
                    crawl.warn(f"unreachable: the home page could not be read ({crawl.reachability})")
                else:
                    crawl.warn(f"unreachable: {urlsplit(url).path or '/'} could not be loaded")
                return None
            final_url = page.url
            if len(final_url) > MAX_URL or (not first and not same_site(final_url, crawl.final_url or url)):
                return None  # a key page that script-redirected off-site: not this business's page
            served = log.documents.get(final_url) or log.documents.get(response.url) or document
            if first:
                self._record_home(crawl, url, final_url, response.status, served)
            headers = {k.lower(): v for k, v in served.headers.items()}
            parsed = await self._read(
                page, final_url, crawl, kind=kind, status=response.status, headers=headers
            )
            if parsed is None:
                return None
            crawl.pages.append(parsed)
            if first:
                await self._observe(page, log, crawl)
                await self._desktop_screenshots(page, request, crawl)  # the page as loaded: no second visit
            return parsed
        finally:
            with suppress(PlaywrightError):
                await page.close()

    async def _read(
        self, page: BrowserPage, url: str, crawl: Crawl, *, kind: str, status: int, headers: dict[str, str]
    ) -> Page | None:
        """The rendered page, parsed (in a worker thread)."""
        try:
            read = _html(await page.evaluate(_READ_HTML, MAX_HTML_CHARS))
        except PlaywrightError:
            read = None
        if read is None:
            crawl.warn(f"unreadable: {urlsplit(url).path or '/'} could not be read")
            return None
        html, truncated = read
        if truncated:
            crawl.warn(f"large: {urlsplit(url).path or '/'} was read partially")
        return await asyncio.to_thread(Page, url, html, kind=kind, status=status, headers=headers)

    @staticmethod
    def _record_home(crawl: Crawl, url: str, final_url: str, status: int, served: FetchResult) -> None:
        crawl.final_url = final_url
        crawl.status = status
        crawl.certificate = dict(served.certificate) if served.certificate else None
        if status in _BLOCKED_STATUSES:
            crawl.reachability = "blocked"  # refused us (auth, bot wall, rate limit): not "missing"
        elif status >= 500:
            crawl.reachability = "server_error"
        elif status >= 400:
            crawl.reachability = "not_found"
        elif path_key(final_url) != path_key(url):
            crawl.reachability = "redirected"

    @staticmethod
    def _failure(log: NetworkLog, url: str) -> str:
        """Why the home page could not be read: a refused hop (SSRF guard) wins over what followed it."""
        if log.blocked:
            return "blocked"
        kinds = list(log.failures.values())
        kind = log.failures.get(url) or (kinds[-1] if kinds else "error")
        return {
            "blocked": "blocked",
            "dns_error": "dns_error",
            "tls_error": "tls_error",
            "timeout": "timeout",
        }.get(kind, "server_error")

    async def _observe(self, page: BrowserPage, log: NetworkLog, crawl: Crawl) -> None:
        database = await asyncio.to_thread(tech_db.load_database)  # parsed once per process, then cached
        try:
            # The page controls these results (its scripts can patch what they read): expected shapes only.
            js = await page.evaluate(_JS_GLOBALS, tech_db.js_paths(database))
            if isinstance(js, dict):
                crawl.js = {str(k)[:200]: v[:200] for k, v in list(js.items())[:2000] if isinstance(v, str)}
            dom = await page.evaluate(_DOM_MATCHES, tech_db.dom_selectors(database))
            if isinstance(dom, list):
                crawl.dom = {d for d in dom[:5000] if isinstance(d, str)}
            loaded = _number(await page.evaluate(_DOM_CONTENT_LOADED))
            crawl.dom_content_loaded_ms = (
                int(loaded) if loaded is not None and 0 <= loaded < 3_600_000 else None
            )
        except PlaywrightError:
            crawl.warn("scripts: the page could not be inspected")
        try:
            cookies = await page.context.cookies()
        except PlaywrightError:
            cookies = []
        crawl.cookies = {c["name"].lower()[:200]: c.get("value", "")[:200] for c in cookies[:200]}
        crawl.request_count = log.requests
        crawl.page_bytes = log.bytes
        crawl.mixed_content = log.http_on_https

    async def _desktop_screenshots(self, page: BrowserPage, request: SiteIntelRequest, crawl: Crawl) -> None:
        try:
            if request.screenshots.desktop:
                crawl.screenshots["desktopKey"] = await self._put_screenshot(
                    request, crawl, "desktop", await page.screenshot(type="png")
                )
            if request.screenshots.fullPage:
                reported = _number(await page.evaluate(_SCROLL_HEIGHT))
                height = int(min(max(reported or DESKTOP[1], 1), FULL_PAGE_MAX_HEIGHT))
                image = await page.screenshot(
                    type="png", full_page=True, clip={"x": 0, "y": 0, "width": DESKTOP[0], "height": height}
                )
                crawl.screenshots["fullPageKey"] = await self._put_screenshot(request, crawl, "full", image)
        except PlaywrightError:
            crawl.warn("screenshot: the desktop screenshot failed")

    async def _mobile(
        self, request: SiteIntelRequest, user_agent: str, locale: str, crawl: Crawl, url: str
    ) -> None:
        # DECISION(BF-026): prefetched with the crawler's own User-Agent (as every fetch): a site that sends
        # mobile browsers to an `m.` host is shown as its desktop page at phone width — the page we analysed.
        document = await self._prefetch(url, crawl, first=False, revisit=True)
        if document is None:
            crawl.warn("screenshot: the mobile page could not be loaded")
            return
        try:
            async with self._browsers.context(
                user_agent=user_agent, locale=locale, viewport=MOBILE, site=url, mobile=True
            ) as (context, log):
                log.prefetched[document.url] = document
                page = await context.new_page()
                await self._goto(page, document.url, crawl)
                issues = await page.evaluate(_SMALL_TEXT)
                crawl.font_size_issues = issues if isinstance(issues, bool) else None
                crawl.screenshots["mobileKey"] = await self._put_screenshot(
                    request, crawl, "mobile", await page.screenshot(type="png")
                )
                if log.over_budget:
                    crawl.warn("budget: the mobile page asked for too many resources; some were not loaded")
        except PlaywrightError:
            crawl.warn("screenshot: the mobile screenshot failed")

    async def _put_screenshot(
        self, request: SiteIntelRequest, crawl: Crawl, name: str, png: bytes
    ) -> str | None:
        key = f"{request.artifactPrefix}/screenshots/{name}.webp"
        try:
            image = await asyncio.to_thread(_webp, png)
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            logger.warning("screenshot conversion failed", error=type(error).__name__)
            crawl.warn(f"screenshot: {name} could not be converted")
            return None
        return await self._put(crawl, key, image, "image/webp")

    async def _check_links(self, crawl: Crawl, rules: robots.SiteRules, home: str) -> tuple[int, int]:
        """Internal links counted; a bounded sample of those not crawled (same origin, allowed by robots.txt)
        checked with HEAD — GET when HEAD is not supported. Broken = an error status, or a host that does not
        resolve or refuses the connection; a slow or refused (SSRF guard) answer proves nothing."""
        crawled = {path_key(p.url) for p in crawl.pages}
        internal: dict[str, str] = {}
        for page in crawl.pages:
            for link in page.links:
                if same_site(link.url, home):
                    internal.setdefault(path_key(link.url), link.url)
        sample = [
            u
            for k, u in sorted(internal.items())
            if k not in crawled and robots.origin_of(u) == rules.origin and rules.allowed(u, home)
        ][:_LINK_CHECKS]
        probe = replace(self._policy, max_bytes=_LINK_CHECK_BYTES)
        broken = 0
        for index, target in enumerate(sample):
            if index and rules.crawl_delay:
                await asyncio.sleep(rules.crawl_delay)
            try:
                result = await self._fetcher.fetch(target, method="HEAD", policy=self._policy)
                status = result.status_code
                if status in (405, 501):
                    status = (await self._fetcher.fetch(target, policy=probe)).status_code
            except ResponseTooLargeError as error:
                status = error.status_code or 200  # it answered; only its body was too long to read
            except FetchError as error:
                broken += failure_kind(error) in ("dns_error", "error")
                continue
            broken += status >= 400
        return len(internal), broken

    def _bundle(self, *, request: SiteIntelRequest, url: str, now: datetime, crawl: Crawl) -> dict[str, Any]:
        """The answer, from what was gathered (CPU only: runs in a worker thread)."""
        pages = crawl.pages
        home = pages[0] if pages else None
        markdown_keys = crawl.markdown_keys or [None] * len(pages)
        jsonld_items = _section(
            "jsonLd", crawl, list[jsonld.JsonLdItem](), lambda: jsonld.extract_jsonld(pages)
        )
        whatsapp = _section("whatsappLinks", crawl, list[str](), lambda: contacts.whatsapp_links(pages))
        same_as = [s for item in jsonld_items for s in item.data["sameAs"]]
        https = (crawl.final_url or url).startswith("https://")
        headers = home.headers if home else {}
        regions = _regions(
            crawl.final_url or url,
            request.countryHint,
            [item.country for item in jsonld_items if item.country],
            [hint.root for hint in request.localesHint],
        )

        def tech() -> list[dict[str, Any]]:
            if home is None:
                return []
            observations = tech_db.Observations(
                headers=headers,
                cookies=crawl.cookies,
                meta={
                    str(tag.get("name") or tag.get("property") or "").lower(): [str(tag.get("content") or "")]
                    for tag in home.soup.find_all("meta")
                    if isinstance(tag, Tag) and (tag.get("name") or tag.get("property"))
                },
                script_src=[src for p in pages for src in p.script_sources()],
                html=home.html,
                urls=[p.url for p in pages],
                js=crawl.js,
                dom=crawl.dom,
            )
            return tech_db.identify(observations)

        no_solicitation = {
            "checked": False,
            "detected": False,
            "phrases": [],
            "pageUrl": None,
            "snippet": None,
        }
        bundle: dict[str, Any] = {
            "requestedUrl": request.url.strip()[:MAX_URL],
            "finalUrl": crawl.final_url,
            "httpStatus": crawl.status,
            "fetchedAt": _iso(now),
            "reachability": crawl.reachability,
            "socialOnly": crawl.social_only,
            "tls": {
                # A TLS failure is a verdict even when the URL we were given was http (an upgrade redirect).
                "valid": False
                if crawl.tls_error
                else (True if crawl.certificate else None)
                if https
                else None,
                "expiresAt": _certificate_expiry(crawl.certificate),
                "issuer": _certificate_issuer(crawl.certificate),
            },
            "security": {
                "https": https,
                "hsts": "strict-transport-security" in headers,
                "mixedContent": crawl.mixed_content
                or _section("mixedContent", crawl, False, lambda: bool(home and _static_mixed_content(home))),
            },
            "pages": [
                {
                    "url": page.url,
                    "kind": page.kind,
                    "title": page.title,
                    "metaDescription": page.meta("description"),
                    "lang": page.lang,
                    "h1": page.h1,
                    "wordCount": page.word_count,
                    "markdownKey": markdown_keys[index],
                }
                for index, page in enumerate(pages)
            ],
            "languages": _section(
                "languages",
                crawl,
                {"declared": [], "detected": [], "hreflang": [], "hasLanguageSwitcher": False},
                lambda: languages.extract_languages(pages),
            ),
            "jsonLd": [item.data for item in jsonld_items],
            "contacts": {
                "emails": _section(
                    "emails",
                    crawl,
                    _none(),
                    lambda: contacts.extract_emails(
                        pages, [(i.data["email"], i.page) for i in jsonld_items if i.data["email"]]
                    ),
                ),
                "phones": _section(
                    "phones",
                    crawl,
                    _none(),
                    lambda: contacts.extract_phones(
                        pages,
                        regions,
                        whatsapp,
                        [(i.data["telephone"], i.page) for i in jsonld_items if i.data["telephone"]],
                    ),
                ),
                "whatsappLinks": whatsapp,
                "contactForms": _section(
                    "contactForms", crawl, _none(), lambda: contacts.contact_forms(pages)
                ),
            },
            "socials": _section("socials", crawl, _none(), lambda: socials.extract_socials(pages, same_as)),
            "booking": {
                "providers": _section(
                    "booking",
                    crawl,
                    _none(),
                    lambda: (providers.detect(pages, providers.BOOKING) + providers.booking_forms(pages))[
                        :20
                    ],
                )
            },
            "ordering": {
                "providers": _section(
                    "ordering", crawl, _none(), lambda: providers.detect(pages, providers.ORDERING)
                )
            },
            "chat": {
                "providers": _section("chat", crawl, _none(), lambda: providers.detect(pages, providers.CHAT))
            },
            "analytics": _section(
                "analytics",
                crawl,
                {"ga4": False, "gtm": False, "metaPixel": False, "tiktokPixel": False, "others": []},
                lambda: providers.detect_analytics(pages),
            ),
            "tech": _section("tech", crawl, _none(), tech),
            "freshness": _section(
                "freshness",
                crawl,
                {
                    "copyrightYear": None,
                    "httpLastModified": None,
                    "sitemapLastmod": None,
                    "latestDatedContent": None,
                },
                lambda: freshness.extract_freshness(pages, crawl.sitemap, now),
            ),
            "mobile": {
                "hasViewportMeta": bool(home and home.meta("viewport")),
                "fontSizeIssues": crawl.font_size_issues,
            },
            "performanceHints": {
                "pageWeightKb": round(crawl.page_bytes / 1024) if crawl.page_bytes is not None else None,
                "requestCount": crawl.request_count,
                "domContentLoadedMs": crawl.dom_content_loaded_ms,
            },
            "links": {"internalCount": crawl.internal_links, "brokenCount": crawl.broken_links},
            "noSolicitation": _section(
                "noSolicitation", crawl, no_solicitation, lambda: solicitation.detect_no_solicitation(pages)
            ),
            "logoCandidates": _section(
                "logoCandidates", crawl, _none(), lambda: images.logo_candidates(home) if home else []
            ),
            "imageCandidates": _section(
                "imageCandidates", crawl, _none(), lambda: images.image_candidates(pages)
            ),
            "screenshots": crawl.screenshots,
            "durationMs": 0,
        }
        if crawl.reachability not in ("ok", "redirected") or not any(
            p.status is not None and 200 <= p.status < 300 for p in pages
        ):
            # A bot wall, an error or a parking page says nothing about the business's wishes: not checked.
            bundle["noSolicitation"] = no_solicitation
        # Last: the extractors above may have added warnings.
        bundle["warnings"] = list(crawl.warnings)
        return bundle
