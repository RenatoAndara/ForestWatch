"""
Pruebas automáticas del motor Python (geojson_validator.py).
Ejecutar: python -m unittest discover -s tests -v

Incluye una prueba de PARIDAD: si Node.js está instalado, compara diagnóstico a
diagnóstico los resultados de Python con los del motor JavaScript del navegador.

Autor: Renato Andara
"""

import json
import os
import shutil
import subprocess
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(BASE_DIR, "tests", "fixtures")
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from geojson_validator import GeoJSONRepairer, GeoJSONValidator, GeoUtils, main  # noqa: E402

with open(os.path.join(FIX, "expected.json"), encoding="utf-8") as fh:
    EXPECTED = {k: v for k, v in json.load(fh).items() if not k.startswith("_")}

SQ = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]


def fc(*geoms):
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {"PlotID": f"P{i}"}, "geometry": g} for i, g in enumerate(geoms)]}


def P(*rings):
    return {"type": "Polygon", "coordinates": [list(r) for r in rings]}


def cats(r):
    return [i["category"] for i in r["issues"]]


class TestFixtures(unittest.TestCase):
    def test_expected_results(self):
        v = GeoJSONValidator()
        for name, exp in EXPECTED.items():
            with self.subTest(archivo=name):
                r = v.validate_file(os.path.join(FIX, name))
                self.assertEqual(r["overall_status"], exp["status"])
                if "errors" in exp:
                    self.assertEqual(r["summary"]["errors"], exp["errors"])
                if "warnings" in exp:
                    self.assertEqual(r["summary"]["warnings"], exp["warnings"])
                for c in exp["categories"]:
                    self.assertIn(c, cats(r))
                if "location" in exp:
                    self.assertTrue(any(i["location"] and abs(i["location"][0] - exp["location"][0]) < 1e-6
                                        and abs(i["location"][1] - exp["location"][1]) < 1e-6 for i in r["issues"]))
                if "repaired_status" in exp:
                    rep = GeoJSONRepairer.repair(r["data"])
                    self.assertEqual(GeoJSONValidator().validate_data(rep["repairedData"])["overall_status"], exp["repaired_status"])


@unittest.skipUnless(shutil.which("node"), "Node.js no está instalado")
class TestParityWithJavaScript(unittest.TestCase):
    """Python y JavaScript deben producir exactamente los mismos diagnósticos."""

    def test_same_issues(self):
        script = (
            "const {GeoJSONValidator}=require(process.argv[1]+'/js/validator.js');"
            "const fs=require('fs');const out={};"
            "for(const f of JSON.parse(process.argv[2])){"
            "const r=new GeoJSONValidator().validate(fs.readFileSync(process.argv[1]+'/tests/fixtures/'+f,'utf8'));"
            "out[f]=r.issues.filter(i=>i.category!=='Sintaxis JSON').map(i=>[i.severity,i.category,i.message]);}"
            "console.log(JSON.stringify(out));"
        )
        names = list(EXPECTED)
        js = json.loads(subprocess.check_output(["node", "-e", script, BASE_DIR, json.dumps(names)], text=True))
        for name in names:
            with self.subTest(archivo=name):
                r = GeoJSONValidator().validate_file(os.path.join(FIX, name))
                py = [[i["severity"], i["category"], i["message"]] for i in r["issues"] if i["category"] != "Sintaxis JSON"]
                self.assertEqual(py, js[name])


class TestTopology(unittest.TestCase):
    def setUp(self):
        self.v = GeoJSONValidator()

    def test_adjacent_parcels_are_not_overlaps(self):
        self.assertEqual(self.v.validate_data(fc(P(SQ), P([[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]])))["summary"]["errors"], 0)
        self.assertEqual(self.v.validate_data(fc(P([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]),
                                                 P([[2, 0.5], [3, 0.5], [3, 1.5], [2, 1.5], [2, 0.5]])))["summary"]["errors"], 0)

    def test_overlaps(self):
        self.assertIn("Solapamiento Inter-Parcelas", cats(self.v.validate_data(
            fc(P([[0, 1], [3, 1], [3, 2], [0, 2], [0, 1]]), P([[1, 0], [2, 0], [2, 3], [1, 3], [1, 0]])))))
        self.assertIn("Solapamiento Inter-Parcelas", cats(self.v.validate_data(
            fc(P([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]), P([[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]])))))
        r = self.v.validate_data(fc(P(SQ), P(SQ)))
        self.assertTrue(any(i["details"].get("identical") for i in r["issues"]))

    def test_parcel_inside_hole_is_valid(self):
        donut = P([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]])
        self.assertEqual(self.v.validate_data(fc(donut, P([[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]])))["summary"]["errors"], 0)

    def test_pinch_reported_once_and_spike(self):
        r = self.v.validate_data(fc(P([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 1], [0, 0]])))
        self.assertEqual(sum(c.startswith("Punto de Auto-Contacto") for c in cats(r)), 1)
        self.assertIn("Espiga / Retroceso de Borde",
                      cats(self.v.validate_data(fc(P([[0, 0], [2, 0], [1, 0], [1, 1], [0, 1], [0, 0]])))))

    def test_invalid_coordinates_do_not_crash(self):
        r = self.v.validate_data(fc({"type": "Polygon", "coordinates": [[[0, 0], "x", [1, 1], None]]}))
        self.assertIn("Coordenada Inválida", cats(r))

    def test_feature_status_and_area(self):
        r = self.v.validate_data(fc(P([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]),
                                    P([[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]])))
        self.assertEqual([f["status"] for f in r["features"]], ["VALIDO", "ALERTA"])
        self.assertAlmostEqual(r["features"][0]["area_ha"], 123.6, delta=1)


class TestRepair(unittest.TestCase):
    def test_open_ring_keeps_all_vertices(self):
        rep = GeoJSONRepairer.repair(fc(P([[0, 0], [1, 0], [1, 1], [0, 1], [-0.5, 0.5]])))
        ring = rep["repairedData"]["features"][0]["geometry"]["coordinates"][0]
        self.assertEqual(len(ring), 6)
        self.assertIn([-0.5, 0.5], ring)

    def test_duplicates_winding_and_holes(self):
        bad = P([[0, 0], [0, 10], [10, 10], [10, 0], [10, 0], [0, 0]], [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]])
        rep = GeoJSONRepairer.repair(fc(bad))
        ext, hole = rep["repairedData"]["features"][0]["geometry"]["coordinates"]
        self.assertGreater(GeoUtils.signed_area(ext), 0)
        self.assertLess(GeoUtils.signed_area(hole), 0)
        self.assertEqual(len(ext), 5)

    def test_original_untouched_and_legacy_api(self):
        src = fc(P([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]))
        before = json.dumps(src)
        data, changes = GeoJSONRepairer.repair_data(src)
        self.assertEqual(json.dumps(src), before)
        self.assertEqual(len(changes), 1)
        self.assertNotIn("metadata", data)


class TestCLI(unittest.TestCase):
    def test_exit_codes_and_repair(self):
        import tempfile
        from contextlib import redirect_stdout
        from io import StringIO
        with redirect_stdout(StringIO()):
            self.assertEqual(main([os.path.join(FIX, "valida_colindantes.geojson")]), 0)
            self.assertEqual(main([os.path.join(FIX, "auto_interseccion.geojson")]), 1)
            self.assertEqual(main([os.path.join(FIX, "no_existe.geojson")]), 2)
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "rep.geojson")
                main([os.path.join(FIX, "anillo_abierto_duplicados.geojson"), "--reparar", out])
                self.assertEqual(GeoJSONValidator().validate_file(out)["overall_status"], "VALIDO")


if __name__ == "__main__":
    unittest.main()
