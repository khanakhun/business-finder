"""Extractors and helpers of the website crawler (BF-026), on hand-written HTML (no browser, no network)."""

import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.services.site_intel.discovery import classify, key_pages
from app.services.site_intel.extractors import (
    contacts,
    freshness,
    images,
    jsonld,
    languages,
    no_solicitation,
    parked,
    providers,
    socials,
)
from app.services.site_intel.extractors import tech as tech_db
from app.services.site_intel.page import Link, Page
from app.services.site_intel.urls import (
    absolute,
    path_key,
    registrable_domain,
    registrable_suffix,
    same_site,
    with_scheme,
)

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)


def page(html: str, url: str = "https://www.example.com/", kind: str = "home", **headers: str) -> Page:
    return Page(url, f"<html><body>{html}</body></html>", kind=kind, headers=headers)


# --- URLs & discovery -------------------------------------------------------------------------------------


def test_registrable_domain_and_same_site() -> None:
    assert registrable_domain("www.salon.example.co.uk") == "example.co.uk"
    assert registrable_domain("salon.test") == "salon.test"
    assert same_site("https://www.example.com/a", "http://shop.example.com/b")
    assert not same_site("https://example.com/", "https://example.org/")


@pytest.mark.parametrize(
    ("href", "expected"),
    [
        ("/contact#form", "https://www.example.com/contact"),
        ("mailto:a@b.co", None),
        ("javascript:void(0)", None),
        ("#top", None),
        ("http://[::1", None),
        ("", None),
        ("/" + "a" * 2000, None),  # longer than any URL the contract carries
    ],
)
def test_absolute(href: str, expected: str | None) -> None:
    assert absolute(href, "https://www.example.com/") == expected


def test_path_key_ignores_trailing_slash() -> None:
    assert path_key("https://Example.com/a/") == path_key("https://example.com/a")
    assert path_key("https://example.com") == "example.com/"


@pytest.mark.parametrize(
    ("url", "text", "kind"),
    [
        ("https://x.com/nous-contacter", "", "contact"),
        ("https://x.com/page", "Qui sommes-nous ?", "about"),
        ("https://x.com/prestations", "", "services"),
        ("https://x.com/la-carte", "", "menu"),
        ("https://x.com/p", "Prendre rendez-vous", "booking"),
        ("https://x.com/r%C3%A9servation", "", "booking"),
        ("https://x.com/blog", "News", "other"),
    ],
)
def test_classify(url: str, text: str, kind: str) -> None:
    assert classify(url, text) == kind


def test_key_pages_ranks_and_skips() -> None:
    links = [
        Link("https://x.com/about", "About"),
        Link("https://x.com/contact", "Contact"),
        Link("https://x.com/contact/", "Contact again"),
        Link("https://other.com/contact", "Elsewhere"),
        Link("https://x.com/brochure.pdf", "Menu PDF"),
        Link("https://x.com/cart", "Cart menu"),
        Link("https://x.com/blog", "Blog"),
    ]
    assert key_pages("https://x.com/", links, 5) == [
        ("https://x.com/contact", "contact"),
        ("https://x.com/about", "about"),
    ]
    assert key_pages("https://x.com/", links, 1) == [("https://x.com/contact", "contact")]


def test_key_pages_reach_the_legal_notice_first_of_its_kind() -> None:
    links = [
        Link("https://x.com/contact", "Contact"),
        Link("https://x.com/acces", "Accès"),
        Link("https://x.com/reserver", "Réserver"),
        Link("https://x.com/mentions-legales", "Mentions légales"),
    ]
    assert key_pages("https://x.com/", links, 2) == [
        ("https://x.com/contact", "contact"),
        ("https://x.com/mentions-legales", "legal"),
    ]
    assert key_pages("https://x.com/", links, 4)[-1] == ("https://x.com/acces", "contact")


def test_shared_hosting_subdomains_are_different_sites() -> None:
    assert not same_site("https://salon.wixsite.com/home", "https://bakery.wixsite.com/home")
    assert not same_site("https://salon.github.io/", "https://other.github.io/")
    assert same_site("https://www.salon.co.uk/", "https://shop.salon.co.uk/")


def test_url_helpers() -> None:
    assert with_scheme(" salon.example ") == "http://salon.example"
    assert with_scheme("https://salon.example/") == "https://salon.example/"
    assert registrable_suffix("salon.co.uk") == "co.uk"
    assert registrable_suffix("salon.notatld") == ""


# --- Contacts ---------------------------------------------------------------------------------------------


def test_cloudflare_email_decoding() -> None:
    assert contacts.decode_cfemail("423026340231232e2d2c6c273a232f322e276c212d2f") == "rdv@salon.example.com"
    assert contacts.decode_cfemail("zz") is None
    assert contacts.decode_cfemail("42") is None
    assert contacts.decode_cfemail("4201") is None


@pytest.mark.parametrize(
    "text",
    [
        "Great food dot com, really.",
        "Chocolat maison point de vente à Gustavia",
        "Pat Martin point de vue sur la baie",
        "contact [at] salon [dot] notatld",  # no public suffix
        "meet us at the beach dot party",  # `at` + `dot` prose, no real suffix
        "name [at) salon (dot] fr",  # brackets that do not pair still need both tokens bracketed
    ],
)
def test_prose_is_not_an_obfuscated_email(text: str) -> None:
    assert contacts.extract_emails([page(f"<p>{text}</p>")], []) == []


@pytest.mark.parametrize(
    ("text", "email"),
    [
        ("contact [at] salon [dot] fr", "contact@salon.fr"),
        ("contact (at) salon (dot) co (dot) uk", "contact@salon.co.uk"),
        ("jean at example dot com", "jean@example.com"),
        ("info{at}salon.example{dot}com", "info@salon.example.com"),
        ("resa [arobase] villa [point] fr", "resa@villa.fr"),
    ],
)
def test_obfuscated_emails(text: str, email: str) -> None:
    found = contacts.extract_emails([page(f"<p>{text}</p>")], [])
    assert found == [
        {
            "email": email,
            "source": "obfuscated",
            "pageUrl": "https://www.example.com/",
            "onContactPage": False,
        }
    ]


def test_emails_from_text_mailto_jsonld_dedupe_and_noise() -> None:
    home = page(
        '<a href="mailto:Hello@Example.com?subject=hi">mail</a> hello@example.com logo@2x.png '
        "example@example.com"
    )
    contact = page("<p>team@example.com</p>", url="https://www.example.com/contact", kind="contact")
    found = contacts.extract_emails(
        [home, contact], [("owner@example.com", contact), ("hello@example.com", home)]
    )
    # Contact-page addresses first; a JSON-LD address belongs to the page that declared it.
    assert [(e["email"], e["source"], e["onContactPage"]) for e in found] == [
        ("owner@example.com", "jsonld", True),
        ("team@example.com", "text", True),
        ("hello@example.com", "mailto", False),
    ]


def test_phones_whatsapp_and_regions() -> None:
    home = page(
        '<a href="tel:+33199001122">Call</a> <p>Fax 01 99 00 11 23, invalid 01 23</p>'
        '<a href="https://api.whatsapp.com/send?phone=33199001123">WA</a>'
    )
    links = contacts.whatsapp_links([home])
    assert links == ["https://api.whatsapp.com/send?phone=33199001123"]
    phones = contacts.extract_phones([home], ["FR"], links, [("+33 1 99 00 44 55", home), ("junk", home)])
    assert [(p["e164"], p["isWhatsApp"]) for p in phones] == [
        ("+33199001122", False),
        ("+33199001123", True),
        ("+33199004455", False),
    ]
    assert contacts.extract_phones([], ["FR"], [], []) == []


@pytest.mark.parametrize(
    ("text", "regions", "e164"),
    [
        # Saint-Barthélemy numbers are only valid read as BL (the business's country first).
        ("Tél. 0590 27 00 00", ["BL", "FR"], "+590590270000"),
        ("Mobile 0690 31 00 00", ["FR", "BL"], "+590690310000"),
        ("Bel ons: 020 123 4567", ["NL", "FR"], "+31201234567"),
        ("Call (201) 555-0123", ["US", "FR"], "+12015550123"),
        ("International +590 590 27 00 00", ["FR"], "+590590270000"),
        # A region phonenumbers does not know is skipped, not fatal.
        ("Tél. 01 42 00 00 00", ["EU", "FR"], "+33142000000"),
        ("Call 020 7946 0018", ["GB", "US", "FR"], "+442079460018"),
    ],
)
def test_phones_are_read_in_each_candidate_region(text: str, regions: list[str], e164: str) -> None:
    assert [p["e164"] for p in contacts.extract_phones([page(f"<p>{text}</p>")], regions, [], [])] == [e164]


def test_whatsapp_numbers_are_unquoted() -> None:
    home = page('<a href="https://wa.me/%2B33199001124">WhatsApp</a>')
    phones = contacts.extract_phones([home], ["FR"], contacts.whatsapp_links([home]), [])
    assert [(p["e164"], p["isWhatsApp"]) for p in phones] == [("+33199001124", True)]


def test_contact_forms_need_a_message_and_an_email() -> None:
    home = page(
        '<form action="/send"><input name="email"><textarea name="msg"></textarea></form>'
        '<form action="/search"><input name="q"></form>'
    )
    assert contacts.contact_forms([home]) == [
        {"pageUrl": "https://www.example.com/", "action": "https://www.example.com/send"}
    ]


# --- JSON-LD ----------------------------------------------------------------------------------------------


def test_jsonld_graph_types_and_bad_json() -> None:
    html = """
    <script type="application/ld+json">{bad json</script>
    <script type="application/ld+json">{"@type": "WebSite", "name": "ignored"}</script>
    <script type="application/ld+json">
    {"@graph": [{"@type": ["HairSalon", "LocalBusiness"], "name": {"name": "Salon"},
      "telephone": ["+33 1 99 00 11 22"], "email": "mailto:a@b.com", "address": "1 rue X",
      "geo": {"latitude": "200", "longitude": 1}, "openingHours": "Mo-Fr 09:00-18:00",
      "openingHoursSpecification": {"dayOfWeek": "https://schema.org/Saturday",
        "opens": "10:00", "closes": "12:00"},
      "sameAs": ["https://facebook.com/salon", "not a url"]}]}
    </script>"""
    [item] = jsonld.extract_jsonld([page(html)])
    assert item.country is None
    assert item.data == {
        "type": "HairSalon",
        "name": "Salon",
        "telephone": "+33 1 99 00 11 22",
        "email": "a@b.com",
        "address": "1 rue X",
        "geo": None,
        "openingHours": ["Saturday 10:00-12:00", "Mo-Fr 09:00-18:00"],
        "priceRange": None,
        "sameAs": ["https://facebook.com/salon"],
        "servesCuisine": [],
    }


def test_jsonld_hostile_nesting_dedupe_and_country() -> None:
    deep = "[" * 50_000 + "]" * 50_000
    nested: dict[str, object] = {"@type": "LocalBusiness", "name": "Deep"}
    for _ in range(20):
        nested = {"@graph": [nested]}
    business = (
        '{"@type": "Bakery", "name": "Fournil", "telephone": "0590 27 00 00",'
        ' "address": {"addressCountry": {"name": "bl"}}}'
    )
    html = (
        f'<script type="application/ld+json">{deep}</script>'
        f'<script type="application/ld+json">{json.dumps(nested)}</script>'
        f'<script type="application/ld+json">{business}</script>'
    )
    items = jsonld.extract_jsonld([page(html), page(html, url="https://www.example.com/contact")])
    # The over-deep graph is ignored; the bakery repeated on two pages is one item, with its country.
    assert [(i.data["name"], i.country, i.page.url) for i in items] == [
        ("Fournil", "BL", "https://www.example.com/")
    ]


# --- Socials, providers, analytics ------------------------------------------------------------------------


def test_socials_ignore_share_buttons_and_dedupe() -> None:
    home = page(
        '<a href="https://www.facebook.com/salon/">FB</a><a href="https://facebook.com/sharer/sharer.php?u=x">Share</a>'
        '<a href="https://m.instagram.com/@salon">IG</a><a href="https://linktr.ee/">root</a>'
    )
    assert socials.extract_socials([home], ["https://www.facebook.com/salon"]) == [
        {"network": "facebook", "url": "https://www.facebook.com/salon/", "handle": "salon"},
        {"network": "instagram", "url": "https://m.instagram.com/@salon", "handle": "salon"},
    ]


def test_socials_match_the_first_segment_and_drop_queries() -> None:
    home = page(
        '<a href="https://www.facebook.com/tracy.salon?ref=page">FB</a>'
        '<a href="https://twitter.com/intent/tweet?text=x">Tweet</a>'
        '<a href="https://www.instagram.com/salon/?hl=fr">IG</a>'
    )
    assert socials.extract_socials([home], []) == [
        {"network": "facebook", "url": "https://www.facebook.com/tracy.salon", "handle": "tracy.salon"},
        {"network": "instagram", "url": "https://www.instagram.com/salon/", "handle": "salon"},
    ]


def test_generic_booking_form() -> None:
    form = '<form><label>Arrivée <input type="date" name="arrivee"></label><button>Réserver</button></form>'
    assert providers.booking_forms([page(form, url="https://villa.example.com/sejour")]) == [
        {"name": "Booking form", "evidence": "villa.example.com/sejour"}
    ]
    search = '<form><input type="date" name="from"><button>Search the archive</button></form>'
    assert providers.booking_forms([page(search)]) == []
    assert providers.booking_forms([page(search, kind="booking")])[0]["name"] == "Booking form"


def test_provider_detection_by_hosts_never_text() -> None:
    home = page(
        '<script src="https://cdn.fresha.com/widget.js"></script><iframe src="https://www.opentable.com/w"></iframe>'
        "<p>Book on Planity!</p>"
    )
    assert [p["name"] for p in providers.detect([home], providers.BOOKING)] == ["Fresha", "OpenTable"]


def test_analytics() -> None:
    home = page(
        '<script src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>'
        '<script src="https://static.hotjar.com/c/hotjar.js"></script><script>ttq.load("X")</script>'
    )
    lower = page('<script>gtag("config", "g-abcdefgh"); var x = "big-ticket";</script>')
    assert providers.detect_analytics([lower])["ga4"] is False
    ga4 = page('<script>gtag("config", "G-ABC123XYZ");</script>')
    assert providers.detect_analytics([ga4])["ga4"] is True
    assert providers.detect_analytics([home]) == {
        "ga4": False,
        "gtm": False,
        "metaPixel": False,
        "tiktokPixel": True,
        "others": ["Hotjar"],
    }


# --- No solicitation, parked, freshness, images, languages ------------------------------------------------


def test_no_solicitation_fr_en_and_absent() -> None:
    fr = page("<p>Merci : PAS DE DÉMARCHAGE commercial, nous refusons tout démarchage.</p>")
    result = no_solicitation.detect_no_solicitation([fr])
    assert result["detected"] is True
    assert result["phrases"] == ["pas de démarchage", "refusons tout démarchage"]
    assert result["snippet"].startswith("merci : pas de démarchage")
    en = page("<p>No soliciting. We do not accept unsolicited offers.</p>")
    assert no_solicitation.detect_no_solicitation([en])["phrases"] == ["we do not accept unsolicited"]
    clean = no_solicitation.detect_no_solicitation([page("<p>Hello</p>")])
    assert (clean["checked"], clean["detected"]) == (True, False)
    nothing = no_solicitation.detect_no_solicitation([])
    assert (nothing["checked"], nothing["detected"]) == (False, False)


def test_parked_and_social_only() -> None:
    assert parked.is_parked(page("<h1>Ce nom de domaine est à vendre</h1>"))
    assert parked.is_parked(page('<a href="https://www.hugedomains.com/domain_profile.cfm?d=x">Buy</a>'))
    assert not parked.is_parked(page("<h1>Boulangerie</h1>"))
    # An estate agency selling a "domaine", a long page mentioning domains, a look-alike host: not parked.
    assert not parked.is_parked(page("<h1>Villas</h1><p>Domaine à vendre à Gustavia, vue mer.</p>"))
    long_text = " ".join(["Notre boutique en ligne propose des créations uniques."] * 30)
    assert not parked.is_parked(page(f"<p>{long_text} This domain is for sale.</p>"))
    assert not parked.is_parked(page('<a href="https://notbodis.com.example/x">partner</a>'))
    assert parked.is_parked(page('<script src="https://img.sedoparking.com/js/x.js"></script>'))
    assert parked.is_social_only("https://instagram.com/salon")
    assert not parked.is_social_only("https://salon.example.com")


def test_freshness() -> None:
    home = page(
        "<p>© 2015-2023 Salon. Updated 2026-09-01, event 31/12/2030, bad 2026-02-30, 15/10/2026.</p>",
        **{"last-modified": "Tue, 12 Mar 2024 10:00:00 GMT"},
    )
    result = freshness.extract_freshness([home], datetime(2026, 9, 2, tzinfo=UTC), NOW)
    assert result == {
        "copyrightYear": 2023,
        "httpLastModified": "2024-03-12T10:00:00Z",
        "sitemapLastmod": "2026-09-02T00:00:00Z",
        "latestDatedContent": "2026-10-15",
    }
    broken = page("<p>nothing</p>", **{"last-modified": "yesterday"})
    assert freshness.extract_freshness([broken], None, NOW)["httpLastModified"] is None
    assert freshness.latest_dated_content([], date(2026, 1, 1)) is None


def test_logo_and_image_candidates() -> None:
    home = page(
        '<img src="/brand-logo.svg" alt="" width="200px">'
        '<img src="/hero.jpg" alt="Hero" width="1600" height="900">'
        '<img src="/small.jpg" width="50"><img data-src="/lazy.jpg" alt="Lazy">'
    )
    home.soup.head  # noqa: B018 — parsed
    home_with_meta = Page(
        "https://x.com/",
        '<html><head><meta property="og:image" content="/og.png">'
        '<link rel="apple-touch-icon" sizes="180x180" '
        'href="/icon.png"></head><body><img class="logo" src="/l.png"></body></html>',
    )
    assert [c["source"] for c in images.logo_candidates(home_with_meta)] == [
        "img-logo",
        "og:image",
        "link-icon",
    ]
    assert images.logo_candidates(home_with_meta)[2]["width"] == 180
    assert [i["url"] for i in images.image_candidates([home])] == [
        "https://www.example.com/hero.jpg",
        "https://www.example.com/lazy.jpg",
    ]


def test_languages() -> None:
    en = Page(
        "https://x.com/",
        '<html lang="en-GB"><head><link rel="alternate" hreflang="fr" href="/fr/"></head><body>'
        "<p>The best villas for you and your family, with the sea on your doorstep and our team to help.</p>"
        '<div class="lang-picker"><a href="/">EN</a><a href="/fr/">FR</a></div></body></html>',
    )
    result = languages.extract_languages([en])
    assert result == {
        "declared": ["en-gb"],
        "detected": ["en"],
        "hreflang": [{"lang": "fr", "url": "https://x.com/fr/"}],
        "hasLanguageSwitcher": True,
    }
    assert languages.detect_languages([page("<p>Hi</p>")]) == []


# --- Technologies -----------------------------------------------------------------------------------------


def test_tech_database_is_vendored_with_license() -> None:
    vendor = Path(tech_db.VENDOR)
    assert (vendor / "LICENSE").read_text().startswith(" " * 20 + "GNU GENERAL PUBLIC LICENSE")
    assert len((vendor / "COMMIT").read_text().strip()) == 40
    database = tech_db.load_database()
    assert len(database) > 5000
    assert "jQuery" in tech_db.js_paths(database) or any("jQuery" in p for p in tech_db.js_paths(database))
    assert tech_db.dom_selectors(database)


def _observations(**changes: object) -> tech_db.Observations:
    base: dict[str, object] = {
        "headers": {},
        "cookies": {},
        "meta": {},
        "script_src": [],
        "html": "",
        "urls": [],
        "js": {},
        "dom": set(),
    }
    base.update(changes)
    return tech_db.Observations(**base)  # type: ignore[arg-type]


def test_tech_identification_signals() -> None:
    found = {
        t["name"]: t
        for t in tech_db.identify(
            _observations(
                headers={"x-powered-by": "PHP/8.2.0"},
                meta={"generator": ["WordPress 6.4.2"]},
                cookies={"_shopify_y": "1"},
                js={"jQuery.fn.jquery": "3.7.1"},
                script_src=["https://www.googletagmanager.com/gtag/js?id=G-1"],
            )
        )
    }
    assert found["WordPress"]["version"] == "6.4.2"
    assert found["PHP"]["version"] == "8.2.0"
    assert found["jQuery"]["version"] == "3.7.1"
    assert "Shopify" in found
    assert tech_db.identify(_observations()) == []


def test_tech_pattern_parsing() -> None:
    pattern = tech_db._parse("^Foo ([\\d.]+)\\;version:\\1\\;confidence:40")
    assert pattern is not None
    assert pattern.confidence == 40
    assert tech_db._parse("(unclosed") is None
    ternary = tech_db._parse("(x)?\\;version:\\1?a:b")
    assert ternary is not None
    match = ternary.regex.search("x")
    assert match is not None
    assert tech_db._version(ternary, match) is None
