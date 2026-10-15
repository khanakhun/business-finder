"""SSRF-guarded HTTP fetching for URLs that come from users, providers or crawled pages (security.md §4).

For every hop (the first request and each redirect):
1. scheme and port must be allowed, and the URL must not carry credentials;
2. the host is resolved once and **every** address must be public (`ip_policy.blocked_reason`);
3. the request connects to that resolved address (pinning, so DNS rebinding cannot swap it), with the
   original host in `Host` and in TLS SNI, so certificates are still verified against the hostname.
Redirects are followed manually (max 5) and re-validated. One time budget covers the whole call, and the body
is capped after decompression (we only ask for gzip/deflate and inflate with a bounded output).
"""

import asyncio
import re
import socket
import ssl
import zlib
from collections.abc import Awaitable, Callable, Collection, Mapping
from dataclasses import dataclass, field
from ipaddress import ip_address

import httpx
import structlog

from app.net.ip_policy import IPAddress, blocked_reason

type Resolver = Callable[[str, int], Awaitable[list[IPAddress]]]
#: Why an address must not be contacted, or None (production: `ip_policy.blocked_reason`).
type AddressPolicy = Callable[[IPAddress], str | None]

DEFAULT_USER_AGENT = "BusinessFinderBot/1.0"
_DEFAULT_PORTS = {"http": 80, "https": 443}
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ACCEPT_ENCODING = "gzip, deflate"
# LDH labels after IDNA encoding; anything else (`%`, `_`, spaces) never reaches the resolver.
_HOSTNAME = re.compile(
    r"(?=.{1,253}\.?$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?"
)

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.safe_fetch")


class FetchError(Exception):
    """Base class: the URL could not be fetched safely. Messages never contain response content."""


class BlockedDestinationError(FetchError):
    """The URL or a redirect points somewhere outbound requests may not go (SSRF guard)."""


class TooManyRedirectsError(FetchError):
    pass


class ResponseTooLargeError(FetchError):
    #: The status of the response whose body was too large (it did answer: a link check can still read it).
    status_code: int | None = None


class DisallowedContentTypeError(FetchError):
    pass


class FetchTimeoutError(FetchError):
    pass


class FetchConnectionError(FetchError):
    """DNS failure, refused connection, TLS error, malformed response."""


class FetchResolutionError(FetchConnectionError):
    """The host name does not resolve (or has no addresses)."""


class FetchTlsError(FetchConnectionError):
    """The TLS handshake failed: invalid, expired or mismatched certificate, or no common protocol."""


def _tls_failure(error: BaseException) -> bool:
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        if isinstance(current, ssl.SSLError):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


@dataclass(frozen=True, slots=True)
class FetchPolicy:
    schemes: frozenset[str] = frozenset({"http", "https"})
    ports: frozenset[int] = frozenset({80, 443})
    max_redirects: int = 5
    timeout_seconds: float = 20.0
    max_bytes: int = 10 * 1024 * 1024
    #: Media types such as `text/html` or `image/*`; None accepts any.
    allowed_content_types: frozenset[str] | None = None
    #: False returns redirect responses as they are (a browser behind the guard follows them itself, so every
    #: hop goes through the guard again).
    follow_redirects: bool = True


@dataclass(frozen=True, slots=True)
class FetchResult:
    url: str
    status_code: int
    headers: httpx.Headers
    content: bytes
    #: Every URL redirected to, in order (the last one is `url`).
    redirects: tuple[str, ...] = ()
    #: The address actually connected to for the final hop.
    ip: str = ""
    media_type: str | None = field(default=None)
    #: The peer certificate of an https response (`ssl.SSLSocket.getpeercert()`), verified by the TLS layer.
    certificate: Mapping[str, object] | None = None


async def system_resolver(host: str, port: int) -> list[IPAddress]:
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )
    addresses: list[IPAddress] = []
    for info in infos:
        address = ip_address(str(info[4][0]).split("%", 1)[0])  # drop an IPv6 zone id
        if address not in addresses:
            addresses.append(address)
    return addresses


def _peer_certificate(response: httpx.Response) -> Mapping[str, object] | None:
    stream = response.extensions.get("network_stream")
    ssl_object = stream.get_extra_info("ssl_object") if stream is not None else None
    if ssl_object is None:
        return None
    certificate: Mapping[str, object] | None = ssl_object.getpeercert()
    return certificate


def _origin(url: httpx.URL) -> tuple[str, bytes, int | None]:
    return url.scheme, url.raw_host, url.port or _DEFAULT_PORTS.get(url.scheme)


def _loggable(url: httpx.URL) -> str:
    """URL without query or fragment: crawled/user URLs can carry tokens there (signed links, `?token=`)."""
    return str(url.copy_with(query=None, fragment=None))


async def strip_query_from_span(span: object, request: object) -> None:
    """httpx instrumentation request hook: record URLs without their query string (see `_loggable`).

    Async on purpose: for an `AsyncClient` the instrumentation only calls async hooks.
    """
    attributes = getattr(span, "attributes", None) or {}
    set_attribute = getattr(span, "set_attribute", None)
    if set_attribute is None:
        return
    for key in ("url.full", "http.url"):
        value = attributes.get(key)
        if isinstance(value, str) and "?" in value:
            set_attribute(key, value.split("?", 1)[0])


def _media_type(headers: httpx.Headers) -> str | None:
    value = headers.get("content-type")
    return value.split(";", 1)[0].strip().lower() or None if value else None


def _content_type_allowed(media_type: str | None, allowed: Collection[str]) -> bool:
    if media_type is None:
        return False
    major = media_type.split("/", 1)[0]
    return media_type in allowed or f"{major}/*" in allowed


class _BoundedDecoder:
    """Inflates gzip/deflate with a hard output cap, so a small compressed body cannot balloon in memory."""

    def __init__(self, encoding: str, limit: int) -> None:
        self._limit = limit
        self._size = 0
        self._deflate_raw_fallback = encoding == "deflate"
        if encoding in ("", "identity"):
            self._inflater: zlib._Decompress | None = None
        elif encoding in ("gzip", "x-gzip"):
            self._inflater = zlib.decompressobj(zlib.MAX_WBITS | 16)
        elif encoding == "deflate":
            self._inflater = zlib.decompressobj(zlib.MAX_WBITS)
        else:
            raise FetchConnectionError(f"unsupported content-encoding {encoding!r}")

    def feed(self, data: bytes) -> bytes:
        if self._inflater is None:
            return self._count(data)
        try:
            out = self._inflater.decompress(data, self._limit - self._size + 1)
        except zlib.error:
            if not self._deflate_raw_fallback or self._size:
                raise FetchConnectionError("corrupt compressed body") from None
            # Some servers send raw deflate without the zlib header.
            self._deflate_raw_fallback = False
            self._inflater = zlib.decompressobj(-zlib.MAX_WBITS)
            return self.feed(data)
        self._deflate_raw_fallback = False
        return self._count(out)

    def flush(self) -> bytes:
        return self._count(self._inflater.flush()) if self._inflater is not None else b""

    def _count(self, data: bytes) -> bytes:
        self._size += len(data)
        if self._size > self._limit:
            raise ResponseTooLargeError(f"response body exceeds {self._limit} bytes")
        return data


class SafeFetcher:
    """Create one per process and `aclose()` it on shutdown. Never use a plain httpx client for such URLs."""

    def __init__(
        self,
        policy: FetchPolicy | None = None,
        *,
        resolver: Resolver = system_resolver,
        user_agent: str = DEFAULT_USER_AGENT,
        transport: httpx.AsyncBaseTransport | None = None,
        address_policy: AddressPolicy = blocked_reason,
    ) -> None:
        self.policy = policy or FetchPolicy()
        self._resolver = resolver
        self._address_policy = address_policy
        self.client = httpx.AsyncClient(
            transport=transport,
            # Environment proxies would bypass pinning and the address checks.
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(self.policy.timeout_seconds),
            # Connections are keyed by IP; a pooled TLS session for one hostname must not serve another.
            limits=httpx.Limits(max_keepalive_connections=0),
            headers={"User-Agent": user_agent},
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    async def fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        content: bytes | None = None,
        policy: FetchPolicy | None = None,
    ) -> FetchResult:
        """Raises a `FetchError` subclass; HTTP error statuses (4xx/5xx) are returned, not raised."""
        policy = policy or self.policy
        try:
            async with asyncio.timeout(policy.timeout_seconds):
                return await self._fetch(url, method.upper(), headers or {}, content, policy)
        except TimeoutError:
            raise FetchTimeoutError(f"no complete response within {policy.timeout_seconds} s") from None
        except httpx.TimeoutException as error:
            raise FetchTimeoutError(type(error).__name__) from None
        except httpx.InvalidURL as error:
            raise BlockedDestinationError(f"invalid URL: {error}") from None
        except httpx.HTTPError as error:
            if _tls_failure(error):
                raise FetchTlsError(type(error).__name__) from None
            raise FetchConnectionError(type(error).__name__) from None

    async def _fetch(
        self,
        url: str,
        method: str,
        headers: Mapping[str, str],
        content: bytes | None,
        policy: FetchPolicy,
    ) -> FetchResult:
        current = httpx.URL(url)
        redirects: list[str] = []
        request_headers = {k: v for k, v in headers.items() if k.lower() not in ("host", "accept-encoding")}
        while True:
            ip = await self._check_destination(current, policy)
            hostname = current.raw_host.decode("ascii")
            port = current.port or _DEFAULT_PORTS[current.scheme]
            request = self.client.build_request(
                method,
                current.copy_with(host=str(ip)),
                headers={**request_headers, "Accept-Encoding": _ACCEPT_ENCODING},
                content=content,
                extensions={"sni_hostname": hostname} if current.scheme == "https" else {},
            )
            request.headers["Host"] = (
                hostname if port == _DEFAULT_PORTS[current.scheme] else f"{hostname}:{port}"
            )
            logger.debug("fetch", url=_loggable(current), ip=str(ip), method=method)
            response = await self.client.send(request, stream=True)
            try:
                location = response.headers.get("location")
                if response.status_code in _REDIRECT_STATUSES and location and policy.follow_redirects:
                    if len(redirects) >= policy.max_redirects:
                        raise TooManyRedirectsError(f"more than {policy.max_redirects} redirects")
                    target = current.join(location)
                    if response.status_code == 303 or (
                        response.status_code in (301, 302) and method not in ("GET", "HEAD")
                    ):
                        method, content = "GET", None
                    if _origin(target) != _origin(current):
                        # Caller headers (credentials, cookies, tokens) are meant for the first origin only.
                        request_headers = {}
                        if content:
                            raise BlockedDestinationError(
                                "cross-origin redirect would resend the request body"
                            )
                    current = target
                    redirects.append(str(current))
                    continue
                media_type = _media_type(response.headers)
                if policy.allowed_content_types is not None and not _content_type_allowed(
                    media_type, policy.allowed_content_types
                ):
                    raise DisallowedContentTypeError(f"content type {media_type!r} is not allowed")
                redirecting = response.status_code in _REDIRECT_STATUSES and bool(location)
                try:
                    body = (
                        b""
                        if method == "HEAD" or redirecting
                        else await self._read(response, policy.max_bytes)
                    )
                except ResponseTooLargeError as error:
                    error.status_code = response.status_code
                    raise
                return FetchResult(
                    url=str(current),
                    status_code=response.status_code,
                    headers=response.headers,
                    content=body,
                    redirects=tuple(redirects),
                    ip=str(ip),
                    media_type=media_type,
                    certificate=_peer_certificate(response) if current.scheme == "https" else None,
                )
            finally:
                await response.aclose()

    async def _check_destination(self, url: httpx.URL, policy: FetchPolicy) -> IPAddress:
        if url.scheme not in policy.schemes:
            raise BlockedDestinationError(f"scheme {url.scheme!r} is not allowed")
        if url.userinfo:
            raise BlockedDestinationError("URLs with credentials are not allowed")
        port = url.port or _DEFAULT_PORTS.get(url.scheme)
        if port is None or port not in policy.ports:
            raise BlockedDestinationError(f"port {port} is not allowed")
        host = url.raw_host.decode("ascii")
        if not host:
            raise BlockedDestinationError("URL has no host")
        try:
            addresses: list[IPAddress] = [ip_address(host)]
        except ValueError:
            if not _HOSTNAME.fullmatch(host):
                raise BlockedDestinationError(f"invalid host {host!r}") from None
            try:
                addresses = await self._resolver(host, port)
            except OSError as error:
                raise FetchResolutionError(f"could not resolve {host}") from error
        if not addresses:
            raise FetchResolutionError(f"{host} has no addresses")
        for address in addresses:
            # Any non-public record blocks the host: we cannot know which one a later connection would use.
            if reason := self._address_policy(address):
                raise BlockedDestinationError(f"{host} resolves to a {reason}")
        return addresses[0]

    @staticmethod
    async def _read(response: httpx.Response, limit: int) -> bytes:
        declared = response.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > limit:
            raise ResponseTooLargeError(f"response body exceeds {limit} bytes")
        decoder = _BoundedDecoder(response.headers.get("content-encoding", "").strip().lower(), limit)
        body = bytearray()
        received = 0
        async for chunk in response.aiter_raw():
            received += len(chunk)
            if received > limit:
                raise ResponseTooLargeError(f"response body exceeds {limit} bytes")
            body += decoder.feed(chunk)
        body += decoder.flush()
        return bytes(body)
