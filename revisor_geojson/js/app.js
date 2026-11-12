/**
 * Orquestador de la interfaz del Revisor GeoJSON
 *
 * Autor: Renato Andara
 *
 * Requiere (en este orden): validator.js, repair.js, map.js.
 * Todo el procesamiento ocurre en el navegador: el archivo nunca se sube a ningún servidor.
 */
(function (root) {
    'use strict';

    const { GeoJSONValidator, GeoJSONRepairer, GeoJSONMapViewer, GeoUtils } = root;
    const esc = GeoUtils.escapeHtml;
    const $ = id => document.getElementById(id);

    const SEVERITY_BADGE = { ERROR: 'badge-error', ALERTA: 'badge-warning', INFO: 'badge-info' };
    const STATUS_LABEL = { VALIDO: '✅ Válida', ALERTA: '⚠️ Alertas', ERROR: '❌ Errores' };

    function formatBytes(n) {
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1048576).toFixed(1)} MB`;
    }

    class App {
        constructor() {
            this.validator = new GeoJSONValidator();
            this.mapViewer = new GeoJSONMapViewer('map');
            this.currentGeoJSON = null;
            this.currentFilename = 'archivo.geojson';
            this.currentValidation = null;
            this.repairedGeoJSON = null;
            this.activeFilter = 'ALL';
            this.searchText = '';

            this._setupFileUpload();
            this._setupToolbarControls();
            this._setupFilterTabs();
            this._setupRepairModal();
            this._setupReportExport();
        }

        // --------------------------- Carga ---------------------------
        _setupFileUpload() {
            const dropzone = $('dropzone');
            const fileInput = $('file-input');

            // El <label for="file-input"> abre el selector de forma nativa; no se
            // añade un click() manual (provocaba que el diálogo se abriera dos veces).
            fileInput.addEventListener('change', e => {
                const file = e.target.files?.[0];
                if (file) this.loadFile(file);
                fileInput.value = ''; // permite volver a cargar el mismo archivo
            });

            // Arrastrar y soltar en cualquier parte de la ventana.
            let depth = 0;
            const prevent = e => { e.preventDefault(); e.stopPropagation(); };
            window.addEventListener('dragenter', e => { prevent(e); depth++; dropzone.classList.add('drag-over'); });
            window.addEventListener('dragover', prevent);
            window.addEventListener('dragleave', e => { prevent(e); if (--depth <= 0) { depth = 0; dropzone.classList.remove('drag-over'); } });
            window.addEventListener('drop', e => {
                prevent(e);
                depth = 0;
                dropzone.classList.remove('drag-over');
                const file = e.dataTransfer?.files?.[0];
                if (file) this.loadFile(file);
            });
        }

        loadFile(file) {
            if (!/\.(geo)?json$/i.test(file.name)) {
                if (!confirm(`"${file.name}" no tiene extensión .geojson ni .json. ¿Analizarlo de todos modos?`)) return;
            }
            this._setBusy(`Analizando ${file.name} (${formatBytes(file.size)})…`);
            const reader = new FileReader();
            reader.onload = e => this.processGeoJSON(e.target.result, file.name, file.size);
            reader.onerror = () => this._setFatal(`No se pudo leer el archivo: ${reader.error?.message || 'error desconocido'}`);
            reader.readAsText(file, 'utf-8');
        }

        processGeoJSON(contentString, filename, size) {
            this.currentFilename = filename;
            // Ceder un ciclo al navegador para que pinte el estado "Analizando…".
            setTimeout(() => {
                let result;
                const t0 = performance.now();
                try {
                    result = this.validator.validate(contentString);
                } catch (err) {
                    console.error(err);
                    this._setFatal(`Error interno al validar: ${err.message}. Por favor reporte este archivo.`);
                    return;
                }
                result.elapsed_ms = Math.round(performance.now() - t0);
                this.currentValidation = result;
                this.currentGeoJSON = result.data && typeof result.data === 'object' ? result.data : null;
                this.repairedGeoJSON = null;

                $('current-file-name').textContent = `${filename}${size ? ` · ${formatBytes(size)}` : ''}`;
                $('current-file-name').title = filename;
                $('dropzone').classList.add('has-file');

                this._updateMetricsDashboard(result);
                this._renderTable();

                let renderInfo = { decorationsSkipped: false };
                try {
                    renderInfo = this.mapViewer.render(this.currentGeoJSON, result) || renderInfo;
                } catch (err) {
                    console.error('Error al dibujar el mapa:', err);
                }
                const note = $('map-note');
                if (note) {
                    note.hidden = !renderInfo.decorationsSkipped || !this.mapViewer.map;
                    note.textContent = `Archivo grande (${renderInfo.totalVertices} vértices): números y flechas desactivados para mantener la fluidez.`;
                }

                $('btn-repair').disabled = !this.currentGeoJSON;
                $('btn-report-csv').disabled = false;
                $('btn-report-json').disabled = false;
            }, 20);
        }

        _setBusy(text) {
            const badge = $('overall-status-badge');
            badge.className = 'status-pill status-info';
            badge.innerHTML = '<span>⏳</span> <strong>ANALIZANDO</strong>';
            $('overall-status-text').textContent = text;
        }

        _setFatal(text) {
            const badge = $('overall-status-badge');
            badge.className = 'status-pill status-error';
            badge.innerHTML = '<span>❌</span> <strong>ERROR</strong>';
            $('overall-status-text').textContent = text;
        }

        // --------------------------- Panel ---------------------------
        _updateMetricsDashboard(result) {
            $('metric-errors-count').textContent = result.summary.errors;
            $('metric-warnings-count').textContent = result.summary.warnings;
            $('metric-features-count').textContent = result.features_count;

            const totalHa = (result.features || []).reduce((s, f) => s + (f.area_ha || 0), 0);
            $('metric-area').textContent = totalHa > 0
                ? `${totalHa.toLocaleString('es-ES', { maximumFractionDigits: 2 })} ha`
                : '—';

            const badge = $('overall-status-badge');
            badge.className = 'status-pill';
            if (result.overall_status === 'ERROR') {
                badge.classList.add('status-error');
                badge.innerHTML = '<span>❌</span> <strong>INVÁLIDO</strong>';
            } else if (result.overall_status === 'ALERTA') {
                badge.classList.add('status-warning');
                badge.innerHTML = '<span>⚠️</span> <strong>VÁLIDO CON ALERTAS</strong>';
            } else {
                badge.classList.add('status-success');
                badge.innerHTML = '<span>✅</span> <strong>VÁLIDO</strong>';
            }
            const bad = (result.features || []).filter(f => f.status === 'ERROR').length;
            $('overall-status-text').textContent = `${result.status_text}` +
                (result.features_count ? ` ${bad} de ${result.features_count} entidad(es) con errores.` : '') +
                ` Analizado en ${result.elapsed_ms ?? 0} ms.`;
        }

        _setupFilterTabs() {
            const tabs = document.querySelectorAll('.filter-tab');
            tabs.forEach(tab => tab.addEventListener('click', () => {
                tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
                tab.classList.add('active');
                tab.setAttribute('aria-selected', 'true');
                this.activeFilter = tab.dataset.filter;
                this._renderTable();
            }));
            $('issues-search').addEventListener('input', e => {
                this.searchText = e.target.value.trim().toLowerCase();
                this._renderTable();
            });
        }

        _updateTabCounts() {
            const r = this.currentValidation;
            const counts = r ? { ALL: r.issues.length, ERROR: r.summary.errors, ALERTA: r.summary.warnings, INFO: r.summary.info, FEATURES: r.features_count } : {};
            document.querySelectorAll('.filter-tab').forEach(tab => {
                const c = tab.querySelector('.tab-count');
                if (c) c.textContent = counts[tab.dataset.filter] ?? '';
            });
        }

        _renderTable() {
            this._updateTabCounts();
            const thead = $('issues-table-head');
            const body = $('issues-table-body');
            const empty = $('issues-empty-state');
            body.innerHTML = '';

            if (!this.currentValidation) {
                empty.style.display = 'block';
                return;
            }
            empty.style.display = 'none';

            if (this.activeFilter === 'FEATURES') {
                thead.innerHTML = '<tr><th>Estado</th><th>Entidad</th><th>Geometría</th><th class="num">Área (ha)</th></tr>';
                this._renderFeatureRows(body);
                return;
            }
            thead.innerHTML = '<tr><th style="width:74px">Nivel</th><th>Diagnóstico</th><th style="width:92px">Ubicación</th></tr>';

            const q = this.searchText;
            const rows = this.currentValidation.issues.filter(i =>
                (this.activeFilter === 'ALL' || i.severity === this.activeFilter) &&
                (!q || `${i.category} ${i.message} ${i.plot_id || ''}`.toLowerCase().includes(q)));

            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No hay diagnósticos con este filtro.</td></tr>';
                return;
            }

            const frag = document.createDocumentFragment();
            rows.slice(0, 1000).forEach(issue => {
                const tr = document.createElement('tr');
                tr.className = `issue-row issue-row-${issue.severity.toLowerCase()}`;
                const loc = issue.location;
                const hasCoord = Array.isArray(loc) && Number.isFinite(loc[0]) && Number.isFinite(loc[1]);
                tr.innerHTML = `
                    <td><span class="badge ${SEVERITY_BADGE[issue.severity] || 'badge-info'}">${esc(issue.severity)}</span></td>
                    <td><strong>${esc(issue.category)}</strong> <small class="text-muted">· ${esc(issue.plot_id || 'Archivo')}</small>
                        <div class="issue-msg-text">${esc(issue.message)}</div></td>
                    <td>${hasCoord ? `<button type="button" class="btn-coord" title="Centrar en el mapa">📍 ${loc[0].toFixed(5)}<br>${loc[1].toFixed(5)}</button>` : '<span class="text-muted">—</span>'}</td>`;
                if (hasCoord) {
                    tr.classList.add('clickable');
                    tr.addEventListener('click', () => this.mapViewer.zoomToLocation(loc[0], loc[1], 18));
                } else if (issue.feature_index !== null) {
                    tr.classList.add('clickable');
                    tr.addEventListener('click', () => this.mapViewer.focusFeature(issue.feature_index));
                }
                frag.appendChild(tr);
            });
            body.appendChild(frag);
            if (rows.length > 1000) {
                body.insertAdjacentHTML('beforeend', `<tr><td colspan="3" class="text-center text-muted">Se muestran 1000 de ${rows.length} diagnósticos. Descargue el reporte para verlos todos.</td></tr>`);
            }
        }

        _renderFeatureRows(body) {
            const q = this.searchText;
            const feats = (this.currentValidation.features || []).filter(f =>
                !q || `${f.plot_id} ${f.geometry_type}`.toLowerCase().includes(q));
            if (!feats.length) {
                body.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No hay entidades que mostrar.</td></tr>';
                return;
            }
            const frag = document.createDocumentFragment();
            feats.slice(0, 2000).forEach(f => {
                const tr = document.createElement('tr');
                tr.className = 'issue-row clickable';
                tr.innerHTML = `
                    <td><span class="badge ${f.status === 'ERROR' ? 'badge-error' : f.status === 'ALERTA' ? 'badge-warning' : 'badge-success'}">${STATUS_LABEL[f.status] || esc(f.status)}</span></td>
                    <td><strong>${esc(f.plot_id)}</strong><br><small class="text-muted">${f.errors} error(es) · ${f.warnings} alerta(s)</small></td>
                    <td>${esc(f.geometry_type || '—')}<br><small class="text-muted">${f.vertices} vértices</small></td>
                    <td class="num">${f.area_ha != null ? f.area_ha.toLocaleString('es-ES', { maximumFractionDigits: 4 }) : '—'}</td>`;
                tr.addEventListener('click', () => this.mapViewer.focusFeature(f.index));
                frag.appendChild(tr);
            });
            body.appendChild(frag);
        }

        _setupToolbarControls() {
            $('toggle-arrows').addEventListener('change', e => this.mapViewer.toggleArrows(e.target.checked));
            $('toggle-vertices').addEventListener('change', e => this.mapViewer.toggleVertices(e.target.checked));
            $('btn-fit').addEventListener('click', () => this.mapViewer.fitAll());
        }

        // --------------------------- Reparación ---------------------------
        _setupRepairModal() {
            const modal = $('repair-modal');
            const close = () => { modal.classList.add('hidden'); $('btn-repair').focus(); };

            $('btn-repair').addEventListener('click', () => this._runRepair());
            $('opt-metadata').addEventListener('change', () => this._runRepair());
            $('btn-close-modal').addEventListener('click', close);
            modal.addEventListener('click', e => { if (e.target === modal) close(); });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });

            $('btn-download-fixed').addEventListener('click', () => {
                if (this.repairedGeoJSON) GeoJSONRepairer.downloadGeoJSON(this.repairedGeoJSON, this.currentFilename);
            });
            $('btn-load-fixed').addEventListener('click', () => {
                if (!this.repairedGeoJSON) return;
                close();
                this.processGeoJSON(JSON.stringify(this.repairedGeoJSON), GeoJSONRepairer.outputFilename(this.currentFilename));
            });
        }

        _runRepair() {
            if (!this.currentGeoJSON) return;
            const { repairedData, changes, unrepaired } = GeoJSONRepairer.repair(this.currentGeoJSON, { addMetadata: $('opt-metadata').checked });
            this.repairedGeoJSON = repairedData;
            const after = new GeoJSONValidator().validate(repairedData);

            const list = $('repair-notes-list');
            list.innerHTML = changes.length
                ? changes.slice(0, 300).map(c => `<li>✔️ ${esc(c)}</li>`).join('') + (changes.length > 300 ? `<li>… y ${changes.length - 300} cambio(s) más.</li>` : '')
                : '<li class="text-success">No se necesitaron correcciones automáticas.</li>';

            const manual = after.issues.filter(i => i.severity === 'ERROR');
            const box = $('repair-after');
            const items = unrepaired.map(u => `<li>${esc(u)}</li>`)
                .concat(manual.slice(0, 50).map(i => `<li><strong>${esc(i.category)}:</strong> ${esc(i.message)}</li>`));
            box.className = `repair-after ${after.summary.errors ? 'repair-after-error' : after.summary.warnings ? 'repair-after-warning' : 'repair-after-ok'}`;
            box.innerHTML = after.summary.errors
                ? `<strong>Quedan ${after.summary.errors} error(es) que requieren corrección manual en un SIG</strong> (p. ej. QGIS → Vectorial → Herramientas de geometría → Corregir geometrías, o editar los vértices):<ul>${items.join('')}</ul>`
                : `<strong>Resultado tras la reparación: ${after.overall_status === 'VALIDO' ? 'VÁLIDO ✅' : 'válido con alertas ⚠️'}</strong>` +
                  (after.summary.warnings ? ` (${after.summary.warnings} alerta(s) no corregibles automáticamente).` : '') +
                  (items.length ? `<ul>${items.join('')}</ul>` : '');

            $('repair-modal').classList.remove('hidden');
            $('btn-download-fixed').focus();
        }

        // --------------------------- Reportes ---------------------------
        _setupReportExport() {
            const base = () => this.currentFilename.replace(/\.(geo)?json$/i, '');
            $('btn-report-csv').addEventListener('click', () => {
                if (!this.currentValidation) return;
                const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const lines = [['Nivel', 'Categoría', 'Entidad', 'Mensaje', 'Longitud', 'Latitud'].map(q).join(';')];
                this.currentValidation.issues.forEach(i => {
                    const loc = Array.isArray(i.location) ? i.location : [];
                    lines.push([i.severity, i.category, i.plot_id || 'Archivo', i.message, loc[0] ?? '', loc[1] ?? ''].map(q).join(';'));
                });
                // BOM para que Excel reconozca UTF-8; ';' por la coma decimal en español.
                GeoJSONRepairer.downloadText('﻿' + lines.join('\r\n'), `${base()}_reporte_validacion.csv`, 'text/csv;charset=utf-8');
            });
            $('btn-report-json').addEventListener('click', () => {
                if (!this.currentValidation) return;
                const { data, ...report } = this.currentValidation;
                const out = { archivo: this.currentFilename, generado: new Date().toISOString(), herramienta: 'Revisor GeoJSON RFC 7946', ...report };
                GeoJSONRepairer.downloadText(JSON.stringify(out, null, 2), `${base()}_reporte_validacion.json`, 'application/json;charset=utf-8');
            });
        }
    }

    const start = () => { root.app = new App(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(typeof self !== 'undefined' ? self : this);
