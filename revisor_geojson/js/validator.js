/**
 * Motor de Validación GeoJSON (RFC 7946 / topología OGC / EUDR)
 *
 * Autor: Renato Andara
 *
 * Fuente única del motor: se carga como <script> clásico en el navegador
 * (funciona con file:// y http://) y con require() en Node para las pruebas.
 * Expone: ValidationSeverity, GeoUtils, GeoJSONValidator.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(root, api);
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ValidationSeverity = {
        ERROR: 'ERROR',
        WARNING: 'ALERTA',
        INFO: 'INFO'
    };

    const SEVERITY_RANK = { VALIDO: 0, INFO: 0, ALERTA: 1, ERROR: 2 };

    // Máximo de auto-intersecciones reportadas por anillo (evita miles de filas
    // en anillos completamente desordenados).
    const MAX_ISSUES_PER_RING = 25;

    // Tolerancia relativa para considerar tres puntos colineales (≈ ruido de
    // coma flotante; muy por debajo de cualquier precisión de levantamiento).
    const COLLINEAR_EPS = 1e-10;

    const GEOMETRY_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString',
        'Polygon', 'MultiPolygon', 'GeometryCollection'];

    // ------------------------------------------------------------------
    // Utilidades geométricas compartidas (validador, reparador y mapa)
    // ------------------------------------------------------------------
    const GeoUtils = {
        samePoint(a, b) {
            return a[0] === b[0] && a[1] === b[1];
        },

        key(p) {
            return p[0] + ',' + p[1];
        },

        /** Producto cruzado (b - a) x (c - a). > 0 giro antihorario. */
        orient(a, b, c) {
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        },

        /** Signo de orient() con tolerancia relativa a la escala. */
        orientSign(a, b, c) {
            const o = GeoUtils.orient(a, b, c);
            const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - a[0], c[1] - a[1]);
            if (Math.abs(o) <= COLLINEAR_EPS * scale) return 0;
            return o > 0 ? 1 : -1;
        },

        /** p colineal con a-b: ¿está dentro de la caja del segmento? */
        withinBox(p, a, b) {
            return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
                   p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
        },

        pointOnSegment(p, a, b) {
            return GeoUtils.orientSign(a, b, p) === 0 && GeoUtils.withinBox(p, a, b);
        },

        lineIntersection(p1, p2, p3, p4) {
            const denom = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
            if (denom === 0) return null;
            const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / denom;
            return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
        },

        /**
         * Relación entre dos segmentos:
         *   null                      → no se tocan
         *   { type: 'cross', point }  → cruce propio (interior con interior)
         *   { type: 'touch', point }  → contacto en un único punto (extremo)
         *   { type: 'overlap', point }→ tramos colineales superpuestos
         */
        segmentRelation(p1, p2, q1, q2) {
            const d1 = GeoUtils.orientSign(q1, q2, p1);
            const d2 = GeoUtils.orientSign(q1, q2, p2);
            const d3 = GeoUtils.orientSign(p1, p2, q1);
            const d4 = GeoUtils.orientSign(p1, p2, q2);

            if (d1 * d2 < 0 && d3 * d4 < 0) {
                return { type: 'cross', point: GeoUtils.lineIntersection(p1, p2, q1, q2) || p1.slice(0, 2) };
            }

            if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
                const ax = Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? 0 : 1;
                const lo = Math.max(Math.min(p1[ax], p2[ax]), Math.min(q1[ax], q2[ax]));
                const hi = Math.min(Math.max(p1[ax], p2[ax]), Math.max(q1[ax], q2[ax]));
                if (lo > hi) return null;
                const shared = [p1, p2, q1, q2].find(pt => pt[ax] === lo &&
                    GeoUtils.withinBox(pt, p1, p2) && GeoUtils.withinBox(pt, q1, q2)) || p1;
                return { type: lo === hi ? 'touch' : 'overlap', point: shared.slice(0, 2) };
            }

            if (d1 === 0 && GeoUtils.withinBox(p1, q1, q2)) return { type: 'touch', point: p1.slice(0, 2) };
            if (d2 === 0 && GeoUtils.withinBox(p2, q1, q2)) return { type: 'touch', point: p2.slice(0, 2) };
            if (d3 === 0 && GeoUtils.withinBox(q1, p1, p2)) return { type: 'touch', point: q1.slice(0, 2) };
            if (d4 === 0 && GeoUtils.withinBox(q2, p1, p2)) return { type: 'touch', point: q2.slice(0, 2) };
            return null;
        },

        /** Área con signo (fórmula del cordón/Shoelace, ×2). > 0 → CCW. */
        signedArea(ring) {
            let area = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            }
            return area;
        },

        /** 1 = dentro, 0 = sobre el borde, -1 = fuera. */
        pointInRing(pt, ring) {
            const n = ring.length;
            for (let i = 0; i < n - 1; i++) {
                if (GeoUtils.pointOnSegment(pt, ring[i], ring[i + 1])) return 0;
            }
            const [x, y] = pt;
            let inside = false;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                }
            }
            return inside ? 1 : -1;
        },

        /** Igual que pointInRing pero considerando huecos del polígono. */
        pointInPolygon(pt, rings) {
            const ext = GeoUtils.pointInRing(pt, rings[0]);
            if (ext <= 0) return ext;
            for (let h = 1; h < rings.length; h++) {
                const r = GeoUtils.pointInRing(pt, rings[h]);
                if (r === 0) return 0;
                if (r === 1) return -1;
            }
            return 1;
        },

        bbox(ring) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of ring) {
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            }
            return [minX, minY, maxX, maxY];
        },

        bboxesOverlap(a, b) {
            return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
        },

        /** Segmentos no nulos de un anillo, con su caja envolvente. */
        buildSegments(ring, ringIndex) {
            const segs = [];
            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i], b = ring[i + 1];
                if (GeoUtils.samePoint(a, b)) continue;
                segs.push({
                    a, b, i, ring: ringIndex, seq: segs.length,
                    minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
                    minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1])
                });
            }
            return segs;
        },

        /**
         * Barrido por X: invoca cb(s, t) para cada par de segmentos cuyas
         * cajas se solapan. Mucho más rápido que O(n²) en anillos grandes.
         */
        sweepPairs(segs, cb) {
            const sorted = segs.slice().sort((s, t) => s.minX - t.minX);
            for (let x = 0; x < sorted.length; x++) {
                const s = sorted[x];
                for (let y = x + 1; y < sorted.length; y++) {
                    const t = sorted[y];
                    if (t.minX > s.maxX) break;
                    if (t.maxY < s.minY || t.minY > s.maxY) continue;
                    if (cb(s, t) === false) return;
                }
            }
        },

        haversine(p1, p2) {
            const R = 6371008.8;
            const toRad = Math.PI / 180;
            const dLat = (p2[1] - p1[1]) * toRad;
            const dLon = (p2[0] - p1[0]) * toRad;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(p1[1] * toRad) * Math.cos(p2[1] * toRad) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        },

        /** Área esférica aproximada de un anillo en m² (radio WGS84 ecuatorial). */
        ringAreaM2(ring) {
            const R = 6378137;
            const toRad = Math.PI / 180;
            let area = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                const p1 = ring[i], p2 = ring[i + 1];
                area += (p2[0] - p1[0]) * toRad * (2 + Math.sin(p1[1] * toRad) + Math.sin(p2[1] * toRad));
            }
            return Math.abs(area * R * R / 2);
        },

        /** Métricas de un Polygon (anillos): área neta (exterior − huecos) y perímetro exterior. */
        polygonMetrics(rings) {
            if (!Array.isArray(rings) || !rings.length) return { areaM2: 0, perimeterM: 0, vertices: 0 };
            let areaM2 = 0, perimeterM = 0, vertices = 0;
            rings.forEach((ring, idx) => {
                if (!Array.isArray(ring) || ring.length < 4) return;
                const a = GeoUtils.ringAreaM2(ring);
                areaM2 += idx === 0 ? a : -a;
                vertices += ring.length - 1;
                if (idx === 0) {
                    for (let i = 0; i < ring.length - 1; i++) perimeterM += GeoUtils.haversine(ring[i], ring[i + 1]);
                }
            });
            return { areaM2: Math.max(0, areaM2), perimeterM, vertices };
        },

        /** Decimales con que está escrito un número (tras JSON.parse). */
        decimals(n) {
            if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
            const s = String(n);
            const e = s.indexOf('e-');
            if (e >= 0) {
                const mant = s.slice(0, e);
                const dot = mant.indexOf('.');
                return (dot >= 0 ? mant.length - dot - 1 : 0) + parseInt(s.slice(e + 2), 10);
            }
            const dot = s.indexOf('.');
            return dot >= 0 ? s.length - dot - 1 : 0;
        },

        /** Escapa texto para insertarlo de forma segura en HTML. */
        escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[ch]);
        },

        /** Identificador legible de una entidad. */
        featureLabel(feat, fIdx) {
            const props = (feat && typeof feat.properties === 'object' && feat.properties) || {};
            const candidates = [props.PlotID, props.plotId, props.plot_id, props.ProductionPlace,
                props.id, props.ID, props.Id, props.name, props.Name, props.NOMBRE, feat && feat.id];
            const found = candidates.find(v => v !== undefined && v !== null && String(v).trim() !== '');
            return found !== undefined ? String(found) : `Entidad #${fIdx + 1}`;
        },

        /** Identificador "oficial" (para duplicados): solo PlotID o id explícitos. */
        featureId(feat) {
            const props = (feat && typeof feat.properties === 'object' && feat.properties) || {};
            const v = props.PlotID ?? props.plotId ?? props.plot_id ?? feat?.id ?? props.id;
            return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
        }
    };

    // ------------------------------------------------------------------
    // Validador
    // ------------------------------------------------------------------
    class GeoJSONValidator {
        constructor() {
            this.issues = [];
        }

        validate(geojsonStringOrObject) {
            this.issues = [];
            this._stats = { exteriorRings: 0, ccwExteriors: 0, points: 0 };
            let data = geojsonStringOrObject;

            if (typeof data === 'string') {
                // Quitar BOM UTF-8 (frecuente en archivos exportados desde Windows).
                const text = data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data;
                if (!text.trim()) {
                    this._add('ERROR', 'Sintaxis JSON', 'El archivo está vacío.');
                    return this._buildResult([], null);
                }
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    this._add('ERROR', 'Sintaxis JSON', `El archivo no es un JSON válido: ${e.message}`);
                    return this._buildResult([], null);
                }
            }

            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                this._add('ERROR', 'Estructura GeoJSON', 'La raíz del archivo debe ser un objeto JSON.');
                return this._buildResult([], data ?? null);
            }

            const rootType = data.type;
            if (!rootType) {
                this._add('ERROR', 'Estructura GeoJSON', 'El objeto raíz no contiene la propiedad requerida "type".');
                return this._buildResult([], data);
            }

            if (data.crs !== undefined) {
                this._add('ALERTA', 'Sistema de Referencia (crs)',
                    'El miembro "crs" pertenece a la especificación GeoJSON 2008 y fue eliminado en RFC 7946 (§4): ' +
                    'las coordenadas deben estar siempre en WGS84 (longitud, latitud en grados decimales).',
                    { details: { crs: data.crs } });
            }

            let features;
            if (rootType === 'FeatureCollection') {
                if (!Array.isArray(data.features)) {
                    this._add('ERROR', 'Estructura GeoJSON', 'La propiedad "features" de FeatureCollection debe ser un arreglo.');
                    return this._buildResult([], data);
                }
                features = data.features;
                if (features.length === 0) {
                    this._add('ALERTA', 'Estructura GeoJSON', 'La FeatureCollection no contiene ninguna entidad (features vacío).');
                }
            } else if (rootType === 'Feature') {
                features = [data];
            } else if (GEOMETRY_TYPES.includes(rootType)) {
                features = [{ type: 'Feature', geometry: data, properties: {} }];
            } else {
                this._add('ERROR', 'Estructura GeoJSON', `Tipo GeoJSON no reconocido: "${rootType}".`);
                return this._buildResult([], data);
            }

            const polygons = [];
            const featureInfo = features.map((feat, fIdx) => this._validateFeature(feat, fIdx, polygons));

            this._checkDuplicateIds(features);
            if (polygons.length >= 2) this._checkInterPolygonOverlaps(polygons);
            this._addSummaryNotes();

            return this._buildResult(featureInfo, data);
        }

        _add(severity, category, message, options = {}) {
            this.issues.push({
                severity,
                category,
                message,
                feature_index: options.featureIndex ?? null,
                related_feature_index: options.relatedFeatureIndex ?? null,
                plot_id: options.plotId ?? null,
                location: options.location ?? null,
                details: options.details ?? {}
            });
        }

        // -------------------------- Entidades --------------------------
        _validateFeature(feat, fIdx, polygons) {
            const info = { index: fIdx, plot_id: `Entidad #${fIdx + 1}`, geometry_type: null, area_ha: null, perimeter_m: null, vertices: 0 };

            if (!feat || typeof feat !== 'object' || Array.isArray(feat) || feat.type !== 'Feature') {
                this._add('ERROR', 'Estructura Feature',
                    `El elemento en el índice ${fIdx} no es un Feature válido (se esperaba "type": "Feature").`,
                    { featureIndex: fIdx });
                return info;
            }

            const plotId = GeoUtils.featureLabel(feat, fIdx);
            info.plot_id = plotId;
            const ctx = { fIdx, plotId };

            if (!('properties' in feat)) {
                this._add('ALERTA', 'Estructura Feature',
                    `La entidad "${plotId}" no tiene el miembro "properties" (RFC 7946 §3.2 lo exige, aunque sea null).`,
                    { featureIndex: fIdx, plotId });
            }

            const geom = feat.geometry;
            if (geom === null || geom === undefined) {
                this._add('ERROR', 'Geometría Nula', `La entidad "${plotId}" no contiene geometría.`, { featureIndex: fIdx, plotId });
                return info;
            }

            info.geometry_type = geom.type || null;
            const metrics = { areaM2: 0, perimeterM: 0, vertices: 0, hasArea: false };
            this._validateGeometry(geom, ctx, plotId, polygons, metrics);
            this._checkPrecision(geom, ctx);

            info.vertices = metrics.vertices;
            if (metrics.hasArea) {
                info.area_ha = metrics.areaM2 / 10000;
                info.perimeter_m = metrics.perimeterM;
            }
            return info;
        }

        _validateGeometry(geom, ctx, label, polygons, metrics) {
            const { fIdx, plotId } = ctx;
            if (typeof geom !== 'object' || Array.isArray(geom) || !geom.type) {
                this._add('ERROR', 'Geometría Inválida', `La geometría de "${label}" no tiene un "type" válido.`, { featureIndex: fIdx, plotId });
                return;
            }

            if (geom.type === 'GeometryCollection') {
                if (!Array.isArray(geom.geometries)) {
                    this._add('ERROR', 'Geometría Inválida', `La GeometryCollection de "${label}" no tiene un arreglo "geometries".`, { featureIndex: fIdx, plotId });
                    return;
                }
                geom.geometries.forEach((g, k) => this._validateGeometry(g, ctx, `${label} [Geom ${k + 1}]`, polygons, metrics));
                return;
            }

            if (!GEOMETRY_TYPES.includes(geom.type)) {
                this._add('ERROR', 'Tipo de Geometría', `Tipo de geometría "${geom.type}" no reconocido en "${label}".`, { featureIndex: fIdx, plotId });
                return;
            }

            if (!Array.isArray(geom.coordinates)) {
                this._add('ERROR', 'Geometría Inválida', `La geometría ${geom.type} de "${label}" no tiene un arreglo "coordinates".`, { featureIndex: fIdx, plotId });
                return;
            }

            const c = geom.coordinates;
            switch (geom.type) {
                case 'Point':
                    this._stats.points++;
                    this._checkPositions([c], ctx, `punto de "${label}"`);
                    metrics.vertices += 1;
                    break;
                case 'MultiPoint':
                    this._stats.points++;
                    this._checkPositions(c, ctx, `MultiPoint de "${label}"`);
                    metrics.vertices += c.length;
                    break;
                case 'LineString':
                    this._validateLine(c, ctx, label, metrics);
                    break;
                case 'MultiLineString':
                    c.forEach((line, k) => this._validateLine(line, ctx, `${label} [Línea ${k + 1}]`, metrics));
                    break;
                case 'Polygon':
                    this._validatePolygon(c, ctx, label, polygons, metrics);
                    break;
                case 'MultiPolygon':
                    if (c.length === 0) {
                        this._add('ERROR', 'Geometría Vacía', `El MultiPolygon de "${label}" no contiene polígonos.`, { featureIndex: fIdx, plotId });
                    }
                    c.forEach((poly, k) => this._validatePolygon(poly, ctx, c.length > 1 ? `${label} [Parte ${k + 1}]` : label, polygons, metrics, k));
                    break;
            }
        }

        _validateLine(line, ctx, label, metrics) {
            if (!Array.isArray(line) || line.length < 2) {
                this._add('ERROR', 'Vértices Insuficientes', `La línea "${label}" necesita al menos 2 posiciones.`, { featureIndex: ctx.fIdx, plotId: ctx.plotId });
                return;
            }
            this._checkPositions(line, ctx, `línea "${label}"`);
            metrics.vertices += line.length;
        }

        /**
         * Valida que cada posición sea [lon, lat(, alt)] numérica y dentro de
         * WGS84. Los problemas se agregan (un solo diagnóstico por anillo).
         * Devuelve true si todas las posiciones son utilizables.
         */
        _checkPositions(positions, ctx, where) {
            const { fIdx, plotId } = ctx;
            if (!Array.isArray(positions)) {
                this._add('ERROR', 'Coordenada Inválida', `Las coordenadas del ${where} no son un arreglo.`, { featureIndex: fIdx, plotId });
                return false;
            }
            let badIdx = -1, badCount = 0;
            let outIdx = -1, outCount = 0, outPt = null;
            let swappedPossible = true, projectedLikely = true;
            let extraDims = 0;

            positions.forEach((pt, i) => {
                if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
                    if (badIdx < 0) badIdx = i;
                    badCount++;
                    return;
                }
                if (pt.length > 3) extraDims++;
                const [lon, lat] = pt;
                if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
                    if (outIdx < 0) { outIdx = i; outPt = pt; }
                    outCount++;
                    if (!(Math.abs(lat) <= 180 && Math.abs(lon) <= 90)) swappedPossible = false;
                    if (!(Math.abs(lon) > 1000 || Math.abs(lat) > 1000)) projectedLikely = false;
                }
            });

            if (badCount) {
                this._add('ERROR', 'Coordenada Inválida',
                    `${badCount} posición(es) del ${where} no son de la forma [longitud, latitud] numérica (primera en el índice ${badIdx}).`,
                    { featureIndex: fIdx, plotId, details: { firstIndex: badIdx, count: badCount } });
            }
            if (outCount) {
                let hint = '';
                if (projectedLikely) hint = ' Los valores parecen coordenadas proyectadas (p. ej. UTM, en metros): RFC 7946 exige grados decimales WGS84; reproyecte a EPSG:4326.';
                else if (swappedPossible) hint = ' Es posible que longitud y latitud estén invertidas: RFC 7946 exige el orden [longitud, latitud].';
                this._add('ERROR', 'Límites WGS84',
                    `${outCount} coordenada(s) del ${where} fuera del rango WGS84 (lon ±180, lat ±90); primera: vértice ${outIdx} [${outPt[0]}, ${outPt[1]}].${hint}`,
                    { featureIndex: fIdx, plotId, details: { firstIndex: outIdx, count: outCount } });
            }
            if (extraDims) {
                this._add('ALERTA', 'Dimensiones de Coordenadas',
                    `${extraDims} posición(es) del ${where} tienen más de 3 valores; RFC 7946 §3.1.1 recomienda usar solo [lon, lat] o [lon, lat, altitud].`,
                    { featureIndex: fIdx, plotId });
            }
            return badCount === 0 && outCount === 0;
        }

        // -------------------------- Polígonos --------------------------
        _validatePolygon(rings, ctx, label, polygons, metrics, partIndex = null) {
            const { fIdx, plotId } = ctx;
            const opt = { featureIndex: fIdx, plotId: label };

            if (!Array.isArray(rings) || rings.length === 0) {
                this._add('ERROR', 'Geometría Vacía', `El polígono "${label}" no tiene anillos de coordenadas.`, opt);
                return;
            }

            let usable = true;
            rings.forEach((ring, rIdx) => {
                const ringName = rIdx === 0 ? 'anillo exterior' : `anillo interior (hueco ${rIdx})`;
                if (!Array.isArray(ring)) {
                    this._add('ERROR', 'Geometría Inválida', `El ${ringName} de "${label}" no es un arreglo de posiciones.`, opt);
                    usable = false;
                    return;
                }
                if (!this._checkPositions(ring, ctx, `${ringName} de "${label}"`)) {
                    usable = false;
                    return;
                }
                if (ring.length < 4) {
                    this._add('ERROR', 'Vértices Insuficientes',
                        `El ${ringName} de "${label}" tiene ${ring.length} posición(es); un anillo cerrado necesita al menos 4 (RFC 7946 §3.1.6).`, opt);
                    usable = false;
                    return;
                }
                const first = ring[0], last = ring[ring.length - 1];
                if (!GeoUtils.samePoint(first, last)) {
                    this._add('ERROR', 'Anillo Abierto',
                        `El ${ringName} de "${label}" no está cerrado: el primer vértice [${first[0]}, ${first[1]}] difiere del último [${last[0]}, ${last[1]}].`,
                        { ...opt, location: [first[0], first[1]] });
                    usable = false;
                }
            });

            metrics.vertices += rings.reduce((s, r) => s + (Array.isArray(r) ? Math.max(0, r.length - 1) : 0), 0);
            if (!usable) return;

            rings.forEach((ring, rIdx) => {
                const ringName = rIdx === 0 ? 'anillo exterior' : `anillo interior (hueco ${rIdx})`;
                this._checkDuplicates(ring, ringName, label, fIdx);
                const distinct = new Set(ring.slice(0, -1).map(GeoUtils.key)).size;
                if (distinct < 3) {
                    this._add('ERROR', 'Anillo Degenerado',
                        `El ${ringName} de "${label}" tiene solo ${distinct} vértice(s) distinto(s); no encierra superficie.`,
                        { ...opt, location: [ring[0][0], ring[0][1]] });
                    return;
                }
                this._checkRingSelfIntersections(ring, ringName, label, fIdx);
                this._checkWinding(ring, rIdx === 0, ringName, label, fIdx);
            });

            if (rings.length > 1) this._checkHoles(rings, label, fIdx);

            const m = GeoUtils.polygonMetrics(rings);
            metrics.areaM2 += m.areaM2;
            metrics.perimeterM += m.perimeterM;
            metrics.hasArea = true;

            polygons.push({ fIdx, plotId: label, featureLabel: plotId, partIndex, rings, bbox: GeoUtils.bbox(rings[0]) });
        }

        _checkDuplicates(ring, ringName, label, fIdx) {
            const dups = [];
            for (let i = 0; i < ring.length - 1; i++) {
                if (GeoUtils.samePoint(ring[i], ring[i + 1])) dups.push(i);
            }
            if (!dups.length) return;
            const p = ring[dups[0]];
            this._add('ERROR', 'Vértices Duplicados Consecutivos',
                `${dups.length} vértice(s) duplicado(s) consecutivo(s) en el ${ringName} de "${label}" ` +
                `(índices ${dups.slice(0, 5).map(i => `${i}-${i + 1}`).join(', ')}${dups.length > 5 ? '…' : ''}). Se corrigen con "Reparar".`,
                { featureIndex: fIdx, plotId: label, location: [p[0], p[1]], details: { vertexIndices: dups, coordinate: p } });
        }

        _checkRingSelfIntersections(ring, ringName, label, fIdx) {
            const segs = GeoUtils.buildSegments(ring, 0);
            const m = segs.length;
            const seenTouches = new Set();
            let reported = 0, suppressed = 0;
            const base = { featureIndex: fIdx, plotId: label };

            const report = (severity, category, message, location, details) => {
                if (reported >= MAX_ISSUES_PER_RING) { suppressed++; return; }
                reported++;
                this._add(severity, category, message, { ...base, location, details });
            };

            GeoUtils.sweepPairs(segs, (s, t) => {
                if (s.seq > t.seq) [s, t] = [t, s];
                const adjacent = (t.seq === s.seq + 1) || (s.seq === 0 && t.seq === m - 1);
                const rel = GeoUtils.segmentRelation(s.a, s.b, t.a, t.b);
                if (!rel) return;
                const segDetails = {
                    seg1Indices: [s.i, s.i + 1], seg1Coords: [s.a, s.b],
                    seg2Indices: [t.i, t.i + 1], seg2Coords: [t.a, t.b],
                    intersectionPoint: rel.point
                };

                if (adjacent) {
                    if (rel.type === 'overlap') {
                        report('ERROR', 'Espiga / Retroceso de Borde',
                            `El ${ringName} de "${label}" retrocede sobre sí mismo entre los segmentos ${s.i}-${s.i + 1} y ${t.i}-${t.i + 1} ` +
                            `(vértice en "punta" que regresa por el mismo borde).`, rel.point, segDetails);
                    }
                    return;
                }

                const loc = `[${rel.point[0].toFixed(6)}, ${rel.point[1].toFixed(6)}]`;
                if (rel.type === 'cross') {
                    report('ERROR', 'Auto-intersección / Solapamiento de Bordes',
                        `Auto-intersección en "${label}" (${ringName}): el segmento ${s.i}-${s.i + 1} cruza el segmento ${t.i}-${t.i + 1} en ${loc}.`,
                        rel.point, segDetails);
                } else if (rel.type === 'overlap') {
                    report('ERROR', 'Bordes Colineales Superpuestos',
                        `En "${label}" (${ringName}) los segmentos ${s.i}-${s.i + 1} y ${t.i}-${t.i + 1} se superponen sobre la misma línea cerca de ${loc}.`,
                        rel.point, segDetails);
                } else {
                    const k = GeoUtils.key(rel.point);
                    if (seenTouches.has(k)) return;
                    seenTouches.add(k);
                    const isVertexVertex = [s.a, s.b].some(p => GeoUtils.samePoint(p, rel.point)) &&
                                           [t.a, t.b].some(p => GeoUtils.samePoint(p, rel.point));
                    report('ERROR', isVertexVertex ? 'Punto de Auto-Contacto (Pinch Point)' : 'Vértice sobre Borde Propio',
                        isVertexVertex
                            ? `El ${ringName} de "${label}" pasa dos veces por el mismo vértice ${loc}, dividiendo la superficie en lóbulos.`
                            : `Un vértice del ${ringName} de "${label}" toca otro borde del mismo anillo en ${loc}.`,
                        rel.point, segDetails);
                }
            });

            if (suppressed) {
                this._add('ERROR', 'Auto-intersección / Solapamiento de Bordes',
                    `El ${ringName} de "${label}" tiene ${suppressed} conflicto(s) topológico(s) adicionales no listados (se muestran los primeros ${MAX_ISSUES_PER_RING}).`,
                    { ...base });
            }
        }

        _checkWinding(ring, isExterior, ringName, label, fIdx) {
            const area = GeoUtils.signedArea(ring);
            const isCCW = area > 0;
            if (isExterior) this._stats.exteriorRings++;
            if (isExterior && isCCW) { this._stats.ccwExteriors++; return; }
            if (!isExterior && !isCCW) return;

            const expected = isExterior ? 'antihoraria (CCW)' : 'horaria (CW)';
            const found = isCCW ? 'antihoraria (CCW)' : 'horaria (CW)';
            this._add('ALERTA', 'Regla de la Mano Derecha (RFC 7946)',
                `El ${ringName} de "${label}" tiene orientación ${found}; RFC 7946 §3.1.6 indica orientación ${expected}. ` +
                'Los lectores permisivos lo aceptan, pero algunos sistemas exigen la regla estricta. Se corrige con "Reparar".',
                {
                    featureIndex: fIdx, plotId: label, location: [ring[0][0], ring[0][1]],
                    details: { isExterior, detectedOrientation: found, requiredOrientation: expected, signedArea: area / 2 }
                });
        }

        /** Huecos: dentro del exterior, sin cruzar otros anillos, sin solaparse entre sí. */
        _checkHoles(rings, label, fIdx) {
            const opt = { featureIndex: fIdx, plotId: label };
            const segs = [];
            rings.forEach((r, idx) => segs.push(...GeoUtils.buildSegments(r, idx)));
            const crossingPairs = new Set();

            GeoUtils.sweepPairs(segs, (s, t) => {
                if (s.ring === t.ring) return;
                const rel = GeoUtils.segmentRelation(s.a, s.b, t.a, t.b);
                if (!rel || rel.type === 'touch') return; // OGC admite contacto en un punto
                const [r1, r2] = s.ring < t.ring ? [s.ring, t.ring] : [t.ring, s.ring];
                const pk = r1 + '-' + r2;
                if (crossingPairs.has(pk)) return;
                crossingPairs.add(pk);
                const n1 = r1 === 0 ? 'el anillo exterior' : `el hueco ${r1}`;
                this._add('ERROR', 'Intersección entre Anillos',
                    `En "${label}" el hueco ${r2} ${rel.type === 'cross' ? 'cruza' : 'comparte un tramo de borde con'} ${n1} ` +
                    `cerca de [${rel.point[0].toFixed(6)}, ${rel.point[1].toFixed(6)}].`,
                    { ...opt, location: rel.point });
            });

            const samplePoint = (ring, other) => ring.slice(0, -1).find(p => GeoUtils.pointInRing(p, other) !== 0);

            for (let h = 1; h < rings.length; h++) {
                if (crossingPairs.has('0-' + h)) continue;
                const p = samplePoint(rings[h], rings[0]);
                if (p && GeoUtils.pointInRing(p, rings[0]) < 0) {
                    this._add('ERROR', 'Hueco fuera del Exterior',
                        `El hueco ${h} de "${label}" está fuera del anillo exterior (un hueco debe estar contenido en el polígono).`,
                        { ...opt, location: [p[0], p[1]] });
                }
            }
            for (let a = 1; a < rings.length; a++) {
                for (let b = a + 1; b < rings.length; b++) {
                    if (crossingPairs.has(a + '-' + b)) continue;
                    const pb = samplePoint(rings[b], rings[a]);
                    const pa = samplePoint(rings[a], rings[b]);
                    if ((pb && GeoUtils.pointInRing(pb, rings[a]) > 0) || (pa && GeoUtils.pointInRing(pa, rings[b]) > 0)) {
                        this._add('ERROR', 'Huecos Solapados',
                            `En "${label}" el hueco ${b} está dentro del hueco ${a} (o lo contiene).`,
                            { ...opt, location: (pb || pa).slice(0, 2) });
                    }
                }
            }
        }

        // ------------------------ Entre parcelas ------------------------
        /**
         * Dos polígonos se solapan si sus INTERIORES se intersectan. Compartir
         * linderos o vértices (parcelas colindantes) NO es solapamiento.
         */
        _polygonsOverlap(P, Q) {
            const segsP = [], segsQ = [];
            P.rings.forEach((r, i) => segsP.push(...GeoUtils.buildSegments(r, i)));
            Q.rings.forEach((r, i) => segsQ.push(...GeoUtils.buildSegments(r, i)));
            const all = segsP.map(s => ({ ...s, owner: 0 })).concat(segsQ.map(s => ({ ...s, owner: 1 })));

            const crossings = [];
            GeoUtils.sweepPairs(all, (s, t) => {
                if (s.owner === t.owner) return;
                const rel = GeoUtils.segmentRelation(s.a, s.b, t.a, t.b);
                if (rel && rel.type === 'cross') crossings.push(rel.point);
                return crossings.length < 5;
            });
            if (crossings.length) return { point: crossings[0], crossings };

            // Sin cruces propios: comprobar contención (incluye polígonos idénticos).
            const probe = (A, B) => {
                let allOnBoundary = true;
                for (const ring of A.rings) {
                    for (let i = 0; i < ring.length - 1; i++) {
                        const v = ring[i];
                        const mid = [(ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2];
                        for (const pt of [v, mid]) {
                            if (pt[0] < B.bbox[0] || pt[0] > B.bbox[2] || pt[1] < B.bbox[1] || pt[1] > B.bbox[3]) {
                                allOnBoundary = false;
                                continue;
                            }
                            const r = GeoUtils.pointInPolygon(pt, B.rings);
                            if (r === 1) return { point: pt.slice(0, 2) };
                            if (r === -1) allOnBoundary = false;
                        }
                    }
                }
                return allOnBoundary ? { point: A.rings[0][0].slice(0, 2), identical: true } : null;
            };
            return probe(P, Q) || probe(Q, P);
        }

        _checkInterPolygonOverlaps(polygons) {
            const items = polygons.map((p, idx) => ({ ...p, idx })).sort((a, b) => a.bbox[0] - b.bbox[0]);
            for (let x = 0; x < items.length; x++) {
                const P = items[x];
                for (let y = x + 1; y < items.length; y++) {
                    const Q = items[y];
                    if (Q.bbox[0] > P.bbox[2]) break;
                    if (!GeoUtils.bboxesOverlap(P.bbox, Q.bbox)) continue;
                    const ov = this._polygonsOverlap(P, Q);
                    if (!ov) continue;

                    const [A, B] = P.idx < Q.idx ? [P, Q] : [Q, P];
                    const sameFeature = A.fIdx === B.fIdx;
                    const msg = sameFeature
                        ? `Las partes "${A.plotId}" y "${B.plotId}" del mismo MultiPolygon se solapan; las partes de un MultiPolygon deben ser disjuntas.`
                        : `Solapamiento entre "${A.plotId}" y "${B.plotId}"${ov.identical ? ' (geometrías idénticas o duplicadas)' : ''}: ` +
                          'sus superficies se superponen. Las parcelas colindantes pueden compartir linderos, pero no área.';
                    this._add('ERROR', sameFeature ? 'Solapamiento entre Partes' : 'Solapamiento Inter-Parcelas', msg, {
                        featureIndex: A.fIdx,
                        relatedFeatureIndex: sameFeature ? null : B.fIdx,
                        plotId: sameFeature ? A.featureLabel : `${A.plotId} / ${B.plotId}`,
                        location: ov.point,
                        details: { parcel1: A.plotId, parcel2: B.plotId, intersectionPoints: ov.crossings || [ov.point], identical: !!ov.identical }
                    });
                }
            }
        }

        // ------------------------ Otras comprobaciones ------------------------
        _checkDuplicateIds(features) {
            const seen = new Map();
            features.forEach((f, i) => {
                const id = GeoUtils.featureId(f);
                if (id === null) return;
                if (!seen.has(id)) seen.set(id, []);
                seen.get(id).push(i);
            });
            for (const [id, idxs] of seen) {
                if (idxs.length < 2) continue;
                this._add('ALERTA', 'Identificador Duplicado',
                    `El identificador "${id}" se repite en ${idxs.length} entidades (índices ${idxs.slice(0, 10).join(', ')}${idxs.length > 10 ? '…' : ''}).`,
                    { featureIndex: idxs[0], plotId: id, details: { featureIndices: idxs } });
            }
        }

        /** Precisión: avisa si TODAS las coordenadas de la entidad tienen < 6 decimales. */
        _checkPrecision(geom, ctx) {
            let maxDec = 0, count = 0, firstPt = null;
            const walk = (c, depth) => {
                if (!Array.isArray(c)) return;
                if (typeof c[0] === 'number') {
                    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
                        count++;
                        if (!firstPt) firstPt = c;
                        maxDec = Math.max(maxDec, GeoUtils.decimals(c[0]), GeoUtils.decimals(c[1]));
                    }
                    return;
                }
                if (depth < 4) c.forEach(x => walk(x, depth + 1));
            };
            const geoms = geom.type === 'GeometryCollection' && Array.isArray(geom.geometries) ? geom.geometries : [geom];
            geoms.forEach(g => g && walk(g.coordinates, 0));
            if (count > 0 && maxDec < 6) {
                this._add('INFO', 'Precisión de Coordenadas',
                    `Las coordenadas de "${ctx.plotId}" tienen como máximo ${maxDec} decimales (6 decimales ≈ 0,1 m). ` +
                    'Para declaraciones EUDR se suelen pedir al menos 6 decimales; verifique el requisito vigente.',
                    { featureIndex: ctx.fIdx, plotId: ctx.plotId, location: [firstPt[0], firstPt[1]], details: { maxDecimals: maxDec } });
            }
        }

        _addSummaryNotes() {
            const s = this._stats;
            if (s.exteriorRings > 0) {
                this._add('INFO', 'Regla de la Mano Derecha (RFC 7946)',
                    `${s.ccwExteriors} de ${s.exteriorRings} anillo(s) exterior(es) siguen la orientación antihoraria (CCW) recomendada por RFC 7946.`);
            }
            if (s.points > 0) {
                this._add('INFO', 'Geometrías de Punto',
                    `${s.points} geometría(s) son puntos. En EUDR, las parcelas de más de 4 ha deben declararse como polígono.`);
            }
        }

        _buildResult(featureInfo, rawData) {
            const count = sev => this.issues.filter(i => i.severity === sev).length;
            const errors = count('ERROR'), warnings = count('ALERTA'), info = count('INFO');

            // Estado por entidad (para colorear el mapa y la lista de parcelas).
            const featureStatus = featureInfo.map(() => 'VALIDO');
            const bump = (idx, sev) => {
                if (idx === null || idx === undefined || idx >= featureStatus.length) return;
                if (SEVERITY_RANK[sev] > SEVERITY_RANK[featureStatus[idx]]) featureStatus[idx] = sev;
            };
            this.issues.forEach(i => {
                if (i.severity === 'INFO') return;
                bump(i.feature_index, i.severity);
                bump(i.related_feature_index, i.severity);
                (i.details?.featureIndices || []).forEach(k => bump(k, i.severity));
            });
            featureInfo.forEach((f, k) => {
                f.status = featureStatus[k];
                f.errors = this.issues.filter(i => i.severity === 'ERROR' && (i.feature_index === k || i.related_feature_index === k)).length;
                f.warnings = this.issues.filter(i => i.severity === 'ALERTA' && (i.feature_index === k || i.related_feature_index === k)).length;
            });

            let overallStatus = 'VALIDO';
            let statusText = 'Válido: sin errores ni alertas (conforme a RFC 7946).';
            if (errors > 0) {
                overallStatus = 'ERROR';
                statusText = 'Inválido: contiene errores que deben corregirse.';
            } else if (warnings > 0) {
                overallStatus = 'ALERTA';
                statusText = 'Válido con alertas: revise las advertencias.';
            }

            return {
                valid: errors === 0,
                overall_status: overallStatus,
                status_text: statusText,
                features_count: featureInfo.length,
                summary: { errors, warnings, info, total_issues: this.issues.length },
                features: featureInfo,
                issues: this.issues,
                data: rawData
            };
        }
    }

    return { ValidationSeverity, GeoUtils, GeoJSONValidator };
});
