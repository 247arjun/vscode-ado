import * as vscode from 'vscode';
import { AdoTreeProvider, AdoTreeItem } from './tree/AdoTreeProvider';
import { Settings, QueryDefinition } from './config/Settings';
import { WorkItemNode, QueryNode } from './grouping/GroupingEngine';
import { extractQueryInfoFromUrl } from './utils/urlParser';

let treeProvider: AdoTreeProvider | undefined;
let treeView: vscode.TreeView<AdoTreeItem> | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Azure DevOps Queries extension is now active');

    // Create the tree provider
    treeProvider = new AdoTreeProvider();

    // Register the tree view
    treeView = vscode.window.createTreeView('adoQueries.results', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(treeView);

    // ── Refresh commands ─────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.refresh', () => {
            treeProvider?.forceRefresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.refreshQuery', async (node?: QueryNode | AdoTreeItem) => {
            if (!treeProvider) return;

            const queryNode = extractQueryNode(node);
            if (queryNode) {
                const index = treeProvider.findQueryIndex(queryNode);
                if (index >= 0) {
                    await treeProvider.refreshSingleQuery(index);
                }
            }
        })
    );

    // ── Expand All ───────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.expandAll', async () => {
            if (!treeProvider || !treeView) return;
            
            const topItems = await treeProvider.getChildren();
            for (const item of topItems) {
                await expandItemRecursively(item);
            }
        })
    );

    // ── Add Query from Clipboard ─────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setQueryFromClipboard', async () => {
            const clipboardText = await vscode.env.clipboard.readText();
            
            if (!clipboardText) {
                vscode.window.showWarningMessage('Clipboard is empty');
                return;
            }

            // Try to extract query info from clipboard
            const parsed = extractQueryInfoFromUrl(clipboardText.trim());
            
            // Try to auto-fetch query name from ADO if we have a queryId
            let defaultName = 'New Query';
            if (parsed.queryId && treeProvider) {
                const adoClient = treeProvider.getAdoClient();
                const metadata = await adoClient.fetchQueryMetadata(
                    parsed.queryId,
                    parsed.organization,
                    parsed.project
                );
                if (metadata?.name) {
                    defaultName = metadata.name;
                }
            }

            // Ask for a name for this query
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a display name for this query',
                placeHolder: 'e.g., Sprint Tasks, My Bugs, etc.',
                value: defaultName
            });

            if (!name) {
                return;
            }

            // Build new query definition
            const newQuery: QueryDefinition = { name };
            
            // Set org/project if parsed from URL
            if (parsed.organization) {
                newQuery.organization = parsed.organization;
            }
            if (parsed.project) {
                newQuery.project = parsed.project;
            }
            
            // Set default groupBy explicitly so it's visible in settings
            newQuery.groupBy = [
                { field: 'System.State', missingLabel: '(no state)' }
            ];
            
            if (parsed.queryId) {
                newQuery.queryId = parsed.queryId;
            } else {
                // Ask how to interpret the clipboard content
                const choice = await vscode.window.showQuickPick([
                    { label: 'Query ID', description: 'Treat as a query GUID' },
                    { label: 'Query Path', description: 'Treat as a query path (e.g., Shared Queries/My Query)' }
                ], {
                    placeHolder: 'How should the clipboard content be interpreted?'
                });

                if (choice?.label === 'Query ID') {
                    newQuery.queryId = clipboardText.trim();
                } else if (choice?.label === 'Query Path') {
                    newQuery.queryPath = clipboardText.trim();
                } else {
                    return;
                }
            }

            // Add to existing queries, respecting scope
            await addQueryToSettings(newQuery);

            vscode.window.showInformationMessage(`Added query: ${name}`);
            treeProvider?.forceRefresh();
        })
    );

    // ── Add Query Manually ───────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setQueryManual', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a display name for this query',
                placeHolder: 'e.g., Sprint Tasks, My Bugs, etc.'
            });

            if (!name) return;

            const choice = await vscode.window.showQuickPick([
                { label: 'Query ID', description: 'Enter a query GUID' },
                { label: 'Query Path', description: 'Enter a query path' }
            ], {
                placeHolder: 'What type of query identifier?'
            });

            if (!choice) return;

            const value = await vscode.window.showInputBox({
                prompt: `Enter the ${choice.label}`,
                placeHolder: choice.label === 'Query ID' 
                    ? 'e.g., 12345678-1234-1234-1234-123456789012'
                    : 'e.g., Shared Queries/My Team/Active Bugs'
            });

            if (!value) return;

            const newQuery: QueryDefinition = { 
                name,
                groupBy: [
                    { field: 'System.State', missingLabel: '(no state)' }
                ]
            };
            if (choice.label === 'Query ID') {
                newQuery.queryId = value;
            } else {
                newQuery.queryPath = value;
            }

            await addQueryToSettings(newQuery);

            vscode.window.showInformationMessage(`Added query: ${name}`);
            treeProvider?.forceRefresh();
        })
    );

    // ── Remove Query ─────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.removeQuery', async (node?: QueryNode | AdoTreeItem) => {
            const queryNode = extractQueryNode(node);
            if (!queryNode) return;

            const confirm = await vscode.window.showWarningMessage(
                `Remove query "${queryNode.name}"?`,
                { modal: true },
                'Remove'
            );

            if (confirm !== 'Remove') return;

            const config = vscode.workspace.getConfiguration('adoQueries');
            const queries = [...(config.get<QueryDefinition[]>('queries') ?? [])];
            const index = queries.findIndex(q => 
                q.name === queryNode.name && 
                (q.queryId === queryNode.queryId || q.queryPath === queryNode.queryPath)
            );
            
            if (index >= 0) {
                queries.splice(index, 1);
                await config.update('queries', queries, getSettingsTarget());
                vscode.window.showInformationMessage(`Removed query: ${queryNode.name}`);
                treeProvider?.forceRefresh();
            }
        })
    );

    // ── Rename Query ─────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.renameQuery', async (node?: QueryNode | AdoTreeItem) => {
            const queryNode = extractQueryNode(node);
            if (!queryNode) return;

            const newName = await vscode.window.showInputBox({
                prompt: 'Enter new name for this query',
                value: queryNode.name
            });

            if (!newName || newName === queryNode.name) return;

            const config = vscode.workspace.getConfiguration('adoQueries');
            const queries = [...(config.get<QueryDefinition[]>('queries') ?? [])];
            const index = queries.findIndex(q => 
                q.name === queryNode.name && 
                (q.queryId === queryNode.queryId || q.queryPath === queryNode.queryPath)
            );
            
            if (index >= 0) {
                queries[index] = { ...queries[index], name: newName };
                await config.update('queries', queries, getSettingsTarget());
                treeProvider?.forceRefresh();
            }
        })
    );

    // ── Configure Grouping ───────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setGroupBy', async () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'adoQueries.groupBy');
        })
    );

    // ── Open Work Item ───────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.openWorkItem', async (node: WorkItemNode | AdoTreeItem) => {
            const workItemNode = extractWorkItemNode(node);
            if (workItemNode) {
                await treeProvider?.openWorkItem(workItemNode);
            }
        })
    );

    // ── Open Query in Browser ────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.openQueryInBrowser', (node?: QueryNode | AdoTreeItem) => {
            const queryNode = extractQueryNode(node);
            treeProvider?.openQueryInBrowser(
                queryNode?.queryId,
                queryNode?.organization,
                queryNode?.project
            );
        })
    );

    // ── Copy Commands ────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.copyWorkItemId', async (node: WorkItemNode | AdoTreeItem) => {
            const workItemNode = extractWorkItemNode(node);
            if (workItemNode) {
                await treeProvider?.copyWorkItemId(workItemNode);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.copyWorkItemUrl', async (node: WorkItemNode | AdoTreeItem) => {
            const workItemNode = extractWorkItemNode(node);
            if (workItemNode) {
                await treeProvider?.copyWorkItemUrl(workItemNode);
            }
        })
    );

    // ── Show Output Channel ──────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.showOutput', () => {
            treeProvider?.showOutputChannel();
        })
    );

    // Initial refresh
    treeProvider.refresh();
}

// ─── Helper functions ────────────────────────────────────────────────

/**
 * Determine the appropriate settings target (workspace if available, else global)
 */
function getSettingsTarget(): vscode.ConfigurationTarget {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        // Check if there's already workspace-level config
        const config = vscode.workspace.getConfiguration('adoQueries');
        const inspect = config.inspect<QueryDefinition[]>('queries');
        if (inspect?.workspaceValue !== undefined) {
            return vscode.ConfigurationTarget.Workspace;
        }
    }
    return vscode.ConfigurationTarget.Global;
}

/**
 * Add a query to settings, using the appropriate scope
 */
async function addQueryToSettings(newQuery: QueryDefinition): Promise<void> {
    const config = vscode.workspace.getConfiguration('adoQueries');
    const existingQueries = config.get<QueryDefinition[]>('queries') ?? [];
    const updatedQueries = [...existingQueries, newQuery];
    await config.update('queries', updatedQueries, getSettingsTarget());
}

/**
 * Extract a QueryNode from various node types
 */
function extractQueryNode(node?: QueryNode | AdoTreeItem): QueryNode | undefined {
    if (!node) return undefined;
    
    if ('type' in node && node.type === 'query') {
        return node;
    }
    if ('node' in node && node.node !== 'configure' && node.node !== 'error' && 
        node.node !== 'loading' && node.node !== 'empty' && node.node.type === 'query') {
        return node.node;
    }
    return undefined;
}

/**
 * Extract a WorkItemNode from various node types
 */
function extractWorkItemNode(node?: WorkItemNode | AdoTreeItem): WorkItemNode | undefined {
    if (!node) return undefined;

    if ('type' in node && node.type === 'workItem') {
        return node as WorkItemNode;
    }
    if ('node' in node && node.node !== 'configure' && node.node !== 'error' && 
        node.node !== 'loading' && node.node !== 'empty' && node.node.type === 'workItem') {
        return node.node;
    }
    return undefined;
}

/**
 * Recursively expand a tree item and all its children
 */
async function expandItemRecursively(item: AdoTreeItem): Promise<void> {
    if (!treeView || !treeProvider) return;
    
    const node = item.node;
    if (node === 'configure' || node === 'error' || node === 'loading' || node === 'empty') {
        return;
    }
    
    if (node.type === 'workItem') {
        return; // Leaf node, nothing to expand
    }
    
    try {
        await treeView.reveal(item, { expand: true, select: false, focus: false });
        
        const children = await treeProvider.getChildren(item);
        for (const child of children) {
            await expandItemRecursively(child);
        }
    } catch {
        // Item might not be visible yet, ignore
    }
}

export function deactivate() {
    if (treeProvider) {
        treeProvider.dispose();
        treeProvider = undefined;
    }
}
