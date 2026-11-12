/**
 * Interactive Cartographic Viewer for GeoJSON Inspector
 * Handles Leaflet map rendering, satellite/street layers, issue highlighting,
 * vertex numbering, and direction arrows (CCW / CW).
 */

export class GeoJSONMapViewer {
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

        // Check if Leaflet L is available
        if (typeof L === 'undefined') {
            this._renderFallbackViewer(container);
            return;
        }

        // Initialize Leaflet map
        this.map = L.map(this.containerId, {
            center: [7.935, -71.747],
            zoom: 15,
            zoomControl: false
        });

        L.control.zoom({ position: 'topright' }).addTo(this.map);

        // Tile layers
        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        });

        const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        });

        // Default to Satellite for farming/agricultural parcels
        esriSatellite.addTo(this.map);

        const baseMaps = {
            "🛰️ Satélite de Alta Resolución (Esri)": esriSatellite,
            "🗺️ Mapa Callejero (OpenStreetMap)": osmLayer
        };

        this.layerControl = L.control.layers(baseMaps, null, { position: 'topright' }).addTo(this.map);

        // Layer groups
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

        // Style and add GeoJSON layer
        this.geojsonLayer = L.geoJSON(data, {
            style: (feature) => ({
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

                const popupContent = `
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
                `;
                layer.bindPopup(popupContent);
            }
        }).addTo(this.map);

        // Auto zoom and fit bounds with padding
        try {
            const bounds = this.geojsonLayer.getBounds();
            if (bounds.isValid()) {
                this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
            }
        } catch (e) {
            console.warn('Could not fit bounds:', e);
        }

        // Render direction arrows & vertices
        this._renderDirectionArrowsAndVertices(data);

        // Render issue markers and conflict segments
        if (validationResult && validationResult.issues) {
            this._renderIssues(validationResult.issues);
        }
    }

    _renderIssues(issues) {
        issues.forEach((issue) => {
            if (issue.location && issue.location.length >= 2) {
                const [lon, lat] = issue.location;
                const isError = issue.severity === 'ERROR';

                // Pulse marker for errors
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

            // Highlight conflicting segments if detected
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

                // Add vertices markers
                ring.forEach((pt, pIdx) => {
                    // Do not duplicate the closing point marker
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

                // Add directional arrows at intermediate points of segments
                for (let i = 0; i < ring.length - 1; i++) {
                    const p1 = ring[i];
                    const p2 = ring[i + 1];
                    const midLon = (p1[0] + p2[0]) / 2;
                    const midLat = (p1[1] + p2[1]) / 2;

                    // Calculate bearing/angle
                    const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * (180 / Math.PI);
                    // Leaflet coordinate transform: angle from east counterclockwise
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

            // Geodesic perimeter
            for (let i = 0; i < ring.length - 1; i++) {
                totalPerimeterM += this._haversineDistance(ring[i], ring[i + 1]);
            }

            // Approximate spherical polygon area
            totalAreaM2 += this._sphericalPolygonArea(ring);
        };

        if (geom.type === 'Polygon') {
            geom.coordinates.forEach((ring, idx) => {
                if (idx === 0) processRing(ring); // Exterior
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
        const R = 6371000; // Earth radius in meters
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
        const R = 6378137; // WGS84 semimajor axis
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
        area = Math.abs(area * R * R / 4.0);
        return area;
    }

    _renderFallbackViewer(container) {
        container.innerHTML = `
            <div id="svg-map-fallback" class="svg-map-container">
                <div class="offline-banner">
                    <span>Modo Cartográfico Vectorial (Offline / Nativo)</span>
                </div>
                <svg id="geo-svg" width="100%" height="100%" viewBox="0 0 800 600"></svg>
            </div>
        `;
    }

    _renderFallbackData() {
        const svg = document.getElementById('geo-svg');
        if (!svg || !this.currentData) return;

        // Extract coordinates and transform to SVG space
        let allPts = [];
        const extract = (data) => {
            const feats = data.type === 'FeatureCollection' ? data.features : [data];
            feats.forEach(f => {
                const geom = f.geometry;
                if (!geom) return;
                const coords = geom.type === 'Polygon' ? geom.coordinates[0] : (geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : []);
                coords.forEach(p => allPts.push(p));
            });
        };
        extract(this.currentData);

        if (allPts.length === 0) return;

        const lons = allPts.map(p => p[0]);
        const lats = allPts.map(p => p[1]);
        const minX = Math.min(...lons), maxX = Math.max(...lons);
        const minY = Math.min(...lats), maxY = Math.max(...lats);

        const pad = 50;
        const w = 800 - pad * 2, h = 600 - pad * 2;
        const scaleX = w / (maxX - minX || 1);
        const scaleY = h / (maxY - minY || 1);
        const scale = Math.min(scaleX, scaleY);

        const toSvg = (lon, lat) => {
            const x = pad + (lon - minX) * scale;
            const y = 600 - (pad + (lat - minY) * scale); // Invert y for SVG
            return [x, y];
        };

        const pathPoints = allPts.map(p => toSvg(p[0], p[1]).join(',')).join(' ');

        svg.innerHTML = `
            <defs>
                <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
                </pattern>
            </defs>
            <rect width="100%" height="100%" fill="#0f172a"/>
            <rect width="100%" height="100%" fill="url(#grid)"/>
            <polygon points="${pathPoints}" fill="rgba(16, 185, 129, 0.25)" stroke="#10b981" stroke-width="2"/>
        `;
    }
}
