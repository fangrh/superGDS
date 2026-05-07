import test from 'node:test';
import assert from 'node:assert/strict';
import { getPythonRunEnv } from './pythonEnv';

test('python run environment enables GDS provenance', () => {
    const env = getPythonRunEnv({ PATH: '/bin', GDS_PROVENANCE: '0' });

    assert.equal(env.PATH, '/bin');
    assert.equal(env.GDS_PROVENANCE, '1');
});
