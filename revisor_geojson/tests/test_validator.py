"""
Automated unit tests for GeoJSONValidator and GeoJSONRepairer.
"""

import unittest
import os
import sys
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from geojson_validator import GeoJSONValidator, GeoJSONRepairer, ValidationSeverity


class TestGeoJSONValidator(unittest.TestCase):

    def setUp(self):
        self.validator = GeoJSONValidator()
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def test_rancho_alegre_with_solapamiento(self):
        """
        Verify that V19579584_RanchoAlegre_polygons.geojson fails with self-intersection ERROR
        at coordinate ~(-71.748012, 7.935516) between segments 2-3 and 18-19.
        """
        filepath = os.path.join(self.base_dir, "V19579584_RanchoAlegre_polygons.geojson")
        result = self.validator.validate_file(filepath)

        self.assertFalse(result["valid"], "El archivo con solapamiento no debe ser válido")
        self.assertEqual(result["overall_status"], ValidationSeverity.ERROR)
        self.assertGreater(result["summary"]["errors"], 0)

        # Check that self-intersection issue is found
        intersection_issues = [
            i for i in result["issues"] 
            if i["category"] == "Auto-intersección / Solapamiento de Bordes"
        ]
        self.assertEqual(len(intersection_issues), 1, "Debe detectar exactamente 1 auto-intersección")
        issue = intersection_issues[0]
        loc = issue["location"]
        self.assertAlmostEqual(loc[0], -71.748012, places=4)
        self.assertAlmostEqual(loc[1], 7.935516, places=4)
        self.assertEqual(issue["details"]["seg1_indices"], [2, 3])
        self.assertEqual(issue["details"]["seg2_indices"], [18, 19])

    def test_rancho_alegre_clean_file(self):
        """
        Verify that V19579584_RanchoAlegre_polygons-new.geojson is completely valid (no errors, CCW).
        """
        filepath = os.path.join(self.base_dir, "V19579584_RanchoAlegre_polygons-new.geojson")
        result = self.validator.validate_file(filepath)

        self.assertTrue(result["valid"], "El archivo corregido debe ser válido")
        self.assertEqual(result["summary"]["errors"], 0)
        self.assertEqual(result["overall_status"], "VALIDO")

    def test_rfc7946_clockwise_warning_only(self):
        """
        Verify that a polygon with Clockwise (CW) exterior ring generates an ALERTA (warning),
        NOT an ERROR!
        """
        cw_polygon = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"PlotID": "CW_TEST"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [0.0, 0.0],
                                [0.0, 1.0],
                                [1.0, 1.0],
                                [1.0, 0.0],
                                [0.0, 0.0]
                            ]
                        ]
                    }
                }
            ]
        }
        result = self.validator.validate_data(cw_polygon)

        # Must be valid because RFC 7946 winding is an ALERT, not ERROR!
        self.assertTrue(result["valid"], "Un polígono CW debe ser válido a nivel de formato/topología")
        self.assertEqual(result["overall_status"], ValidationSeverity.WARNING)
        self.assertEqual(result["summary"]["errors"], 0)
        self.assertEqual(result["summary"]["warnings"], 1)

        warning = result["issues"][0]
        self.assertEqual(warning["severity"], ValidationSeverity.WARNING)
        self.assertEqual(warning["category"], "Regla de la Mano Derecha (RFC 7946)")
        self.assertIn("horaria (CW)", warning["message"])

    def test_duplicate_consecutive_vertices_error(self):
        """
        Verify that duplicate consecutive vertices produce an ERROR.
        """
        dup_polygon = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"PlotID": "DUP_TEST"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [0.0, 0.0],
                                [1.0, 0.0],
                                [1.0, 0.0],  # Duplicate!
                                [1.0, 1.0],
                                [0.0, 1.0],
                                [0.0, 0.0]
                            ]
                        ]
                    }
                }
            ]
        }
        result = self.validator.validate_data(dup_polygon)

        self.assertFalse(result["valid"])
        self.assertGreater(result["summary"]["errors"], 0)
        error_cats = [i["category"] for i in result["issues"] if i["severity"] == ValidationSeverity.ERROR]
        self.assertIn("Vértices Duplicados Consecutivos", error_cats)

    def test_inter_polygon_overlap_error(self):
        """
        Verify that overlapping distinct polygons in a FeatureCollection trigger an ERROR.
        """
        overlap_features = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"PlotID": "PARCEL_A"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
                    }
                },
                {
                    "type": "Feature",
                    "properties": {"PlotID": "PARCEL_B"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]
                    }
                }
            ]
        }
        result = self.validator.validate_data(overlap_features)
        self.assertFalse(result["valid"])
        error_cats = [i["category"] for i in result["issues"] if i["severity"] == ValidationSeverity.ERROR]
        self.assertIn("Solapamiento Inter-Parcelas", error_cats)

    def test_auto_repair(self):
        """
        Verify that GeoJSONRepairer fixes CW winding order to CCW and removes duplicates.
        """
        broken_geojson = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"PlotID": "TO_REPAIR"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [0.0, 0.0],
                                [0.0, 1.0],
                                [0.0, 1.0],  # duplicate
                                [1.0, 1.0],
                                [1.0, 0.0],
                                [0.0, 0.0]
                            ]
                        ]
                    }
                }
            ]
        }
        repaired, changes = GeoJSONRepairer.repair_data(broken_geojson)
        self.assertGreater(len(changes), 0)

        # Validate the repaired data: it must now be completely valid!
        validation_after = self.validator.validate_data(repaired)
        self.assertTrue(validation_after["valid"])
        self.assertEqual(validation_after["summary"]["errors"], 0)
        self.assertEqual(validation_after["summary"]["warnings"], 0)
        self.assertEqual(validation_after["overall_status"], "VALIDO")


if __name__ == "__main__":
    unittest.main(verbosity=2)
