"""
GeoJSON Integrity, Topology, and RFC 7946 Validator & Repair Engine.
Compatible with Python 3.10+ and standard library.
"""

import json
import math
from typing import Dict, Any, List, Tuple, Optional


class ValidationSeverity:
    ERROR = "ERROR"      # Fails format, duplicate points, self-intersections, overlap
    WARNING = "ALERTA"   # RFC 7946 right-hand rule non-compliance (CW exterior, CCW holes)
    INFO = "INFO"


class GeoJSONValidator:
    """
    Validates GeoJSON files against:
    1. GeoJSON Format & Schema (RFC 7946 / OGC) -> ERROR
    2. Overlapping vertices & self-intersections (internal topology) -> ERROR
    3. Inter-polygon spatial overlaps -> ERROR
    4. RFC 7946 Right-Hand Rule (CCW exterior ring, CW interior holes) -> ALERTA
    """

    def __init__(self):
        self.issues = []

    def validate_file(self, filepath: str) -> Dict[str, Any]:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            return {
                "valid": False,
                "status": ValidationSeverity.ERROR,
                "issues": [{
                    "severity": ValidationSeverity.ERROR,
                    "category": "Sintaxis JSON",
                    "message": f"Error de sintaxis JSON: {str(e)}",
                    "location": None
                }],
                "features_count": 0,
                "summary": {"errors": 1, "warnings": 0, "info": 0}
            }
        except Exception as e:
            return {
                "valid": False,
                "status": ValidationSeverity.ERROR,
                "issues": [{
                    "severity": ValidationSeverity.ERROR,
                    "category": "Lectura de Archivo",
                    "message": f"No se pudo leer el archivo: {str(e)}",
                    "location": None
                }],
                "features_count": 0,
                "summary": {"errors": 1, "warnings": 0, "info": 0}
            }

        return self.validate_data(data)

    def validate_data(self, data: Any) -> Dict[str, Any]:
        self.issues = []

        if not isinstance(data, dict):
            self._add_issue(ValidationSeverity.ERROR, "Estructura GeoJSON", "La raíz del archivo debe ser un objeto JSON.")
            return self._build_result(0)

        root_type = data.get("type")
        if not root_type:
            self._add_issue(ValidationSeverity.ERROR, "Estructura GeoJSON", "El objeto raíz no contiene la propiedad requerida 'type'.")
            return self._build_result(0)

        features = []
        if root_type == "FeatureCollection":
            raw_features = data.get("features")
            if not isinstance(raw_features, list):
                self._add_issue(ValidationSeverity.ERROR, "Estructura GeoJSON", "La propiedad 'features' de FeatureCollection debe ser un arreglo.")
                return self._build_result(0)
            features = raw_features
        elif root_type == "Feature":
            features = [data]
        elif root_type in ["Polygon", "MultiPolygon", "Point", "MultiPoint", "LineString", "MultiLineString", "GeometryCollection"]:
            features = [{"type": "Feature", "geometry": data, "properties": {}}]
        else:
            self._add_issue(ValidationSeverity.ERROR, "Estructura GeoJSON", f"Tipo GeoJSON desconocido o inválido: '{root_type}'.")
            return self._build_result(0)

        # Validate each feature
        parsed_polygons = []  # List of tuples: (feature_index, prop_id, [polygon_rings])

        for f_idx, feat in enumerate(features):
            self._validate_feature(feat, f_idx, parsed_polygons)

        # Check inter-polygon overlaps if there are 2 or more polygons
        if len(parsed_polygons) >= 2:
            self._check_inter_polygon_overlaps(parsed_polygons)

        return self._build_result(len(features), data)

    def _add_issue(self, severity: str, category: str, message: str,
                   feature_index: Optional[int] = None,
                   plot_id: Optional[str] = None,
                   location: Optional[Tuple[float, float]] = None,
                   details: Optional[Dict[str, Any]] = None):
        self.issues.append({
            "severity": severity,
            "category": category,
            "message": message,
            "feature_index": feature_index,
            "plot_id": plot_id,
            "location": location,
            "details": details or {}
        })

    def _validate_feature(self, feat: Any, f_idx: int, parsed_polygons: List):
        if not isinstance(feat, dict) or feat.get("type") != "Feature":
            self._add_issue(ValidationSeverity.ERROR, "Estructura Feature",
                            f"El elemento en el índice {f_idx} no es un Feature válido.", feature_index=f_idx)
            return

        props = feat.get("properties") or {}
        plot_id = props.get("PlotID") or props.get("id") or props.get("ID") or f"Feature #{f_idx+1}"

        geom = feat.get("geometry")
        if geom is None:
            self._add_issue(ValidationSeverity.ERROR, "Geometría Nula",
                            f"La entidad '{plot_id}' no posee geometría.", feature_index=f_idx, plot_id=plot_id)
            return

        if not isinstance(geom, dict) or "type" not in geom or "coordinates" not in geom:
            self._add_issue(ValidationSeverity.ERROR, "Geometría Inválida",
                            f"La entidad '{plot_id}' tiene una geometría mal estructurada.", feature_index=f_idx, plot_id=plot_id)
            return

        g_type = geom["type"]
        coords = geom["coordinates"]

        if g_type == "Polygon":
            self._validate_polygon_coords(coords, f_idx, plot_id)
            parsed_polygons.append((f_idx, plot_id, coords))
        elif g_type == "MultiPolygon":
            for p_idx, poly_coords in enumerate(coords):
                sub_id = f"{plot_id} [Polígono {p_idx+1}]"
                self._validate_polygon_coords(poly_coords, f_idx, sub_id)
                parsed_polygons.append((f_idx, sub_id, poly_coords))
        elif g_type in ["Point", "MultiPoint", "LineString", "MultiLineString"]:
            self._validate_other_coords(g_type, coords, f_idx, plot_id)
        else:
            self._add_issue(ValidationSeverity.ERROR, "Tipo de Geometría",
                            f"Tipo de geometría '{g_type}' no soportado para análisis catastral/EUDR.",
                            feature_index=f_idx, plot_id=plot_id)

    def _validate_other_coords(self, g_type: str, coords: Any, f_idx: int, plot_id: str):
        # Validate coordinates bounds for Point/LineString
        def check_pt(pt):
            if not isinstance(pt, (list, tuple)) or len(pt) < 2:
                self._add_issue(ValidationSeverity.ERROR, "Coordenada Inválida",
                                f"Punto mal estructurado en '{plot_id}'.", feature_index=f_idx, plot_id=plot_id)
                return
            lon, lat = pt[0], pt[1]
            if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
                self._add_issue(ValidationSeverity.ERROR, "Límites WGS84",
                                f"Coordenada fuera de rango WGS84 [{lon}, {lat}] en '{plot_id}'.",
                                feature_index=f_idx, plot_id=plot_id, location=(lon, lat))

        if g_type == "Point":
            check_pt(coords)
        elif g_type in ["MultiPoint", "LineString"]:
            for pt in coords:
                check_pt(pt)
        elif g_type == "MultiLineString":
            for line in coords:
                for pt in line:
                    check_pt(pt)

    def _validate_polygon_coords(self, rings: Any, f_idx: int, plot_id: str):
        if not isinstance(rings, list) or len(rings) == 0:
            self._add_issue(ValidationSeverity.ERROR, "Geometría Vacía",
                            f"El polígono '{plot_id}' no contiene anillos de coordenadas.",
                            feature_index=f_idx, plot_id=plot_id)
            return

        for r_idx, ring in enumerate(rings):
            is_exterior = (r_idx == 0)
            ring_name = "exterior" if is_exterior else f"interior (hueco {r_idx})"

            if not isinstance(ring, list) or len(ring) < 4:
                self._add_issue(ValidationSeverity.ERROR, "Vértices Insuficientes",
                                f"El anillo {ring_name} de '{plot_id}' tiene menos de 4 coordenadas (encontrados: {len(ring) if isinstance(ring, list) else 0}).",
                                feature_index=f_idx, plot_id=plot_id)
                continue

            # Check coordinate bounds
            for p_idx, pt in enumerate(ring):
                if not isinstance(pt, (list, tuple)) or len(pt) < 2:
                    self._add_issue(ValidationSeverity.ERROR, "Coordenada Malformada",
                                    f"Vértice {p_idx} del anillo {ring_name} en '{plot_id}' no tiene formato [lon, lat].",
                                    feature_index=f_idx, plot_id=plot_id)
                    continue
                lon, lat = pt[0], pt[1]
                if not (isinstance(lon, (int, float)) and isinstance(lat, (int, float))):
                    self._add_issue(ValidationSeverity.ERROR, "Tipo de Coordenada",
                                    f"Las coordenadas deben ser numéricas. Vértice {p_idx}: [{lon}, {lat}].",
                                    feature_index=f_idx, plot_id=plot_id)
                    continue
                if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
                    self._add_issue(ValidationSeverity.ERROR, "Límites WGS84",
                                    f"Coordenada [{lon}, {lat}] fuera del rango WGS84 en vértice {p_idx} de '{plot_id}'.",
                                    feature_index=f_idx, plot_id=plot_id, location=(lon, lat))

            # 1. Closed Ring Check: first == last
            first_pt, last_pt = ring[0], ring[-1]
            if first_pt[0] != last_pt[0] or first_pt[1] != last_pt[1]:
                self._add_issue(ValidationSeverity.ERROR, "Anillo Abierto",
                                f"El anillo {ring_name} de '{plot_id}' no está cerrado (primer vértice {first_pt} != último {last_pt}).",
                                feature_index=f_idx, plot_id=plot_id, location=(first_pt[0], first_pt[1]))

            # 2. Check for Duplicate Consecutive Vertices (excluding closed ring edge)
            for i in range(len(ring) - 1):
                p1, p2 = ring[i], ring[i+1]
                if p1[0] == p2[0] and p1[1] == p2[1]:
                    self._add_issue(ValidationSeverity.ERROR, "Vértices Duplicados Consecutivos",
                                    f"Vértice duplicado consecutivo en anillo {ring_name} de '{plot_id}' en índice {i} y {i+1} en [{p1[0]}, {p1[1]}].",
                                    feature_index=f_idx, plot_id=plot_id, location=(p1[0], p1[1]),
                                    details={"vertex_index": i, "coordinate": p1})

            # 3. Check for Self-Intersections (crossing edges)
            self._check_ring_self_intersections(ring, ring_name, f_idx, plot_id)

            # 4. Check RFC 7946 Right-Hand Rule (Winding Order) -> WARNING (ALERTA)
            self._check_rfc7946_winding(ring, is_exterior, ring_name, f_idx, plot_id)

    def _check_ring_self_intersections(self, ring: List[List[float]], ring_name: str, f_idx: int, plot_id: str):
        n = len(ring)
        # Compare every pair of non-adjacent segments
        for i in range(n - 1):
            p1, p2 = ring[i], ring[i+1]
            for j in range(i + 1, n - 1):
                # Adjacent segments share a vertex and do not count as self-intersection
                if abs(i - j) <= 1:
                    continue
                # Closing segment and first segment share the start/end vertex
                if i == 0 and j == n - 2:
                    continue

                q1, q2 = ring[j], ring[j+1]

                # Check if non-adjacent segments share identical vertices (pinch point / figure 8)
                if (p1[0] == q1[0] and p1[1] == q1[1]) or (p1[0] == q2[0] and p1[1] == q2[1]):
                    self._add_issue(ValidationSeverity.ERROR, "Punto de Auto-Contacto (Pinch Point)",
                                    f"El anillo {ring_name} de '{plot_id}' se toca a sí mismo en el vértice [{p1[0]}, {p1[1]}].",
                                    feature_index=f_idx, plot_id=plot_id, location=(p1[0], p1[1]),
                                    details={"vertex_i": i, "vertex_j": j, "coordinate": p1})
                    continue

                # Check edge crossing
                if self._segments_intersect(p1, p2, q1, q2):
                    pt = self._compute_line_intersection(p1, p2, q1, q2)
                    loc = (pt[0], pt[1]) if pt else (p1[0], p1[1])
                    self._add_issue(
                        ValidationSeverity.ERROR,
                        "Auto-intersección / Solapamiento de Bordes",
                        f"Auto-intersección detectada en '{plot_id}' ({ring_name}): El segmento {i}-{i+1} se cruza con el segmento {j}-{j+1} en [{loc[0]:.6f}, {loc[1]:.6f}].",
                        feature_index=f_idx,
                        plot_id=plot_id,
                        location=loc,
                        details={
                            "seg1_indices": [i, i+1],
                            "seg1_coords": [p1, p2],
                            "seg2_indices": [j, j+1],
                            "seg2_coords": [q1, q2],
                            "intersection_point": loc
                        }
                    )

    def _check_rfc7946_winding(self, ring: List[List[float]], is_exterior: bool, ring_name: str, f_idx: int, plot_id: str):
        # Calculate signed area using Shoelace formula
        # Positive area -> Counter-Clockwise (CCW)
        # Negative area -> Clockwise (CW)
        area = 0.0
        n = len(ring)
        for i in range(n - 1):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i+1][0], ring[i+1][1]
            area += (x1 * y2) - (x2 * y1)

        is_ccw = (area > 0)

        rfc_note = (
            "RFC 7946 §3.1.6 establece la regla de la mano derecha: el anillo exterior DEBE ser antihorario (CCW) "
            "y los anillos interiores DEBEN ser horarios (CW). Requerido por sistemas como EUDR/TRACES-NT de la Unión Europea."
        )

        if is_exterior:
            if not is_ccw:
                # Exterior ring is Clockwise (CW) -> RFC 7946 Non-compliance ALERT
                self._add_issue(
                    ValidationSeverity.WARNING,
                    "Regla de la Mano Derecha (RFC 7946)",
                    f"El anillo exterior de '{plot_id}' sigue una orientación horaria (CW). {rfc_note}",
                    feature_index=f_idx,
                    plot_id=plot_id,
                    location=(ring[0][0], ring[0][1]),
                    details={
                        "is_exterior": True,
                        "detected_orientation": "CW (Horario)",
                        "required_orientation": "CCW (Antihorario)",
                        "signed_area": area
                    }
                )
            else:
                self._add_issue(
                    ValidationSeverity.INFO,
                    "Regla de la Mano Derecha (RFC 7946)",
                    f"El anillo exterior de '{plot_id}' cumple correctamente con RFC 7946 (orientación antihoraria CCW).",
                    feature_index=f_idx,
                    plot_id=plot_id,
                    details={"is_exterior": True, "detected_orientation": "CCW", "signed_area": area}
                )
        else:
            # Interior ring (hole) must be CW (area < 0)
            if is_ccw:
                self._add_issue(
                    ValidationSeverity.WARNING,
                    "Regla de la Mano Derecha (RFC 7946)",
                    f"El anillo {ring_name} de '{plot_id}' sigue una orientación antihoraria (CCW). {rfc_note}",
                    feature_index=f_idx,
                    plot_id=plot_id,
                    location=(ring[0][0], ring[0][1]),
                    details={
                        "is_exterior": False,
                        "detected_orientation": "CCW (Antihorario)",
                        "required_orientation": "CW (Horario)",
                        "signed_area": area
                    }
                )

    def _check_inter_polygon_overlaps(self, parsed_polygons: List):
        """
        Check for bounding box and polygon-polygon overlaps across distinct parcels.
        """
        num_polys = len(parsed_polygons)
        for i in range(num_polys):
            f_idx1, id1, rings1 = parsed_polygons[i]
            ext1 = rings1[0]
            bbox1 = self._get_bbox(ext1)

            for j in range(i + 1, num_polys):
                f_idx2, id2, rings2 = parsed_polygons[j]
                ext2 = rings2[0]
                bbox2 = self._get_bbox(ext2)

                # Quick bounding box disjoint check
                if not self._bboxes_overlap(bbox1, bbox2):
                    continue

                # Detailed segment intersection check between polygon 1 and polygon 2
                overlap_pts = []
                for s1 in range(len(ext1) - 1):
                    p1, p2 = ext1[s1], ext1[s1+1]
                    for s2 in range(len(ext2) - 1):
                        q1, q2 = ext2[s2], ext2[s2+1]
                        if self._segments_intersect(p1, p2, q1, q2):
                            ipt = self._compute_line_intersection(p1, p2, q1, q2)
                            if ipt:
                                overlap_pts.append(ipt)

                # Check if one polygon is completely contained inside the other
                pt_inside = self._point_in_ring(ext2[0], ext1) or self._point_in_ring(ext1[0], ext2)

                if len(overlap_pts) > 0 or pt_inside:
                    loc = overlap_pts[0] if overlap_pts else (ext1[0][0], ext1[0][1])
                    self._add_issue(
                        ValidationSeverity.ERROR,
                        "Solapamiento Inter-Parcelas",
                        f"Solapamiento espacial detectado entre '{id1}' y '{id2}'. En sistemas catastrales y EUDR las parcelas no pueden solaparse.",
                        feature_index=f_idx1,
                        plot_id=f"{id1} / {id2}",
                        location=loc,
                        details={
                            "parcel1": id1,
                            "parcel2": id2,
                            "intersection_points": overlap_pts[:5]
                        }
                    )

    @staticmethod
    def _ccw(A, B, C):
        return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])

    @classmethod
    def _segments_intersect(cls, A, B, C, D) -> bool:
        return cls._ccw(A, C, D) != cls._ccw(B, C, D) and cls._ccw(A, B, C) != cls._ccw(A, B, D)

    @staticmethod
    def _compute_line_intersection(p1, p2, p3, p4) -> Optional[Tuple[float, float]]:
        x1, y1 = p1[0], p1[1]
        x2, y2 = p2[0], p2[1]
        x3, y3 = p3[0], p3[1]
        x4, y4 = p4[0], p4[1]

        denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(denom) < 1e-12:
            return None

        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
        px = x1 + t * (x2 - x1)
        py = y1 + t * (y2 - y1)
        return (px, py)

    @staticmethod
    def _get_bbox(ring):
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return min(xs), min(ys), max(xs), max(ys)

    @staticmethod
    def _bboxes_overlap(b1, b2):
        return not (b1[2] < b2[0] or b1[0] > b2[2] or b1[3] < b2[1] or b1[1] > b2[3])

    @staticmethod
    def _point_in_ring(pt, ring):
        x, y = pt[0], pt[1]
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    def _build_result(self, features_count: int, raw_data: Any = None) -> Dict[str, Any]:
        errors = [i for i in self.issues if i["severity"] == ValidationSeverity.ERROR]
        warnings = [i for i in self.issues if i["severity"] == ValidationSeverity.WARNING]
        infos = [i for i in self.issues if i["severity"] == ValidationSeverity.INFO]

        if len(errors) > 0:
            overall_status = "ERROR"
            status_text = "Inválido (Contiene errores críticos)"
        elif len(warnings) > 0:
            overall_status = "ALERTA"
            status_text = "Válido con Advertencias (Alerta RFC 7946)"
        else:
            overall_status = "VALIDO"
            status_text = "Completamente Válido (Conforme a RFC 7946)"

        return {
            "valid": len(errors) == 0,
            "overall_status": overall_status,
            "status_text": status_text,
            "features_count": features_count,
            "summary": {
                "errors": len(errors),
                "warnings": len(warnings),
                "info": len(infos),
                "total_issues": len(self.issues)
            },
            "issues": self.issues
        }


class GeoJSONRepairer:
    """
    Auto-repair engine for GeoJSON files:
    1. Fixes RFC 7946 winding order (reverses outer rings to CCW, inner rings to CW).
    2. Cleans duplicate consecutive vertices.
    3. Re-closes unclosed rings.
    """

    @classmethod
    def repair_data(cls, data: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
        repaired = json.loads(json.dumps(data))  # Deep copy
        changes = []

        root_type = repaired.get("type")
        if root_type == "FeatureCollection":
            for idx, feat in enumerate(repaired.get("features", [])):
                cls._repair_feature(feat, idx, changes)
        elif root_type == "Feature":
            cls._repair_feature(repaired, 0, changes)
        elif root_type in ["Polygon", "MultiPolygon"]:
            fake_feat = {"type": "Feature", "geometry": repaired}
            cls._repair_feature(fake_feat, 0, changes)

        # Add or update metadata
        if "metadata" not in repaired:
            repaired["metadata"] = {}
        repaired["metadata"]["repaired_by"] = "GeoJSON Integrity & RFC 7946 Repairer"
        repaired["metadata"]["repair_notes"] = changes

        return repaired, changes

    @classmethod
    def _repair_feature(cls, feat: Dict[str, Any], f_idx: int, changes: List[str]):
        geom = feat.get("geometry")
        if not geom:
            return

        g_type = geom.get("type")
        coords = geom.get("coordinates")

        if g_type == "Polygon":
            new_rings = cls._repair_polygon_rings(coords, f_idx, changes)
            geom["coordinates"] = new_rings
        elif g_type == "MultiPolygon":
            new_multipoly = []
            for p_idx, poly_coords in enumerate(coords):
                new_rings = cls._repair_polygon_rings(poly_coords, f"{f_idx}.{p_idx}", changes)
                new_multipoly.append(new_rings)
            geom["coordinates"] = new_multipoly

    @classmethod
    def _repair_polygon_rings(cls, rings: List[List[List[float]]], poly_id: Any, changes: List[str]) -> List[List[List[float]]]:
        repaired_rings = []
        for r_idx, ring in enumerate(rings):
            if len(ring) < 3:
                repaired_rings.append(ring)
                continue

            is_exterior = (r_idx == 0)

            # Step 1: Remove duplicate consecutive vertices (keep first and last closed)
            cleaned = [ring[0]]
            dups_removed = 0
            for i in range(1, len(ring) - 1):
                prev = cleaned[-1]
                curr = ring[i]
                if curr[0] == prev[0] and curr[1] == prev[1]:
                    dups_removed += 1
                else:
                    cleaned.append(curr)
            # Ensure ring remains closed
            cleaned.append([cleaned[0][0], cleaned[0][1]])
            if dups_removed > 0:
                changes.append(f"Polígono {poly_id}, anillo {r_idx}: Eliminados {dups_removed} vértice(s) duplicados consecutivos.")

            # Step 2: Check & fix RFC 7946 winding order
            area = cls._signed_area(cleaned)
            is_ccw = (area > 0)

            if is_exterior and not is_ccw:
                cleaned.reverse()
                changes.append(f"Polígono {poly_id}, anillo exterior: Invertido a sentido antihorario (CCW) conforme a RFC 7946 §3.1.6.")
            elif not is_exterior and is_ccw:
                cleaned.reverse()
                changes.append(f"Polígono {poly_id}, anillo interior (hueco {r_idx}): Invertido a sentido horario (CW) conforme a RFC 7946 §3.1.6.")

            repaired_rings.append(cleaned)
        return repaired_rings

    @staticmethod
    def _signed_area(ring: List[List[float]]) -> float:
        area = 0.0
        n = len(ring)
        for i in range(n - 1):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i+1][0], ring[i+1][1]
            area += (x1 * y2) - (x2 * y1)
        return area
