/**
 * Pruebas automáticas del motor JS (validator.js + repair.js).
 * Ejecutar: npm test   (o: node --test tests/)
 *
 * Autor: Renato Andara
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { GeoJSONValidator, GeoUtils } = require('../js/validator.js');
const { GeoJSONRepairer } = require('../js/repair.js');

const FIX = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const v = new GeoJSONValidator();
const cats = r => r.issues.map(i => i.category);
const fc = geoms => ({ type: 'FeatureCollection', features: geoms.map((g, i) => ({ type: 'Feature', properties: { PlotID: 'P' + i }, geometry: g })) });
const P = (...rings) => ({ type: 'Polygon', coordinates: rings });
const SQ = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

// ---------------- Archivos de ejemplo (compartidos con Python) ----------------
for (const [file, exp] of Object.entries(expected)) {
    if (file.startsWith('_')) continue;
    test(`archivo ${file}`, () => {
        const r = v.validate(fs.readFileSync(path.join(FIX, file), 'utf8'));
        assert.equal(r.overall_status, exp.status);
        if ('errors' in exp) assert.equal(r.summary.errors, exp.errors);
        if ('warnings' in exp) assert.equal(r.summary.warnings, exp.warnings);
        for (const c of exp.categories) assert.ok(cats(r).includes(c), `falta la categoría "${c}"`);
        if (exp.location) {
            const hit = r.issues.some(i => i.location && Math.abs(i.location[0] - exp.location[0]) < 1e-6 && Math.abs(i.location[1] - exp.location[1]) < 1e-6);
            assert.ok(hit, 'no se reportó el punto de intersección esperado');
        }
        if (exp.repaired_status) {
            const { repairedData } = GeoJSONRepairer.repair(r.data);
            assert.equal(v.validate(repairedData).overall_status, exp.repaired_status);
        }
    });
}

// ---------------- Topología ----------------
test('parcelas colindantes (lindero, vértice en T, borde parcial) no son solapamiento', () => {
    assert.equal(v.validate(fc([P(SQ), P([[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]])])).summary.errors, 0);
    assert.equal(v.validate(fc([P([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), P([[2, 0.5], [3, 0.5], [3, 1.5], [2, 1.5], [2, 0.5]])])).summary.errors, 0);
    assert.equal(v.validate(fc([P([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), P([[2, 1], [3, 1], [3, 3], [2, 3], [2, 1]])])).summary.errors, 0);
});

test('solapamientos: cruz, contención, idénticos', () => {
    assert.ok(cats(v.validate(fc([P([[0, 1], [3, 1], [3, 2], [0, 2], [0, 1]]), P([[1, 0], [2, 0], [2, 3], [1, 3], [1, 0]])]))).includes('Solapamiento Inter-Parcelas'));
    assert.ok(cats(v.validate(fc([P([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]), P([[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]])]))).includes('Solapamiento Inter-Parcelas'));
    const r = v.validate(fc([P(SQ), P(SQ)]));
    assert.ok(r.issues.some(i => i.details.identical));
});

test('parcela dentro del hueco de otra no es solapamiento', () => {
    const donut = P([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]]);
    assert.equal(v.validate(fc([donut, P([[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]])])).summary.errors, 0);
});

test('partes solapadas de un MultiPolygon', () => {
    const r = v.validate({ type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]], [[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]] });
    assert.ok(cats(r).includes('Solapamiento entre Partes'));
});

test('pinch point se reporta una sola vez', () => {
    const r = v.validate(fc([P([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 1], [0, 0]])]));
    assert.equal(r.issues.filter(i => i.category.startsWith('Punto de Auto-Contacto')).length, 1);
});

test('espiga (retroceso colineal) y vértice sobre borde propio', () => {
    assert.ok(cats(v.validate(fc([P([[0, 0], [2, 0], [1, 0], [1, 1], [0, 1], [0, 0]])]))).includes('Espiga / Retroceso de Borde'));
    assert.ok(cats(v.validate(fc([P([[0, 0], [2, 0], [2, 2], [1, 0], [0, 2], [0, 0]])]))).includes('Vértice sobre Borde Propio'));
});

test('hueco que cruza el exterior', () => {
    const r = v.validate(fc([P(SQ, [[0.5, 0.5], [0.5, 1.5], [0.8, 1.5], [0.8, 0.5], [0.5, 0.5]])]));
    assert.ok(cats(r).includes('Intersección entre Anillos'));
});

// ---------------- Robustez ----------------
test('coordenadas inválidas no rompen el validador', () => {
    const r = v.validate(fc([{ type: 'Polygon', coordinates: [[[0, 0], 'x', [1, 1], null]] }]));
    assert.ok(cats(r).includes('Coordenada Inválida'));
});

test('entradas raras: vacío, BOM, arreglo, tipo desconocido, geometría nula', () => {
    assert.equal(v.validate('').overall_status, 'ERROR');
    assert.equal(v.validate('﻿' + JSON.stringify(fc([P(SQ)]))).summary.errors, 0);
    assert.equal(v.validate('[]').overall_status, 'ERROR');
    assert.equal(v.validate({ type: 'Foo' }).overall_status, 'ERROR');
    assert.ok(cats(v.validate({ type: 'Feature', properties: {}, geometry: null })).includes('Geometría Nula'));
});

test('GeometryCollection se valida miembro a miembro', () => {
    const r = v.validate({ type: 'GeometryCollection', geometries: [P([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]])] });
    assert.ok(cats(r).includes('Auto-intersección / Solapamiento de Bordes'));
});

test('coordenadas invertidas lat/lon se sugieren', () => {
    const r = v.validate(fc([P([[7.93, -100.1], [7.94, -100.1], [7.94, -100.2], [7.93, -100.1]])]));
    assert.ok(r.issues.some(i => /invertidas/.test(i.message)));
});

test('identificadores duplicados y precisión', () => {
    const r = v.validate({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { PlotID: 'X' }, geometry: P(SQ) },
        { type: 'Feature', properties: { PlotID: 'X' }, geometry: P([[5, 5], [6, 5], [6, 6], [5, 5]]) }] });
    assert.ok(cats(r).includes('Identificador Duplicado'));
    assert.ok(cats(r).includes('Precisión de Coordenadas'));
});

test('estado por entidad y área', () => {
    const r = v.validate(fc([P([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]), P([[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]])]));
    assert.deepEqual(r.features.map(f => f.status), ['VALIDO', 'ALERTA']);
    assert.ok(Math.abs(r.features[0].area_ha - 123.6) < 1, `área ${r.features[0].area_ha}`);
});

test('anillo grande (20 000 vértices) se valida rápido', () => {
    const N = 20000, ring = [];
    for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; ring.push([Math.cos(a) * (1 + 0.1 * Math.sin(7 * a)), Math.sin(a) * (1 + 0.1 * Math.sin(7 * a))]); }
    ring.push(ring[0]);
    const t = Date.now();
    assert.equal(v.validate(fc([P(ring)])).summary.errors, 0);
    assert.ok(Date.now() - t < 3000);
});

// ---------------- Reparación ----------------
test('reparar anillo abierto conserva todos los vértices', () => {
    const { repairedData, changes } = GeoJSONRepairer.repair(fc([P([[0, 0], [1, 0], [1, 1], [0, 1], [-0.5, 0.5]])]));
    const ring = repairedData.features[0].geometry.coordinates[0];
    assert.equal(ring.length, 6);
    assert.ok(ring.some(p => p[0] === -0.5));
    assert.ok(changes.some(c => /cerrado/.test(c)));
});

test('reparar quita duplicados (también antes del cierre) y orienta huecos', () => {
    const donutBad = P([[0, 0], [0, 10], [10, 10], [10, 0], [10, 0], [0, 0]], [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]);
    const { repairedData } = GeoJSONRepairer.repair(fc([donutBad]));
    const [ext, hole] = repairedData.features[0].geometry.coordinates;
    assert.ok(GeoUtils.signedArea(ext) > 0 && GeoUtils.signedArea(hole) < 0);
    assert.equal(ext.length, 5);
    assert.equal(v.validate(repairedData).overall_status, 'VALIDO');
});

test('reparar elimina crs WGS84, conserva altitud y no añade metadata por defecto', () => {
    const src = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
        features: [{ type: 'Feature', geometry: P([[0, 0, 5], [0, 1, 5], [1, 1, 5], [1, 0, 5], [0, 0, 5]]) }] };
    const { repairedData } = GeoJSONRepairer.repair(src);
    assert.equal(repairedData.crs, undefined);
    assert.equal(repairedData.metadata, undefined);
    assert.deepEqual(repairedData.features[0].properties, {});
    assert.ok(repairedData.features[0].geometry.coordinates[0].every(p => p[2] === 5));
    assert.ok(GeoJSONRepairer.repair(src, { addMetadata: true }).repairedData.metadata.repair_notes.length > 0);
});

test('reparar no modifica el original', () => {
    const src = fc([P([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])]);
    const copy = JSON.stringify(src);
    GeoJSONRepairer.repair(src);
    assert.equal(JSON.stringify(src), copy);
});

test('escapeHtml neutraliza HTML de las propiedades', () => {
    assert.equal(GeoUtils.escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});
