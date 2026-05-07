export interface SourceLocation {
    file: string;
    line: number;
    functionName?: string;
}

export interface ComponentProvenance {
    file?: string;
    line?: number | string;
    function?: string;
    class_name?: string;
    call_index?: number;
    call_chain?: Array<{ file?: string; line?: number | string; function?: string }>;
    call_stack?: string[];
    cell?: string;
    instance_name?: string;
    area_um2?: number;
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
    });

    if (Array.isArray(provenance.call_chain)) {
        for (const frame of provenance.call_chain) {
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
                lines.push(`   - ${location.file}:${location.line}${fn}`);
            }
        } else {
            lines.push('   Source chain: unavailable');
        }
    });

    return lines.join('\n');
}

function addLocation(
    locations: SourceLocation[],
    candidate: { file?: string; line?: number | string; functionName?: string }
): void {
    const file = normalizeFile(candidate.file);
    const line = normalizeLine(candidate.line);
    if (!file || line === undefined) {
        return;
    }

    if (locations.some((location) => location.file === file && location.line === line)) {
        return;
    }

    locations.push({
        file,
        line,
        functionName: candidate.functionName || undefined,
    });
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

export function formatMentions(locations: SourceLocation[]): string {
    return locations.map((loc) => `@${loc.file}:${loc.line}`).join(' ');
}
