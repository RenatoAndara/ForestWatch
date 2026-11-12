/**
 * Motor de Reparación y Exportación GeoJSON (RFC 7946)
 *
 * Autor: Renato Andara
 *
 * Correcciones automáticas y seguras (no alteran la forma de la parcela):
 *   - Cierra anillos abiertos SIN perder vértices.
 *   - Elimina vértices duplicados consecutivos (incluido el previo al cierre).
 *   - Orienta anillos según la regla de la mano derecha (exterior CCW, huecos CW).
 *   - Añade "properties": {} cuando falta.
 *   - Elimina el miembro "crs" obsoleto cuando ya declara WGS84 (CRS84 / EPSG:4326).
 *
 * NO corrige (requiere decisión humana): auto-intersecciones, solapamientos,
 * coordenadas fuera de rango o proyectadas.
 */
(function (root, factory) {
    'use strict';
    const geo = (typeof module === 'object' && module.exports)
        ? require('./validator.js').GeoUtils
        : root.GeoUtils;
    const api = factory(geo);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(root, api);
    }
})(typeof self !== 'undefined' ? self : this, function (GeoUtils) {
    'use strict';

    const isPosition = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

    class GeoJSONRepairer {
        /**
         * @param {object} geojsonObj  GeoJSON ya parseado.
         * @param {object} [options]
         * @param {boolean} [options.addMetadata=false]  Añadir bloque "metadata" de trazabilidad
         *        (miembro ajeno permitido por RFC 7946 §6.1, pero algunos sistemas lo rechazan).
         */
        static repair(geojsonObj, options = {}) {
            const repaired = JSON.parse(JSON.stringify(geojsonObj));
            const changes = [];
            const unrepaired = [];
            const ctx = { changes, unrepaired };

            if (repaired && typeof repaired === 'object' && repaired.crs !== undefined) {
                if (this._crsIsWGS84(repaired.crs)) {
                    delete repaired.crs;
                    changes.push('Se eliminó el miembro "crs" (obsoleto en RFC 7946; ya declaraba WGS84).');
                } else {
                    unrepaired.push('El miembro "crs" declara un sistema distinto de WGS84: reproyecte el archivo a EPSG:4326 con un SIG (QGIS, ogr2ogr).');
                }
            }

            const rootType = repaired && repaired.type;
            if (rootType === 'FeatureCollection' && Array.isArray(repaired.features)) {
                repaired.features.forEach((feat, fIdx) => this._repairFeature(feat, fIdx, ctx));
            } else if (rootType === 'Feature') {
                this._repairFeature(repaired, 0, ctx);
            } else if (rootType) {
                this._repairGeometry(repaired, 'Geometría raíz', ctx);
            }

            if (options.addMetadata && repaired && typeof repaired === 'object') {
                repaired.metadata = Object.assign({}, repaired.metadata, {
                    repaired_by: 'Revisor GeoJSON RFC 7946',
                    repaired_at: new Date().toISOString(),
                    repair_notes: changes
                });
            }

            return { repairedData: repaired, changesCount: changes.length, changes, unrepaired };
        }

        static _crsIsWGS84(crs) {
            const name = String(crs?.properties?.name ?? crs?.properties?.code ?? '').toUpperCase();
            return /CRS84|EPSG:+4326|EPSG::4326|^4326$/.test(name);
        }

        static _repairFeature(feat, fIdx, ctx) {
            if (!feat || typeof feat !== 'object' || feat.type !== 'Feature') return;
            const label = GeoUtils.featureLabel(feat, fIdx);
            if (!('properties' in feat)) {
                feat.properties = {};
                ctx.changes.push(`${label}: se añadió "properties": {} (miembro obligatorio en RFC 7946 §3.2).`);
            }
            if (feat.geometry && typeof feat.geometry === 'object') {
                this._repairGeometry(feat.geometry, label, ctx);
            }
        }

        static _repairGeometry(geom, label, ctx) {
            if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
                geom.geometries.forEach((g, k) => g && this._repairGeometry(g, `${label} [Geom ${k + 1}]`, ctx));
            } else if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates = this._repairPolygon(geom.coordinates, label, ctx);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                const multi = geom.coordinates.length > 1;
                geom.coordinates = geom.coordinates.map((poly, k) =>
                    Array.isArray(poly) ? this._repairPolygon(poly, multi ? `${label} [Parte ${k + 1}]` : label, ctx) : poly);
            }
        }

        static _repairPolygon(rings, label, ctx) {
            return rings.map((ring, rIdx) => {
                const ringName = rIdx === 0 ? 'anillo exterior' : `hueco ${rIdx}`;
                if (!Array.isArray(ring) || !ring.every(isPosition)) {
                    ctx.unrepaired.push(`${label} (${ringName}): contiene coordenadas inválidas; corríjalas manualmente.`);
                    return ring;
                }
                if (ring.length === 0) return ring;

                const wasClosed = ring.length > 1 && GeoUtils.samePoint(ring[0], ring[ring.length - 1]);
                const open = wasClosed ? ring.slice(0, -1) : ring.slice();

                // Eliminar duplicados consecutivos (tratando el anillo como circular).
                const cleaned = [];
                for (const p of open) {
                    if (cleaned.length && GeoUtils.samePoint(cleaned[cleaned.length - 1], p)) continue;
                    cleaned.push(p);
                }
                while (cleaned.length > 1 && GeoUtils.samePoint(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop();
                const removed = open.length - cleaned.length;

                if (cleaned.length < 3) {
                    ctx.unrepaired.push(`${label} (${ringName}): tiene menos de 3 vértices distintos; no puede formar un polígono.`);
                    return ring;
                }

                const out = cleaned.concat([cleaned[0].slice()]);
                if (!wasClosed) ctx.changes.push(`${label} (${ringName}): anillo cerrado repitiendo el primer vértice al final.`);
                if (removed > 0) ctx.changes.push(`${label} (${ringName}): se eliminaron ${removed} vértice(s) duplicado(s) consecutivo(s).`);

                const isCCW = GeoUtils.signedArea(out) > 0;
                if (rIdx === 0 && !isCCW) {
                    out.reverse();
                    ctx.changes.push(`${label} (anillo exterior): orientación invertida a antihoraria (CCW) según RFC 7946 §3.1.6.`);
                } else if (rIdx > 0 && isCCW) {
                    out.reverse();
                    ctx.changes.push(`${label} (${ringName}): orientación invertida a horaria (CW) según RFC 7946 §3.1.6.`);
                }
                return out;
            });
        }

        static outputFilename(originalFilename) {
            const base = String(originalFilename || 'archivo').replace(/\.(geo)?json$/i, '');
            return `${base}_reparado_RFC7946.geojson`;
        }

        /** Descarga (solo navegador). */
        static downloadGeoJSON(data, originalFilename) {
            GeoJSONRepairer.downloadText(JSON.stringify(data, null, 2),
                GeoJSONRepairer.outputFilename(originalFilename), 'application/geo+json;charset=utf-8');
        }

        static downloadText(text, filename, mime) {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    return { GeoJSONRepairer };
});
