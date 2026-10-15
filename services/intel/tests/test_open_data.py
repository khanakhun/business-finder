"""Open-data search against tiny local parquet fixtures in the Overture / Foursquare shapes (no network)."""

import asyncio
import json
from pathlib import Path

import duckdb
import httpx
import httpx2
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider

import app.services.open_data.service as module
from app.contracts.problem_details import Code
from app.errors import IntelError
from app.main import create_app
from app.services.open_data import cache, cursor
from app.services.open_data.geometry import BBox, area_from_contract
from app.services.open_data.mapping import foursquare_place, overture_place
from app.services.open_data.releases import ReleaseResolver
from app.services.open_data.service import OpenDataService
from app.settings import Settings
from tests.conftest import NOW, Signer

RELEASE = "2026-09-23.1"
FSQ_RELEASE = "2026-09-15"
PATH = "/v1/open-data/places/search"
BL = {"type": "BBox", "bbox": {"west": -62.88, "south": 17.87, "east": -62.79, "north": 17.93}}

# Fictional places in Saint-Barthélemy (and one outside the island).
OVERTURE_ROWS = [
    (
        "08f-001",
        "Café Fictif",
        "cafe",
        -62.8499,
        17.8963,
        "open",
        "https://cafe-fictif.example",
        "+590 590 00 00 01",
    ),
    ("08f-002", "Salon Démo", "hair_salon", -62.8270, 17.9020, None, None, None),
    ("08f-003", "Boulangerie Test", "bakery", -62.8180, 17.9040, "temporarily_closed", None, None),
    ("08f-004", "Café Lointain", "cafe", -63.0500, 18.0700, "open", None, None),
    ("08f-005", None, "cafe", -62.8400, 17.9000, "open", None, None),
]


def write_overture(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for pid, name, category, lng, lat, status, website, phone in OVERTURE_ROWS:

        def lit(value: object) -> str:
            return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"

        rows.append(
            f"""SELECT {lit(pid)} AS id,
              struct_pack("primary" := {lit(name)}::VARCHAR) AS names,
              {lit(category)} AS basic_category,
              struct_pack("primary" := {lit(category)}, hierarchy := ['food_and_drink', {lit(category)}],
                          alternates := ['coffee_shop']) AS taxonomy,
              0.92 AS confidence,
              {f"[{lit(website)}]" if website else "NULL::VARCHAR[]"} AS websites,
              NULL::VARCHAR[] AS socials, NULL::VARCHAR[] AS emails,
              {f"[{lit(phone)}]" if phone else "NULL::VARCHAR[]"} AS phones,
              struct_pack(wikidata := NULL::VARCHAR,
                          names := struct_pack("primary" := NULL::VARCHAR)) AS brand,
              [struct_pack(freeform := '12 Rue de l''Exemple', locality := 'Gustavia', postcode := '97133',
                           region := NULL::VARCHAR, country := 'BL')] AS addresses,
              {lit(status)}::VARCHAR AS operating_status,
              [struct_pack(dataset := 'meta', license := 'CDLA-Permissive-2.0',
                           record_id := {lit(pid)})] AS sources,
              struct_pack(xmin := {lng}, xmax := {lng}, ymin := {lat}, ymax := {lat}) AS bbox"""
        )
    duckdb.execute(f"COPY ({' UNION ALL '.join(rows)}) TO '{path}' (FORMAT parquet)")


def write_foursquare(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    duckdb.execute(
        f"""COPY (
          SELECT * FROM (VALUES
            ('fsq-1', 'Pizzeria Exemple', ['4bf58dd8d48988d1ca941735'], ['Dining and Drinking > Pizzeria'],
             17.8970, -62.8495, 'Rue du Test', 'Gustavia', '97133', NULL, 'BL', '+590 590 00 00 02',
             'https://pizzeria.example', NULL, 'pizzeria.fb', 'pizzeria_ig', NULL, NULL::DATE),
            ('fsq-2', 'Ancien Bar', ['4bf58dd8d48988d116941735'], ['Dining and Drinking > Bar'],
             17.9000, -62.8400, NULL, 'Gustavia', NULL, NULL, 'BL', NULL, NULL, NULL, NULL, NULL, NULL,
             DATE '2025-01-01')
          ) AS t(fsq_place_id, name, fsq_category_ids, fsq_category_labels, latitude, longitude, address,
                 locality, postcode, region, country, tel, website, email, facebook_id, instagram, twitter,
                 date_closed)
        ) TO '{path}' (FORMAT parquet)"""
    )


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    write_overture(tmp_path / "overture" / RELEASE / "part-0.parquet")
    write_foursquare(tmp_path / "foursquare" / FSQ_RELEASE / "places-0.parquet")
    return tmp_path


@pytest.fixture
def od_settings(settings: Settings, data_dir: Path) -> Settings:
    return settings.model_copy(
        update={
            "open_data_cache_dir": str(data_dir / "cache"),
            "overture_source_url": str(data_dir / "overture" / "{release}" / "*.parquet"),
            "foursquare_source_url": str(data_dir / "foursquare" / "{release}" / "*.parquet"),
            "overture_release": RELEASE,
            "foursquare_release": FSQ_RELEASE,
        }
    )


@pytest.fixture
def od_client(od_settings: Settings, tracer_provider: TracerProvider) -> TestClient:
    app: FastAPI = create_app(od_settings, tracer_provider=tracer_provider, clock=lambda: NOW)
    return TestClient(app, raise_server_exceptions=False)


def search(client: TestClient, signed: Signer, body: dict[str, object]) -> httpx2.Response:
    payload = json.dumps({"limit": 200, "categories": [], **body}).encode()
    return client.post(PATH, content=payload, headers=signed("POST", PATH, payload))


def test_overture_bbox_and_categories(od_client: TestClient, signed: Signer) -> None:
    response = search(
        od_client, signed, {"dataset": "overture", "geometry": BL, "categories": ["cafe", "hair_salon"]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["release"] == RELEASE
    assert body["cached"] is False
    assert [p["name"] for p in body["places"]] == ["Café Fictif", "Salon Démo"]
    cafe = body["places"][0]
    assert cafe["websites"] == ["https://cafe-fictif.example"]
    assert cafe["phones"] == ["+590 590 00 00 01"]
    assert cafe["categories"][:2] == [{"key": "cafe", "label": None}, {"key": "coffee_shop", "label": None}]
    assert cafe["address"] == {
        "line1": "12 Rue de l'Exemple",
        "city": "Gustavia",
        "postalCode": "97133",
        "region": None,
        "countryCode": "BL",
    }
    assert cafe["sources"] == [{"dataset": "meta", "recordId": "08f-001", "license": "CDLA-Permissive-2.0"}]
    assert cafe["location"] == {"lat": 17.8963, "lng": -62.8499}

    again = search(od_client, signed, {"dataset": "overture", "geometry": BL, "categories": ["bakery"]})
    assert again.json()["cached"] is True
    assert [p["operatingStatus"] for p in again.json()["places"]] == ["temporarily_closed"]


def test_polygon_filter_and_cursor_paging(od_client: TestClient, signed: Signer) -> None:
    # A polygon around Gustavia only.
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[-62.86, 17.89], [-62.84, 17.89], [-62.84, 17.91], [-62.86, 17.91], [-62.86, 17.89]]
        ],
    }
    inside = search(od_client, signed, {"dataset": "overture", "geometry": polygon})
    assert [p["name"] for p in inside.json()["places"]] == ["Café Fictif"]

    first = search(od_client, signed, {"dataset": "overture", "geometry": BL, "limit": 1})
    assert len(first.json()["places"]) == 1
    token = first.json()["nextCursor"]
    assert token
    second = search(od_client, signed, {"dataset": "overture", "geometry": BL, "limit": 5, "cursor": token})
    assert [p["name"] for p in second.json()["places"]] == ["Salon Démo", "Boulangerie Test"]
    assert second.json()["nextCursor"] is None


def test_foursquare_needs_a_token_and_skips_closed_places(od_client: TestClient, signed: Signer) -> None:
    refused = search(od_client, signed, {"dataset": "foursquare", "geometry": BL})
    assert refused.status_code == 422
    response = search(
        od_client, signed, {"dataset": "foursquare", "geometry": BL, "hfToken": "hf_fakeTokenForTests123456"}
    )
    assert response.status_code == 200, response.text
    places = response.json()["places"]
    assert [p["name"] for p in places] == ["Pizzeria Exemple"]
    assert places[0]["categories"] == [{"key": "4bf58dd8d48988d1ca941735", "label": "Pizzeria"}]
    assert places[0]["socials"] == [
        "https://www.facebook.com/pizzeria.fb",
        "https://www.instagram.com/pizzeria_ig",
    ]
    assert places[0]["sources"][0]["license"] == "Apache-2.0"


def test_requests_must_be_signed_and_valid(od_client: TestClient, signed: Signer) -> None:
    payload = json.dumps({"dataset": "overture", "geometry": BL, "categories": [], "limit": 10}).encode()
    assert (
        od_client.post(PATH, content=payload, headers={"Content-Type": "application/json"}).status_code == 401
    )
    bad = search(od_client, signed, {"dataset": "overture", "geometry": BL, "cursor": "not-a-cursor"})
    assert bad.status_code == 422
    other = cursor.encode("overture", "2026-08-19.0", "08f-001")
    assert (
        search(od_client, signed, {"dataset": "overture", "geometry": BL, "cursor": other}).status_code == 422
    )
    assert search(od_client, signed, {"dataset": "osm", "geometry": BL}).status_code == 422


def test_missing_release_is_not_found(od_client: TestClient, signed: Signer) -> None:
    response = search(od_client, signed, {"dataset": "overture", "geometry": BL, "release": "2025-01-01.0"})
    assert response.status_code == 404
    # No partial extract or temp file is left behind.
    cache_root = Path(od_client.app.state.settings.open_data_cache_dir)  # type: ignore[attr-defined]
    assert not list(cache_root.rglob("*.tmp"))
    assert not list(cache_root.glob("overture/2025-01-01.0/*.parquet"))


def test_extract_cache_keys() -> None:
    snapped = cache.snap(BBox(-62.88, 17.87, -62.79, 17.93))
    assert snapped == BBox(-62.9, 17.8, -62.7, 18.0)
    key = cache.extract_key("overture", RELEASE, BBox(-62.88, 17.87, -62.79, 17.93))
    assert key is not None
    assert key.relative == "overture/2026-09-23.1/-0062.90_+017.80_-0062.70_+018.00.parquet"
    assert cache.extract_key("overture", RELEASE, BBox(-63, 17, -61, 19)) is None
    with pytest.raises(ValueError, match="unsafe"):
        _ = cache.ExtractKey("../etc", RELEASE, snapped).relative


def test_area_point_in_polygon_with_hole() -> None:
    outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    area = area_from_contract({"type": "MultiPolygon", "coordinates": [[outer, hole]]})
    assert area.contains(1, 1)
    assert not area.contains(5, 5)
    assert not area.contains(11, 1)


def test_mapping_bounds_and_skips() -> None:
    assert overture_place({"id": "x", "name": " ", "lat": 1, "lng": 1}) is None
    assert foursquare_place({"id": "x", "name": "N", "lat": None, "lng": 1}) is None
    place = overture_place(
        {
            "id": "x",
            "name": "N" * 400,
            "lat": 1.0,
            "lng": 2.0,
            "basic_category": "cafe",
            "phones": ["1" * 80, "1" * 80],
            "confidence": 3,
            "operating_status": "weird",
            "addresses": [{"country": "France"}],
        }
    )
    assert place is not None
    assert len(str(place["name"])) == 300
    assert place["phones"] == ["1" * 40]
    assert place["confidence"] == 1.0
    assert place["operatingStatus"] is None
    assert place["address"]["countryCode"] is None  # type: ignore[index]


@respx.mock
async def test_release_resolver_uses_stac_latest_and_caches() -> None:
    route = respx.get("https://stac.example.test/catalog.json").mock(
        return_value=httpx.Response(200, json={"latest": "2026-09-23.1"})
    )
    resolver = ReleaseResolver(
        stac_url="https://stac.example.test/catalog.json", pinned_overture=None, foursquare=FSQ_RELEASE
    )
    assert await resolver.resolve("overture", None) == "2026-09-23.1"
    assert await resolver.resolve("overture", None) == "2026-09-23.1"
    assert route.call_count == 1
    assert await resolver.resolve("overture", "2026-08-19.0") == "2026-08-19.0"
    assert await resolver.resolve("foursquare", None) == FSQ_RELEASE


@respx.mock
async def test_release_catalog_failure_is_an_upstream_error() -> None:
    respx.get("https://stac.example.test/catalog.json").mock(return_value=httpx.Response(503))
    resolver = ReleaseResolver(
        stac_url="https://stac.example.test/catalog.json", pinned_overture=None, foursquare=FSQ_RELEASE
    )
    with pytest.raises(IntelError) as raised:
        await resolver.resolve("overture", None)
    assert raised.value.code == Code.EXTERNAL_SERVICE_FAILED


async def test_slow_queries_are_interrupted(od_settings: Settings) -> None:
    service = OpenDataService(
        od_settings.model_copy(update={"open_data_query_timeout_seconds": 0.05}),
        ReleaseResolver(stac_url="https://unused.test", pinned_overture=RELEASE, foursquare=FSQ_RELEASE),
    )

    def slow(con: duckdb.DuckDBPyConnection) -> object:
        con.execute("SELECT count(*) FROM range(100000000000) a")
        raise AssertionError("not interrupted")

    with pytest.raises(IntelError) as raised:
        await service._run(slow)  # type: ignore[arg-type]
    assert raised.value.code == Code.EXTERNAL_SERVICE_FAILED
    await asyncio.sleep(0)


def test_rejects_inverted_boxes_huge_polygons_and_odd_tokens(od_client: TestClient, signed: Signer) -> None:
    inverted = {"type": "BBox", "bbox": {"west": -62.79, "south": 17.87, "east": -62.88, "north": 17.93}}
    assert search(od_client, signed, {"dataset": "overture", "geometry": inverted}).status_code == 422
    ring = [[i / 10_000, (i % 7) / 10_000] for i in range(10_001)]
    huge = {"type": "Polygon", "coordinates": [[*ring, ring[0]]]}
    assert search(od_client, signed, {"dataset": "overture", "geometry": huge}).status_code == 422
    newline = search(
        od_client, signed, {"dataset": "foursquare", "geometry": BL, "hfToken": "hf_fakeTokenForTests1\n"}
    )
    assert newline.status_code == 422


def test_cache_drops_old_releases_and_stays_under_its_cap(od_settings: Settings, data_dir: Path) -> None:
    cache_dir = data_dir / "cache"
    old = cache_dir / "overture" / "2026-08-19.0"
    old.mkdir(parents=True)
    (old / "stale.parquet").write_bytes(b"x" * 10)
    other = cache_dir / "foursquare" / FSQ_RELEASE
    other.mkdir(parents=True)
    big = other / "+000.00_+00.00_+000.10_+00.10.parquet"
    big.write_bytes(b"x" * (200 * 1024 * 1024))
    service = OpenDataService(
        od_settings.model_copy(update={"open_data_cache_max_mb": 100}),
        ReleaseResolver(stac_url="https://unused.test", pinned_overture=RELEASE, foursquare=FSQ_RELEASE),
    )
    key = cache.extract_key("overture", RELEASE, BBox(-62.88, 17.87, -62.79, 17.93))
    assert key is not None
    path = cache.local_path(cache_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"y" * 100)
    service._evict(key)
    assert not old.exists()  # another release of the same dataset
    assert not big.exists()  # least recently used, beyond the cap
    assert path.exists()  # the extract just written is kept


async def test_busy_slots_answer_429(od_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "SLOT_WAIT_SECONDS", 0.05)
    service = OpenDataService(
        od_settings,
        ReleaseResolver(stac_url="https://unused.test", pinned_overture=RELEASE, foursquare=FSQ_RELEASE),
    )
    for _ in range(module.MAX_CONCURRENT_QUERIES):
        await service._slots.acquire()
    with pytest.raises(IntelError) as raised:
        await service._run(lambda _con: None)  # type: ignore[arg-type,return-value]
    assert raised.value.code == Code.RATE_LIMITED


@respx.mock
async def test_release_catalog_names_are_validated() -> None:
    respx.get("https://stac.example.test/catalog.json").mock(
        return_value=httpx.Response(200, json={"latest": "../x"})
    )
    resolver = ReleaseResolver(
        stac_url="https://stac.example.test/catalog.json", pinned_overture=None, foursquare=FSQ_RELEASE
    )
    with pytest.raises(IntelError):
        await resolver.resolve("overture", None)
