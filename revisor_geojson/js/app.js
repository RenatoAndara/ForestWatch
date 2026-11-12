/**
 * Validador, Revisor y Visualizador Cartográfico GeoJSON (RFC 7946 / EUDR)
 * Versión Autónoma Compatible con file:/// y http://
 */

// 1. Constantes de Severidad
const ValidationSeverity = {
    ERROR: 'ERROR',
    WARNING: 'ALERTA',
    INFO: 'INFO'
};

// 2. Motor de Validación Geoespacial
class GeoJSONValidator {
    constructor() {
        this.issues = [];
    }

    validate(geojsonStringOrObject) {
        this.issues = [];
        let data = geojsonStringOrObject;

        if (typeof geojsonStringOrObject === 'string') {
            try {
                data = JSON.parse(geojsonStringOrObject);
            } catch (e) {
                return {
                    valid: false,
                    overall_status: ValidationSeverity.ERROR,
                    status_text: 'Error de Sintaxis JSON',
                    features_count: 0,
                    summary: { errors: 1, warnings: 0, info: 0, total_issues: 1 },
                    issues: [{
                        severity: ValidationSeverity.ERROR,
                        category: 'Sintaxis JSON',
                        message: `El archivo no es un JSON válido: ${e.message}`,
                        location: null
                    }],
                    data: null
                };
            }
        }

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            this._addIssue(ValidationSeverity.ERROR, 'Estructura GeoJSON', 'La raíz del archivo debe ser un objeto JSON.');
            return this._buildResult(0, data);
        }

        const rootType = data.type;
        if (!rootType) {
            this._addIssue(ValidationSeverity.ERROR, 'Estructura GeoJSON', 'El objeto raíz no contiene la propiedad requerida "type".');
            return this._buildResult(0, data);
        }

        let features = [];
        if (rootType === 'FeatureCollection') {
            if (!Array.isArray(data.features)) {
                this._addIssue(ValidationSeverity.ERROR, 'Estructura GeoJSON', 'La propiedad "features" de FeatureCollection debe ser un arreglo.');
                return this._buildResult(0, data);
            }
            features = data.features;
        } else if (rootType === 'Feature') {
            features = [data];
        } else if (['Polygon', 'MultiPolygon', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'GeometryCollection'].includes(rootType)) {
            features = [{ type: 'Feature', geometry: data, properties: {} }];
        } else {
            this._addIssue(ValidationSeverity.ERROR, 'Estructura GeoJSON', `Tipo GeoJSON no reconocido: "${rootType}".`);
            return this._buildResult(0, data);
        }

        const parsedPolygons = [];

        features.forEach((feat, fIdx) => {
            this._validateFeature(feat, fIdx, parsedPolygons);
        });

        // Inter-polygon overlap check if multiple polygons exist
        if (parsedPolygons.length >= 2) {
            this._checkInterPolygonOverlaps(parsedPolygons);
        }

        return this._buildResult(features.length, data);
    }

    _addIssue(severity, category, message, options = {}) {
        this.issues.push({
            severity,
            category,
            message,
            feature_index: options.featureIndex ?? null,
            plot_id: options.plotId ?? null,
            location: options.location ?? null,
            details: options.details ?? {}
        });
    }

    _validateFeature(feat, fIdx, parsedPolygons) {
        if (!feat || typeof feat !== 'object' || feat.type !== 'Feature') {
            this._addIssue(ValidationSeverity.ERROR, 'Estructura Feature', `El elemento en el índice ${fIdx} no es un Feature válido.`, { featureIndex: fIdx });
            return;
        }

        const props = feat.properties || {};
        const plotId = props.PlotID || props.id || props.ID || props.name || `Parcela #${fIdx + 1}`;

        const geom = feat.geometry;
        if (!geom) {
            this._addIssue(ValidationSeverity.ERROR, 'Geometría Nula', `La entidad "${plotId}" no contiene geometría.`, { featureIndex: fIdx, plotId });
            return;
        }

        if (typeof geom !== 'object' || !geom.type || !Array.isArray(geom.coordinates)) {
            this._addIssue(ValidationSeverity.ERROR, 'Geometría Inválida', `La geometría de "${plotId}" tiene formato inválido.`, { featureIndex: fIdx, plotId });
            return;
        }

        const gType = geom.type;
        const coords = geom.coordinates;

        if (gType === 'Polygon') {
            this._validatePolygonRings(coords, fIdx, plotId);
            parsedPolygons.push({ fIdx, plotId, coords });
        } else if (gType === 'MultiPolygon') {
            coords.forEach((polyCoords, pIdx) => {
                const subId = `${plotId} [Parte ${pIdx + 1}]`;
                this._validatePolygonRings(polyCoords, fIdx, subId);
                parsedPolygons.push({ fIdx, plotId: subId, coords: polyCoords });
            });
        } else if (['Point', 'MultiPoint', 'LineString', 'MultiLineString'].includes(gType)) {
            this._validateOtherCoords(gType, coords, fIdx, plotId);
        } else {
            this._addIssue(ValidationSeverity.ERROR, 'Tipo de Geometría', `Tipo "${gType}" no soportado en "${plotId}".`, { featureIndex: fIdx, plotId });
        }
    }

    _validateOtherCoords(gType, coords, fIdx, plotId) {
        const checkPt = (pt) => {
            if (!Array.isArray(pt) || pt.length < 2) return;
            const [lon, lat] = pt;
            if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
                this._addIssue(ValidationSeverity.ERROR, 'Límites WGS84', `Coordenada fuera de rango WGS84 [${lon}, ${lat}] en "${plotId}".`, {
                    featureIndex: fIdx, plotId, location: [lon, lat]
                });
            }
        };

        if (gType === 'Point') checkPt(coords);
        else if (['MultiPoint', 'LineString'].includes(gType)) coords.forEach(checkPt);
        else if (gType === 'MultiLineString') coords.forEach(line => line.forEach(checkPt));
    }

    _validatePolygonRings(rings, fIdx, plotId) {
        if (!Array.isArray(rings) || rings.length === 0) {
            this._addIssue(ValidationSeverity.ERROR, 'Geometría Vacía', `El polígono "${plotId}" no tiene anillos de coordenadas.`, { featureIndex: fIdx, plotId });
            return;
        }

        rings.forEach((ring, rIdx) => {
            const isExterior = (rIdx === 0);
            const ringName = isExterior ? 'exterior' : `interior (hueco ${rIdx})`;

            if (!Array.isArray(ring) || ring.length < 4) {
                this._addIssue(ValidationSeverity.ERROR, 'Vértices Insuficientes',
                    `El anillo ${ringName} de "${plotId}" tiene menos de 4 coordenadas (${ring?.length || 0} encontrados).`,
                    { featureIndex: fIdx, plotId });
                return;
            }

            // Bounds check
            ring.forEach((pt, pIdx) => {
                if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
                    this._addIssue(ValidationSeverity.ERROR, 'Coordenada Inválida',
                        `Vértice ${pIdx} en anillo ${ringName} de "${plotId}" debe ser [número, número].`,
                        { featureIndex: fIdx, plotId });
                    return;
                }
                const [lon, lat] = pt;
                if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
                    this._addIssue(ValidationSeverity.ERROR, 'Límites WGS84',
                        `Coordenada [${lon}, ${lat}] fuera de rango WGS84 en vértice ${pIdx} de "${plotId}".`,
                        { featureIndex: fIdx, plotId, location: [lon, lat] });
                }
            });

            // 1. Ring Closure
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                this._addIssue(ValidationSeverity.ERROR, 'Anillo Abierto',
                    `El anillo ${ringName} de "${plotId}" no está cerrado (primer vértice [${first}] != último [${last}]).`,
                    { featureIndex: fIdx, plotId, location: [first[0], first[1]] });
            }

            // 2. Duplicate Consecutive Vertices
            for (let i = 0; i < ring.length - 1; i++) {
                const p1 = ring[i];
                const p2 = ring[i + 1];
                if (p1[0] === p2[0] && p1[1] === p2[1]) {
                    this._addIssue(ValidationSeverity.ERROR, 'Vértices Duplicados Consecutivos',
                        `Vértice duplicado consecutivo en anillo ${ringName} de "${plotId}" en índice ${i} y ${i + 1} en [${p1[0]}, ${p1[1]}].`,
                        {
                            featureIndex: fIdx,
                            plotId,
                            location: [p1[0], p1[1]],
                            details: { vertexIndex: i, coordinate: p1 }
                        });
                }
            }

            // 3. Self-Intersections (Crossed Edges & Pinch Points)
            this._checkRingSelfIntersections(ring, ringName, fIdx, plotId);

            // 4. RFC 7946 Right-Hand Rule (Winding Order -> ALERTA)
            this._checkRFC7946Winding(ring, isExterior, ringName, fIdx, plotId);
        });
    }

    _checkRingSelfIntersections(ring, ringName, fIdx, plotId) {
        const n = ring.length;
        for (let i = 0; i < n - 1; i++) {
            const p1 = ring[i];
            const p2 = ring[i + 1];

            for (let j = i + 1; j < n - 1; j++) {
                if (Math.abs(i - j) <= 1) continue;
                if (i === 0 && j === n - 2) continue; // First and last closing segment

                const q1 = ring[j];
                const q2 = ring[j + 1];

                // Pinch point check (exact shared vertex non-adjacent)
                if ((p1[0] === q1[0] && p1[1] === q1[1]) || (p1[0] === q2[0] && p1[1] === q2[1])) {
                    this._addIssue(ValidationSeverity.ERROR, 'Punto de Auto-Contacto (Pinch Point)',
                        `El anillo ${ringName} de "${plotId}" se toca a sí mismo en el vértice [${p1[0]}, ${p1[1]}].`,
                        {
                            featureIndex: fIdx,
                            plotId,
                            location: [p1[0], p1[1]],
                            details: { vertexI: i, vertexJ: j, coordinate: p1 }
                        });
                    continue;
                }

                // Check edge crossing
                if (this._segmentsIntersect(p1, p2, q1, q2)) {
                    const pt = this._computeLineIntersection(p1, p2, q1, q2);
                    const loc = pt || [p1[0], p1[1]];
                    this._addIssue(
                        ValidationSeverity.ERROR,
                        'Auto-intersección / Solapamiento de Bordes',
                        `Auto-intersección detectada en "${plotId}" (${ringName}): El segmento ${i}-${i + 1} se cruza con el segmento ${j}-${j + 1} en [${loc[0].toFixed(6)}, ${loc[1].toFixed(6)}].`,
                        {
                            featureIndex: fIdx,
                            plotId,
                            location: loc,
                            details: {
                                seg1Indices: [i, i + 1],
                                seg1Coords: [p1, p2],
                                seg2Indices: [j, j + 1],
                                seg2Coords: [q1, q2],
                                intersectionPoint: loc
                            }
                        }
                    );
                }
            }
        }
    }

    _checkRFC7946Winding(ring, isExterior, ringName, fIdx, plotId) {
        let area = 0.0;
        const n = ring.length;
        for (let i = 0; i < n - 1; i++) {
            const x1 = ring[i][0];
            const y1 = ring[i][1];
            const x2 = ring[i + 1][0];
            const y2 = ring[i + 1][1];
            area += (x1 * y2) - (x2 * y1);
        }

        const isCCW = area > 0;
        const rfcNote = 'RFC 7946 §3.1.6 establece la regla de la mano derecha: el anillo exterior DEBE ser antihorario (CCW) y los anillos interiores DEBEN ser horarios (CW). Requerido por sistemas como EUDR/TRACES-NT de la Unión Europea.';

        if (isExterior) {
            if (!isCCW) {
                this._addIssue(
                    ValidationSeverity.WARNING,
                    'Regla de la Mano Derecha (RFC 7946)',
                    `El anillo exterior de "${plotId}" sigue una orientación horaria (CW). ${rfcNote}`,
                    {
                        featureIndex: fIdx,
                        plotId,
                        location: [ring[0][0], ring[0][1]],
                        details: {
                            isExterior: true,
                            detectedOrientation: 'CW (Horario)',
                            requiredOrientation: 'CCW (Antihorario)',
                            signedArea: area
                        }
                    }
                );
            } else {
                this._addIssue(
                    ValidationSeverity.INFO,
                    'Regla de la Mano Derecha (RFC 7946)',
                    `El anillo exterior de "${plotId}" cumple con RFC 7946 (orientación antihoraria CCW).`,
                    { featureIndex: fIdx, plotId, details: { isExterior: true, detectedOrientation: 'CCW', signedArea: area } }
                );
            }
        } else {
            if (isCCW) {
                this._addIssue(
                    ValidationSeverity.WARNING,
                    'Regla de la Mano Derecha (RFC 7946)',
                    `El anillo interior (${ringName}) de "${plotId}" sigue una orientación antihoraria (CCW). ${rfcNote}`,
                    {
                        featureIndex: fIdx,
                        plotId,
                        location: [ring[0][0], ring[0][1]],
                        details: {
                            isExterior: false,
                            detectedOrientation: 'CCW (Antihorario)',
                            requiredOrientation: 'CW (Horario)',
                            signedArea: area
                        }
                    }
                );
            }
        }
    }

    _checkInterPolygonOverlaps(parsedPolygons) {
        const count = parsedPolygons.length;
        for (let i = 0; i < count; i++) {
            const p1 = parsedPolygons[i];
            const ext1 = p1.coords[0];
            const bbox1 = this._getBBox(ext1);

            for (let j = i + 1; j < count; j++) {
                const p2 = parsedPolygons[j];
                const ext2 = p2.coords[0];
                const bbox2 = this._getBBox(ext2);

                if (!this._bboxesOverlap(bbox1, bbox2)) continue;

                const overlapPts = [];
                for (let s1 = 0; s1 < ext1.length - 1; s1++) {
                    const a1 = ext1[s1], a2 = ext1[s1 + 1];
                    for (let s2 = 0; s2 < ext2.length - 1; s2++) {
                        const b1 = ext2[s2], b2 = ext2[s2 + 1];
                        if (this._segmentsIntersect(a1, a2, b1, b2)) {
                            const ipt = this._computeLineIntersection(a1, a2, b1, b2);
                            if (ipt) overlapPts.push(ipt);
                        }
                    }
                }

                const ptInside = this._pointInRing(ext2[0], ext1) || this._pointInRing(ext1[0], ext2);

                if (overlapPts.length > 0 || ptInside) {
                    const loc = overlapPts[0] || [ext1[0][0], ext1[0][1]];
                    this._addIssue(
                        ValidationSeverity.ERROR,
                        'Solapamiento Inter-Parcelas',
                        `Solapamiento espacial detectado entre "${p1.plotId}" y "${p2.plotId}". En especificaciones catastrales y EUDR las parcelas no pueden solaparse.`,
                        {
                            featureIndex: p1.fIdx,
                            plotId: `${p1.plotId} / ${p2.plotId}`,
                            location: loc,
                            details: {
                                parcel1: p1.plotId,
                                parcel2: p2.plotId,
                                intersectionPoints: overlapPts.slice(0, 5)
                            }
                        }
                    );
                }
            }
        }
    }

    _ccw(A, B, C) {
        return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
    }

    _segmentsIntersect(A, B, C, D) {
        return (this._ccw(A, C, D) !== this._ccw(B, C, D)) && (this._ccw(A, B, C) !== this._ccw(A, B, D));
    }

    _computeLineIntersection(p1, p2, p3, p4) {
        const x1 = p1[0], y1 = p1[1];
        const x2 = p2[0], y2 = p2[1];
        const x3 = p3[0], y3 = p3[1];
        const x4 = p4[0], y4 = p4[1];

        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-12) return null;

        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const px = x1 + t * (x2 - x1);
        const py = y1 + t * (y2 - y1);
        return [px, py];
    }

    _getBBox(ring) {
        const xs = ring.map(p => p[0]);
        const ys = ring.map(p => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    _bboxesOverlap(b1, b2) {
        return !(b1[2] < b2[0] || b1[0] > b2[2] || b1[3] < b2[1] || b1[1] > b2[3]);
    }

    _pointInRing(pt, ring) {
        const [x, y] = pt;
        let inside = false;
        const n = ring.length;
        let j = n - 1;
        for (let i = 0; i < n; i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
            j = i;
        }
        return inside;
    }

    _buildResult(featuresCount, rawData) {
        const errors = this.issues.filter(i => i.severity === ValidationSeverity.ERROR);
        const warnings = this.issues.filter(i => i.severity === ValidationSeverity.WARNING);
        const info = this.issues.filter(i => i.severity === ValidationSeverity.INFO);

        let overallStatus = 'VALIDO';
        let statusText = 'Completamente Válido (Conforme a RFC 7946)';

        if (errors.length > 0) {
            overallStatus = 'ERROR';
            statusText = 'Inválido (Contiene errores críticos)';
        } else if (warnings.length > 0) {
            overallStatus = 'ALERTA';
            statusText = 'Válido con Advertencias (Alerta RFC 7946)';
        }

        return {
            valid: errors.length === 0,
            overall_status: overallStatus,
            status_text: statusText,
            features_count: featuresCount,
            summary: {
                errors: errors.length,
                warnings: warnings.length,
                info: info.length,
                total_issues: this.issues.length
            },
            issues: this.issues,
            data: rawData
        };
    }
}

// 3. Motor de Reparación y Exportación
class GeoJSONRepairer {
    static repair(geojsonObj) {
        const repaired = JSON.parse(JSON.stringify(geojsonObj));
        const changes = [];

        const rootType = repaired.type;
        if (rootType === 'FeatureCollection') {
            (repaired.features || []).forEach((feat, fIdx) => {
                this._repairFeature(feat, fIdx, changes);
            });
        } else if (rootType === 'Feature') {
            this._repairFeature(repaired, 0, changes);
        } else if (['Polygon', 'MultiPolygon'].includes(rootType)) {
            const fakeFeat = { type: 'Feature', geometry: repaired };
            this._repairFeature(fakeFeat, 0, changes);
        }

        if (!repaired.metadata) {
            repaired.metadata = {};
        }
        repaired.metadata.repaired_by = 'Revisor y Reparador GeoJSON RFC 7946';
        repaired.metadata.repaired_at = new Date().toISOString();
        repaired.metadata.repair_notes = changes;

        return {
            repairedData: repaired,
            changesCount: changes.length,
            changes
        };
    }

    static _repairFeature(feat, fIdx, changes) {
        const geom = feat.geometry;
        if (!geom) return;

        const gType = geom.type;
        const coords = geom.coordinates;
        const props = feat.properties || {};
        const plotId = props.PlotID || props.id || props.name || `Parcela #${fIdx + 1}`;

        if (gType === 'Polygon') {
            geom.coordinates = this._repairPolygonRings(coords, plotId, changes);
        } else if (gType === 'MultiPolygon') {
            geom.coordinates = coords.map((polyCoords, pIdx) => {
                return this._repairPolygonRings(polyCoords, `${plotId} [P${pIdx + 1}]`, changes);
            });
        }
    }

    static _repairPolygonRings(rings, plotId, changes) {
        return rings.map((ring, rIdx) => {
            if (!Array.isArray(ring) || ring.length < 3) return ring;

            const isExterior = (rIdx === 0);
            const ringName = isExterior ? 'exterior' : `interior (hueco ${rIdx})`;

            // Step 1: Remove duplicate consecutive vertices
            let cleaned = [ring[0]];
            let dupsRemoved = 0;
            for (let i = 1; i < ring.length - 1; i++) {
                const prev = cleaned[cleaned.length - 1];
                const curr = ring[i];
                if (curr[0] === prev[0] && curr[1] === prev[1]) {
                    dupsRemoved++;
                } else {
                    cleaned.push(curr);
                }
            }
            cleaned.push([cleaned[0][0], cleaned[0][1]]);

            if (dupsRemoved > 0) {
                changes.push(`${plotId} (${ringName}): Se eliminaron ${dupsRemoved} vértice(s) duplicados consecutivos.`);
            }

            // Step 2: Fix RFC 7946 winding order
            const area = this._signedArea(cleaned);
            const isCCW = area > 0;

            if (isExterior && !isCCW) {
                cleaned.reverse();
                changes.push(`${plotId} (anillo exterior): Invertido a sentido antihorario (CCW) conforme a RFC 7946 §3.1.6.`);
            } else if (!isExterior && isCCW) {
                cleaned.reverse();
                changes.push(`${plotId} (${ringName}): Invertido a sentido horario (CW) conforme a RFC 7946 §3.1.6.`);
            }

            return cleaned;
        });
    }

    static _signedArea(ring) {
        let area = 0.0;
        const n = ring.length;
        for (let i = 0; i < n - 1; i++) {
            const x1 = ring[i][0];
            const y1 = ring[i][1];
            const x2 = ring[i + 1][0];
            const y2 = ring[i + 1][1];
            area += (x1 * y2) - (x2 * y1);
        }
        return area;
    }

    static downloadGeoJSON(data, originalFilename = 'reparado.geojson') {
        let filename = originalFilename.replace(/\.geojson$/i, '').replace(/\.json$/i, '') + '_reparado_RFC7946.geojson';
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/geo+json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// 4. Controlador Cartográfico Interactivo (Leaflet + Fallback)
class GeoJSONMapViewer {
    constructor(containerId) {
        this.containerId = containerId;
        this.map = null;
        this.geojsonLayer = null;
        this.issuesLayer = null;
        this.arrowsLayer = null;
        this.verticesLayer = null;
        this.conflictSegmentsLayer = null;
        this.currentData = null;
        this.validationResult = null;
        this.showArrows = true;
        this.showVertices = true;

        this.init();
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        if (typeof L === 'undefined') {
            this._renderFallbackViewer(container);
            return;
        }

        // Initialize neutral view
        this.map = L.map(this.containerId, {
            center: [15, -40],
            zoom: 3,
            zoomControl: false
        });

        L.control.zoom({ position: 'topright' }).addTo(this.map);

        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        });

        const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: 'Tiles © Esri'
        });

        esriSatellite.addTo(this.map);

        const baseMaps = {
            "🛰️ Satélite de Alta Resolución (Esri)": esriSatellite,
            "🗺️ Mapa Callejero (OpenStreetMap)": osmLayer
        };

        this.layerControl = L.control.layers(baseMaps, null, { position: 'topright' }).addTo(this.map);

        this.geojsonLayer = L.geoJSON(null).addTo(this.map);
        this.conflictSegmentsLayer = L.layerGroup().addTo(this.map);
        this.issuesLayer = L.layerGroup().addTo(this.map);
        this.arrowsLayer = L.layerGroup().addTo(this.map);
        this.verticesLayer = L.layerGroup().addTo(this.map);
    }

    render(data, validationResult) {
        this.currentData = data;
        this.validationResult = validationResult;

        if (!this.map) {
            this._renderFallbackData();
            return;
        }

        this.clear();
        if (!data) return;

        const hasErrors = validationResult?.summary?.errors > 0;
        const hasWarnings = validationResult?.summary?.warnings > 0;
        const polyColor = hasErrors ? '#ef4444' : (hasWarnings ? '#f59e0b' : '#10b981');

        this.geojsonLayer = L.geoJSON(data, {
            style: () => ({
                color: polyColor,
                weight: 3,
                opacity: 0.9,
                fillColor: polyColor,
                fillOpacity: 0.25
            }),
            onEachFeature: (feature, layer) => {
                const props = feature.properties || {};
                const plotId = props.PlotID || props.id || props.name || 'Sin ID';
                const nodeId = props.NodeID || props.node || 'N/A';
                const metrics = this._calculateGeometryMetrics(feature.geometry);

                const statusBadge = hasErrors 
                    ? '<span class="badge badge-error">❌ Errores Topológicos</span>'
                    : (hasWarnings 
                        ? '<span class="badge badge-warning">⚠️ Alerta RFC 7946</span>' 
                        : '<span class="badge badge-success">✅ Válido RFC 7946</span>');

                layer.bindPopup(`
                    <div class="map-popup-card">
                        <div class="popup-header">
                            <h4>${plotId}</h4>
                            ${statusBadge}
                        </div>
                        <div class="popup-body">
                            <p><strong>Nodo:</strong> ${nodeId}</p>
                            <p><strong>Área estimada:</strong> ${metrics.areaHa.toFixed(2)} ha (${metrics.areaM2.toLocaleString('es-ES', { maximumFractionDigits: 0 })} m²)</p>
                            <p><strong>Perímetro:</strong> ${metrics.perimeterM.toFixed(1)} m</p>
                            <p><strong>Total vértices:</strong> ${metrics.vertexCount}</p>
                        </div>
                    </div>
                `);
            }
        }).addTo(this.map);

        try {
            const bounds = this.geojsonLayer.getBounds();
            if (bounds.isValid()) {
                this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
            }
        } catch (e) {
            console.warn('Could not fit bounds:', e);
        }

        this._renderDirectionArrowsAndVertices(data);

        if (validationResult && validationResult.issues) {
            this._renderIssues(validationResult.issues);
        }
    }

    _renderIssues(issues) {
        issues.forEach((issue) => {
            if (issue.location && issue.location.length >= 2) {
                const [lon, lat] = issue.location;
                const isError = issue.severity === 'ERROR';

                const markerHtml = isError 
                    ? `<div class="issue-marker-pulse issue-marker-error" title="${issue.category}"></div>`
                    : `<div class="issue-marker-pulse issue-marker-warning" title="${issue.category}"></div>`;

                const icon = L.divIcon({
                    className: 'custom-issue-marker',
                    html: markerHtml,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });

                const marker = L.marker([lat, lon], { icon }).addTo(this.issuesLayer);
                marker.bindPopup(`
                    <div class="issue-popup">
                        <div class="issue-popup-title ${isError ? 'text-error' : 'text-warning'}">
                            ${isError ? '❌ Error' : '⚠️ Alerta'}: ${issue.category}
                        </div>
                        <div class="issue-popup-msg">${issue.message}</div>
                        <div class="issue-popup-coord">📍 [${lon.toFixed(6)}, ${lat.toFixed(6)}]</div>
                    </div>
                `);
            }

            if (issue.details && issue.details.seg1Coords && issue.details.seg2Coords) {
                const seg1 = issue.details.seg1Coords.map(p => [p[1], p[0]]);
                const seg2 = issue.details.seg2Coords.map(p => [p[1], p[0]]);

                L.polyline(seg1, {
                    color: '#ff0055',
                    weight: 6,
                    opacity: 0.9,
                    dashArray: '6, 6'
                }).bindTooltip(`Segmento en conflicto (${issue.details.seg1Indices[0]}-${issue.details.seg1Indices[1]})`).addTo(this.conflictSegmentsLayer);

                L.polyline(seg2, {
                    color: '#ff0055',
                    weight: 6,
                    opacity: 0.9,
                    dashArray: '6, 6'
                }).bindTooltip(`Segmento en conflicto (${issue.details.seg2Indices[0]}-${issue.details.seg2Indices[1]})`).addTo(this.conflictSegmentsLayer);
            }
        });
    }

    _renderDirectionArrowsAndVertices(data) {
        if (!data) return;

        const extractRings = (geom) => {
            if (!geom) return [];
            if (geom.type === 'Polygon') return geom.coordinates;
            if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
            return [];
        };

        const features = data.type === 'FeatureCollection' ? data.features : (data.type === 'Feature' ? [data] : []);

        features.forEach((feat) => {
            const rings = extractRings(feat.geometry);
            rings.forEach((ring, rIdx) => {
                if (!Array.isArray(ring) || ring.length < 3) return;
                const isExterior = (rIdx === 0);

                ring.forEach((pt, pIdx) => {
                    if (pIdx === ring.length - 1) return;
                    const [lon, lat] = pt;
                    const vIcon = L.divIcon({
                        className: 'vertex-number-icon',
                        html: `<span class="vertex-dot">${pIdx + 1}</span>`,
                        iconSize: [18, 18],
                        iconAnchor: [9, 9]
                    });
                    const vMarker = L.marker([lat, lon], { icon: vIcon });
                    vMarker.bindTooltip(`Vértice #${pIdx + 1}: [${lon.toFixed(6)}, ${lat.toFixed(6)}]`);
                    vMarker.addTo(this.verticesLayer);
                });

                for (let i = 0; i < ring.length - 1; i++) {
                    const p1 = ring[i];
                    const p2 = ring[i + 1];
                    const midLon = (p1[0] + p2[0]) / 2;
                    const midLat = (p1[1] + p2[1]) / 2;

                    const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * (180 / Math.PI);
                    const rot = 90 - angle;

                    const arrowIcon = L.divIcon({
                        className: 'arrow-direction-icon',
                        html: `<div style="transform: rotate(${rot}deg);" class="arrow-svg-box">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${isExterior ? '#38bdf8' : '#fbbf24'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="12" y1="19" x2="12" y2="5"></line>
                                    <polyline points="5 12 12 5 19 12"></polyline>
                                </svg>
                               </div>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    });

                    L.marker([midLat, midLon], { icon: arrowIcon }).addTo(this.arrowsLayer);
                }
            });
        });
    }

    zoomToLocation(lon, lat, zoom = 18) {
        if (this.map && typeof lat === 'number' && typeof lon === 'number') {
            this.map.flyTo([lat, lon], zoom, { duration: 1.2 });
        }
    }

    toggleArrows(show) {
        this.showArrows = show;
        if (show) {
            this.arrowsLayer.addTo(this.map);
        } else {
            this.map.removeLayer(this.arrowsLayer);
        }
    }

    toggleVertices(show) {
        this.showVertices = show;
        if (show) {
            this.verticesLayer.addTo(this.map);
        } else {
            this.map.removeLayer(this.verticesLayer);
        }
    }

    clear() {
        if (this.geojsonLayer) this.geojsonLayer.clearLayers();
        if (this.issuesLayer) this.issuesLayer.clearLayers();
        if (this.conflictSegmentsLayer) this.conflictSegmentsLayer.clearLayers();
        if (this.arrowsLayer) this.arrowsLayer.clearLayers();
        if (this.verticesLayer) this.verticesLayer.clearLayers();
    }

    _calculateGeometryMetrics(geom) {
        if (!geom) return { areaHa: 0, areaM2: 0, perimeterM: 0, vertexCount: 0 };
        let totalAreaM2 = 0;
        let totalPerimeterM = 0;
        let vertexCount = 0;

        const processRing = (ring) => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            vertexCount += (ring.length - 1);
            for (let i = 0; i < ring.length - 1; i++) {
                totalPerimeterM += this._haversineDistance(ring[i], ring[i + 1]);
            }
            totalAreaM2 += this._sphericalPolygonArea(ring);
        };

        if (geom.type === 'Polygon') {
            geom.coordinates.forEach((ring, idx) => {
                if (idx === 0) processRing(ring);
            });
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(poly => {
                if (poly[0]) processRing(poly[0]);
            });
        }

        return {
            areaHa: totalAreaM2 / 10000,
            areaM2: totalAreaM2,
            perimeterM: totalPerimeterM,
            vertexCount: vertexCount
        };
    }

    _haversineDistance(p1, p2) {
        const R = 6371000;
        const dLat = (p2[1] - p1[1]) * Math.PI / 180;
        const dLon = (p2[0] - p1[0]) * Math.PI / 180;
        const lat1 = p1[1] * Math.PI / 180;
        const lat2 = p2[1] * Math.PI / 180;

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    _sphericalPolygonArea(ring) {
        const R = 6378137;
        if (ring.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            const p1 = ring[i];
            const p2 = ring[i + 1];
            const lam1 = p1[0] * Math.PI / 180;
            const lam2 = p2[0] * Math.PI / 180;
            const phi1 = p1[1] * Math.PI / 180;
            const phi2 = p2[1] * Math.PI / 180;
            area += (lam2 - lam1) * (2 + Math.sin(phi1) + Math.sin(phi2));
        }
        return Math.abs(area * R * R / 4.0);
    }

    _renderFallbackViewer(container) {
        container.innerHTML = `
            <div id="svg-map-fallback" class="svg-map-container" style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;">
                <p>Carga un archivo GeoJSON para visualizar los linderos vectoriales.</p>
            </div>
        `;
    }
}

// 5. Orquestador de la Aplicación
class App {
    constructor() {
        this.validator = new GeoJSONValidator();
        this.mapViewer = null;
        this.currentGeoJSON = null;
        this.currentFilename = 'archivo.geojson';
        this.currentValidation = null;
        this.activeFilter = 'ALL';

        this.init();
    }

    init() {
        this.mapViewer = new GeoJSONMapViewer('map');
        this._setupFileUpload();
        this._setupToolbarControls();
        this._setupRepairAndExport();
        this._setupFilterTabs();
    }

    _setupFileUpload() {
        const dropzone = document.getElementById('dropzone');
        const fileInput = document.getElementById('file-input');

        if (!fileInput) return;

        // Native file picker trigger fallback
        if (dropzone) {
            dropzone.addEventListener('click', (e) => {
                if (e.target !== fileInput) {
                    fileInput.click();
                }
            });

            // Drag and drop events
            ['dragenter', 'dragover'].forEach(eventName => {
                dropzone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.add('drag-over');
                });
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropzone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.remove('drag-over');
                });
            });

            dropzone.addEventListener('drop', (e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                    this.loadFile(files[0]);
                }
            });
        }

        // Change event when user selects a file
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.loadFile(file);
                // Reset input value so re-selecting the same file also triggers change
                fileInput.value = '';
            }
        });
    }

    loadFile(file) {
        this.currentFilename = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            this.processGeoJSON(content, file.name);
        };
        reader.onerror = (err) => {
            alert('Error al leer el archivo: ' + err.message);
        };
        reader.readAsText(file);
    }

    processGeoJSON(contentString, filename) {
        this.currentFilename = filename;
        const result = this.validator.validate(contentString);
        this.currentValidation = result;
        this.currentGeoJSON = result.data;

        const fileInfoEl = document.getElementById('current-file-name');
        if (fileInfoEl) fileInfoEl.textContent = filename;

        this._updateMetricsDashboard(result);
        this._renderIssuesList();

        if (result.data) {
            this.mapViewer.render(result.data, result);
        }

        const repairBtn = document.getElementById('btn-repair');
        if (repairBtn) {
            repairBtn.disabled = !this.currentGeoJSON;
        }

        const dropzone = document.getElementById('dropzone');
        if (dropzone) {
            dropzone.classList.add('has-file');
        }
    }

    _updateMetricsDashboard(result) {
        const badge = document.getElementById('overall-status-badge');
        const badgeText = document.getElementById('overall-status-text');
        const errCount = document.getElementById('metric-errors-count');
        const warnCount = document.getElementById('metric-warnings-count');
        const featCount = document.getElementById('metric-features-count');

        if (errCount) errCount.textContent = result.summary.errors;
        if (warnCount) warnCount.textContent = result.summary.warnings;
        if (featCount) featCount.textContent = result.features_count;

        if (badge) {
            badge.className = 'status-pill';
            if (result.overall_status === ValidationSeverity.ERROR) {
                badge.classList.add('status-error');
                badge.innerHTML = `<span>❌</span> <strong>INVÁLIDO (ERRORES)</strong>`;
            } else if (result.overall_status === ValidationSeverity.WARNING) {
                badge.classList.add('status-warning');
                badge.innerHTML = `<span>⚠️</span> <strong>VÁLIDO CON ALERTAS</strong>`;
            } else {
                badge.classList.add('status-success');
                badge.innerHTML = `<span>✅</span> <strong>COMPLETAMENTE VÁLIDO</strong>`;
            }
        }

        if (badgeText) {
            badgeText.textContent = result.status_text;
        }
    }

    _renderIssuesList() {
        const container = document.getElementById('issues-table-body');
        const emptyState = document.getElementById('issues-empty-state');
        if (!container) return;

        container.innerHTML = '';

        if (!this.currentValidation || this.currentValidation.issues.length === 0) {
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        const filtered = this.currentValidation.issues.filter(issue => {
            if (this.activeFilter === 'ALL') return true;
            if (this.activeFilter === 'ERROR') return issue.severity === 'ERROR';
            if (this.activeFilter === 'ALERTA') return issue.severity === 'ALERTA';
            if (this.activeFilter === 'INFO') return issue.severity === 'INFO';
            return true;
        });

        if (filtered.length === 0) {
            container.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-muted">No hay elementos bajo este filtro.</td></tr>`;
            return;
        }

        filtered.forEach((issue) => {
            const tr = document.createElement('tr');
            tr.className = `issue-row issue-row-${issue.severity.toLowerCase()}`;

            const badgeClass = issue.severity === 'ERROR' 
                ? 'badge-error' 
                : (issue.severity === 'ALERTA' ? 'badge-warning' : 'badge-info');

            const hasCoord = issue.location && issue.location.length >= 2;
            const coordHtml = hasCoord 
                ? `<button class="btn-coord" title="Centrar en el mapa" data-lon="${issue.location[0]}" data-lat="${issue.location[1]}">
                    📍 [${issue.location[0].toFixed(5)}, ${issue.location[1].toFixed(5)}]
                   </button>` 
                : '<span class="text-muted">—</span>';

            tr.innerHTML = `
                <td><span class="badge ${badgeClass}">${issue.severity}</span></td>
                <td><strong>${issue.category}</strong><br><small class="text-muted">${issue.plot_id || 'Global'}</small></td>
                <td><div class="issue-msg-text">${issue.message}</div></td>
                <td>${coordHtml}</td>
            `;

            if (hasCoord) {
                const btn = tr.querySelector('.btn-coord');
                if (btn) {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.mapViewer.zoomToLocation(issue.location[0], issue.location[1], 18);
                    });
                }
                tr.addEventListener('click', () => {
                    this.mapViewer.zoomToLocation(issue.location[0], issue.location[1], 18);
                });
            }

            container.appendChild(tr);
        });
    }

    _setupFilterTabs() {
        const tabs = document.querySelectorAll('.filter-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.activeFilter = tab.dataset.filter;
                this._renderIssuesList();
            });
        });
    }

    _setupToolbarControls() {
        const toggleArrows = document.getElementById('toggle-arrows');
        const toggleVertices = document.getElementById('toggle-vertices');

        if (toggleArrows) {
            toggleArrows.addEventListener('change', (e) => {
                this.mapViewer.toggleArrows(e.target.checked);
            });
        }

        if (toggleVertices) {
            toggleVertices.addEventListener('change', (e) => {
                this.mapViewer.toggleVertices(e.target.checked);
            });
        }
    }

    _setupRepairAndExport() {
        const repairBtn = document.getElementById('btn-repair');
        const repairModal = document.getElementById('repair-modal');
        const closeModal = document.getElementById('btn-close-modal');
        const downloadFixedBtn = document.getElementById('btn-download-fixed');
        const repairNotesEl = document.getElementById('repair-notes-list');

        if (!repairBtn) return;

        repairBtn.addEventListener('click', () => {
            if (!this.currentGeoJSON) return;

            const { repairedData, changes } = GeoJSONRepairer.repair(this.currentGeoJSON);
            this.repairedGeoJSON = repairedData;

            if (repairNotesEl) {
                if (changes.length === 0) {
                    repairNotesEl.innerHTML = '<li class="text-success">✅ No se requirieron cambios: El GeoJSON ya cumple con RFC 7946 y no tiene vértices duplicados.</li>';
                } else {
                    repairNotesEl.innerHTML = changes.map(c => `<li>✔️ ${c}</li>`).join('');
                }
            }

            if (repairModal) repairModal.classList.remove('hidden');
        });

        if (closeModal) {
            closeModal.addEventListener('click', () => {
                if (repairModal) repairModal.classList.add('hidden');
            });
        }

        if (downloadFixedBtn) {
            downloadFixedBtn.addEventListener('click', () => {
                if (this.repairedGeoJSON) {
                    GeoJSONRepairer.downloadGeoJSON(this.repairedGeoJSON, this.currentFilename);
                }
            });
        }
    }
}

// Iniciar aplicación al cargar el DOM
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.app = new App();
    });
} else {
    window.app = new App();
}
