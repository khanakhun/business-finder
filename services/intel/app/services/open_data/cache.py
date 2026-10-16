"""Regional extracts: the first query for an area copies the dataset rows inside a grid-snapped bbox to a
local parquet file (optionally mirrored to the artifacts bucket); later queries for that area read the
extract. Keys include the release, so a new release starts a new cache (TTL = until the next release)."""

import math
import re
from dataclasses import dataclass
from pathlib import Path

from app.services.open_data.geometry import BBox

GRID_DEG = 0.1
# Larger areas are queried directly: an extract that big would be slow to build and rarely reused.
MAX_EXTRACT_AREA_DEG2 = 1.0
_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True)
class ExtractKey:
    dataset: str
    release: str
    bbox: BBox

    @property
    def name(self) -> str:
        b = self.bbox
        return f"{b.west:+08.2f}_{b.south:+07.2f}_{b.east:+08.2f}_{b.north:+07.2f}.parquet"

    @property
    def relative(self) -> str:
        if not (_SAFE.match(self.dataset) and _SAFE.match(self.release)):
            raise ValueError("unsafe cache key")
        return f"{self.dataset}/{self.release}/{self.name}"


def snap(bbox: BBox) -> BBox:
    """Outward to the grid, so nearby queries share an extract."""

    def down(value: float) -> float:
        return round(math.floor(value / GRID_DEG) * GRID_DEG, 2)

    def up(value: float) -> float:
        return round(math.ceil(value / GRID_DEG) * GRID_DEG, 2)

    return BBox(
        max(-180.0, down(bbox.west)),
        max(-90.0, down(bbox.south)),
        min(180.0, up(bbox.east)),
        min(90.0, up(bbox.north)),
    )


def extract_key(dataset: str, release: str, bbox: BBox) -> ExtractKey | None:
    snapped = snap(bbox)
    return ExtractKey(dataset, release, snapped) if snapped.area_deg2 <= MAX_EXTRACT_AREA_DEG2 else None


def local_path(cache_dir: Path, key: ExtractKey) -> Path:
    return cache_dir / key.relative
