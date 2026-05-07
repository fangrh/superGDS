export function getPythonRunEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...baseEnv,
        GDS_PROVENANCE: '1',
    };
}
