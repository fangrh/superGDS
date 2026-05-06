import * as vscode from 'vscode';

interface ComponentProvenance {
    file?: string;
    function?: string;
    line?: number | string;
    class_name?: string;
    call_index?: number;
    call_chain?: Array<{ file: string; function: string; line: number }>;
    cell?: string;
    instance_name?: string;
    layer?: string;
    bbox?: number[];
    area_um2?: number;
}

export async function askClaude(
    components: ComponentProvenance[],
    userQuestion: string
): Promise<void> {
    const prompt = buildPrompt(components, userQuestion);

    try {
        await vscode.commands.executeCommand(
            'claude-vscode.primaryEditor.open',
            null,
            prompt
        );
    } catch {
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(
            'Claude Code extension not found. Provenance context copied to clipboard.'
        );
    }
}

function buildPrompt(components: ComponentProvenance[], question: string): string {
    const lines: string[] = [];
    lines.push('## Selected GDS Components');
    lines.push('');

    const seenCallChain = new Set<string>();

    components.forEach((prov, idx) => {
        const label = prov.cell || prov.instance_name || `Component ${idx + 1}`;
        const layerInfo = prov.layer ? ` (${prov.layer})` : '';

        lines.push(`### ${label}${layerInfo}`);

        if (prov.file && prov.line) {
            lines.push(`- Source: ${prov.file}:${prov.line} in \`${prov.function || '<module>'}\``);
        }
        if (prov.class_name) {
            lines.push(`- Class: ${prov.class_name}`);
        }
        if (prov.bbox && prov.bbox.length === 4) {
            lines.push(`- BBox: [(${prov.bbox[0].toFixed(4)}, ${prov.bbox[1].toFixed(4)}), (${prov.bbox[2].toFixed(4)}, ${prov.bbox[3].toFixed(4)})]`);
        }
        if (prov.area_um2 !== undefined) {
            lines.push(`- Area: ${prov.area_um2} um²`);
        }

        const chain = prov.call_chain || [];
        if (chain.length > 0) {
            lines.push('- Call chain:');
            chain.forEach((cc) => {
                const key = `${cc.file}:${cc.line}`;
                if (!seenCallChain.has(key)) {
                    seenCallChain.add(key);
                    const fn = cc.function ? ` (${cc.function})` : '';
                    lines.push(`  - ${cc.file}:${cc.line}${fn}`);
                }
            });
        }
        lines.push('');
    });

    lines.push('---');
    lines.push('');
    lines.push(question);

    return lines.join('\n');
}
