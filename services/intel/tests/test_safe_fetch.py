import asyncio
import gzip
import ssl
import zlib
from collections.abc import AsyncIterator, Iterator
from ipaddress import ip_address

import httpx
import pytest
import respx
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.net.ip_policy import IPAddress
from app.net.safe_fetch import (
    BlockedDestinationError,
    DisallowedContentTypeError,
    FetchConnectionError,
    FetchPolicy,
    FetchResolutionError,
    FetchTimeoutError,
    FetchTlsError,
    ResponseTooLargeError,
    SafeFetcher,
    TooManyRedirectsError,
    strip_query_from_span,
)

PUBLIC = "93.184.215.14"
PUBLIC_2 = "151.101.1.1"


class FakeDns:
    """Hostname → addresses; records lookups. Unknown names fail like a real NXDOMAIN."""

    def __init__(self, records: dict[str, list[str] | list[list[str]]]) -> None:
        self.records = records
        self.lookups: list[str] = []

    async def __call__(self, host: str, port: int) -> list[IPAddress]:
        self.lookups.append(host)
        if host not in self.records:
            raise OSError(f"NXDOMAIN {host}")
        answer = self.records[host]
        if answer and isinstance(answer[0], list):  # successive answers (DNS rebinding)
            answer = answer.pop(0) if len(answer) > 1 else answer[0]
        return [ip_address(a) for a in answer]  # type: ignore[arg-type]


DNS = {
    "example.com": [PUBLIC],
    "cdn.example.net": [PUBLIC_2],
    "internal.example.com": ["10.0.0.7"],
    "mixed.example.com": [PUBLIC, "127.0.0.1"],
    "metadata.example.com": ["169.254.169.254"],
    "v6only.example.com": ["2606:4700::6810:84e5"],
    "xn--bcher-kva.example": [PUBLIC],
}


@pytest.fixture
def dns() -> FakeDns:
    return FakeDns({k: list(v) for k, v in DNS.items()})


@pytest.fixture
async def fetcher(dns: FakeDns) -> AsyncIterator[SafeFetcher]:
    instance = SafeFetcher(FetchPolicy(timeout_seconds=5, max_bytes=1_000), resolver=dns)
    yield instance
    await instance.aclose()


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router


class TestBlockedDestinations:
    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://10.0.0.5/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fd00:ec2::254]/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://[fe80::1]/",
            "https://192.168.1.1/",
        ],
    )
    async def test_ip_literals(self, fetcher: SafeFetcher, mock: respx.MockRouter, url: str) -> None:
        with pytest.raises(BlockedDestinationError):
            await fetcher.fetch(url)
        assert not mock.calls

    @pytest.mark.parametrize(
        "url", ["http://internal.example.com/", "http://metadata.example.com/", "http://mixed.example.com/"]
    )
    async def test_hostnames_resolving_to_non_public_addresses(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, url: str
    ) -> None:
        with pytest.raises(BlockedDestinationError, match="resolves to"):
            await fetcher.fetch(url)
        assert not mock.calls

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://127.1/",
            "http://0177.0.0.1/",
        ],
    )
    async def test_numeric_and_local_hostnames_with_the_system_resolver(
        self, mock: respx.MockRouter, url: str
    ) -> None:
        """Decimal/hex/octal/short IPv4 forms resolve (libc) to 127.0.0.1 and are blocked after resolution."""
        fetcher = SafeFetcher()
        try:
            with pytest.raises((BlockedDestinationError, FetchConnectionError)):
                await fetcher.fetch(url)
        finally:
            await fetcher.aclose()
        assert not mock.calls

    @pytest.mark.parametrize(
        ("url", "match"),
        [
            ("ftp://example.com/file", "scheme"),
            ("file:///etc/passwd", "scheme"),
            ("gopher://example.com/", "scheme"),
            ("http://example.com:8080/", "port"),
            ("https://example.com:22/", "port"),
            ("http://user:pass@example.com/", "credentials"),
        ],
    )
    async def test_schemes_ports_and_credentials(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, url: str, match: str
    ) -> None:
        with pytest.raises(BlockedDestinationError, match=match):
            await fetcher.fetch(url)
        assert not mock.calls

    async def test_redirect_to_a_private_address(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.get(f"http://{PUBLIC}/").respond(302, headers={"Location": "http://169.254.169.254/latest/"})
        with pytest.raises(BlockedDestinationError, match="metadata"):
            await fetcher.fetch("http://example.com/")
        assert len(mock.calls) == 1

    async def test_redirect_to_a_hostname_resolving_privately(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.get(f"https://{PUBLIC}/start").respond(301, headers={"Location": "//internal.example.com/admin"})
        with pytest.raises(BlockedDestinationError, match=r"internal\.example\.com resolves to a private"):
            await fetcher.fetch("https://example.com/start")

    async def test_redirect_to_ipv6_loopback(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.get(f"http://{PUBLIC}/").respond(307, headers={"Location": "http://[::1]:80/"})
        with pytest.raises(BlockedDestinationError, match="loopback"):
            await fetcher.fetch("http://example.com/")


class TestPinning:
    async def test_connects_to_the_resolved_address_with_host_and_sni(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        route = mock.get(f"https://{PUBLIC}/page?q=1").respond(
            200, text="ok", headers={"Content-Type": "text/plain"}
        )
        result = await fetcher.fetch("https://example.com/page?q=1")
        request = route.calls.last.request
        assert request.headers["host"] == "example.com"
        assert request.extensions["sni_hostname"] == "example.com"
        assert request.headers["user-agent"].startswith("BusinessFinderBot/")
        assert result.url == "https://example.com/page?q=1"
        assert result.ip == PUBLIC
        assert result.content == b"ok"
        assert result.media_type == "text/plain"

    async def test_idn_hosts_use_punycode(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, dns: FakeDns
    ) -> None:
        route = mock.get(f"https://{PUBLIC}/").respond(200)
        await fetcher.fetch("https://bücher.example/")
        assert dns.lookups == ["xn--bcher-kva.example"]
        assert route.calls.last.request.headers["host"] == "xn--bcher-kva.example"

    async def test_ipv6_destinations_and_non_default_port_in_host(
        self, dns: FakeDns, mock: respx.MockRouter
    ) -> None:
        fetcher = SafeFetcher(FetchPolicy(ports=frozenset({8443})), resolver=dns)
        route = mock.get("https://[2606:4700::6810:84e5]:8443/").respond(200)
        try:
            await fetcher.fetch("https://v6only.example.com:8443/")
        finally:
            await fetcher.aclose()
        assert route.calls.last.request.headers["host"] == "v6only.example.com:8443"

    async def test_dns_rebinding_cannot_swap_the_address(self, mock: respx.MockRouter) -> None:
        """The first answer is public; a later answer would be private. The request goes to the checked IP."""
        dns = FakeDns({"rebind.example.com": [[PUBLIC], ["127.0.0.1"]]})
        fetcher = SafeFetcher(resolver=dns)
        route = mock.get(f"http://{PUBLIC}/").respond(200)
        try:
            await fetcher.fetch("http://rebind.example.com/")
        finally:
            await fetcher.aclose()
        assert route.called
        assert dns.lookups == ["rebind.example.com"]  # resolved once per hop, never again by the client

    async def test_ignores_proxy_environment_variables(
        self, monkeypatch: pytest.MonkeyPatch, dns: FakeDns, mock: respx.MockRouter
    ) -> None:
        monkeypatch.setenv("HTTP_PROXY", "http://10.0.0.1:3128")
        monkeypatch.setenv("ALL_PROXY", "http://10.0.0.1:3128")
        fetcher = SafeFetcher(resolver=dns)
        route = mock.get(f"http://{PUBLIC}/").respond(200)
        try:
            await fetcher.fetch("http://example.com/")
        finally:
            await fetcher.aclose()
        assert route.called


class TestRedirects:
    async def test_follows_and_reports_redirects(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.get(f"http://{PUBLIC}/a").respond(301, headers={"Location": "https://cdn.example.net/b"})
        mock.get(f"https://{PUBLIC_2}/b").respond(302, headers={"Location": "/c"})
        mock.get(f"https://{PUBLIC_2}/c").respond(200, text="done")
        result = await fetcher.fetch("http://example.com/a")
        assert result.content == b"done"
        assert result.redirects == ("https://cdn.example.net/b", "https://cdn.example.net/c")
        assert result.url == "https://cdn.example.net/c"

    @pytest.mark.parametrize(("hops", "ok"), [(5, True), (6, False)])
    async def test_at_most_five_redirects(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, hops: int, ok: bool
    ) -> None:
        for i in range(hops):
            mock.get(f"http://{PUBLIC}/{i}").respond(302, headers={"Location": f"/{i + 1}"})
        mock.get(f"http://{PUBLIC}/{hops}").respond(200)
        if ok:
            assert len((await fetcher.fetch("http://example.com/0")).redirects) == hops
        else:
            with pytest.raises(TooManyRedirectsError):
                await fetcher.fetch("http://example.com/0")

    async def test_303_turns_a_post_into_a_get_without_body(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.post(f"http://{PUBLIC}/form").respond(303, headers={"Location": "/thanks"})
        thanks = mock.get(f"http://{PUBLIC}/thanks").respond(200)
        await fetcher.fetch("http://example.com/form", method="POST", content=b"a=1")
        assert thanks.calls.last.request.content == b""

    async def test_307_keeps_method_and_body(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.post(f"http://{PUBLIC}/old").respond(307, headers={"Location": "/new"})
        new = mock.post(f"http://{PUBLIC}/new").respond(200)
        await fetcher.fetch("http://example.com/old", method="POST", content=b"a=1")
        assert new.calls.last.request.content == b"a=1"


class TestResponseLimits:
    async def test_rejects_a_declared_oversized_body(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.get(f"http://{PUBLIC}/").respond(200, content=b"x" * 1_001)
        with pytest.raises(ResponseTooLargeError):
            await fetcher.fetch("http://example.com/")

    async def test_rejects_an_oversized_stream_without_content_length(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        async def chunks() -> AsyncIterator[bytes]:
            for _ in range(20):
                yield b"x" * 100

        mock.get(f"http://{PUBLIC}/").mock(return_value=httpx.Response(200, content=chunks()))
        with pytest.raises(ResponseTooLargeError):
            await fetcher.fetch("http://example.com/")

    async def test_rejects_a_decompression_bomb(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        bomb = gzip.compress(b"\0" * 10_000_000)  # ~10 kB on the wire, 10 MB inflated
        mock.get(f"http://{PUBLIC}/").respond(200, content=bomb[:900], headers={"Content-Encoding": "gzip"})
        with pytest.raises(ResponseTooLargeError):
            await fetcher.fetch("http://example.com/")

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "deflate-raw"])
    async def test_decodes_compressed_bodies_within_the_limit(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, encoding: str
    ) -> None:
        raw = b"hello " * 100
        if encoding == "gzip":
            body = gzip.compress(raw)
        elif encoding == "deflate":
            body = zlib.compress(raw)
        else:
            compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
            body = compressor.compress(raw) + compressor.flush()
        route = mock.get(f"http://{PUBLIC}/").respond(
            200, content=body, headers={"Content-Encoding": encoding.removesuffix("-raw")}
        )
        assert (await fetcher.fetch("http://example.com/")).content == raw
        assert route.calls.last.request.headers["accept-encoding"] == "gzip, deflate"

    async def test_refuses_encodings_it_did_not_ask_for(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.get(f"http://{PUBLIC}/").respond(200, content=b"??", headers={"Content-Encoding": "br"})
        with pytest.raises(FetchConnectionError, match="content-encoding"):
            await fetcher.fetch("http://example.com/")

    async def test_content_type_allowlist(self, dns: FakeDns, mock: respx.MockRouter) -> None:
        fetcher = SafeFetcher(
            FetchPolicy(allowed_content_types=frozenset({"text/html", "image/*"})), resolver=dns
        )
        mock.get(f"http://{PUBLIC}/page").respond(200, headers={"Content-Type": "text/html; charset=utf-8"})
        mock.get(f"http://{PUBLIC}/logo").respond(200, headers={"Content-Type": "image/png"})
        mock.get(f"http://{PUBLIC}/app").respond(200, headers={"Content-Type": "application/octet-stream"})
        mock.get(f"http://{PUBLIC}/none").respond(200)
        try:
            assert (await fetcher.fetch("http://example.com/page")).media_type == "text/html"
            assert (await fetcher.fetch("http://example.com/logo")).media_type == "image/png"
            for path in ("app", "none"):
                with pytest.raises(DisallowedContentTypeError):
                    await fetcher.fetch(f"http://example.com/{path}")
        finally:
            await fetcher.aclose()

    async def test_head_reads_no_body(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.head(f"http://{PUBLIC}/").respond(200, headers={"Content-Length": "999999"})
        assert (await fetcher.fetch("http://example.com/", method="head")).content == b""

    async def test_error_statuses_are_returned(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.get(f"http://{PUBLIC}/").respond(503, text="down")
        assert (await fetcher.fetch("http://example.com/")).status_code == 503


class TestFailures:
    async def test_total_time_budget(self, dns: FakeDns, mock: respx.MockRouter) -> None:
        never = asyncio.Event()

        async def hang(request: httpx.Request) -> httpx.Response:
            await never.wait()
            return httpx.Response(200)  # pragma: no cover

        mock.get(f"http://{PUBLIC}/").mock(side_effect=hang)
        fetcher = SafeFetcher(FetchPolicy(timeout_seconds=0.05), resolver=dns)
        try:
            with pytest.raises(FetchTimeoutError):
                await fetcher.fetch("http://example.com/")
        finally:
            await fetcher.aclose()

    @pytest.mark.parametrize(
        ("error", "expected"),
        [
            (httpx.ConnectTimeout("t"), FetchTimeoutError),
            (httpx.ConnectError("refused"), FetchConnectionError),
        ],
    )
    async def test_transport_errors(
        self, fetcher: SafeFetcher, mock: respx.MockRouter, error: Exception, expected: type[Exception]
    ) -> None:
        mock.get(f"http://{PUBLIC}/").mock(side_effect=error)
        with pytest.raises(expected):
            await fetcher.fetch("http://example.com/")

    async def test_unknown_host(self, fetcher: SafeFetcher) -> None:
        with pytest.raises(FetchConnectionError, match="resolve"):
            await fetcher.fetch("http://does-not-exist.example/")

    async def test_invalid_url(self, fetcher: SafeFetcher) -> None:
        with pytest.raises(BlockedDestinationError):
            await fetcher.fetch("http://exa mple.com/")


class TestPrivacy:
    async def test_drops_caller_headers_on_cross_origin_redirects(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.get(f"https://{PUBLIC}/a").respond(302, headers={"Location": "/b"})
        mock.get(f"https://{PUBLIC}/b").respond(302, headers={"Location": "https://cdn.example.net/c"})
        final = mock.get(f"https://{PUBLIC_2}/c").respond(200)
        same_origin = mock.routes[1]
        await fetcher.fetch("https://example.com/a", headers={"Authorization": "Bearer t", "Cookie": "s=1"})
        assert same_origin.calls.last.request.headers["authorization"] == "Bearer t"
        assert "authorization" not in final.calls.last.request.headers
        assert "cookie" not in final.calls.last.request.headers

    async def test_refuses_to_resend_a_body_to_another_origin(
        self, fetcher: SafeFetcher, mock: respx.MockRouter
    ) -> None:
        mock.post(f"http://{PUBLIC}/upload").respond(307, headers={"Location": "http://cdn.example.net/x"})
        with pytest.raises(BlockedDestinationError, match="body"):
            await fetcher.fetch("http://example.com/upload", method="POST", content=b"secret=1")

    async def test_spans_and_logs_omit_query_strings(self, dns: FakeDns, mock: respx.MockRouter) -> None:
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        fetcher = SafeFetcher(resolver=dns)
        HTTPXClientInstrumentor.instrument_client(
            fetcher.client, tracer_provider=provider, request_hook=strip_query_from_span
        )
        mock.get(f"https://{PUBLIC}/file").respond(200)
        try:
            await fetcher.fetch("https://example.com/file?token=s3cr3t")
        finally:
            await fetcher.aclose()
        [span] = exporter.get_finished_spans()
        assert span.attributes is not None
        urls = [v for k, v in span.attributes.items() if k in ("url.full", "http.url")]
        assert urls
        assert all("s3cr3t" not in str(url) for url in urls)


class TestCrawlerOptions:
    """Options the website crawler relies on (BF-026)."""

    async def test_redirects_returned_unfollowed(self, dns: FakeDns, mock: respx.MockRouter) -> None:
        fetcher = SafeFetcher(FetchPolicy(follow_redirects=False), resolver=dns)
        mock.get(f"http://{PUBLIC}/").respond(
            302, headers={"Location": "http://169.254.169.254/"}, text="body"
        )
        result = await fetcher.fetch("http://example.com/")
        assert (result.status_code, result.content, result.headers["location"]) == (
            302,
            b"",
            "http://169.254.169.254/",
        )
        await fetcher.aclose()

    async def test_address_policy_is_injectable(self, mock: respx.MockRouter) -> None:
        async def loopback(host: str, port: int) -> list[IPAddress]:
            return [ip_address("127.0.0.1")]

        fetcher = SafeFetcher(resolver=loopback, address_policy=lambda ip: None)
        mock.get("http://127.0.0.1/").respond(200, text="local")
        assert (await fetcher.fetch("http://site.test/")).content == b"local"
        await fetcher.aclose()

    async def test_unresolvable_hosts_are_resolution_errors(self, fetcher: SafeFetcher) -> None:
        with pytest.raises(FetchResolutionError):
            await fetcher.fetch("http://nowhere.example/")

    async def test_tls_failures_are_tls_errors(self, dns: FakeDns) -> None:
        def handshake(_: httpx.Request) -> httpx.Response:
            # As httpx raises it: a ConnectError caused by the ssl module's error.
            raise httpx.ConnectError("handshake failed") from ssl.SSLCertVerificationError(
                "certificate expired"
            )

        fetcher = SafeFetcher(resolver=dns, transport=httpx.MockTransport(handshake))
        with pytest.raises(FetchTlsError):
            await fetcher.fetch("https://example.com/")
        await fetcher.aclose()

    async def test_plain_http_has_no_certificate(self, fetcher: SafeFetcher, mock: respx.MockRouter) -> None:
        mock.get(f"http://{PUBLIC}/").respond(200, text="ok")
        assert (await fetcher.fetch("http://example.com/")).certificate is None
