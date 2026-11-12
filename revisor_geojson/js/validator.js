/**
 * GeoJSON Integrity, Topology, and RFC 7946 Validation Engine (Browser)
 */

export const ValidationSeverity = {
    ERROR: 'ERROR',
    WARNING: 'ALERTA',
    INFO: 'INFO'
};

export class GeoJSONValidator {
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
                    }]
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
        // Shoelace formula signed area:
        // area > 0 -> CCW (Counter-Clockwise)
        // area < 0 -> CW (Clockwise)
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
            // Interior hole must be CW (area < 0)
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

                // Check segment crossings between poly1 and poly2
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
