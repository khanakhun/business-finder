"""Area filters for point places: a bounding box for SQL pushdown, then exact point-in-polygon in Python.

Places are points, so no spatial extension is needed (and tests run offline).
"""

from dataclasses import dataclass
from itertools import pairwise

from app.contracts.problem_details import Code
from app.errors import IntelError

MAX_VERTICES = 10_000

type Ring = list[tuple[float, float]]  # [(lng, lat), ...] closed
type PolygonRings = list[Ring]  # outer ring first, then holes


@dataclass(frozen=True)
class BBox:
    west: float
    south: float
    east: float
    north: float

    def contains(self, lng: float, lat: float) -> bool:
        return self.west <= lng <= self.east and self.south <= lat <= self.north

    @property
    def area_deg2(self) -> float:
        return (self.east - self.west) * (self.north - self.south)


@dataclass(frozen=True)
class Area:
    """A query area: its bbox and, for polygons, the rings to test points against."""

    bbox: BBox
    polygons: tuple[PolygonRings, ...] = ()

    def contains(self, lng: float, lat: float) -> bool:
        if not self.bbox.contains(lng, lat):
            return False
        return not self.polygons or any(_in_polygon(lng, lat, rings) for rings in self.polygons)


def _in_ring(lng: float, lat: float, ring: Ring) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in pairwise(ring):
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _in_polygon(lng: float, lat: float, rings: PolygonRings) -> bool:
    outer, *holes = rings
    return _in_ring(lng, lat, outer) and not any(_in_ring(lng, lat, hole) for hole in holes)


def area_from_contract(geometry: dict[str, object]) -> Area:
    """`{type: BBox, bbox}` | GeoJSON Polygon | MultiPolygon (validated by the contract) → Area."""
    kind = geometry["type"]
    if kind == "BBox":
        box = geometry["bbox"]
        if not isinstance(box, dict):
            raise TypeError("bbox must be an object")
        bbox = BBox(float(box["west"]), float(box["south"]), float(box["east"]), float(box["north"]))
        if bbox.west > bbox.east or bbox.south > bbox.north:
            raise IntelError(Code.VALIDATION_FAILED, "The box must have west ≤ east and south ≤ north.")
        return Area(bbox)
    coordinates = geometry["coordinates"]
    if not isinstance(coordinates, list):
        raise TypeError("coordinates must be a list")
    polygons: list[PolygonRings] = (
        [_rings(coordinates)] if kind == "Polygon" else [_rings(polygon) for polygon in coordinates]
    )
    if sum(len(ring) for rings in polygons for ring in rings) > MAX_VERTICES:
        raise IntelError(Code.VALIDATION_FAILED, f"At most {MAX_VERTICES} vertices.")
    points = [point for rings in polygons for point in rings[0]]
    lngs = [p[0] for p in points]
    lats = [p[1] for p in points]
    return Area(BBox(min(lngs), min(lats), max(lngs), max(lats)), tuple(polygons))


def _rings(polygon: object) -> PolygonRings:
    if not isinstance(polygon, list):
        raise TypeError("polygon must be a list of rings")
    return [[(float(p[0]), float(p[1])) for p in ring] for ring in polygon]
