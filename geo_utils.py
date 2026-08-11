"""Utilidades para parsear geometrías WKT y prepararlas para el análisis en GFW.

Los puntos se convierten en un polígono circular (buffer) medido en metros
usando una proyección UTM local, para que el radio sea preciso sin importar
en qué parte del mundo esté el punto. Los polígonos se usan tal cual.
"""
from __future__ import annotations

from dataclasses import dataclass

import shapely.wkt
from pyproj import Geod, Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.database import query_utm_crs_info
from shapely.geometry import Point, Polygon, mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

_GEOD = Geod(ellps="WGS84")

SUPPORTED_TYPES = {"Point", "MultiPoint", "Polygon", "MultiPolygon"}


class GeometryParseError(ValueError):
    """Se lanza cuando el WKT no se puede interpretar o no está soportado."""


@dataclass
class ParsedGeometry:
    geometry: BaseGeometry
    geometry_type: str
    area_ha: float


def _utm_epsg_for(lon: float, lat: float) -> str:
    matches = query_utm_crs_info(
        datum_name="WGS 84",
        area_of_interest=AreaOfInterest(
            west_lon_degree=lon,
            south_lat_degree=lat,
            east_lon_degree=lon,
            north_lat_degree=lat,
        ),
    )
    if not matches:
        raise GeometryParseError("No se encontró una zona UTM para las coordenadas dadas")
    return matches[0].code


def _buffer_point_meters(point: Point, radius_m: float) -> Polygon:
    epsg_code = _utm_epsg_for(point.x, point.y)
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg_code}", always_xy=True)
    to_wgs84 = Transformer.from_crs(f"EPSG:{epsg_code}", "EPSG:4326", always_xy=True)

    x, y = to_utm.transform(point.x, point.y)
    buffered_utm = Point(x, y).buffer(radius_m, quad_segs=32)

    coords = [to_wgs84.transform(px, py) for px, py in buffered_utm.exterior.coords]
    return Polygon(coords)


def geodesic_area_ha(geometry: BaseGeometry) -> float:
    area_m2, _ = _GEOD.geometry_area_perimeter(geometry)
    return abs(area_m2) / 10_000


def parse_wkt(wkt_text: str, point_buffer_m: float) -> ParsedGeometry:
    """Convierte un texto WKT en una geometría lista para consultar en GFW."""
    if not isinstance(wkt_text, str) or not wkt_text.strip():
        raise GeometryParseError("WKT vacío")

    try:
        geometry = shapely.wkt.loads(wkt_text.strip())
    except Exception as exc:  # shapely lanza distintos tipos de error de parseo
        raise GeometryParseError(f"WKT inválido: {exc}") from exc

    if geometry.is_empty:
        raise GeometryParseError("La geometría está vacía")

    if geometry.geom_type not in SUPPORTED_TYPES:
        raise GeometryParseError(f"Tipo de geometría no soportado: {geometry.geom_type}")

    if geometry.geom_type == "Point":
        final_geom: BaseGeometry = _buffer_point_meters(geometry, point_buffer_m)
        geometry_type = f"Punto (buffer {int(point_buffer_m)} m)"
    elif geometry.geom_type == "MultiPoint":
        buffered = [_buffer_point_meters(p, point_buffer_m) for p in geometry.geoms]
        final_geom = unary_union(buffered)
        geometry_type = f"Multipunto (buffer {int(point_buffer_m)} m)"
    else:
        if not geometry.is_valid:
            geometry = geometry.buffer(0)
        final_geom = geometry
        geometry_type = geometry.geom_type

    return ParsedGeometry(
        geometry=final_geom,
        geometry_type=geometry_type,
        area_ha=geodesic_area_ha(final_geom),
    )


def to_geojson(geometry: BaseGeometry) -> dict:
    return mapping(geometry)
