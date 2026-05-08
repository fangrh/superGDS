import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildAnnotationProvenance,
    deleteAnnotation,
    getNextAnnotationPath,
    loadAnnotationsForPythonFile,
    saveAnnotation,
    sanitizeShapeType,
    type DrawnShapePayload,
} from './annotations';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'supergds-annotations-'));
}

function shape(shapeType = 'rectangle'): DrawnShapePayload {
    return {
        shapeType,
        geometry: {
            type: 'Polygon',
            bbox: [0, 0, 10, 5],
        },
        meta: {
            area_um2: 50,
            vertex_count: 4,
        },
    };
}

test('sanitizeShapeType keeps supported lowercase shape names', () => {
    assert.equal(sanitizeShapeType('rectangle'), 'rectangle');
    assert.equal(sanitizeShapeType('Circle'), 'circle');
    assert.equal(sanitizeShapeType('../bad name'), 'shape');
});

test('getNextAnnotationPath allocates next numbered json next to python file', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    fs.writeFileSync(path.join(dir, 'chip_rectangle_1.json'), '{}');
    fs.writeFileSync(path.join(dir, 'chip_rectangle_2.json'), '{}');

    assert.equal(
        getNextAnnotationPath(pythonFile, 'rectangle'),
        path.join(dir, 'chip_rectangle_3.json')
    );
});

test('saveAnnotation writes json and provenance for source panel', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');

    const saved = saveAnnotation(pythonFile, shape('rectangle'));

    assert.equal(saved.schema, 'supergds.drawn-shape.v1');
    assert.equal(saved.shapeType, 'rectangle');
    assert.equal(saved.sourcePythonFile, pythonFile);
    assert.equal(saved.provenance.file, path.join(dir, 'chip_rectangle_1.json'));
    assert.equal(saved.provenance.line, 1);
    assert.equal(saved.provenance.function, 'drawn annotation');
    assert.deepEqual(saved.geometry.bbox, [0, 0, 10, 5]);
    assert.equal(fs.existsSync(saved.jsonPath), true);

    const raw = JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8'));
    assert.equal(raw.schema, 'supergds.drawn-shape.v1');
    assert.equal(raw.shapeType, 'rectangle');
    assert.deepEqual(raw.geometry.bbox, [0, 0, 10, 5]);
    assert.equal(raw.provenance.file, saved.jsonPath);
    assert.equal(raw.provenance.line, 1);
    assert.equal(raw.provenance.function, 'drawn annotation');
});

test('loadAnnotationsForPythonFile returns matching valid annotations sorted by file name', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    saveAnnotation(pythonFile, shape('line'));
    saveAnnotation(pythonFile, shape('rectangle'));
    fs.writeFileSync(path.join(dir, 'chip_polygon_1.json'), JSON.stringify({ schema: 'other' }));
    fs.writeFileSync(path.join(dir, 'chip_rectangle_bad.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'other_rectangle_1.json'), JSON.stringify(shape('rectangle')));

    const loaded = loadAnnotationsForPythonFile(pythonFile);

    assert.deepEqual(
        loaded.map((item) => path.basename(item.jsonPath)),
        ['chip_line_1.json', 'chip_rectangle_1.json']
    );
});

test('loadAnnotationsForPythonFile sorts by numeric suffix before filename', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    saveAnnotation(pythonFile, shape('rectangle'));
    const two = saveAnnotation(pythonFile, shape('rectangle'));
    for (let index = 3; index <= 9; index += 1) {
        fs.writeFileSync(path.join(dir, `chip_rectangle_${index}.json`), JSON.stringify({
            ...two,
            id: `chip_rectangle_${index}`,
            jsonPath: path.join(dir, `chip_rectangle_${index}.json`),
            provenance: buildAnnotationProvenance(path.join(dir, `chip_rectangle_${index}.json`), 'rectangle'),
        }));
    }
    fs.writeFileSync(path.join(dir, 'chip_rectangle_10.json'), JSON.stringify({
        ...two,
        id: 'chip_rectangle_10',
        jsonPath: path.join(dir, 'chip_rectangle_10.json'),
        provenance: buildAnnotationProvenance(path.join(dir, 'chip_rectangle_10.json'), 'rectangle'),
    }));

    const loaded = loadAnnotationsForPythonFile(pythonFile);

    assert.deepEqual(
        loaded.map((item) => path.basename(item.jsonPath)).slice(0, 4),
        ['chip_rectangle_1.json', 'chip_rectangle_2.json', 'chip_rectangle_3.json', 'chip_rectangle_4.json']
    );
    assert.ok(
        loaded.findIndex((item) => path.basename(item.jsonPath) === 'chip_rectangle_10.json')
        > loaded.findIndex((item) => path.basename(item.jsonPath) === 'chip_rectangle_2.json')
    );
});

test('saveAnnotation throws for invalid geometry or meta', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');

    assert.throws(
        () => saveAnnotation(pythonFile, {
            ...shape(),
            geometry: {
                type: 'Polygon',
            } as DrawnShapePayload['geometry'],
        }),
        /Invalid annotation payload: geometry/
    );

    assert.throws(
        () => saveAnnotation(pythonFile, {
            ...shape(),
            meta: {
                area_um2: 'bad' as unknown as number,
            },
        }),
        /Invalid annotation payload: meta/
    );
});

test('deleteAnnotation refuses to remove non-annotation json files', () => {
    const dir = tmpDir();
    const otherJson = path.join(dir, 'notes.json');
    fs.writeFileSync(otherJson, JSON.stringify({ hello: 'world' }));

    assert.equal(deleteAnnotation(otherJson), false);
    assert.equal(fs.existsSync(otherJson), true);
});

test('buildAnnotationProvenance points at json file line 1', () => {
    const jsonPath = path.join(tmpDir(), 'chip_circle_1.json');

    assert.deepEqual(buildAnnotationProvenance(jsonPath, 'circle'), {
        file: jsonPath,
        line: 1,
        function: 'drawn annotation',
        cell: 'drawn circle',
        source_text: 'superGDS drawn shape annotation',
    });
});

test('deleteAnnotation removes valid superGDS annotation sidecars only', () => {
    const dir = tmpDir();
    const pythonFile = path.join(dir, 'chip.py');
    const saved = saveAnnotation(pythonFile, shape('rectangle'));

    assert.equal(deleteAnnotation(saved.jsonPath), true);
    assert.equal(fs.existsSync(saved.jsonPath), false);
});

test('deleteAnnotation refuses forged annotations outside the source python directory', () => {
    const sourceDir = tmpDir();
    const wrongDir = tmpDir();
    const sourcePythonFile = path.join(sourceDir, 'chip.py');
    const wrongPath = path.join(wrongDir, 'chip_rectangle_1.json');

    fs.writeFileSync(wrongPath, JSON.stringify({
        schema: 'supergds.drawn-shape.v1',
        id: 'chip_rectangle_1',
        shapeType: 'rectangle',
        jsonPath: wrongPath,
        sourcePythonFile,
        geometry: shape().geometry,
        meta: shape().meta,
        provenance: buildAnnotationProvenance(wrongPath, 'rectangle'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }));

    assert.equal(deleteAnnotation(wrongPath), false);
    assert.equal(fs.existsSync(wrongPath), true);
});
