import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionForOutput, getSourceChain, type ComponentSelection } from './provenance';

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
