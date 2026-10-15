"""Full crawls of the synthetic fixture sites (BF-026) through the real browser and the SSRF guard.

Only loopback is reachable: a test resolver maps `*.test` to 127.0.0.1 (the one address the test policy
allows) and every other host fails to resolve — so third-party scripts on the fixtures are refused, as unknown
hosts would be.
"""

from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from ipaddress import IPv4Address
from typing import Any

import pytest
import pytest_asyncio

from app.contracts.site_intel import SiteIntel
from app.contracts.site_intel_request import SiteIntelRequest
from app.net.ip_policy import IPAddress, blocked_reason
from app.net.safe_fetch import FetchPolicy, SafeFetcher
from app.services.site_intel.browser import BrowserPool
from app.services.site_intel.service import SiteIntelService
from app.services.site_intel.storage import ArtifactStoreError, MemoryArtifactStore
from tests.site_server import serve_sites

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)
LOOPBACK = IPv4Address("127.0.0.1")
pytestmark = pytest.mark.asyncio(loop_scope="module")
type Harness = tuple[SiteIntelService, MemoryArtifactStore]
# The API sends requests as @bf/contracts parsed them (defaults applied), so Python reads the full shape.
DEFAULTS: dict[str, Any] = {
    "maxPages": 6,
    "localesHint": [],
    "screenshots": {"desktop": True, "mobile": True, "fullPage": False},
    "timeoutSeconds": 60,
}


def site_request(**fields: Any) -> SiteIntelRequest:
    return SiteIntelRequest.model_validate({**DEFAULTS, **fields})


async def fixture_resolver(host: str, port: int) -> list[IPAddress]:
    if host.endswith(".test"):
        return [LOOPBACK]
    raise OSError(f"{host} is not resolvable in tests")


def loopback_only(ip: IPAddress) -> str | None:
    return None if ip == LOOPBACK else blocked_reason(ip)


@pytest.fixture(scope="module")
def port() -> Iterator[int]:
    with serve_sites() as server_port:
        yield server_port


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def harness(port: int) -> AsyncIterator[tuple[SiteIntelService, MemoryArtifactStore]]:
    ports = frozenset({80, 443, port})
    fetcher = SafeFetcher(
        FetchPolicy(ports=ports, timeout_seconds=5),
        resolver=fixture_resolver,
        address_policy=loopback_only,
        user_agent="BusinessFinderBot/1.0 (test)",
    )
    browsers = BrowserPool(
        fetcher,
        max_contexts=2,
        resource_policy=FetchPolicy(ports=ports, timeout_seconds=5, follow_redirects=False),
    )
    store = MemoryArtifactStore()
    service = SiteIntelService(
        browsers=browsers,
        fetcher=fetcher,
        store=store,
        user_agent="BusinessFinderBot/1.0 (test)",
        fetch_policy=FetchPolicy(ports=ports, timeout_seconds=5),
        clock=lambda: NOW,
    )
    try:
        yield service, store
    finally:
        await browsers.aclose()
        await fetcher.aclose()


async def analyse(
    harness: tuple[SiteIntelService, MemoryArtifactStore], port: int, site: str, **options: Any
) -> SiteIntel:
    service, _ = harness
    request = site_request(url=f"http://{site}.test:{port}/", artifactPrefix=f"test/{site}", **options)
    return (await service.analyse(request)).intel


class FailingStore:
    async def put(self, key: str, data: bytes, content_type: str) -> None:
        raise ArtifactStoreError("ClientError")


def dump(result: SiteIntel) -> dict[str, Any]:
    data: dict[str, Any] = result.model_dump(mode="json")
    return data


async def test_salon_contacts_booking_analytics_and_robots(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "salon", localesHint=["fr"]))
    assert result["reachability"] == "ok"
    assert result["httpStatus"] == 200
    emails = {e["email"]: e for e in result["contacts"]["emails"]}
    assert emails["contact@salon.example.com"]["source"] == "obfuscated"
    assert emails["rdv@salon.example.com"]["source"] == "cfemail"
    assert emails["bonjour@salon.example.com"] == {
        "email": "bonjour@salon.example.com",
        "source": "mailto",
        "pageUrl": f"http://salon.test:{port}/nous-contacter",
        "onContactPage": True,
    }
    # robots.txt disallows /private/ and /tarifs (a key page): never read.
    assert "secret@salon.example.com" not in emails
    assert "tarifs@salon.example.com" not in emails
    assert "robots: skipped /tarifs" in result["warnings"]
    assert all("/private" not in page["url"] for page in result["pages"])
    phones = {p["e164"]: p for p in result["contacts"]["phones"]}
    assert phones["+33199001122"]["isWhatsApp"] is True
    assert "+33199001123" in phones
    assert result["contacts"]["whatsappLinks"] == ["https://wa.me/33199001122"]
    assert result["contacts"]["contactForms"] == [
        {
            "pageUrl": f"http://salon.test:{port}/nous-contacter",
            "action": f"http://salon.test:{port}/contact/envoyer",
        }
    ]
    assert [p["name"] for p in result["booking"]["providers"]] == ["Planity"]
    assert result["analytics"]["ga4"] is True
    assert result["analytics"]["metaPixel"] is True
    assert {s["network"] for s in result["socials"]} == {"facebook", "instagram"}
    assert result["security"]["hsts"] is True
    assert result["freshness"]["copyrightYear"] == 2019
    assert result["freshness"]["httpLastModified"] == "2024-03-12T10:00:00Z"
    assert result["freshness"]["latestDatedContent"] == "2024-03-12"
    assert result["mobile"]["hasViewportMeta"] is True
    kinds = {page["kind"] for page in result["pages"]}
    assert {"home", "contact", "services"} <= kinds
    assert result["links"]["brokenCount"] >= 1  # /ancienne-page answers 404
    assert result["logoCandidates"][0]["source"] == "img-logo"
    assert result["imageCandidates"][0]["alt"] == "La salle du salon"
    assert result["languages"]["declared"] == ["fr"]
    assert result["languages"]["detected"][0] == "fr"


async def test_salon_artifacts_are_stored_under_the_prefix(harness: Harness, port: int) -> None:
    _, store = harness
    result = dump(
        await analyse(harness, port, "salon", screenshots={"desktop": True, "mobile": True, "fullPage": True})
    )
    keys = result["screenshots"]
    assert keys == {
        "desktopKey": "test/salon/screenshots/desktop.webp",
        "mobileKey": "test/salon/screenshots/mobile.webp",
        "fullPageKey": "test/salon/screenshots/full.webp",
    }
    for key in keys.values():
        data, content_type = store.objects[key]
        assert content_type == "image/webp"
        assert data[:4] == b"RIFF"
        assert data[8:12] == b"WEBP"
    markdown = [page["markdownKey"] for page in result["pages"]]
    assert all(key and key.startswith("test/salon/pages/") for key in markdown)
    home, _ = store.objects[markdown[0]]
    assert b"# Salon Ondine" in home
    assert result["mobile"]["fontSizeIssues"] is False


async def test_cafe_jsonld_menu_tech_and_sitemap(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "cafe", localesHint=["en"]))
    [business] = result["jsonLd"]
    assert business["type"] == "CafeOrCoffeeShop"
    assert business["geo"] == {"lat": 17.8962, "lng": -62.8498}
    assert business["openingHours"] == ["Monday,Tuesday 08:00-16:00"]
    assert business["servesCuisine"] == ["Coffee", "Pastries"]
    emails = {e["email"]: e["source"] for e in result["contacts"]["emails"]}
    assert emails["hello@cafe.example.com"] == "jsonld"
    assert "+33199002233" in {p["e164"] for p in result["contacts"]["phones"]}
    assert "menu" in {page["kind"] for page in result["pages"]}
    assert [p["name"] for p in result["ordering"]["providers"]] == ["Uber Eats"]
    assert result["analytics"]["gtm"] is True
    tech = {t["name"]: t for t in result["tech"]}
    assert tech["WordPress"]["version"] == "6.4.2"
    assert "PHP" in tech
    assert result["freshness"]["sitemapLastmod"] == "2026-09-02T00:00:00Z"
    assert {s["network"] for s in result["socials"]} == {"instagram"}
    # The legal notice is always worth a page: that is where "pas de démarchage" usually is.
    assert "legal" in {page["kind"] for page in result["pages"]}
    assert result["noSolicitation"]["checked"] is True
    assert result["noSolicitation"]["phrases"] == ["pas de démarchage"]
    assert result["noSolicitation"]["pageUrl"] == f"http://cafe.test:{port}/mentions-legales"


async def test_villa_languages_lodgify_and_chat(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "villa"))
    assert result["languages"]["hreflang"] == [
        {"lang": "en", "url": f"http://villa.test:{port}/"},
        {"lang": "fr", "url": f"http://villa.test:{port}/fr/"},
    ]
    assert result["languages"]["hasLanguageSwitcher"] is True
    assert [p["name"] for p in result["booking"]["providers"]] == ["Airbnb", "Lodgify"]
    assert [p["name"] for p in result["chat"]["providers"]] == ["Tawk.to"]
    assert "booking" in {page["kind"] for page in result["pages"]}
    # "Domaine à vendre" is an estate for sale here, not the domain name.
    assert result["reachability"] == "ok"
    # "Contact" redirects to the home page: read once, as the home page.
    assert [page["kind"] for page in result["pages"]].count("home") == 1
    assert "contact" not in {page["kind"] for page in result["pages"]}


async def test_parked_domain(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "parked"))
    assert result["reachability"] == "parked"
    assert result["contacts"]["emails"] == []
    assert result["noSolicitation"]["checked"] is False  # a parking page says nothing about a business


async def test_dutch_no_acquisition_statement(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "acquisitie", localesHint=["nl"]))
    solicitation = result["noSolicitation"]
    assert solicitation["detected"] is True
    assert solicitation["phrases"] == ["acquisitie wordt niet op prijs gesteld"]
    assert solicitation["pageUrl"] == f"http://acquisitie.test:{port}/"
    assert "acquisitie" in solicitation["snippet"]
    assert len(solicitation["snippet"].split()) <= 30
    assert result["languages"]["detected"] == ["nl"]


async def test_single_page_app_is_rendered(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "spa"))
    assert {e["email"] for e in result["contacts"]["emails"]} == {"relax@spa.example.com"}
    assert "contact" in {page["kind"] for page in result["pages"]}
    assert "+33199006677" in {p["e164"] for p in result["contacts"]["phones"]}
    # A key page that answers 404 is not one of the business's pages.
    assert all(not page["url"].endswith("/a-propos") for page in result["pages"])


async def test_redirect_to_cloud_metadata_is_blocked(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "evil"))
    assert result["reachability"] == "blocked"
    assert result["pages"] == []
    assert result["noSolicitation"]["checked"] is False  # nothing read: not "no statement"
    assert result["tls"]["valid"] is None


async def test_slow_site_times_out_and_is_not_cached(harness: Harness, port: int) -> None:
    service, _ = harness
    request = site_request(url=f"http://slow.test:{port}/", artifactPrefix="test/slow", timeoutSeconds=20)
    first = await service.analyse(request)
    assert first.intel.reachability.value == "timeout"
    # robots.txt timed out too: home page only (RFC 9309: unreachable robots.txt is no licence to crawl).
    assert first.intel.warnings[-1].root == "unreachable: the home page could not be read (timeout)"
    assert (await service.analyse(request)).cached is False


async def test_bot_wall_is_blocked(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "forbidden"))
    assert result["reachability"] == "blocked"
    assert result["httpStatus"] == 403
    assert [page["kind"] for page in result["pages"]] == ["home"]
    # The challenge page was read, but it is not the business's site: no-solicitation is unknown.
    assert result["noSolicitation"]["checked"] is False


async def test_robots_rules_are_ours_whatever_the_user_agent(harness: Harness, port: int) -> None:
    """robots.txt disallows BusinessFinderBot: announcing a browser's User-Agent does not get around it."""
    result = dump(
        await analyse(harness, port, "nobots", userAgent="Mozilla/5.0 (X11; Linux x86_64) Test/1.0")
    )
    assert result["reachability"] == "blocked"
    assert result["warnings"] == ["robots: robots.txt disallows our crawler on this site"]
    assert result["pages"] == []


async def test_unreadable_robots_txt_means_home_page_only(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "flaky"))
    assert result["reachability"] == "ok"
    assert [page["kind"] for page in result["pages"]] == ["home"]
    assert "robots: skipped /carte" in result["warnings"]
    assert result["freshness"]["sitemapLastmod"] is None  # /sitemap.xml is not fetched either


async def test_home_redirecting_to_a_site_that_disallows_us(harness: Harness, port: int) -> None:
    result = dump(await analyse(harness, port, "moved"))
    assert result["reachability"] == "blocked"
    assert result["pages"] == []
    assert result["warnings"] == ["robots: robots.txt of the redirected site disallows our crawler"]


async def test_a_page_asking_for_too_much_is_cut_off(harness: Harness, port: int) -> None:
    result = dump(
        await analyse(
            harness, port, "heavy", screenshots={"desktop": False, "mobile": False, "fullPage": False}
        )
    )
    assert result["reachability"] == "ok"
    assert "budget: the site asked for too many resources; some were not loaded" in result["warnings"]
    assert result["performanceHints"]["requestCount"] is not None
    assert result["performanceHints"]["requestCount"] <= 300


async def test_storage_failures_cost_the_artifacts_only(harness: Harness, port: int) -> None:
    service, _ = harness
    failing = SiteIntelService(
        browsers=service._browsers,
        fetcher=service._fetcher,
        store=FailingStore(),
        user_agent="BusinessFinderBot/1.0 (test)",
        fetch_policy=service._policy,
        clock=lambda: NOW,
    )
    request = site_request(url=f"http://spa.test:{port}/", artifactPrefix="test/failing")
    result = dump((await failing.analyse(request)).intel)
    assert result["reachability"] == "ok"
    assert result["screenshots"] == {"desktopKey": None, "mobileKey": None, "fullPageKey": None}
    assert all(page["markdownKey"] is None for page in result["pages"])
    assert "storage: desktop.webp could not be stored" in result["warnings"]
    assert {e["email"] for e in result["contacts"]["emails"]} == {"relax@spa.example.com"}


async def test_unknown_host_is_a_dns_error(harness: Harness, port: int) -> None:
    service, _ = harness
    request = site_request(url="http://nowhere.invalid/", artifactPrefix="test/dns")
    result = dump((await service.analyse(request)).intel)
    assert result["reachability"] == "dns_error"


async def test_social_profile_is_not_crawled(harness: Harness, port: int) -> None:
    service, _ = harness
    request = site_request(url="https://www.facebook.com/somebusiness", artifactPrefix="test/social")
    result = dump((await service.analyse(request)).intel)
    assert result["pages"] == []
    assert result["socialOnly"] is True
    assert result["noSolicitation"]["checked"] is False
    assert result["warnings"][0].startswith("social_only")


async def test_identical_requests_share_one_crawl(harness: Harness, port: int) -> None:
    service, _ = harness
    request = site_request(url=f"http://parked.test:{port}/", artifactPrefix="test/parked-cache")
    first = await service.analyse(request)
    second = await service.analyse(request)
    assert (first.cached, second.cached) == (False, True)
    assert first.intel == second.intel


async def test_scheme_less_website_is_read_over_http(harness: Harness, port: int) -> None:
    service, _ = harness
    request = site_request(url=f"acquisitie.test:{port}", artifactPrefix="test/no-scheme")
    result = (await service.analyse(request)).intel
    assert result.finalUrl is not None
    assert result.finalUrl.root == f"http://acquisitie.test:{port}/"


async def test_browser_readiness(harness: Harness) -> None:
    service, _ = harness
    first = await service._browsers.ready()
    assert first["sandbox"] is True
    assert await service._browsers.ready() == first


async def test_private_subresources_are_refused(harness: Harness, port: int) -> None:
    """Images, scripts and fetches a page asks for go through the same guard as its navigation."""
    service, _ = harness
    pool: BrowserPool = service._browsers
    async with (
        pool.slot(),
        pool.context(user_agent="t", locale="fr", viewport=(800, 600), site="http://salon.test/") as (
            context,
            log,
        ),
    ):
        page = await context.new_page()
        await page.goto(f"http://salon.test:{port}/")
        await page.evaluate(
            """async () => {
              const urls = ['http://10.0.0.5/x.png', 'http://169.254.169.254/latest/', 'http://localhost:6379/'];
              await Promise.all(urls.map((u) => fetch(u).catch(() => null)));
            }"""
        )
        await page.close()
    assert set(log.blocked) >= {"http://10.0.0.5/x.png", "http://169.254.169.254/latest/"}
    assert log.failures["http://localhost:6379/"] in ("blocked", "dns_error")


async def test_pages_cannot_post_elsewhere_use_webrtc_or_patch_the_html_reader(
    harness: Harness, port: int
) -> None:
    service, _ = harness
    pool: BrowserPool = service._browsers
    async with (
        pool.slot(),
        pool.context(user_agent="t", locale="fr", viewport=(800, 600), site=f"http://salon.test:{port}/") as (
            context,
            _,
        ),
    ):
        page = await context.new_page()
        await page.goto(f"http://salon.test:{port}/")
        checks = await page.evaluate(
            """async (other) => {
              const post = (u) => fetch(u, { method: 'POST', body: 'x' }).then(() => 'sent', () => 'refused');
              Object.defineProperty(Element.prototype, 'outerHTML', { get: () => 'patched' });
              try { window.__bfReadHtml = () => [0, 'replaced']; } catch (e) { /* frozen */ }
              return {
                own: await post('/contact/envoyer'),
                other: await post(other),
                webrtc: typeof RTCPeerConnection,
              };
            }""",
            f"http://cafe.test:{port}/collect",
        )
        length, html = await page.evaluate("(n) => window.__bfReadHtml(n)", 100)
        await page.close()
    assert checks == {"own": "sent", "other": "refused", "webrtc": "undefined"}
    assert html.startswith("<html")
    assert len(html) == 100 < length
