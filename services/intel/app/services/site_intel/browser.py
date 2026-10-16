"""Headless Chromium that never touches the network itself (BF-026, security.md §4).

Chromium is launched behind a proxy that does not exist, and every request a page makes — navigations,
scripts, images, XHR — is intercepted and fetched by `SafeFetcher` (scheme/port rules, every resolved address
must be public, the connection pinned to the checked address, size and time caps). WebSockets are closed,
service workers blocked, downloads refused.

Chromium does not route the request that follows a redirect it was handed (it goes to the dead proxy and
fails, closed): navigations are therefore resolved by the caller first (`navigation_policy` follows redirects,
each hop checked and pinned) and the final document is served from that prefetch; subresources follow
redirects inside the fetcher the same way.

Chromium keeps its own sandbox (`chromium_sandbox=True`; the container allows the user namespaces it needs,
infra/compose/seccomp-chromium.json). WebRTC is off: its UDP would not go through the proxy. The renderer's
heap is capped, and the page's HTML is read through functions captured before any page script runs (a page
cannot patch them to hand us something else, or something unbounded).
"""

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field, replace
from urllib.parse import urlsplit

import structlog
from playwright.async_api import (
    Browser,
    BrowserContext,
    Playwright,
    Request,
    Route,
    WebSocketRoute,
    async_playwright,
)
from playwright.async_api import Error as PlaywrightError

from app.net.safe_fetch import (
    BlockedDestinationError,
    FetchError,
    FetchPolicy,
    FetchResolutionError,
    FetchResult,
    FetchTimeoutError,
    FetchTlsError,
    ResponseTooLargeError,
    SafeFetcher,
)
from app.services.site_intel.urls import same_site

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.site_intel.browser")

# A closed port on loopback: anything that would bypass interception (it cannot, but defence in depth)
# fails here.
_BLACK_HOLE_PROXY = "http://127.0.0.1:9"
_SKIPPED_RESOURCES = frozenset({"media", "eventsource", "websocket", "manifest"})
# Hop-by-hop or re-encoded headers: the body handed to Chromium is already decoded and complete.
_DROPPED_RESPONSE_HEADERS = frozenset(
    {"content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "alt-svc"}
)
_DROPPED_REQUEST_HEADERS = frozenset({"host", "accept-encoding", "connection", "content-length"})
_SAFE_METHODS = frozenset({"GET", "HEAD"})
#: What one context (one page view session) may fetch in all: a page that asks for more is cut off.
MAX_CONTEXT_REQUESTS = 300
MAX_CONTEXT_BYTES = 30 * 1024 * 1024
_CLOSE_SECONDS = 10.0
#: Fetches in flight per context: bounds how far past MAX_CONTEXT_BYTES a burst of parallel requests can go.
_INFLIGHT_PER_CONTEXT = 8
_LAUNCH_ARGS = (
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    # Through the (dead) proxy even for loopback — explicit, not Playwright's default.
    "--proxy-bypass-list=<-loopback>",
    # WebRTC's UDP (STUN/TURN) ignores proxies: no UDP that is not proxied, i.e. none.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--js-flags=--max-old-space-size=512",
)
#: Runs in every frame before the page's scripts: removes WebRTC/WebTransport and installs the HTML reader.
INIT_SCRIPT = """(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); }
    catch (e) { /* already gone */ }
  }
  const apply = Reflect.apply;
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get;
  const slice = String.prototype.slice;
  const root = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get;
  const read = (limit) => {
    const element = apply(root, document, []);
    const html = element ? apply(outer, element, []) : '';
    return [html.length, apply(slice, html, [0, limit])];
  };
  Object.defineProperty(window, '__bfReadHtml', { value: read, writable: false, configurable: false });
})()"""


@dataclass(slots=True)
class NetworkLog:
    """What one browser context asked for, and what the guard did."""

    requests: int = 0
    bytes: int = 0
    blocked: list[str] = field(default_factory=list)
    #: url → failure kind (`blocked`, `dns_error`, `tls_error`, `timeout`, `too_large`, `error`).
    failures: dict[str, str] = field(default_factory=dict)
    http_on_https: bool = False
    #: Main-document responses by URL (status, headers, certificate).
    documents: dict[str, FetchResult] = field(default_factory=dict)
    #: Documents the caller already fetched (redirects resolved): served once, not fetched again.
    prefetched: dict[str, FetchResult] = field(default_factory=dict)
    #: The business's site: pages may not send non-GET requests anywhere else.
    site: str = ""
    #: The context hit MAX_CONTEXT_REQUESTS or MAX_CONTEXT_BYTES; later requests were refused.
    over_budget: bool = False
    #: Identical GETs in flight share one fetch (a page asking for the same script twice pays once).
    inflight: dict[str, "asyncio.Task[FetchResult]"] = field(default_factory=dict)
    fetch_slots: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(_INFLIGHT_PER_CONTEXT))


def failure_kind(error: FetchError) -> str:
    if isinstance(error, BlockedDestinationError):
        return "blocked"
    if isinstance(error, FetchResolutionError):
        return "dns_error"
    if isinstance(error, FetchTlsError):
        return "tls_error"
    if isinstance(error, FetchTimeoutError):
        return "timeout"
    if isinstance(error, ResponseTooLargeError):
        return "too_large"
    return "error"


class BrowserPool:
    """One Chromium per process, a bounded number of concurrent contexts (`max_contexts`)."""

    def __init__(
        self,
        fetcher: SafeFetcher,
        *,
        max_contexts: int,
        resource_policy: FetchPolicy,
        launch_args: Sequence[str] = (),
        sandbox: bool = True,
    ) -> None:
        self._fetcher = fetcher
        self._policy = resource_policy
        #: For subresources and for callers resolving a navigation before handing it to Chromium.
        self.navigation_policy = replace(resource_policy, follow_redirects=True)
        self._launch_args = list(launch_args)
        self._sandbox = sandbox
        self._slots = asyncio.Semaphore(max_contexts)
        self._lock = asyncio.Lock()
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._launching: asyncio.Task[Browser] | None = None
        #: Contexts open per browser: a retired browser closes when its count reaches zero.
        self._users: dict[Browser, int] = {}

    async def _ensure_browser(self, *, use: bool = False) -> Browser:
        """The running browser (launched if needed). `use`: counted as in use by one more context, under the
        same lock — it cannot be retired and closed between being handed out and being used."""
        async with self._lock:
            if self._browser is None or not self._browser.is_connected():
                if self._playwright is None:
                    self._playwright = await async_playwright().start()
                try:
                    self._browser = await self._playwright.chromium.launch(
                        headless=True,
                        chromium_sandbox=self._sandbox,
                        proxy={"server": _BLACK_HOLE_PROXY},
                        args=[*_LAUNCH_ARGS, *self._launch_args],
                    )
                except PlaywrightError:
                    # The driver itself may be gone: start it again next time rather than failing forever.
                    with suppress(PlaywrightError):
                        await self._playwright.stop()
                    self._playwright = None
                    raise
                self._users[self._browser] = 0
            if use:
                self._users[self._browser] = self._users.get(self._browser, 0) + 1
            return self._browser

    async def ready(self) -> dict[str, object]:
        """Readiness: Chromium starts, with its sandbox when configured — a host that cannot run the sandbox
        fails the deploy's health gate instead of every analysis later. Launching outlives a timed-out check
        (shielded): the next check finds the browser running."""
        if self._launching is None or self._launching.done():
            self._launching = asyncio.create_task(self._ensure_browser())
        browser = await asyncio.shield(self._launching)
        return {"sandbox": self._sandbox, "version": browser.version}

    async def aclose(self) -> None:
        async with self._lock:
            for browser in [*self._users, *([self._browser] if self._browser else [])]:
                with suppress(PlaywrightError):
                    await browser.close()
            self._users.clear()
            self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None

    async def _release(self, browser: Browser, *, hung: bool) -> None:
        """A context is done with `browser`. A hung context retires the browser: new contexts get a fresh one,
        and the old one closes when its last context is gone (others still crawling on it are not cut off)."""
        async with self._lock:
            self._users[browser] = self._users.get(browser, 1) - 1
            if hung and self._browser is browser:
                logger.warning("browser context did not close in time; a new browser will be started")
                self._browser = None
            retired = self._browser is not browser and self._users[browser] <= 0
            if retired:
                del self._users[browser]
        if retired:
            try:
                async with asyncio.timeout(_CLOSE_SECONDS):
                    await browser.close()
            except (TimeoutError, PlaywrightError):
                logger.warning("retired browser could not be closed")

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        """One request's turn: at most `max_contexts` requests use the browser at once. Contexts are opened
        inside a slot (a request's desktop and mobile contexts run one after the other)."""
        async with self._slots:
            yield

    @asynccontextmanager
    async def context(
        self,
        *,
        user_agent: str,
        locale: str,
        viewport: tuple[int, int],
        site: str,
        mobile: bool = False,
    ) -> AsyncIterator[tuple[BrowserContext, NetworkLog]]:
        browser = await self._ensure_browser(use=True)
        log = NetworkLog(site=site)
        context: BrowserContext | None = None
        try:
            context = await browser.new_context(
                user_agent=user_agent,
                locale=locale,
                viewport={"width": viewport[0], "height": viewport[1]},
                device_scale_factor=2 if mobile else 1,
                is_mobile=mobile,
                has_touch=mobile,
                service_workers="block",
                accept_downloads=False,
                java_script_enabled=True,
            )
            await context.add_init_script(INIT_SCRIPT)
            await context.route("**/*", lambda route, request: self._handle(route, request, log))
            await context.route_web_socket("**/*", _close_web_socket)
            yield context, log
        finally:
            for task in log.inflight.values():
                task.cancel()
            # Shielded: a deadline that fires while we close must not leave the context (and its pages) open.
            await asyncio.shield(self._close(browser, context))

    async def _close(self, browser: Browser, context: BrowserContext | None) -> None:
        hung = False
        if context is not None:
            try:
                # Bounded: a page stuck in a handler must not hold the request (or the slot) forever.
                async with asyncio.timeout(_CLOSE_SECONDS):
                    await context.unroute_all(behavior="ignoreErrors")
                    await context.close()
            except (TimeoutError, PlaywrightError):
                hung = True
        await self._release(browser, hung=hung)

    async def _handle(self, route: Route, request: Request, log: NetworkLog) -> None:
        """Every request of every page: fetched through the guard and handed back, or refused. Never raises
        (a route left unhandled would stall the page until its timeout)."""
        try:
            await self._serve(route, request, log)
        except PlaywrightError:
            pass  # the page or context closed while the request was in flight
        except Exception as error:  # the request fails closed
            # Type only: messages and tracebacks can carry the URL and its query string.
            logger.error(  # noqa: TRY400 - no traceback: it would carry the URL
                "request handling failed", error=type(error).__name__
            )
            with suppress(PlaywrightError):
                await route.abort("failed")

    async def _serve(self, route: Route, request: Request, log: NetworkLog) -> None:
        url = request.url
        method = request.method.upper()
        if request.resource_type in _SKIPPED_RESOURCES or urlsplit(url).scheme not in ("http", "https"):
            await route.abort("blockedbyclient")
            return
        if method not in _SAFE_METHODS and not same_site(url, log.site):
            # A page may post to its own site (a form, an analytics beacon) — never to anyone else via us.
            await route.abort("blockedbyclient")
            return
        navigation = request.is_navigation_request()
        prefetched = log.prefetched.pop(url, None) if navigation and method == "GET" else None
        # A page we chose to open (prefetched) is not the page's own appetite: never refused for budget.
        if prefetched is None and (log.requests >= MAX_CONTEXT_REQUESTS or log.bytes >= MAX_CONTEXT_BYTES):
            log.over_budget = True
            await route.abort("blockedbyclient")
            return
        log.requests += 1
        frame_url = request.frame.url if request.frame else ""
        if url.startswith("http://") and frame_url.startswith("https://") and not navigation:
            log.http_on_https = True
        headers = {k: v for k, v in request.headers.items() if k.lower() not in _DROPPED_REQUEST_HEADERS}
        try:
            # A navigation's redirect handed to Chromium fails closed (module docstring); subresources
            # follow redirects in the fetcher.
            policy = self._policy if navigation else self.navigation_policy
            if prefetched is not None:
                result = prefetched
            elif method == "GET" and not navigation:
                result = await self._shared_get(log, url, headers, policy)
            else:
                async with log.fetch_slots:
                    result = await self._fetcher.fetch(
                        url, method=method, headers=headers, content=request.post_data_buffer, policy=policy
                    )
        except FetchError as error:
            kind = failure_kind(error)
            log.failures[url] = kind
            if kind == "blocked":
                log.blocked.append(url)
            logger.debug("request refused", kind=kind, resource=request.resource_type)
            await route.abort("blockedbyclient" if kind == "blocked" else "failed")
            return
        log.bytes += len(result.content)
        if navigation and request.frame.parent_frame is None:
            log.documents[url] = result
        response_headers = {
            k: v for k, v in result.headers.multi_items() if k.lower() not in _DROPPED_RESPONSE_HEADERS
        }
        cookies = result.headers.get_list("set-cookie")
        if cookies:
            response_headers["set-cookie"] = "\n".join(cookies)
        await route.fulfill(status=result.status_code, headers=response_headers, body=result.content)

    async def _shared_get(
        self, log: NetworkLog, url: str, headers: dict[str, str], policy: FetchPolicy
    ) -> FetchResult:
        task = log.inflight.get(url)
        if task is None:
            task = asyncio.create_task(self._limited_get(log, url, headers, policy))
            log.inflight[url] = task
            task.add_done_callback(lambda _: log.inflight.pop(url, None))
        # Shielded: one waiter giving up (its page closed) does not cancel the fetch for the others.
        return await asyncio.shield(task)

    async def _limited_get(
        self, log: NetworkLog, url: str, headers: dict[str, str], policy: FetchPolicy
    ) -> FetchResult:
        async with log.fetch_slots:
            return await self._fetcher.fetch(url, headers=headers, policy=policy)


async def _close_web_socket(route: WebSocketRoute) -> None:
    await route.close(code=1008, reason="not allowed")
