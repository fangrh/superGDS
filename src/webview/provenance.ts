export interface SourceLocation {
    file: string;
    line: number;
    functionName?: string;
    loop_index?: number[];
    array_index?: number[];
}

export interface ComponentProvenance {
    file?: string;
    line?: number | string;
    function?: string;
    class_name?: string;
    loop_index?: number[];
    array_index?: number[];
    call_chain?: Array<{ file?: string; line?: number | string; function?: string }>;
    call_stack?: string[];
    cell?: string;
    instance_name?: string;
    area_um2?: number;
    source_text?: string;
    ports?: Array<{ name: string; center?: number[]; orientation?: number }>;
}

export interface ComponentSelection {
    provId: string;
    layer: string;
    bbox: number[];
    provenance: ComponentProvenance;
}

export function getSourceChain(component: ComponentSelection): SourceLocation[] {
    const provenance = component.provenance || {};
    const locations: SourceLocation[] = [];

    addLocation(locations, {
        file: provenance.file,
        line: provenance.line,
        functionName: provenance.function,
        loop_index: provenance.loop_index,
        array_index: provenance.array_index,
    });

    const primaryFile = normalizeFile(provenance.file);
    const primaryLine = normalizeLine(provenance.line);

    if (Array.isArray(provenance.call_chain)) {
        for (const frame of provenance.call_chain) {
            if (normalizeFile(frame.file) === primaryFile && normalizeLine(frame.line) === primaryLine) continue;
            addLocation(locations, {
                file: frame.file,
                line: frame.line,
                functionName: frame.function,
            });
        }
    }

    if (Array.isArray(provenance.call_stack)) {
        for (const frame of provenance.call_stack) {
            const parsed = parseCallStackFrame(frame);
            if (normalizeFile(parsed.file) === primaryFile && normalizeLine(parsed.line) === primaryLine) continue;
            addLocation(locations, parsed);
        }
    }

    return locations;
}

export function formatSelectionForOutput(components: ComponentSelection[]): string {
    const lines: string[] = [];
    const plural = components.length === 1 ? 'component' : 'components';
    lines.push(`Selected ${components.length} GDS ${plural}`);

    components.forEach((component, index) => {
        const provenance = component.provenance || {};
        const label = provenance.cell || provenance.instance_name || `Component ${index + 1}`;

        lines.push('');
        lines.push(`${index + 1}. ${label}`);
        if (provenance.instance_name && provenance.instance_name !== label) {
            lines.push(`   Instance: ${provenance.instance_name}`);
        }
        if (component.layer) {
            lines.push(`   Layer: ${component.layer}`);
        }
        if (component.bbox && component.bbox.length === 4) {
            lines.push(`   BBox: [${component.bbox.map(formatNumber).join(', ')}]`);
        }
        if (provenance.area_um2 !== undefined) {
            lines.push(`   Area: ${provenance.area_um2} um2`);
        }

        const chain = getSourceChain(component);
        if (chain.length > 0) {
            lines.push('   Source chain:');
            for (const location of chain) {
                const fn = location.functionName ? ` (${location.functionName})` : '';
                const loop = (location === chain[0] && provenance.loop_index)
                    ? formatLoopLabel(provenance)
                    : '';
                lines.push(`   - ${location.file}:${location.line}${fn}${loop}`);
            }
        } else {
            lines.push('   Source chain: unavailable');
        }
    });

    return lines.join('\n');
}

function addLocation(
    locations: SourceLocation[],
    candidate: {
        file?: string;
        line?: number | string;
        functionName?: string;
        loop_index?: number[];
        array_index?: number[];
    }
): void {
    const file = normalizeFile(candidate.file);
    const line = normalizeLine(candidate.line);
    if (!file || line === undefined) {
        return;
    }

    const loop_index = normalizeIndex(candidate.loop_index);
    const array_index = normalizeIndex(candidate.array_index);

    if (locations.some((location) => sameSourceLocation(location, { file, line, loop_index, array_index }))) {
        return;
    }

    const location: SourceLocation = {
        file,
        line,
        functionName: candidate.functionName || undefined,
    };
    if (loop_index) {
        location.loop_index = loop_index;
    }
    if (array_index) {
        location.array_index = array_index;
    }
    locations.push(location);
}

function sameSourceLocation(
    a: SourceLocation,
    b: Pick<SourceLocation, 'file' | 'line' | 'loop_index' | 'array_index'>
): boolean {
    return a.file === b.file
        && a.line === b.line
        && sameIndex(a.loop_index, b.loop_index)
        && sameIndex(a.array_index, b.array_index);
}

function sameIndex(a?: number[], b?: number[]): boolean {
    const left = a || [];
    const right = b || [];
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeIndex(index?: number[]): number[] | undefined {
    return index && index.length > 0 ? index : undefined;
}

function normalizeFile(file?: string): string | undefined {
    const normalized = file?.replace(/\\/g, '/').trim();
    return normalized || undefined;
}

function normalizeLine(line?: number | string): number | undefined {
    const parsed = typeof line === 'number' ? line : Number.parseInt(String(line || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCallStackFrame(frame: string): { file?: string; line?: number; functionName?: string } {
    const match = frame.match(/^(.+?):(\d+)\s+in\s+(.+)$/);
    if (!match) {
        return {};
    }

    return {
        file: match[1],
        line: Number.parseInt(match[2], 10),
        functionName: match[3],
    };
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toFixed(4) : String(value);
}

export function filterLocationsByFile(
    locations: SourceLocation[],
    primaryFile: string,
    resolvePath: (f: string) => string
): SourceLocation[] {
    const normalized = resolvePath(primaryFile).replace(/\\/g, '/');
    return locations.filter(
        (loc) => resolvePath(loc.file).replace(/\\/g, '/') === normalized
    );
}

export function getSelectionSourceLocations(components: ComponentSelection[]): SourceLocation[] {
    const byFile = new Map<string, SourceLocation[]>();

    for (const component of components) {
        for (const location of getSourceChain(component)) {
            const existing = byFile.get(location.file) || [];
            if (!existing.some((item) => item.line === location.line)) {
                existing.push(location);
            }
            byFile.set(location.file, existing);
        }
    }

    return Array.from(byFile.values()).flatMap((locations) =>
        locations.sort((a, b) => a.line - b.line)
    );
}

export function formatMentions(
    locations: SourceLocation[],
    formatFile: (file: string) => string = (file) => file
): string {
    return locations
        .map((loc) => `@${formatFile(loc.file)}:${loc.line}${formatSourceLocationIndexLabel(loc)}`)
        .join(' ');
}

export function formatLoopLabel(provenance: ComponentProvenance): string {
    if (provenance.array_index && provenance.array_index.length > 0) {
        return ` (array index [${provenance.array_index.join(', ')}])`;
    }
    if (provenance.loop_index && provenance.loop_index.length > 0) {
        return ` (loop index [${provenance.loop_index.join(', ')}])`;
    }
    return '';
}

export function formatSourceLocationIndexLabel(location: SourceLocation): string {
    const parts: string[] = [];
    if (location.loop_index && location.loop_index.length > 0) {
        parts.push(`(loop index [${location.loop_index.join(', ')}])`);
    }
    if (location.array_index && location.array_index.length > 0) {
        parts.push(`(array index [${location.array_index.join(', ')}])`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
