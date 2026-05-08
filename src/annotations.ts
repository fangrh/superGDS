import * as fs from 'fs';
import * as path from 'path';

export interface DrawnShapePayload {
    shapeType: string;
    geometry: {
        type: string;
        bbox: number[];
        center?: number[];
        radius?: number;
    };
    meta: {
        area_um2?: number;
        vertex_count?: number;
    };
}

export interface AnnotationProvenance {
    file: string;
    line: number;
    function: string;
    cell: string;
    source_text: string;
}

export interface SavedAnnotation {
    schema: 'supergds.drawn-shape.v1';
    id: string;
    shapeType: string;
    jsonPath: string;
    sourcePythonFile: string;
    geometry: DrawnShapePayload['geometry'];
    meta: DrawnShapePayload['meta'];
    provenance: AnnotationProvenance;
    createdAt: string;
    updatedAt: string;
}

const DRAWN_SHAPE_SCHEMA = 'supergds.drawn-shape.v1';
const SUPPORTED_SHAPES = new Set(['rectangle', 'circle', 'line', 'polygon']);
const ANNOTATION_FILENAME_RE = /^(?<base>.+)_(?<shape>[a-z0-9_-]+)_(?<index>\d+)\.json$/;

export function sanitizeShapeType(shapeType: string): string {
    const normalized = shapeType.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return SUPPORTED_SHAPES.has(normalized) ? normalized : 'shape';
}

export function getNextAnnotationPath(pythonFile: string, shapeType: string): string {
    const directory = path.dirname(pythonFile);
    const baseName = path.basename(pythonFile, path.extname(pythonFile));
    const safeShapeType = sanitizeShapeType(shapeType);

    let index = 1;
    while (fs.existsSync(path.join(directory, `${baseName}_${safeShapeType}_${index}.json`))) {
        index += 1;
    }

    return path.join(directory, `${baseName}_${safeShapeType}_${index}.json`);
}

export function buildAnnotationProvenance(jsonPath: string, shapeType: string): AnnotationProvenance {
    const safeShapeType = sanitizeShapeType(shapeType);

    return {
        file: jsonPath,
        line: 1,
        function: 'drawn annotation',
        cell: `drawn ${safeShapeType}`,
        source_text: 'superGDS drawn shape annotation',
    };
}

export function saveAnnotation(pythonFile: string, payload: DrawnShapePayload): SavedAnnotation {
    validateDrawnShapePayload(payload);

    const safeShapeType = sanitizeShapeType(payload.shapeType);
    const jsonPath = getNextAnnotationPath(pythonFile, safeShapeType);
    const timestamp = new Date().toISOString();
    const saved: SavedAnnotation = {
        schema: DRAWN_SHAPE_SCHEMA,
        id: path.basename(jsonPath, '.json'),
        shapeType: safeShapeType,
        jsonPath,
        sourcePythonFile: pythonFile,
        geometry: payload.geometry,
        meta: payload.meta,
        provenance: buildAnnotationProvenance(jsonPath, safeShapeType),
        createdAt: timestamp,
        updatedAt: timestamp,
    };

    fs.writeFileSync(jsonPath, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');

    return saved;
}

export function loadAnnotationsForPythonFile(pythonFile: string): SavedAnnotation[] {
    const directory = path.dirname(pythonFile);
    const baseName = path.basename(pythonFile, path.extname(pythonFile));
    const normalizedPythonFile = normalizePath(pythonFile);

    if (!fs.existsSync(directory)) {
        return [];
    }

    const entries: Array<{ entry: string; parts: { base: string; shape: string; index: number } }> = fs.readdirSync(directory)
        .filter((entry) => entry.startsWith(`${baseName}_`) && entry.endsWith('.json'))
        .map((entry) => ({ entry, parts: parseAnnotationFilename(entry) }))
        .flatMap((item) => item.parts ? [{ entry: item.entry, parts: item.parts }] : [])
        .sort((left, right) => {
            if (left.parts.index !== right.parts.index) {
                return left.parts.index - right.parts.index;
            }
            return left.entry.localeCompare(right.entry);
        });

    return entries.flatMap(({ entry }) => {
            const jsonPath = path.join(directory, entry);

            try {
                const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as unknown;
                const saved = parseSavedAnnotation(parsed);

                if (!saved) {
                    return [];
                }

                if (normalizePath(saved.sourcePythonFile) !== normalizedPythonFile) {
                    return [];
                }

                const realJsonPath = fs.realpathSync(jsonPath);
                return [{
                    ...saved,
                    jsonPath: realJsonPath,
                    provenance: buildAnnotationProvenance(realJsonPath, saved.shapeType),
                }];
            } catch {
                return [];
            }
        });
}

export function deleteAnnotation(jsonPath: string): boolean {
    const trimmedPath = jsonPath.trim();

    if (!trimmedPath) {
        return false;
    }

    const resolvedPath = path.resolve(trimmedPath);
    if (!fs.existsSync(resolvedPath)) {
        return false;
    }

    try {
        const filename = path.basename(resolvedPath);
        const filenameParts = parseAnnotationFilename(filename);
        if (!filenameParts) {
            return false;
        }

        const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
        const saved = parseSavedAnnotation(parsed);
        if (!saved) {
            return false;
        }

        const expectedBase = path.basename(saved.sourcePythonFile, path.extname(saved.sourcePythonFile));
        const expectedShape = sanitizeShapeType(saved.shapeType);
        const expectedId = `${expectedBase}_${expectedShape}_${filenameParts.index}`;
        const expectedSidecarPath = path.join(
            path.dirname(saved.sourcePythonFile),
            `${expectedBase}_${expectedShape}_${filenameParts.index}.json`
        );
        if (
            filenameParts.base !== expectedBase
            || filenameParts.shape !== expectedShape
            || saved.id !== expectedId
            || normalizePath(saved.jsonPath) !== resolvedPath
            || resolvedPath !== path.resolve(expectedSidecarPath)
        ) {
            return false;
        }
    } catch {
        return false;
    }

    fs.unlinkSync(resolvedPath);
    return true;
}

function validateDrawnShapePayload(payload: DrawnShapePayload): void {
    if (!isGeometry(payload.geometry)) {
        throw new Error('Invalid annotation payload: geometry');
    }

    if (!isMeta(payload.meta)) {
        throw new Error('Invalid annotation payload: meta');
    }
}

function parseSavedAnnotation(value: unknown): SavedAnnotation | null {
    if (!isRecord(value)) {
        return null;
    }

    if (value.schema !== DRAWN_SHAPE_SCHEMA) {
        return null;
    }

    if (
        typeof value.id !== 'string'
        || typeof value.shapeType !== 'string'
        || typeof value.jsonPath !== 'string'
        || typeof value.sourcePythonFile !== 'string'
        || typeof value.createdAt !== 'string'
        || typeof value.updatedAt !== 'string'
    ) {
        return null;
    }

    if (!isGeometry(value.geometry) || !isMeta(value.meta) || !isAnnotationProvenance(value.provenance)) {
        return null;
    }

    return {
        schema: DRAWN_SHAPE_SCHEMA,
        id: value.id,
        shapeType: sanitizeShapeType(value.shapeType),
        jsonPath: value.jsonPath,
        sourcePythonFile: value.sourcePythonFile,
        geometry: value.geometry,
        meta: value.meta,
        provenance: value.provenance,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

function isGeometry(value: unknown): value is DrawnShapePayload['geometry'] {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return false;
    }
    if (!Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every((item) => typeof item === 'number')) {
        return false;
    }
    if (value.center !== undefined && (!Array.isArray(value.center) || value.center.length !== 2 || !value.center.every((item) => typeof item === 'number'))) {
        return false;
    }
    if (value.radius !== undefined && typeof value.radius !== 'number') {
        return false;
    }
    return true;
}

function isMeta(value: unknown): value is DrawnShapePayload['meta'] {
    if (!isRecord(value)) {
        return false;
    }

    if ('area_um2' in value && value.area_um2 !== undefined && typeof value.area_um2 !== 'number') {
        return false;
    }

    if ('vertex_count' in value && value.vertex_count !== undefined && typeof value.vertex_count !== 'number') {
        return false;
    }

    return true;
}

function isAnnotationProvenance(value: unknown): value is AnnotationProvenance {
    return isRecord(value)
        && typeof value.file === 'string'
        && typeof value.line === 'number'
        && typeof value.function === 'string'
        && typeof value.cell === 'string'
        && typeof value.source_text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseAnnotationFilename(filename: string): { base: string; shape: string; index: number } | null {
    const match = ANNOTATION_FILENAME_RE.exec(filename);
    if (!match?.groups) {
        return null;
    }

    const index = Number.parseInt(match.groups.index, 10);
    if (!Number.isInteger(index) || index < 1) {
        return null;
    }

    return {
        base: match.groups.base,
        shape: match.groups.shape,
        index,
    };
}

function normalizePath(filePath: string): string {
    return path.resolve(filePath);
}
