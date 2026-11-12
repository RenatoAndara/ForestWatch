/**
 * Visor Cartográfico del Revisor GeoJSON (Leaflet + respaldo SVG sin conexión)
 *
 * Autor: Renato Andara
 *
 * - Colorea cada parcela según SU estado (verde válido, ámbar alerta, rojo error).
 * - Marca el punto exacto de cada problema y resalta los segmentos en conflicto.
 * - Flechas de dirección y numeración de vértices (se limitan en archivos grandes).
 * - Si Leaflet no carga (sin internet), dibuja las geometrías en SVG.
 *
 * Requiere: js/validator.js (GeoUtils) cargado antes.
 */
(function (root) {
    'use strict';

    const GeoUtils = root.GeoUtils;
    const esc = GeoUtils.escapeHtml;

    const STATUS_COLORS = { VALIDO: '#10b981', ALERTA: '#f59e0b', ERROR: '#ef4444' };
    const STATUS_BADGE = {
        VALIDO: '<span class="badge badge-success">✅ Válida</span>',
        ALERTA: '<span class="badge badge-warning">⚠️ Con alertas</span>',
        ERROR: '<span class="badge badge-error">❌ Con errores</span>'
    };
    // Por encima de este número de vértices no se dibujan números ni flechas
    // (miles de marcadores DOM congelan el navegador).
    const MAX_DECORATED_VERTICES = 3000;

    /** Anillos de polígono de una geometría (incluye GeometryCollection). */
    function polygonRings(geom) {
        if (!geom || typeof geom !== 'object') return [];
        const ok = r => Array.isArray(r) && r.length >= 2 && r.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
            return geom.coordinates.filter(ok).map((r, i) => ({ ring: r, exterior: i === 0 }));
        }
        if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
            return geom.coordinates.flatMap(poly => Array.isArray(poly)
                ? poly.filter(ok).map((r, i) => ({ ring: r, exterior: i === 0 })) : []);
        }
        if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
            return geom.geometries.flatMap(polygonRings);
        }
        return [];
    }

    function featuresOf(data) {
        if (!data || typeof data !== 'object') return [];
        if (data.type === 'FeatureCollection') return Array.isArray(data.features) ? data.features : [];
        if (data.type === 'Feature') return [data];
        if (data.type) return [{ type: 'Feature', properties: {}, geometry: data }];
        return [];
    }

    class GeoJSONMapViewer {
        constructor(containerId) {
            this.containerId = containerId;
            this.map = null;
            this.featureLayers = [];
            this.showArrows = true;
            this.showVertices = true;
            this.decorationsSkipped = false;
            this.init();
        }

        init() {
            const container = document.getElementById(this.containerId);
            if (!container) return;

            if (typeof root.L === 'undefined') {
                this._initFallback(container);
                return;
            }
            const L = root.L;

            this.map = L.map(this.containerId, { center: [10, -40], zoom: 3, zoomControl: false, preferCanvas: true });
            L.control.zoom({ position: 'topright' }).addTo(this.map);
            L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);

            const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 20, maxNativeZoom: 19,
                attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics y la comunidad de usuarios SIG'
            });
            const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 20, maxNativeZoom: 19, attribution: '© colaboradores de OpenStreetMap'
            });
            satellite.addTo(this.map);

            this.geojsonLayer = L.featureGroup().addTo(this.map);
            this.conflictSegmentsLayer = L.layerGroup().addTo(this.map);
            this.issuesLayer = L.layerGroup().addTo(this.map);
            this.arrowsLayer = L.layerGroup().addTo(this.map);
            this.verticesLayer = L.layerGroup().addTo(this.map);

            L.control.layers(
                { '🛰️ Satélite (Esri)': satellite, '🗺️ Callejero (OpenStreetMap)': streets },
                { 'Problemas detectados': this.issuesLayer, 'Segmentos en conflicto': this.conflictSegmentsLayer },
                { position: 'topright' }
            ).addTo(this.map);
        }

        /**
         * Dibuja los datos. Devuelve { decorationsSkipped, totalVertices }.
         */
        render(data, validationResult) {
            this.currentData = data;
            this.validationResult = validationResult;
            this.clear();
            if (!data) return { decorationsSkipped: false, totalVertices: 0 };

            if (!this.map) return this._renderFallback();

            const L = root.L;
            const featureInfo = validationResult?.features || [];
            const features = featuresOf(data);

            features.forEach((feat, idx) => {
                if (!feat || !feat.geometry) return;
                const info = featureInfo[idx] || {};
                const status = info.status || 'VALIDO';
                const color = STATUS_COLORS[status] || STATUS_COLORS.VALIDO;
                let layer;
                try {
                    layer = L.geoJSON(feat, {
                        style: () => ({ color, weight: 3, opacity: 0.95, fillColor: color, fillOpacity: 0.22 }),
                        pointToLayer: (_f, latlng) => L.circleMarker(latlng, { radius: 7, color, fillColor: color, fillOpacity: 0.7, weight: 2 })
                    });
                } catch (e) {
                    return; // geometría que Leaflet no puede dibujar (ya reportada por el validador)
                }
                layer.bindPopup(() => this._featurePopup(feat, idx, info, status));
                layer.addTo(this.geojsonLayer);
                this.featureLayers[idx] = layer;
            });

            this.fitAll();

            const totalVertices = features.reduce((s, f) => s + polygonRings(f && f.geometry).reduce((a, r) => a + r.ring.length - 1, 0), 0);
            this.decorationsSkipped = totalVertices > MAX_DECORATED_VERTICES;
            if (!this.decorationsSkipped) this._renderDecorations(features);

            if (validationResult?.issues) this._renderIssues(validationResult.issues);
            return { decorationsSkipped: this.decorationsSkipped, totalVertices };
        }

        _featurePopup(feat, idx, info, status) {
            const props = (feat.properties && typeof feat.properties === 'object') ? feat.properties : {};
            const rows = Object.entries(props).slice(0, 12).map(([k, v]) =>
                `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
            const area = info.area_ha != null
                ? `<p><strong>Área:</strong> ${info.area_ha.toLocaleString('es-ES', { maximumFractionDigits: 4 })} ha</p>
                   <p><strong>Perímetro:</strong> ${info.perimeter_m.toLocaleString('es-ES', { maximumFractionDigits: 1 })} m</p>` : '';
            return `
                <div class="map-popup-card">
                    <div class="popup-header">
                        <h4>${esc(info.plot_id || GeoUtils.featureLabel(feat, idx))}</h4>
                        ${STATUS_BADGE[status] || ''}
                    </div>
                    <div class="popup-body">
                        <p><strong>Geometría:</strong> ${esc(feat.geometry?.type || '—')} · <strong>Vértices:</strong> ${info.vertices ?? '—'}</p>
                        ${area}
                        <p><strong>Errores:</strong> ${info.errors ?? 0} · <strong>Alertas:</strong> ${info.warnings ?? 0}</p>
                        ${rows ? `<table class="popup-props">${rows}</table>` : ''}
                    </div>
                </div>`;
        }

        _renderIssues(issues) {
            const L = root.L;
            issues.forEach(issue => {
                if (issue.severity === 'INFO') return;
                const isError = issue.severity === 'ERROR';
                if (Array.isArray(issue.location) && Number.isFinite(issue.location[0]) && Number.isFinite(issue.location[1])) {
                    const [lon, lat] = issue.location;
                    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
                        const icon = L.divIcon({
                            className: 'custom-issue-marker',
                            html: `<div class="issue-marker-pulse ${isError ? 'issue-marker-error' : 'issue-marker-warning'}"></div>`,
                            iconSize: [24, 24], iconAnchor: [12, 12]
                        });
                        L.marker([lat, lon], { icon, title: issue.category }).bindPopup(`
                            <div class="issue-popup">
                                <div class="issue-popup-title ${isError ? 'text-error' : 'text-warning'}">${isError ? '❌ Error' : '⚠️ Alerta'}: ${esc(issue.category)}</div>
                                <div class="issue-popup-msg">${esc(issue.message)}</div>
                                <div class="issue-popup-coord">📍 [${lon.toFixed(6)}, ${lat.toFixed(6)}]</div>
                            </div>`).addTo(this.issuesLayer);
                    }
                }
                const d = issue.details || {};
                if (d.seg1Coords && d.seg2Coords) {
                    [[d.seg1Coords, d.seg1Indices], [d.seg2Coords, d.seg2Indices]].forEach(([coords, ids]) => {
                        L.polyline(coords.map(p => [p[1], p[0]]), { color: '#ff0055', weight: 6, opacity: 0.9, dashArray: '6, 6' })
                            .bindTooltip(`Segmento en conflicto (${ids[0]}-${ids[1]})`)
                            .addTo(this.conflictSegmentsLayer);
                    });
                }
            });
        }

        _renderDecorations(features) {
            const L = root.L;
            features.forEach(feat => {
                polygonRings(feat && feat.geometry).forEach(({ ring, exterior }) => {
                    for (let i = 0; i < ring.length - 1; i++) {
                        const [lon, lat] = ring[i];
                        L.marker([lat, lon], {
                            icon: L.divIcon({ className: 'vertex-number-icon', html: `<span class="vertex-dot">${i + 1}</span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
                            keyboard: false
                        }).bindTooltip(`Vértice ${i + 1} (índice ${i}): [${lon.toFixed(6)}, ${lat.toFixed(6)}]`).addTo(this.verticesLayer);

                        const p1 = ring[i], p2 = ring[i + 1];
                        if (GeoUtils.samePoint(p1, p2)) continue;
                        // Ángulo en pantalla: corrige la distorsión de Mercator con cos(lat).
                        const dx = (p2[0] - p1[0]) * Math.cos(((p1[1] + p2[1]) / 2) * Math.PI / 180);
                        const dy = p2[1] - p1[1];
                        const rot = 90 - Math.atan2(dy, dx) * 180 / Math.PI;
                        L.marker([(p1[1] + p2[1]) / 2, (p1[0] + p2[0]) / 2], {
                            icon: L.divIcon({
                                className: 'arrow-direction-icon',
                                html: `<div style="transform: rotate(${rot}deg);" class="arrow-svg-box">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${exterior ? '#38bdf8' : '#fbbf24'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                        <line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>
                                    </svg></div>`,
                                iconSize: [14, 14], iconAnchor: [7, 7]
                            }),
                            keyboard: false, interactive: false
                        }).addTo(this.arrowsLayer);
                    }
                });
            });
            this._applyToggle(this.arrowsLayer, this.showArrows);
            this._applyToggle(this.verticesLayer, this.showVertices);
        }

        _applyToggle(layer, show) {
            if (!this.map || !layer) return;
            if (show && !this.map.hasLayer(layer)) layer.addTo(this.map);
            if (!show && this.map.hasLayer(layer)) this.map.removeLayer(layer);
        }

        fitAll() {
            if (!this.map) return;
            const b = this.geojsonLayer.getBounds();
            if (b.isValid()) this.map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
        }

        focusFeature(idx) {
            const layer = this.featureLayers[idx];
            if (!this.map || !layer) return;
            const b = layer.getBounds ? layer.getBounds() : null;
            if (b && b.isValid()) this.map.flyToBounds(b, { padding: [40, 40], maxZoom: 18, duration: 0.8 });
            layer.openPopup?.();
        }

        zoomToLocation(lon, lat, zoom = 18) {
            if (this.map && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
                this.map.flyTo([lat, lon], zoom, { duration: 1.0 });
            }
        }

        toggleArrows(show) { this.showArrows = show; this._applyToggle(this.arrowsLayer, show); }
        toggleVertices(show) { this.showVertices = show; this._applyToggle(this.verticesLayer, show); }

        clear() {
            this.featureLayers = [];
            [this.geojsonLayer, this.issuesLayer, this.conflictSegmentsLayer, this.arrowsLayer, this.verticesLayer]
                .forEach(l => l && l.clearLayers());
            const svg = document.getElementById('geo-svg');
            if (svg) svg.innerHTML = '';
        }

        // ---------------------- Respaldo SVG sin conexión ----------------------
        _initFallback(container) {
            container.innerHTML = `
                <div class="svg-map-container">
                    <div class="offline-banner">Sin conexión al servicio de mapas: vista vectorial simplificada</div>
                    <svg id="geo-svg" width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet"></svg>
                </div>`;
        }

        _renderFallback() {
            const svg = document.getElementById('geo-svg');
            const features = featuresOf(this.currentData);
            const info = this.validationResult?.features || [];
            const all = [];
            features.forEach(f => polygonRings(f && f.geometry).forEach(r => r.ring.forEach(p => all.push(p))));
            if (!svg || !all.length) return { decorationsSkipped: true, totalVertices: 0 };

            const [minX, minY, maxX, maxY] = GeoUtils.bbox(all);
            const pad = 30, W = 800, H = 600;
            const kx = Math.cos(((minY + maxY) / 2) * Math.PI / 180) || 1;
            const scale = Math.min((W - 2 * pad) / (((maxX - minX) * kx) || 1e-9), (H - 2 * pad) / ((maxY - minY) || 1e-9));
            const tx = p => [(pad + (p[0] - minX) * kx * scale).toFixed(2), (H - pad - (p[1] - minY) * scale).toFixed(2)];

            let out = '<rect width="100%" height="100%" fill="#0f172a"/>';
            features.forEach((f, idx) => {
                const color = STATUS_COLORS[info[idx]?.status] || STATUS_COLORS.VALIDO;
                const d = polygonRings(f && f.geometry).map(({ ring }) => 'M' + ring.map(p => tx(p).join(',')).join('L') + 'Z').join(' ');
                if (d) out += `<path d="${d}" fill="${color}" fill-opacity="0.25" fill-rule="evenodd" stroke="${color}" stroke-width="2"><title>${esc(info[idx]?.plot_id || '')}</title></path>`;
            });
            (this.validationResult?.issues || []).forEach(i => {
                if (i.severity === 'INFO' || !Array.isArray(i.location)) return;
                const [x, y] = tx(i.location);
                out += `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${i.severity === 'ERROR' ? '#ef4444' : '#f59e0b'}" stroke-width="3"><title>${esc(i.category)}</title></circle>`;
            });
            svg.innerHTML = out;
            return { decorationsSkipped: true, totalVertices: all.length };
        }
    }

    root.GeoJSONMapViewer = GeoJSONMapViewer;
})(typeof self !== 'undefined' ? self : this);
