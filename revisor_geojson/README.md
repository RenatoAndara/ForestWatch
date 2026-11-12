# Revisor GeoJSON

**Autor:** Renato Andara · **Versión:** 2.0.0

Aplicación local para **validar, visualizar y reparar** archivos GeoJSON de parcelas: formato RFC 7946, topología (auto-intersecciones, huecos, solapamientos), regla de la mano derecha y comprobaciones útiles para declaraciones EUDR. El análisis ocurre en el navegador; el archivo no se sube a ningún servidor.

## Inicio rápido

- **Doble clic** en `index.html`, o bien:

```bash
python serve.py
```

- **Línea de comandos:**

```bash
python geojson_validator.py parcelas.geojson --reparar parcelas_ok.geojson
```

## Documentación

- [MANUAL_DE_USO.md](MANUAL_DE_USO.md) — uso, significado de cada diagnóstico, reparación, reportes.
- [ARQUITECTURA.md](ARQUITECTURA.md) — módulos, algoritmos, seguridad, pruebas.
- [MEMORIA.md](MEMORIA.md) — fundamentos normativos y matemáticos.
- [CHANGELOG.md](CHANGELOG.md) — cambios de la versión 2.0.0.

## Pruebas

```bash
npm test
```

```bash
python -m unittest discover -s tests -v
```

## Licencias de terceros

- [Leaflet 1.9.4](https://leafletjs.com/) — BSD-2-Clause (`vendor/leaflet/LICENSE`).
- Mapas base: imágenes © Esri y colaboradores; © colaboradores de OpenStreetMap. Revise sus condiciones de uso si la aplicación se usa de forma intensiva o comercial.
