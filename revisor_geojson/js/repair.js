/**
 * GeoJSON Auto-Repair & Export Module
 */

export class GeoJSONRepairer {
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
            // Ensure closure
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
