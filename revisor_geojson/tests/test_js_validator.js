import { GeoJSONValidator } from '../js/validator.js';
import { GeoJSONRepairer } from '../js/repair.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = path.dirname(__dirname);

const v = new GeoJSONValidator();

// 1. Test overlap file
const overlapPath = path.join(baseDir, 'V19579584_RanchoAlegre_polygons.geojson');
const overlapContent = fs.readFileSync(overlapPath, 'utf8');
const rOverlap = v.validate(overlapContent);
console.log('1. Overlap File:');
console.log('   Valid:', rOverlap.valid, '(Expected: false)');
console.log('   Errors:', rOverlap.summary.errors, '(Expected: 1)');
console.log('   Status:', rOverlap.overall_status, '(Expected: ERROR)');
const issue = rOverlap.issues.find(i => i.category.includes('Auto-intersección'));
console.log('   Intersection:', issue?.location ? issue.location.map(n => n.toFixed(6)).join(', ') : 'Not found');

// 2. Test clean file
const cleanPath = path.join(baseDir, 'V19579584_RanchoAlegre_polygons-new.geojson');
const cleanContent = fs.readFileSync(cleanPath, 'utf8');
const rClean = v.validate(cleanContent);
console.log('\n2. Clean File:');
console.log('   Valid:', rClean.valid, '(Expected: true)');
console.log('   Errors:', rClean.summary.errors, '(Expected: 0)');
console.log('   Status:', rClean.overall_status, '(Expected: VALIDO)');

// 3. Test CW polygon (ALERTA, not ERROR)
const cwPolygon = {
    type: 'FeatureCollection',
    features: [{
        type: 'Feature',
        properties: { PlotID: 'CW_TEST' },
        geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
        }
    }]
};
const rCW = v.validate(cwPolygon);
console.log('\n3. CW Polygon (RFC 7946 Warning):');
console.log('   Valid:', rCW.valid, '(Expected: true)');
console.log('   Warnings:', rCW.summary.warnings, '(Expected: 1)');
console.log('   Status:', rCW.overall_status, '(Expected: ALERTA)');
console.log('   Severity:', rCW.issues[0]?.severity, '(Expected: ALERTA)');

// 4. Test Auto-Repair
const { repairedData, changes } = GeoJSONRepairer.repair(cwPolygon);
const rRepaired = v.validate(repairedData);
console.log('\n4. Repaired Polygon:');
console.log('   Valid:', rRepaired.valid, '(Expected: true)');
console.log('   Warnings:', rRepaired.summary.warnings, '(Expected: 0)');
console.log('   Status:', rRepaired.overall_status, '(Expected: VALIDO)');
console.log('   Changes applied:', changes.length);

if (!rOverlap.valid && rClean.valid && rCW.valid && rCW.overall_status === 'ALERTA' && rRepaired.overall_status === 'VALIDO') {
    console.log('\n✅ ALL JS VALIDATION TESTS PASSED PERFECTLY!');
} else {
    console.error('\n❌ SOME TESTS FAILED');
    process.exit(1);
}
