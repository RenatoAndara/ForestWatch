#!/usr/bin/env python3
"""
Motor de validación y reparación GeoJSON (RFC 7946 / topología OGC / EUDR).

Autor: Renato Andara

Versión Python equivalente a js/validator.js y js/repair.js (mismas reglas,
mismas categorías y mismos resultados; las pruebas de ambos lenguajes usan los
mismos archivos de tests/fixtures). Solo usa la biblioteca estándar.

Uso desde la línea de comandos:
    python geojson_validator.py archivo.geojson [otro.geojson ...]
    python geojson_validator.py archivo.geojson --json
    python geojson_validator.py archivo.geojson --reparar salida.geojson
    python geojson_validator.py archivo.geojson --csv reporte.csv

Código de salida: 0 si no hay errores, 1 si algún archivo tiene errores, 2 si
no se pudo leer un archivo.
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

__author__ = "Renato Andara"
__version__ = "2.0.0"


class ValidationSeverity:
    ERROR = "ERROR"
    WARNING = "ALERTA"
    INFO = "INFO"


SEVERITY_RANK = {"VALIDO": 0, "INFO": 0, "ALERTA": 1, "ERROR": 2}
MAX_ISSUES_PER_RING = 25
COLLINEAR_EPS = 1e-10
GEOMETRY_TYPES = ("Point", "MultiPoint", "LineString", "MultiLineString",
                  "Polygon", "MultiPolygon", "GeometryCollection")


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_position(p: Any) -> bool:
    return isinstance(p, list) and len(p) >= 2 and _is_num(p[0]) and _is_num(p[1])


def _fmt(n: float) -> str:
    """Formatea un número como lo haría JavaScript (sin '.0' en enteros)."""
    return str(int(n)) if isinstance(n, float) and n.is_integer() else str(n)


# ----------------------------------------------------------------------
# Utilidades geométricas
# ----------------------------------------------------------------------
class GeoUtils:
    @staticmethod
    def same_point(a, b) -> bool:
        return a[0] == b[0] and a[1] == b[1]

    @staticmethod
    def key(p) -> Tuple[float, float]:
        return (p[0], p[1])

    @staticmethod
    def orient(a, b, c) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    @classmethod
    def orient_sign(cls, a, b, c) -> int:
        o = cls.orient(a, b, c)
        scale = math.hypot(b[0] - a[0], b[1] - a[1]) * math.hypot(c[0] - a[0], c[1] - a[1])
        if abs(o) <= COLLINEAR_EPS * scale:
            return 0
        return 1 if o > 0 else -1

    @staticmethod
    def within_box(p, a, b) -> bool:
        return (min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and
                min(a[1], b[1]) <= p[1] <= max(a[1], b[1]))

    @classmethod
    def point_on_segment(cls, p, a, b) -> bool:
        return cls.orient_sign(a, b, p) == 0 and cls.within_box(p, a, b)

    @staticmethod
    def line_intersection(p1, p2, p3, p4) -> Optional[List[float]]:
        denom = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0])
        if denom == 0:
            return None
        t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / denom
        return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]

    @classmethod
    def segment_relation(cls, p1, p2, q1, q2) -> Optional[Dict[str, Any]]:
        """None | {'type': 'cross'|'touch'|'overlap', 'point': [x, y]}"""
        d1 = cls.orient_sign(q1, q2, p1)
        d2 = cls.orient_sign(q1, q2, p2)
        d3 = cls.orient_sign(p1, p2, q1)
        d4 = cls.orient_sign(p1, p2, q2)

        if d1 * d2 < 0 and d3 * d4 < 0:
            pt = cls.line_intersection(p1, p2, q1, q2) or list(p1[:2])
            return {"type": "cross", "point": pt}

        if d1 == 0 and d2 == 0 and d3 == 0 and d4 == 0:
            ax = 0 if abs(p2[0] - p1[0]) >= abs(p2[1] - p1[1]) else 1
            lo = max(min(p1[ax], p2[ax]), min(q1[ax], q2[ax]))
            hi = min(max(p1[ax], p2[ax]), max(q1[ax], q2[ax]))
            if lo > hi:
                return None
            shared = next((pt for pt in (p1, p2, q1, q2) if pt[ax] == lo and
                           cls.within_box(pt, p1, p2) and cls.within_box(pt, q1, q2)), p1)
            return {"type": "touch" if lo == hi else "overlap", "point": list(shared[:2])}

        if d1 == 0 and cls.within_box(p1, q1, q2):
            return {"type": "touch", "point": list(p1[:2])}
        if d2 == 0 and cls.within_box(p2, q1, q2):
            return {"type": "touch", "point": list(p2[:2])}
        if d3 == 0 and cls.within_box(q1, p1, p2):
            return {"type": "touch", "point": list(q1[:2])}
        if d4 == 0 and cls.within_box(q2, p1, p2):
            return {"type": "touch", "point": list(q2[:2])}
        return None

    @staticmethod
    def signed_area(ring) -> float:
        """Área con signo ×2 (Shoelace). > 0 → antihorario (CCW)."""
        return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))

    @classmethod
    def point_in_ring(cls, pt, ring) -> int:
        """1 dentro, 0 sobre el borde, -1 fuera."""
        n = len(ring)
        for i in range(n - 1):
            if cls.point_on_segment(pt, ring[i], ring[i + 1]):
                return 0
        x, y = pt[0], pt[1]
        inside = False
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return 1 if inside else -1

    @classmethod
    def point_in_polygon(cls, pt, rings) -> int:
        ext = cls.point_in_ring(pt, rings[0])
        if ext <= 0:
            return ext
        for hole in rings[1:]:
            r = cls.point_in_ring(pt, hole)
            if r == 0:
                return 0
            if r == 1:
                return -1
        return 1

    @staticmethod
    def bbox(points) -> List[float]:
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        return [min(xs), min(ys), max(xs), max(ys)]

    @staticmethod
    def bboxes_overlap(a, b) -> bool:
        return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])

    @classmethod
    def build_segments(cls, ring, ring_index: int) -> List[Dict[str, Any]]:
        segs = []
        for i in range(len(ring) - 1):
            a, b = ring[i], ring[i + 1]
            if cls.same_point(a, b):
                continue
            segs.append({"a": a, "b": b, "i": i, "ring": ring_index, "seq": len(segs),
                         "minX": min(a[0], b[0]), "maxX": max(a[0], b[0]),
                         "minY": min(a[1], b[1]), "maxY": max(a[1], b[1])})
        return segs

    @staticmethod
    def sweep_pairs(segs, cb) -> None:
        """Barrido por X; cb(s, t) devuelve False para detener."""
        srt = sorted(segs, key=lambda s: s["minX"])
        n = len(srt)
        for x in range(n):
            s = srt[x]
            for y in range(x + 1, n):
                t = srt[y]
                if t["minX"] > s["maxX"]:
                    break
                if t["maxY"] < s["minY"] or t["minY"] > s["maxY"]:
                    continue
                if cb(s, t) is False:
                    return

    @staticmethod
    def haversine(p1, p2) -> float:
        r = 6371008.8
        lat1, lat2 = math.radians(p1[1]), math.radians(p2[1])
        dlat = lat2 - lat1
        dlon = math.radians(p2[0] - p1[0])
        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @staticmethod
    def ring_area_m2(ring) -> float:
        r = 6378137.0
        area = 0.0
        for i in range(len(ring) - 1):
            p1, p2 = ring[i], ring[i + 1]
            area += math.radians(p2[0] - p1[0]) * (2 + math.sin(math.radians(p1[1])) + math.sin(math.radians(p2[1])))
        return abs(area * r * r / 2)

    @classmethod
    def polygon_metrics(cls, rings) -> Dict[str, float]:
        area = perim = 0.0
        vertices = 0
        for idx, ring in enumerate(rings):
            if not isinstance(ring, list) or len(ring) < 4:
                continue
            a = cls.ring_area_m2(ring)
            area += a if idx == 0 else -a
            vertices += len(ring) - 1
            if idx == 0:
                perim += sum(cls.haversine(ring[i], ring[i + 1]) for i in range(len(ring) - 1))
        return {"areaM2": max(0.0, area), "perimeterM": perim, "vertices": vertices}

    @staticmethod
    def decimals(n: Any) -> int:
        if not _is_num(n) or float(n).is_integer():
            return 0
        s = repr(float(n))
        if "e-" in s:
            mant, exp = s.split("e-")
            frac = len(mant.split(".")[1]) if "." in mant else 0
            return frac + int(exp)
        return len(s.split(".")[1]) if "." in s else 0

    @staticmethod
    def feature_label(feat: Any, f_idx: int) -> str:
        props = feat.get("properties") if isinstance(feat, dict) else None
        props = props if isinstance(props, dict) else {}
        for k in ("PlotID", "plotId", "plot_id", "ProductionPlace", "id", "ID", "Id", "name", "Name", "NOMBRE"):
            v = props.get(k)
            if v is not None and str(v).strip() != "":
                return str(v)
        if isinstance(feat, dict) and feat.get("id") not in (None, ""):
            return str(feat["id"])
        return f"Entidad #{f_idx + 1}"

    @staticmethod
    def feature_id(feat: Any) -> Optional[str]:
        if not isinstance(feat, dict):
            return None
        props = feat.get("properties") if isinstance(feat.get("properties"), dict) else {}
        for v in (props.get("PlotID"), props.get("plotId"), props.get("plot_id"), feat.get("id"), props.get("id")):
            if v is not None and str(v).strip() != "":
                return str(v)
        return None


# ----------------------------------------------------------------------
# Validador
# ----------------------------------------------------------------------
class GeoJSONValidator:
    def __init__(self) -> None:
        self.issues: List[Dict[str, Any]] = []
        self._stats = {"exteriorRings": 0, "ccwExteriors": 0, "points": 0}

    # --------------------------- Entrada ---------------------------
    def validate_file(self, filepath: str) -> Dict[str, Any]:
        try:
            with open(filepath, "r", encoding="utf-8-sig") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError) as e:
            self.issues = []
            self._add("ERROR", "Lectura de Archivo", f"No se pudo leer el archivo: {e}")
            return self._build_result([], None)
        return self.validate(text)

    def validate(self, data: Any) -> Dict[str, Any]:
        """Acepta texto JSON o un objeto ya parseado."""
        self.issues = []
        self._stats = {"exteriorRings": 0, "ccwExteriors": 0, "points": 0}

        if isinstance(data, (str, bytes)):
            text = data.decode("utf-8-sig") if isinstance(data, bytes) else data.lstrip("﻿")
            if not text.strip():
                self._add("ERROR", "Sintaxis JSON", "El archivo está vacío.")
                return self._build_result([], None)
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                self._add("ERROR", "Sintaxis JSON", f"El archivo no es un JSON válido: {e}")
                return self._build_result([], None)
        return self.validate_data(data)

    def validate_data(self, data: Any) -> Dict[str, Any]:
        self.issues = []
        self._stats = {"exteriorRings": 0, "ccwExteriors": 0, "points": 0}

        if not isinstance(data, dict):
            self._add("ERROR", "Estructura GeoJSON", "La raíz del archivo debe ser un objeto JSON.")
            return self._build_result([], data)

        root_type = data.get("type")
        if not root_type:
            self._add("ERROR", "Estructura GeoJSON", 'El objeto raíz no contiene la propiedad requerida "type".')
            return self._build_result([], data)

        if "crs" in data:
            self._add("ALERTA", "Sistema de Referencia (crs)",
                      'El miembro "crs" pertenece a la especificación GeoJSON 2008 y fue eliminado en RFC 7946 (§4): '
                      "las coordenadas deben estar siempre en WGS84 (longitud, latitud en grados decimales).",
                      details={"crs": data["crs"]})

        if root_type == "FeatureCollection":
            features = data.get("features")
            if not isinstance(features, list):
                self._add("ERROR", "Estructura GeoJSON", 'La propiedad "features" de FeatureCollection debe ser un arreglo.')
                return self._build_result([], data)
            if not features:
                self._add("ALERTA", "Estructura GeoJSON", "La FeatureCollection no contiene ninguna entidad (features vacío).")
        elif root_type == "Feature":
            features = [data]
        elif root_type in GEOMETRY_TYPES:
            features = [{"type": "Feature", "geometry": data, "properties": {}}]
        else:
            self._add("ERROR", "Estructura GeoJSON", f'Tipo GeoJSON no reconocido: "{root_type}".')
            return self._build_result([], data)

        polygons: List[Dict[str, Any]] = []
        info = [self._validate_feature(feat, i, polygons) for i, feat in enumerate(features)]
        self._check_duplicate_ids(features)
        if len(polygons) >= 2:
            self._check_inter_polygon_overlaps(polygons)
        self._add_summary_notes()
        return self._build_result(info, data)

    def _add(self, severity: str, category: str, message: str, feature_index: Optional[int] = None,
             plot_id: Optional[str] = None, location: Optional[List[float]] = None,
             details: Optional[Dict[str, Any]] = None, related_feature_index: Optional[int] = None) -> None:
        self.issues.append({
            "severity": severity, "category": category, "message": message,
            "feature_index": feature_index, "related_feature_index": related_feature_index,
            "plot_id": plot_id, "location": list(location[:2]) if location else None,
            "details": details or {},
        })

    # --------------------------- Entidades ---------------------------
    def _validate_feature(self, feat: Any, f_idx: int, polygons: List) -> Dict[str, Any]:
        info = {"index": f_idx, "plot_id": f"Entidad #{f_idx + 1}", "geometry_type": None,
                "area_ha": None, "perimeter_m": None, "vertices": 0}
        if not isinstance(feat, dict) or feat.get("type") != "Feature":
            self._add("ERROR", "Estructura Feature",
                      f'El elemento en el índice {f_idx} no es un Feature válido (se esperaba "type": "Feature").',
                      feature_index=f_idx)
            return info

        plot_id = GeoUtils.feature_label(feat, f_idx)
        info["plot_id"] = plot_id
        ctx = {"fIdx": f_idx, "plotId": plot_id}

        if "properties" not in feat:
            self._add("ALERTA", "Estructura Feature",
                      f'La entidad "{plot_id}" no tiene el miembro "properties" (RFC 7946 §3.2 lo exige, aunque sea null).',
                      feature_index=f_idx, plot_id=plot_id)

        geom = feat.get("geometry")
        if geom is None:
            self._add("ERROR", "Geometría Nula", f'La entidad "{plot_id}" no contiene geometría.', feature_index=f_idx, plot_id=plot_id)
            return info

        info["geometry_type"] = geom.get("type") if isinstance(geom, dict) else None
        metrics = {"areaM2": 0.0, "perimeterM": 0.0, "vertices": 0, "hasArea": False}
        self._validate_geometry(geom, ctx, plot_id, polygons, metrics)
        if isinstance(geom, dict):
            self._check_precision(geom, ctx)
        info["vertices"] = metrics["vertices"]
        if metrics["hasArea"]:
            info["area_ha"] = metrics["areaM2"] / 10000
            info["perimeter_m"] = metrics["perimeterM"]
        return info

    def _validate_geometry(self, geom: Any, ctx: Dict, label: str, polygons: List, metrics: Dict) -> None:
        f_idx, plot_id = ctx["fIdx"], ctx["plotId"]
        if not isinstance(geom, dict) or not geom.get("type"):
            self._add("ERROR", "Geometría Inválida", f'La geometría de "{label}" no tiene un "type" válido.', feature_index=f_idx, plot_id=plot_id)
            return
        g_type = geom["type"]
        if g_type == "GeometryCollection":
            members = geom.get("geometries")
            if not isinstance(members, list):
                self._add("ERROR", "Geometría Inválida", f'La GeometryCollection de "{label}" no tiene un arreglo "geometries".', feature_index=f_idx, plot_id=plot_id)
                return
            for k, g in enumerate(members):
                self._validate_geometry(g, ctx, f"{label} [Geom {k + 1}]", polygons, metrics)
            return
        if g_type not in GEOMETRY_TYPES:
            self._add("ERROR", "Tipo de Geometría", f'Tipo de geometría "{g_type}" no reconocido en "{label}".', feature_index=f_idx, plot_id=plot_id)
            return
        c = geom.get("coordinates")
        if not isinstance(c, list):
            self._add("ERROR", "Geometría Inválida", f'La geometría {g_type} de "{label}" no tiene un arreglo "coordinates".', feature_index=f_idx, plot_id=plot_id)
            return

        if g_type == "Point":
            self._stats["points"] += 1
            self._check_positions([c], ctx, f'punto de "{label}"')
            metrics["vertices"] += 1
        elif g_type == "MultiPoint":
            self._stats["points"] += 1
            self._check_positions(c, ctx, f'MultiPoint de "{label}"')
            metrics["vertices"] += len(c)
        elif g_type == "LineString":
            self._validate_line(c, ctx, label, metrics)
        elif g_type == "MultiLineString":
            for k, line in enumerate(c):
                self._validate_line(line, ctx, f"{label} [Línea {k + 1}]", metrics)
        elif g_type == "Polygon":
            self._validate_polygon(c, ctx, label, polygons, metrics)
        elif g_type == "MultiPolygon":
            if not c:
                self._add("ERROR", "Geometría Vacía", f'El MultiPolygon de "{label}" no contiene polígonos.', feature_index=f_idx, plot_id=plot_id)
            for k, poly in enumerate(c):
                self._validate_polygon(poly, ctx, f"{label} [Parte {k + 1}]" if len(c) > 1 else label, polygons, metrics, k)

    def _validate_line(self, line: Any, ctx: Dict, label: str, metrics: Dict) -> None:
        if not isinstance(line, list) or len(line) < 2:
            self._add("ERROR", "Vértices Insuficientes", f'La línea "{label}" necesita al menos 2 posiciones.', feature_index=ctx["fIdx"], plot_id=ctx["plotId"])
            return
        self._check_positions(line, ctx, f'línea "{label}"')
        metrics["vertices"] += len(line)

    def _check_positions(self, positions: Any, ctx: Dict, where: str) -> bool:
        f_idx, plot_id = ctx["fIdx"], ctx["plotId"]
        if not isinstance(positions, list):
            self._add("ERROR", "Coordenada Inválida", f"Las coordenadas del {where} no son un arreglo.", feature_index=f_idx, plot_id=plot_id)
            return False
        bad_idx, bad_count = -1, 0
        out_idx, out_count, out_pt = -1, 0, None
        swapped_possible = projected_likely = True
        extra_dims = 0
        for i, pt in enumerate(positions):
            if not _is_position(pt):
                if bad_idx < 0:
                    bad_idx = i
                bad_count += 1
                continue
            if len(pt) > 3:
                extra_dims += 1
            lon, lat = pt[0], pt[1]
            if lon < -180 or lon > 180 or lat < -90 or lat > 90:
                if out_idx < 0:
                    out_idx, out_pt = i, pt
                out_count += 1
                if not (abs(lat) <= 180 and abs(lon) <= 90):
                    swapped_possible = False
                if not (abs(lon) > 1000 or abs(lat) > 1000):
                    projected_likely = False

        if bad_count:
            self._add("ERROR", "Coordenada Inválida",
                      f"{bad_count} posición(es) del {where} no son de la forma [longitud, latitud] numérica (primera en el índice {bad_idx}).",
                      feature_index=f_idx, plot_id=plot_id, details={"firstIndex": bad_idx, "count": bad_count})
        if out_count:
            hint = ""
            if projected_likely:
                hint = " Los valores parecen coordenadas proyectadas (p. ej. UTM, en metros): RFC 7946 exige grados decimales WGS84; reproyecte a EPSG:4326."
            elif swapped_possible:
                hint = " Es posible que longitud y latitud estén invertidas: RFC 7946 exige el orden [longitud, latitud]."
            self._add("ERROR", "Límites WGS84",
                      f"{out_count} coordenada(s) del {where} fuera del rango WGS84 (lon ±180, lat ±90); "
                      f"primera: vértice {out_idx} [{_fmt(out_pt[0])}, {_fmt(out_pt[1])}].{hint}",
                      feature_index=f_idx, plot_id=plot_id, details={"firstIndex": out_idx, "count": out_count})
        if extra_dims:
            self._add("ALERTA", "Dimensiones de Coordenadas",
                      f"{extra_dims} posición(es) del {where} tienen más de 3 valores; RFC 7946 §3.1.1 recomienda usar solo [lon, lat] o [lon, lat, altitud].",
                      feature_index=f_idx, plot_id=plot_id)
        return bad_count == 0 and out_count == 0

    # --------------------------- Polígonos ---------------------------
    def _validate_polygon(self, rings: Any, ctx: Dict, label: str, polygons: List, metrics: Dict,
                          part_index: Optional[int] = None) -> None:
        f_idx = ctx["fIdx"]
        opt = {"feature_index": f_idx, "plot_id": label}
        if not isinstance(rings, list) or not rings:
            self._add("ERROR", "Geometría Vacía", f'El polígono "{label}" no tiene anillos de coordenadas.', **opt)
            return

        usable = True
        for r_idx, ring in enumerate(rings):
            ring_name = "anillo exterior" if r_idx == 0 else f"anillo interior (hueco {r_idx})"
            if not isinstance(ring, list):
                self._add("ERROR", "Geometría Inválida", f'El {ring_name} de "{label}" no es un arreglo de posiciones.', **opt)
                usable = False
                continue
            if not self._check_positions(ring, ctx, f'{ring_name} de "{label}"'):
                usable = False
                continue
            if len(ring) < 4:
                self._add("ERROR", "Vértices Insuficientes",
                          f'El {ring_name} de "{label}" tiene {len(ring)} posición(es); un anillo cerrado necesita al menos 4 (RFC 7946 §3.1.6).', **opt)
                usable = False
                continue
            first, last = ring[0], ring[-1]
            if not GeoUtils.same_point(first, last):
                self._add("ERROR", "Anillo Abierto",
                          f'El {ring_name} de "{label}" no está cerrado: el primer vértice [{_fmt(first[0])}, {_fmt(first[1])}] '
                          f"difiere del último [{_fmt(last[0])}, {_fmt(last[1])}].", location=first, **opt)
                usable = False

        metrics["vertices"] += sum(max(0, len(r) - 1) for r in rings if isinstance(r, list))
        if not usable:
            return

        for r_idx, ring in enumerate(rings):
            ring_name = "anillo exterior" if r_idx == 0 else f"anillo interior (hueco {r_idx})"
            self._check_duplicates(ring, ring_name, label, f_idx)
            distinct = len({GeoUtils.key(p) for p in ring[:-1]})
            if distinct < 3:
                self._add("ERROR", "Anillo Degenerado",
                          f'El {ring_name} de "{label}" tiene solo {distinct} vértice(s) distinto(s); no encierra superficie.',
                          location=ring[0], **opt)
                continue
            self._check_ring_self_intersections(ring, ring_name, label, f_idx)
            self._check_winding(ring, r_idx == 0, ring_name, label, f_idx)

        if len(rings) > 1:
            self._check_holes(rings, label, f_idx)

        m = GeoUtils.polygon_metrics(rings)
        metrics["areaM2"] += m["areaM2"]
        metrics["perimeterM"] += m["perimeterM"]
        metrics["hasArea"] = True
        polygons.append({"fIdx": f_idx, "plotId": label, "featureLabel": ctx["plotId"], "partIndex": part_index,
                         "rings": rings, "bbox": GeoUtils.bbox(rings[0])})

    def _check_duplicates(self, ring, ring_name: str, label: str, f_idx: int) -> None:
        dups = [i for i in range(len(ring) - 1) if GeoUtils.same_point(ring[i], ring[i + 1])]
        if not dups:
            return
        p = ring[dups[0]]
        pairs = ", ".join(f"{i}-{i + 1}" for i in dups[:5]) + ("…" if len(dups) > 5 else "")
        self._add("ERROR", "Vértices Duplicados Consecutivos",
                  f'{len(dups)} vértice(s) duplicado(s) consecutivo(s) en el {ring_name} de "{label}" (índices {pairs}). Se corrigen con "Reparar".',
                  feature_index=f_idx, plot_id=label, location=p, details={"vertexIndices": dups, "coordinate": p})

    def _check_ring_self_intersections(self, ring, ring_name: str, label: str, f_idx: int) -> None:
        segs = GeoUtils.build_segments(ring, 0)
        m = len(segs)
        seen_touches = set()
        state = {"reported": 0, "suppressed": 0}

        def report(category: str, message: str, location, details) -> None:
            if state["reported"] >= MAX_ISSUES_PER_RING:
                state["suppressed"] += 1
                return
            state["reported"] += 1
            self._add("ERROR", category, message, feature_index=f_idx, plot_id=label, location=location, details=details)

        def visit(s, t):
            if s["seq"] > t["seq"]:
                s, t = t, s
            adjacent = t["seq"] == s["seq"] + 1 or (s["seq"] == 0 and t["seq"] == m - 1)
            rel = GeoUtils.segment_relation(s["a"], s["b"], t["a"], t["b"])
            if not rel:
                return None
            si, ti = s["i"], t["i"]
            det = {"seg1_indices": [si, si + 1], "seg1_coords": [s["a"], s["b"]],
                   "seg2_indices": [ti, ti + 1], "seg2_coords": [t["a"], t["b"]],
                   "intersection_point": rel["point"]}
            if adjacent:
                if rel["type"] == "overlap":
                    report("Espiga / Retroceso de Borde",
                           f'El {ring_name} de "{label}" retrocede sobre sí mismo entre los segmentos {si}-{si + 1} y {ti}-{ti + 1} '
                           '(vértice en "punta" que regresa por el mismo borde).', rel["point"], det)
                return None
            loc = f"[{rel['point'][0]:.6f}, {rel['point'][1]:.6f}]"
            if rel["type"] == "cross":
                report("Auto-intersección / Solapamiento de Bordes",
                       f'Auto-intersección en "{label}" ({ring_name}): el segmento {si}-{si + 1} cruza el segmento {ti}-{ti + 1} en {loc}.',
                       rel["point"], det)
            elif rel["type"] == "overlap":
                report("Bordes Colineales Superpuestos",
                       f'En "{label}" ({ring_name}) los segmentos {si}-{si + 1} y {ti}-{ti + 1} se superponen sobre la misma línea cerca de {loc}.',
                       rel["point"], det)
            else:
                k = GeoUtils.key(rel["point"])
                if k in seen_touches:
                    return None
                seen_touches.add(k)
                vv = (any(GeoUtils.same_point(p, rel["point"]) for p in (s["a"], s["b"])) and
                      any(GeoUtils.same_point(p, rel["point"]) for p in (t["a"], t["b"])))
                if vv:
                    report("Punto de Auto-Contacto (Pinch Point)",
                           f'El {ring_name} de "{label}" pasa dos veces por el mismo vértice {loc}, dividiendo la superficie en lóbulos.',
                           rel["point"], det)
                else:
                    report("Vértice sobre Borde Propio",
                           f'Un vértice del {ring_name} de "{label}" toca otro borde del mismo anillo en {loc}.', rel["point"], det)
            return None

        GeoUtils.sweep_pairs(segs, visit)
        if state["suppressed"]:
            self._add("ERROR", "Auto-intersección / Solapamiento de Bordes",
                      f'El {ring_name} de "{label}" tiene {state["suppressed"]} conflicto(s) topológico(s) adicionales no listados '
                      f"(se muestran los primeros {MAX_ISSUES_PER_RING}).", feature_index=f_idx, plot_id=label)

    def _check_winding(self, ring, is_exterior: bool, ring_name: str, label: str, f_idx: int) -> None:
        area = GeoUtils.signed_area(ring)
        is_ccw = area > 0
        if is_exterior:
            self._stats["exteriorRings"] += 1
        if is_exterior and is_ccw:
            self._stats["ccwExteriors"] += 1
            return
        if not is_exterior and not is_ccw:
            return
        expected = "antihoraria (CCW)" if is_exterior else "horaria (CW)"
        found = "antihoraria (CCW)" if is_ccw else "horaria (CW)"
        self._add("ALERTA", "Regla de la Mano Derecha (RFC 7946)",
                  f'El {ring_name} de "{label}" tiene orientación {found}; RFC 7946 §3.1.6 indica orientación {expected}. '
                  'Los lectores permisivos lo aceptan, pero algunos sistemas exigen la regla estricta. Se corrige con "Reparar".',
                  feature_index=f_idx, plot_id=label, location=ring[0],
                  details={"isExterior": is_exterior, "detectedOrientation": found,
                           "requiredOrientation": expected, "signedArea": area / 2})

    def _check_holes(self, rings, label: str, f_idx: int) -> None:
        segs = []
        for idx, r in enumerate(rings):
            segs.extend(GeoUtils.build_segments(r, idx))
        crossing_pairs = set()

        def visit(s, t):
            if s["ring"] == t["ring"]:
                return None
            rel = GeoUtils.segment_relation(s["a"], s["b"], t["a"], t["b"])
            if not rel or rel["type"] == "touch":
                return None
            r1, r2 = sorted((s["ring"], t["ring"]))
            if (r1, r2) in crossing_pairs:
                return None
            crossing_pairs.add((r1, r2))
            n1 = "el anillo exterior" if r1 == 0 else f"el hueco {r1}"
            verb = "cruza" if rel["type"] == "cross" else "comparte un tramo de borde con"
            self._add("ERROR", "Intersección entre Anillos",
                      f'En "{label}" el hueco {r2} {verb} {n1} cerca de [{rel["point"][0]:.6f}, {rel["point"][1]:.6f}].',
                      feature_index=f_idx, plot_id=label, location=rel["point"])
            return None

        GeoUtils.sweep_pairs(segs, visit)

        def sample(ring, other):
            return next((p for p in ring[:-1] if GeoUtils.point_in_ring(p, other) != 0), None)

        for h in range(1, len(rings)):
            if (0, h) in crossing_pairs:
                continue
            p = sample(rings[h], rings[0])
            if p is not None and GeoUtils.point_in_ring(p, rings[0]) < 0:
                self._add("ERROR", "Hueco fuera del Exterior",
                          f'El hueco {h} de "{label}" está fuera del anillo exterior (un hueco debe estar contenido en el polígono).',
                          feature_index=f_idx, plot_id=label, location=p)
        for a in range(1, len(rings)):
            for b in range(a + 1, len(rings)):
                if (a, b) in crossing_pairs:
                    continue
                pb = sample(rings[b], rings[a])
                pa = sample(rings[a], rings[b])
                if (pb is not None and GeoUtils.point_in_ring(pb, rings[a]) > 0) or \
                   (pa is not None and GeoUtils.point_in_ring(pa, rings[b]) > 0):
                    self._add("ERROR", "Huecos Solapados", f'En "{label}" el hueco {b} está dentro del hueco {a} (o lo contiene).',
                              feature_index=f_idx, plot_id=label, location=pb if pb is not None else pa)

    # ------------------------ Entre parcelas ------------------------
    @staticmethod
    def _polygons_overlap(P: Dict, Q: Dict) -> Optional[Dict[str, Any]]:
        all_segs = []
        for owner, poly in ((0, P), (1, Q)):
            for i, r in enumerate(poly["rings"]):
                for s in GeoUtils.build_segments(r, i):
                    s["owner"] = owner
                    all_segs.append(s)
        crossings: List[List[float]] = []

        def visit(s, t):
            if s["owner"] == t["owner"]:
                return None
            rel = GeoUtils.segment_relation(s["a"], s["b"], t["a"], t["b"])
            if rel and rel["type"] == "cross":
                crossings.append(rel["point"])
            return len(crossings) < 5

        GeoUtils.sweep_pairs(all_segs, visit)
        if crossings:
            return {"point": crossings[0], "crossings": crossings}

        def probe(A, B):
            all_on_boundary = True
            bb = B["bbox"]
            for ring in A["rings"]:
                for i in range(len(ring) - 1):
                    v = ring[i]
                    mid = [(ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2]
                    for pt in (v, mid):
                        if pt[0] < bb[0] or pt[0] > bb[2] or pt[1] < bb[1] or pt[1] > bb[3]:
                            all_on_boundary = False
                            continue
                        r = GeoUtils.point_in_polygon(pt, B["rings"])
                        if r == 1:
                            return {"point": list(pt[:2])}
                        if r == -1:
                            all_on_boundary = False
            return {"point": list(A["rings"][0][0][:2]), "identical": True} if all_on_boundary else None

        return probe(P, Q) or probe(Q, P)

    def _check_inter_polygon_overlaps(self, polygons: List[Dict]) -> None:
        items = sorted(({**p, "idx": i} for i, p in enumerate(polygons)), key=lambda p: p["bbox"][0])
        for x in range(len(items)):
            P = items[x]
            for y in range(x + 1, len(items)):
                Q = items[y]
                if Q["bbox"][0] > P["bbox"][2]:
                    break
                if not GeoUtils.bboxes_overlap(P["bbox"], Q["bbox"]):
                    continue
                ov = self._polygons_overlap(P, Q)
                if not ov:
                    continue
                A, B = (P, Q) if P["idx"] < Q["idx"] else (Q, P)
                same = A["fIdx"] == B["fIdx"]
                if same:
                    msg = (f'Las partes "{A["plotId"]}" y "{B["plotId"]}" del mismo MultiPolygon se solapan; '
                           "las partes de un MultiPolygon deben ser disjuntas.")
                else:
                    ident = " (geometrías idénticas o duplicadas)" if ov.get("identical") else ""
                    msg = (f'Solapamiento entre "{A["plotId"]}" y "{B["plotId"]}"{ident}: sus superficies se superponen. '
                           "Las parcelas colindantes pueden compartir linderos, pero no área.")
                self._add("ERROR", "Solapamiento entre Partes" if same else "Solapamiento Inter-Parcelas", msg,
                          feature_index=A["fIdx"], related_feature_index=None if same else B["fIdx"],
                          plot_id=A["featureLabel"] if same else f'{A["plotId"]} / {B["plotId"]}',
                          location=ov["point"],
                          details={"parcel1": A["plotId"], "parcel2": B["plotId"],
                                   "intersectionPoints": ov.get("crossings", [ov["point"]]),
                                   "identical": bool(ov.get("identical"))})

    # ------------------------ Otras comprobaciones ------------------------
    def _check_duplicate_ids(self, features: List) -> None:
        seen: Dict[str, List[int]] = {}
        for i, f in enumerate(features):
            fid = GeoUtils.feature_id(f)
            if fid is not None:
                seen.setdefault(fid, []).append(i)
        for fid, idxs in seen.items():
            if len(idxs) < 2:
                continue
            listed = ", ".join(map(str, idxs[:10])) + ("…" if len(idxs) > 10 else "")
            self._add("ALERTA", "Identificador Duplicado",
                      f'El identificador "{fid}" se repite en {len(idxs)} entidades (índices {listed}).',
                      feature_index=idxs[0], plot_id=fid, details={"featureIndices": idxs})

    def _check_precision(self, geom: Dict, ctx: Dict) -> None:
        state = {"max": 0, "count": 0, "first": None}

        def walk(c, depth):
            if not isinstance(c, list) or not c:
                return
            if _is_num(c[0]) or isinstance(c[0], (int, float)):
                if _is_position(c):
                    state["count"] += 1
                    state["first"] = state["first"] or c
                    state["max"] = max(state["max"], GeoUtils.decimals(c[0]), GeoUtils.decimals(c[1]))
                return
            if depth < 4:
                for x in c:
                    walk(x, depth + 1)

        members = geom.get("geometries") if geom.get("type") == "GeometryCollection" and isinstance(geom.get("geometries"), list) else [geom]
        for g in members:
            if isinstance(g, dict):
                walk(g.get("coordinates"), 0)
        if state["count"] and state["max"] < 6:
            self._add("INFO", "Precisión de Coordenadas",
                      f'Las coordenadas de "{ctx["plotId"]}" tienen como máximo {state["max"]} decimales (6 decimales ≈ 0,1 m). '
                      "Para declaraciones EUDR se suelen pedir al menos 6 decimales; verifique el requisito vigente.",
                      feature_index=ctx["fIdx"], plot_id=ctx["plotId"], location=state["first"],
                      details={"maxDecimals": state["max"]})

    def _add_summary_notes(self) -> None:
        s = self._stats
        if s["exteriorRings"]:
            self._add("INFO", "Regla de la Mano Derecha (RFC 7946)",
                      f'{s["ccwExteriors"]} de {s["exteriorRings"]} anillo(s) exterior(es) siguen la orientación antihoraria (CCW) recomendada por RFC 7946.')
        if s["points"]:
            self._add("INFO", "Geometrías de Punto",
                      f'{s["points"]} geometría(s) son puntos. En EUDR, las parcelas de más de 4 ha deben declararse como polígono.')

    def _build_result(self, feature_info: List[Dict], raw_data: Any) -> Dict[str, Any]:
        errors = sum(1 for i in self.issues if i["severity"] == "ERROR")
        warnings = sum(1 for i in self.issues if i["severity"] == "ALERTA")
        infos = sum(1 for i in self.issues if i["severity"] == "INFO")

        status = ["VALIDO"] * len(feature_info)

        def bump(idx, sev):
            if idx is None or idx >= len(status):
                return
            if SEVERITY_RANK[sev] > SEVERITY_RANK[status[idx]]:
                status[idx] = sev

        for i in self.issues:
            if i["severity"] == "INFO":
                continue
            bump(i["feature_index"], i["severity"])
            bump(i["related_feature_index"], i["severity"])
            for k in i["details"].get("featureIndices", []) if isinstance(i["details"], dict) else []:
                bump(k, i["severity"])
        for k, f in enumerate(feature_info):
            f["status"] = status[k]
            f["errors"] = sum(1 for i in self.issues if i["severity"] == "ERROR" and k in (i["feature_index"], i["related_feature_index"]))
            f["warnings"] = sum(1 for i in self.issues if i["severity"] == "ALERTA" and k in (i["feature_index"], i["related_feature_index"]))

        if errors:
            overall, text = "ERROR", "Inválido: contiene errores que deben corregirse."
        elif warnings:
            overall, text = "ALERTA", "Válido con alertas: revise las advertencias."
        else:
            overall, text = "VALIDO", "Válido: sin errores ni alertas (conforme a RFC 7946)."

        return {
            "valid": errors == 0, "overall_status": overall, "status_text": text,
            "features_count": len(feature_info),
            "summary": {"errors": errors, "warnings": warnings, "info": infos, "total_issues": len(self.issues)},
            "features": feature_info, "issues": self.issues, "data": raw_data,
        }


# ----------------------------------------------------------------------
# Reparador
# ----------------------------------------------------------------------
class GeoJSONRepairer:
    """Correcciones seguras: cierre de anillos, duplicados, orientación, properties, crs WGS84."""

    @classmethod
    def repair(cls, data: Dict[str, Any], add_metadata: bool = False) -> Dict[str, Any]:
        repaired = copy.deepcopy(data)
        ctx = {"changes": [], "unrepaired": []}

        if isinstance(repaired, dict) and "crs" in repaired:
            if cls._crs_is_wgs84(repaired["crs"]):
                del repaired["crs"]
                ctx["changes"].append('Se eliminó el miembro "crs" (obsoleto en RFC 7946; ya declaraba WGS84).')
            else:
                ctx["unrepaired"].append('El miembro "crs" declara un sistema distinto de WGS84: reproyecte el archivo a EPSG:4326 con un SIG (QGIS, ogr2ogr).')

        root_type = repaired.get("type") if isinstance(repaired, dict) else None
        if root_type == "FeatureCollection" and isinstance(repaired.get("features"), list):
            for i, feat in enumerate(repaired["features"]):
                cls._repair_feature(feat, i, ctx)
        elif root_type == "Feature":
            cls._repair_feature(repaired, 0, ctx)
        elif root_type:
            cls._repair_geometry(repaired, "Geometría raíz", ctx)

        if add_metadata and isinstance(repaired, dict):
            meta = dict(repaired.get("metadata") or {})
            meta.update({"repaired_by": "Revisor GeoJSON RFC 7946",
                         "repaired_at": datetime.now(timezone.utc).isoformat(),
                         "repair_notes": ctx["changes"]})
            repaired["metadata"] = meta

        return {"repairedData": repaired, "changesCount": len(ctx["changes"]),
                "changes": ctx["changes"], "unrepaired": ctx["unrepaired"]}

    @classmethod
    def repair_data(cls, data: Dict[str, Any], add_metadata: bool = False) -> Tuple[Dict[str, Any], List[str]]:
        """Compatibilidad con la API anterior: devuelve (datos_reparados, cambios)."""
        r = cls.repair(data, add_metadata)
        return r["repairedData"], r["changes"]

    @staticmethod
    def _crs_is_wgs84(crs: Any) -> bool:
        props = crs.get("properties", {}) if isinstance(crs, dict) else {}
        name = str(props.get("name", props.get("code", ""))).upper() if isinstance(props, dict) else ""
        return "CRS84" in name or "EPSG::4326" in name or "EPSG:4326" in name or name == "4326"

    @classmethod
    def _repair_feature(cls, feat: Any, f_idx: int, ctx: Dict) -> None:
        if not isinstance(feat, dict) or feat.get("type") != "Feature":
            return
        label = GeoUtils.feature_label(feat, f_idx)
        if "properties" not in feat:
            feat["properties"] = {}
            ctx["changes"].append(f'{label}: se añadió "properties": {{}} (miembro obligatorio en RFC 7946 §3.2).')
        if isinstance(feat.get("geometry"), dict):
            cls._repair_geometry(feat["geometry"], label, ctx)

    @classmethod
    def _repair_geometry(cls, geom: Dict, label: str, ctx: Dict) -> None:
        g_type = geom.get("type")
        if g_type == "GeometryCollection" and isinstance(geom.get("geometries"), list):
            for k, g in enumerate(geom["geometries"]):
                if isinstance(g, dict):
                    cls._repair_geometry(g, f"{label} [Geom {k + 1}]", ctx)
        elif g_type == "Polygon" and isinstance(geom.get("coordinates"), list):
            geom["coordinates"] = cls._repair_polygon(geom["coordinates"], label, ctx)
        elif g_type == "MultiPolygon" and isinstance(geom.get("coordinates"), list):
            multi = len(geom["coordinates"]) > 1
            geom["coordinates"] = [
                cls._repair_polygon(poly, f"{label} [Parte {k + 1}]" if multi else label, ctx) if isinstance(poly, list) else poly
                for k, poly in enumerate(geom["coordinates"])]

    @classmethod
    def _repair_polygon(cls, rings: List, label: str, ctx: Dict) -> List:
        out_rings = []
        for r_idx, ring in enumerate(rings):
            ring_name = "anillo exterior" if r_idx == 0 else f"hueco {r_idx}"
            if not isinstance(ring, list) or not all(_is_position(p) for p in ring):
                ctx["unrepaired"].append(f"{label} ({ring_name}): contiene coordenadas inválidas; corríjalas manualmente.")
                out_rings.append(ring)
                continue
            if not ring:
                out_rings.append(ring)
                continue
            was_closed = len(ring) > 1 and GeoUtils.same_point(ring[0], ring[-1])
            open_ring = ring[:-1] if was_closed else list(ring)
            cleaned: List = []
            for p in open_ring:
                if cleaned and GeoUtils.same_point(cleaned[-1], p):
                    continue
                cleaned.append(p)
            while len(cleaned) > 1 and GeoUtils.same_point(cleaned[0], cleaned[-1]):
                cleaned.pop()
            removed = len(open_ring) - len(cleaned)
            if len(cleaned) < 3:
                ctx["unrepaired"].append(f"{label} ({ring_name}): tiene menos de 3 vértices distintos; no puede formar un polígono.")
                out_rings.append(ring)
                continue
            out = cleaned + [list(cleaned[0])]
            if not was_closed:
                ctx["changes"].append(f"{label} ({ring_name}): anillo cerrado repitiendo el primer vértice al final.")
            if removed:
                ctx["changes"].append(f"{label} ({ring_name}): se eliminaron {removed} vértice(s) duplicado(s) consecutivo(s).")
            is_ccw = GeoUtils.signed_area(out) > 0
            if r_idx == 0 and not is_ccw:
                out.reverse()
                ctx["changes"].append(f"{label} (anillo exterior): orientación invertida a antihoraria (CCW) según RFC 7946 §3.1.6.")
            elif r_idx > 0 and is_ccw:
                out.reverse()
                ctx["changes"].append(f"{label} ({ring_name}): orientación invertida a horaria (CW) según RFC 7946 §3.1.6.")
            out_rings.append(out)
        return out_rings


# ----------------------------------------------------------------------
# Línea de comandos
# ----------------------------------------------------------------------
ICONS = {"ERROR": "❌", "ALERTA": "⚠️ ", "INFO": "ℹ️ "}


def _print_report(path: str, result: Dict[str, Any], show_info: bool) -> None:
    s = result["summary"]
    print("=" * 78)
    print(f"{path}")
    print(f"  Estado: {result['overall_status']} — {result['status_text']}")
    print(f"  Entidades: {result['features_count']} · Errores: {s['errors']} · Alertas: {s['warnings']} · Info: {s['info']}")
    for i in result["issues"]:
        if i["severity"] == "INFO" and not show_info:
            continue
        loc = f"  @ [{i['location'][0]:.6f}, {i['location'][1]:.6f}]" if i.get("location") else ""
        print(f"  {ICONS.get(i['severity'], '')} [{i['category']}] {i['message']}{loc}")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Valida (y opcionalmente repara) archivos GeoJSON según RFC 7946 y reglas topológicas.")
    parser.add_argument("archivos", nargs="+", help="Archivos .geojson / .json a revisar")
    parser.add_argument("--json", action="store_true", help="Imprimir el resultado completo en JSON")
    parser.add_argument("--info", action="store_true", help="Mostrar también los mensajes informativos")
    parser.add_argument("--reparar", metavar="SALIDA", help="Guardar una versión reparada (solo con un archivo de entrada)")
    parser.add_argument("--metadata", action="store_true", help="Al reparar, añadir el bloque 'metadata' con el registro de cambios")
    parser.add_argument("--csv", metavar="REPORTE", help="Guardar los diagnósticos en CSV (separador ';')")
    args = parser.parse_args(argv)

    if args.reparar and len(args.archivos) != 1:
        parser.error("--reparar solo admite un archivo de entrada")

    exit_code = 0
    all_rows = []
    json_out = []
    for path in args.archivos:
        validator = GeoJSONValidator()
        result = validator.validate_file(path)
        if any(i["category"] == "Lectura de Archivo" for i in result["issues"]):
            exit_code = max(exit_code, 2)
        elif not result["valid"]:
            exit_code = max(exit_code, 1)

        if args.json:
            json_out.append({"archivo": path, **{k: v for k, v in result.items() if k != "data"}})
        else:
            _print_report(path, result, args.info)

        for i in result["issues"]:
            loc = i.get("location") or ["", ""]
            all_rows.append([path, i["severity"], i["category"], i.get("plot_id") or "Archivo", i["message"], loc[0], loc[1]])

        if args.reparar and isinstance(result["data"], dict):
            rep = GeoJSONRepairer.repair(result["data"], add_metadata=args.metadata)
            with open(args.reparar, "w", encoding="utf-8") as f:
                json.dump(rep["repairedData"], f, ensure_ascii=False, indent=2)
            after = GeoJSONValidator().validate_data(rep["repairedData"])
            if not args.json:
                print(f"\n🛠️  Reparado → {args.reparar} ({rep['changesCount']} cambio(s)); estado tras reparar: {after['overall_status']}")
                for c in rep["changes"]:
                    print(f"   ✔ {c}")
                for u in rep["unrepaired"]:
                    print(f"   ✖ {u}")
                if after["summary"]["errors"]:
                    print(f"   Quedan {after['summary']['errors']} error(es) que requieren corrección manual.")

    if args.json:
        print(json.dumps(json_out if len(json_out) > 1 else json_out[0], ensure_ascii=False, indent=2))
    if args.csv:
        with open(args.csv, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["Archivo", "Nivel", "Categoría", "Entidad", "Mensaje", "Longitud", "Latitud"])
            w.writerows(all_rows)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
