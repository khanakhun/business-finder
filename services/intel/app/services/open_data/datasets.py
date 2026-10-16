"""Per-dataset SQL. Values are bound as parameters; only server-built source paths and validated floats are
inlined (table functions and COPY do not take parameters)."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.services.open_data import mapping

# Overture places are points: their bbox min corner is the point (Overture DuckDB guide).
OVERTURE_SELECT = """
    SELECT id, names.primary AS name, basic_category, taxonomy.primary AS taxonomy_primary,
           taxonomy.alternates AS alternates, bbox.xmin AS lng, bbox.ymin AS lat, confidence,
           websites, socials, emails, phones, brand.names.primary AS brand, addresses, operating_status,
           sources
    FROM {source}
    WHERE bbox.xmin BETWEEN $west AND $east AND bbox.ymin BETWEEN $south AND $north
      AND names.primary IS NOT NULL
      AND (len($categories) = 0 OR list_contains($categories, basic_category))
      AND id > $after
    ORDER BY id
    LIMIT $limit
"""
OVERTURE_EXTRACT = (
    "SELECT * FROM {source} "
    "WHERE bbox.xmin BETWEEN {west} AND {east} AND bbox.ymin BETWEEN {south} AND {north}"
)

FOURSQUARE_SELECT = """
    SELECT fsq_place_id AS id, name, fsq_category_ids, fsq_category_labels,
           CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lng,
           address, locality, postcode, region, country, tel, website, email,
           facebook_id, instagram, twitter
    FROM {source}
    WHERE CAST(latitude AS DOUBLE) BETWEEN $south AND $north
      AND CAST(longitude AS DOUBLE) BETWEEN $west AND $east
      AND date_closed IS NULL
      AND name IS NOT NULL
      AND (len($categories) = 0 OR list_has_any(fsq_category_ids, $categories))
      AND fsq_place_id > $after
    ORDER BY fsq_place_id
    LIMIT $limit
"""
FOURSQUARE_EXTRACT = (
    "SELECT * FROM {source} WHERE CAST(latitude AS DOUBLE) BETWEEN {south} AND {north} "
    "AND CAST(longitude AS DOUBLE) BETWEEN {west} AND {east}"
)


@dataclass(frozen=True)
class DatasetSpec:
    name: str
    select_sql: str
    extract_sql: str
    to_place: Callable[[Mapping[str, Any]], dict[str, object] | None]


DATASETS: dict[str, DatasetSpec] = {
    "overture": DatasetSpec("overture", OVERTURE_SELECT, OVERTURE_EXTRACT, mapping.overture_place),
    "foursquare": DatasetSpec("foursquare", FOURSQUARE_SELECT, FOURSQUARE_EXTRACT, mapping.foursquare_place),
}


def parquet_source(path: str) -> str:
    """A `read_parquet` call on a server-built path (quotes rejected, never user input)."""
    if "'" in path or "\\" in path:
        raise ValueError("unsafe parquet path")
    return f"read_parquet('{path}', hive_partitioning = false, union_by_name = true)"
