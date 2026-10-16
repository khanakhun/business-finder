"""POST /v1/site-intel (auth, validation, metrics), robots.txt rules and artifact storage (BF-026)."""

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from ipaddress import ip_address
from typing import Any

import pytest
import respx
from botocore.exceptions import EndpointConnectionError
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from protego import Protego

from app.contracts.site_intel import SiteIntel
from app.contracts.site_intel_request import SiteIntelRequest
from app.main import create_app
from app.net.ip_policy import IPAddress
from app.net.safe_fetch import SafeFetcher
from app.services.site_intel import robots
from app.services.site_intel.service import Analysis
from app.services.site_intel.storage import ArtifactStoreError, MemoryArtifactStore, S3ArtifactStore
from app.settings import Settings
from tests.conftest import NOW, Signer

PUBLIC = "93.184.215.14"


def minimal_intel(**changes: Any) -> SiteIntel:
    data: dict[str, Any] = {
        "requestedUrl": "https://example.com/",
        "finalUrl": "https://example.com/",
        "httpStatus": 200,
        "fetchedAt": "2026-10-15T12:00:00.000Z",
        "reachability": "ok",
        "socialOnly": False,
        "tls": {"valid": True, "expiresAt": None, "issuer": None},
        "security": {"https": True, "hsts": False, "mixedContent": False},
        "pages": [
            {
                "url": "https://example.com/",
                "kind": "home",
                "title": "Home",
                "metaDescription": None,
                "lang": "fr",
                "h1": None,
                "wordCount": 3,
                "markdownKey": "p/pages/00-home.md",
            }
        ],
        "languages": {"declared": [], "detected": [], "hreflang": [], "hasLanguageSwitcher": False},
        "jsonLd": [],
        "contacts": {"emails": [], "phones": [], "whatsappLinks": [], "contactForms": []},
        "socials": [],
        "booking": {"providers": []},
        "ordering": {"providers": []},
        "chat": {"providers": []},
        "analytics": {"ga4": False, "gtm": False, "metaPixel": False, "tiktokPixel": False, "others": []},
        "tech": [],
        "freshness": {
            "copyrightYear": None,
            "httpLastModified": None,
            "sitemapLastmod": None,
            "latestDatedContent": None,
        },
        "mobile": {"hasViewportMeta": True, "fontSizeIssues": None},
        "performanceHints": {"pageWeightKb": None, "requestCount": None, "domContentLoadedMs": None},
        "links": {"internalCount": 0, "brokenCount": 0},
        "noSolicitation": {
            "checked": True,
            "detected": False,
            "phrases": [],
            "pageUrl": None,
            "snippet": None,
        },
        "logoCandidates": [],
        "imageCandidates": [],
        "screenshots": {"desktopKey": None, "mobileKey": None, "fullPageKey": None},
        "warnings": [],
        "durationMs": 1200,
    }
    data.update(changes)
    return SiteIntel.model_validate(data)


class FakeSiteIntel:
    def __init__(self) -> None:
        self.requests: list[SiteIntelRequest] = []

    async def analyse(self, request: SiteIntelRequest) -> Analysis:
        # The second identical request is a cache hit, as in the real service.
        cached = request in self.requests
        self.requests.append(request)
        return Analysis(minimal_intel(requestedUrl=request.url), cached=cached)


@pytest.fixture
def fake() -> FakeSiteIntel:
    return FakeSiteIntel()


@pytest.fixture
def api(settings: Settings, tracer_provider: TracerProvider, fake: FakeSiteIntel) -> Iterator[TestClient]:
    app = create_app(
        settings,
        tracer_provider=tracer_provider,
        clock=lambda: NOW,
        site_intel_service=fake,  # type: ignore[arg-type]
    )
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


REQUEST = {
    "url": "https://example.com/",
    "artifactPrefix": "businesses/b1/site-intel/r1",
    "maxPages": 6,
    "localesHint": ["fr"],
    "screenshots": {"desktop": True, "mobile": True, "fullPage": False},
    "timeoutSeconds": 60,
}


def test_analyses_a_site_and_counts_it(api: TestClient, signed: Signer, fake: FakeSiteIntel) -> None:
    body = json.dumps(REQUEST).encode()
    response = api.post("/v1/site-intel", content=body, headers=signed("POST", "/v1/site-intel", body))
    assert response.status_code == 200, response.text
    assert response.json()["reachability"] == "ok"
    assert fake.requests[0].artifactPrefix == "businesses/b1/site-intel/r1"
    metrics = api.get("/metrics").text
    assert 'bf_intel_site_intel_total{reachability="ok"} 1.0' in metrics
    assert "bf_intel_site_intel_pages_total 1.0" in metrics
    # A cache hit is answered but not counted: nothing was crawled.
    again = api.post("/v1/site-intel", content=body, headers=signed("POST", "/v1/site-intel", body))
    assert again.status_code == 200
    assert 'bf_intel_site_intel_total{reachability="ok"} 1.0' in api.get("/metrics").text


def test_requires_internal_auth(api: TestClient) -> None:
    assert api.post("/v1/site-intel", json=REQUEST).status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"artifactPrefix": "../../etc"},
        {"artifactPrefix": "Upper/Case"},
        {"artifactPrefix": "trailing/"},
        {"maxPages": 13},
        {"timeoutSeconds": 5},
        {"localesHint": ["fra"]},
        {"countryHint": "bl"},
    ],
)
def test_rejects_invalid_requests(api: TestClient, signed: Signer, change: dict[str, Any]) -> None:
    body = json.dumps({**REQUEST, **change}).encode()
    response = api.post("/v1/site-intel", content=body, headers=signed("POST", "/v1/site-intel", body))
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")


# --- robots.txt and sitemaps ------------------------------------------------------------------------------


async def public_dns(host: str, port: int) -> list[IPAddress]:
    if host == "example.com":
        return [ip_address(PUBLIC)]
    raise OSError(host)


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router


async def test_robots_rules_delay_and_sitemaps(mock: respx.MockRouter) -> None:
    mock.get(f"https://{PUBLIC}/robots.txt").respond(
        200,
        text="User-agent: *\nDisallow: /admin\nCrawl-delay: 30\nSitemap: https://example.com/map.xml\n"
        "Sitemap: ftp://example.com/x\n",
    )
    mock.get(f"https://{PUBLIC}/map.xml").respond(
        200,
        content=b"<urlset><url><lastmod>2026-09-01T10:00:00+02:00</lastmod></url>"
        b"<url><lastmod>2030-01-01</lastmod></url><url><lastmod>bad-date-x</lastmod></url></urlset>",
    )
    fetcher = SafeFetcher(resolver=public_dns)
    rules = await robots.load_rules(fetcher, "https://example.com/", "Bot")
    assert rules.origin == "https://example.com"
    assert rules.crawl_delay == 5.0  # capped
    assert rules.sitemaps == ["https://example.com/map.xml"]
    assert rules.allowed("https://example.com/", "https://example.com/")
    assert not rules.allowed("https://example.com/admin/x", "https://example.com/")
    lastmod = await robots.sitemap_lastmod(
        fetcher, "https://example.com/", rules, datetime(2026, 10, 15, tzinfo=UTC)
    )
    assert lastmod == datetime(2026, 9, 1, 8, 0, tzinfo=UTC)
    await fetcher.aclose()


async def test_robots_errors(mock: respx.MockRouter) -> None:
    fetcher = SafeFetcher(resolver=public_dns)
    mock.get(f"https://{PUBLIC}/robots.txt").respond(503)
    rules = await robots.load_rules(fetcher, "https://example.com/", "Bot")
    assert rules.unreachable
    assert rules.allowed("https://example.com", "https://example.com/")  # the home page, slash or not
    assert not rules.allowed("https://example.com/contact", "https://example.com/")
    mock.get(f"https://{PUBLIC}/robots.txt").respond(404)
    missing = await robots.load_rules(fetcher, "https://example.com/", "Bot")
    assert missing.parser is None
    assert missing.allowed("https://example.com/contact", "https://example.com/")
    # Unreadable (RFC 9309 §2.3.1.4): the home page only; no sitemap either.
    rules = await robots.load_rules(fetcher, "https://nowhere.example/", "Bot")
    assert rules.unreachable
    mock.get(f"https://{PUBLIC}/sitemap.xml").respond(404)
    now = datetime(2026, 10, 15, tzinfo=UTC)
    assert await robots.sitemap_lastmod(fetcher, "https://example.com/", rules, now) is None
    assert await robots.sitemap_lastmod(fetcher, "https://nowhere.example/", rules, now) is None
    await fetcher.aclose()


# --- Storage ----------------------------------------------------------------------------------------------


def test_bot_token_and_specific_groups() -> None:
    assert robots.bot_token("BusinessFinderBot/1.0 (+https://example.com/bot)") == "BusinessFinderBot"
    assert robots.bot_token("  ") == "*"
    rules = robots.SiteRules(
        "https://example.com",
        "BusinessFinderBot",
        parser=Protego.parse("User-agent: *\nAllow: /\n\nUser-agent: BusinessFinderBot\nDisallow: /\n"),
    )
    assert not rules.allowed("https://example.com/", "https://example.com/")


async def test_memory_store() -> None:
    store = MemoryArtifactStore()
    await store.put("a/b.md", b"# Hi", "text/markdown")
    assert store.objects == {"a/b.md": (b"# Hi", "text/markdown")}


async def test_s3_store_puts_into_the_artifacts_bucket(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = S3ArtifactStore(settings)
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(store._client, "put_object", lambda **kwargs: calls.append(kwargs))
    await store.put("p/screenshots/desktop.webp", b"RIFF", "image/webp")
    assert calls == [
        {
            "Bucket": "bf-artifacts",
            "Key": "p/screenshots/desktop.webp",
            "Body": b"RIFF",
            "ContentType": "image/webp",
        }
    ]


async def test_s3_store_errors_are_typed(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    store = S3ArtifactStore(settings)

    def unreachable(**_: Any) -> None:
        raise EndpointConnectionError(endpoint_url="http://s3.invalid")

    monkeypatch.setattr(store._client, "put_object", unreachable)
    with pytest.raises(ArtifactStoreError, match="EndpointConnectionError"):
        await store.put("p/x.md", b"x", "text/markdown")
