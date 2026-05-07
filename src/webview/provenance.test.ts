import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLocationsByFile, formatMentions, formatSelectionForOutput, getSelectionSourceLocations, getSourceChain, type ComponentSelection, type SourceLocation } from './provenance';

test('source chain starts with primary source and removes duplicate call-chain locations', () => {
    const component: ComponentSelection = {
        provId: 'c1',
        layer: '1/0',
        bbox: [0, 1, 2, 3],
        provenance: {
            file: 'cells/ring.py',
            line: 42,
            function: 'ring',
            call_chain: [
                { file: 'cells/ring.py', line: 42, function: 'ring' },
                { file: 'design.py', line: 10, function: 'top' },
            ],
        },
    };

    assert.deepEqual(getSourceChain(component), [
        { file: 'cells/ring.py', line: 42, functionName: 'ring' },
        { file: 'design.py', line: 10, functionName: 'top' },
    ]);
});

test('source chain parses legacy call-stack strings', () => {
    const component: ComponentSelection = {
        provId: 'c1',
        layer: '1/0',
        bbox: [],
        provenance: {
            call_stack: [
                'cells/coupler.py:27 in coupler',
                'top.py:8 in build',
            ],
        },
    };

    assert.deepEqual(getSourceChain(component), [
        { file: 'cells/coupler.py', line: 27, functionName: 'coupler' },
        { file: 'top.py', line: 8, functionName: 'build' },
    ]);
});

test('selection output includes component basics and source chain', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'c1',
            layer: '2/0',
            bbox: [0, 0, 10.125, 5.5],
            provenance: {
                cell: 'straight',
                instance_name: 'wg1',
                file: 'design.py',
                line: 12,
                function: 'build',
            },
        },
    ];

    const output = formatSelectionForOutput(components);

    assert.match(output, /Selected 1 GDS component/);
    assert.match(output, /straight/);
    assert.match(output, /wg1/);
    assert.match(output, /Layer: 2\/0/);
    assert.match(output, /BBox: \[0\.0000, 0\.0000, 10\.1250, 5\.5000\]/);
    assert.match(output, /Source chain:/);
    assert.match(output, /design\.py:12 \(build\)/);
});

test('filterLocationsByFile keeps only locations in the primary file', () => {
    const resolvePath = (f: string) => f;
    const locations: SourceLocation[] = [
        { file: 'a.py', line: 10 },
        { file: 'a.py', line: 20 },
        { file: 'b.py', line: 30 },
        { file: 'a.py', line: 40 },
    ];

    assert.deepEqual(
        filterLocationsByFile(locations, 'a.py', resolvePath),
        [
            { file: 'a.py', line: 10 },
            { file: 'a.py', line: 20 },
            { file: 'a.py', line: 40 },
        ]
    );
});

test('filterLocationsByFile returns empty when no matches', () => {
    const resolvePath = (f: string) => f;
    const locations: SourceLocation[] = [
        { file: 'b.py', line: 30 },
    ];

    assert.deepEqual(
        filterLocationsByFile(locations, 'a.py', resolvePath),
        []
    );
});

test('getSelectionSourceLocations matches source panel file groups', () => {
    const components: ComponentSelection[] = [
        {
            provId: 'c1',
            layer: '1/0',
            bbox: [],
            provenance: {
                file: 'cells/ring.py',
                line: 42,
                call_chain: [
                    { file: 'top.py', line: 20 },
                    { file: 'cells/ring.py', line: 42 },
                ],
            },
        },
        {
            provId: 'c2',
            layer: '1/0',
            bbox: [],
            provenance: {
                file: 'cells/ring.py',
                line: 12,
                call_chain: [
                    { file: 'top.py', line: 10 },
                    { file: 'top.py', line: 20 },
                ],
            },
        },
    ];

    assert.deepEqual(getSelectionSourceLocations(components), [
        { file: 'cells/ring.py', line: 12, functionName: undefined },
        { file: 'cells/ring.py', line: 42, functionName: undefined },
        { file: 'top.py', line: 10, functionName: undefined },
        { file: 'top.py', line: 20, functionName: undefined },
    ]);
});

test('formatMentions joins file:line with @ prefix', () => {
    const locations: SourceLocation[] = [
        { file: 'dir/a.py', line: 359 },
        { file: 'dir/a.py', line: 504 },
        { file: 'dir/a.py', line: 522 },
    ];

    assert.equal(
        formatMentions(locations),
        '@dir/a.py:359 @dir/a.py:504 @dir/a.py:522'
    );
});

test('formatMentions supports custom file display paths', () => {
    const locations: SourceLocation[] = [
        { file: 'D:/repo/dir/a.py', line: 359 },
    ];

    assert.equal(
        formatMentions(locations, (file) => file.replace('D:/repo/', '')),
        '@dir/a.py:359'
    );
});

test('formatMentions returns empty string for empty array', () => {
    assert.equal(formatMentions([]), '');
});
