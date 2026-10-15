"""DuckDB rows → `OpenDataPlace` dictionaries (contract limits applied: values are cut, never rejected)."""

from collections.abc import Iterable, Mapping
from typing import Any

_STATUSES = {"open", "temporarily_closed", "permanently_closed"}


def _text(value: object, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] or None


def _texts(values: Iterable[object] | None, limit: int, max_items: int = 10) -> list[str]:
    out: list[str] = []
    for value in values or ():
        text = _text(value, limit)
        if text and text not in out:
            out.append(text)
        if len(out) == max_items:
            break
    return out


def _country(value: object) -> str | None:
    text = _text(value, 10)
    return text.upper() if text and len(text) == 2 and text.isalpha() else None


def _categories(pairs: Iterable[tuple[object, object]]) -> list[dict[str, str | None]]:
    out: list[dict[str, str | None]] = []
    for key, label in pairs:
        k = _text(key, 200)
        if k and all(c["key"] != k for c in out):
            out.append({"key": k, "label": _text(label, 200)})
    return out[:30]


def overture_place(row: Mapping[str, Any]) -> dict[str, object] | None:
    name = _text(row.get("name"), 300)
    if not name or row.get("lat") is None or row.get("lng") is None:
        return None
    taxonomy_keys = [row.get("basic_category"), row.get("taxonomy_primary"), *(row.get("alternates") or [])]
    addresses = row.get("addresses") or []
    address = addresses[0] if addresses else {}
    status = row.get("operating_status")
    return {
        "id": str(row["id"])[:200],
        "name": name,
        "categories": _categories((key, None) for key in taxonomy_keys),
        "location": {"lat": float(row["lat"]), "lng": float(row["lng"])},
        "address": {
            "line1": _text(address.get("freeform"), 300),
            "city": _text(address.get("locality"), 120),
            "postalCode": _text(address.get("postcode"), 20),
            "region": _text(address.get("region"), 120),
            "countryCode": _country(address.get("country")),
        },
        "phones": _texts(row.get("phones"), 40),
        "websites": _texts(row.get("websites"), 2_000),
        "emails": _texts(row.get("emails"), 254),
        "socials": _texts(row.get("socials"), 500),
        "operatingStatus": status if status in _STATUSES else None,
        "confidence": max(0.0, min(1.0, float(row["confidence"])))
        if row.get("confidence") is not None
        else None,
        "brand": _text(row.get("brand"), 200),
        "sources": [
            {
                "dataset": _text(source.get("dataset"), 120) or "overture",
                "recordId": _text(source.get("record_id"), 300),
                "license": _text(source.get("license"), 120),
            }
            for source in (row.get("sources") or [])[:20]
        ],
    }


def _social(prefix: str, handle: object) -> str | None:
    text = _text(handle, 200)
    return f"{prefix}{text}" if text else None


def foursquare_place(row: Mapping[str, Any]) -> dict[str, object] | None:
    name = _text(row.get("name"), 300)
    if not name or row.get("lat") is None or row.get("lng") is None:
        return None
    ids = row.get("fsq_category_ids") or []
    labels = row.get("fsq_category_labels") or []
    # Labels are breadcrumbs ("Dining and Drinking > Cafe"): keep the most specific part.
    pairs = [
        (category_id, str(labels[i]).split(">")[-1].strip() if i < len(labels) and labels[i] else None)
        for i, category_id in enumerate(ids)
    ]
    socials = [
        _social("https://www.facebook.com/", row.get("facebook_id")),
        _social("https://www.instagram.com/", row.get("instagram")),
        _social("https://x.com/", row.get("twitter")),
    ]
    return {
        "id": str(row["id"])[:200],
        "name": name,
        "categories": _categories(pairs),
        "location": {"lat": float(row["lat"]), "lng": float(row["lng"])},
        "address": {
            "line1": _text(row.get("address"), 300),
            "city": _text(row.get("locality"), 120),
            "postalCode": _text(row.get("postcode"), 20),
            "region": _text(row.get("region"), 120),
            "countryCode": _country(row.get("country")),
        },
        "phones": _texts([row.get("tel")], 40),
        "websites": _texts([row.get("website")], 2_000),
        "emails": _texts([row.get("email")], 254),
        "socials": _texts(socials, 500),
        # Closed places are filtered out in SQL (`date_closed IS NULL`).
        "operatingStatus": None,
        "confidence": None,
        "brand": None,
        "sources": [{"dataset": "foursquare", "recordId": str(row["id"])[:300], "license": "Apache-2.0"}],
    }
