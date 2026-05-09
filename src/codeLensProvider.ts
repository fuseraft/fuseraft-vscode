import * as vscode from 'vscode';

export class FuseraftCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const text = document.getText();
        if (!isFuseraftConfig(text)) { return []; }

        const firstLine = new vscode.Range(0, 0, 0, 0);
        return [
            new vscode.CodeLens(firstLine, {
                title: '$(play) Run Task',
                command: 'fuseraft.runFromConfig',
                arguments: [document.uri.fsPath],
            }),
            new vscode.CodeLens(firstLine, {
                title: '$(check) Validate',
                command: 'fuseraft.validate',
                arguments: [document.uri.fsPath],
            }),
            new vscode.CodeLens(firstLine, {
                title: '$(type-hierarchy) Diagram',
                command: 'fuseraft.validateDiagram',
                arguments: [document.uri.fsPath],
            }),
        ];
    }
}

export function isFuseraftConfig(content: string): boolean {
    return /^Orchestration:/m.test(content) || /"Orchestration"\s*:/.test(content);
}
