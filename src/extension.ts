import * as vscode from 'vscode';
import { AdoTreeProvider, AdoTreeItem } from './tree/AdoTreeProvider';
import { Settings, QueryDefinition } from './config/Settings';
import { WorkItemNode, QueryNode } from './grouping/GroupingEngine';

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

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.refresh', () => {
            treeProvider?.forceRefresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.expandAll', async () => {
            if (!treeProvider || !treeView) return;
            
            // Get all top-level items and recursively expand them
            const topItems = await treeProvider.getChildren();
            for (const item of topItems) {
                await expandItemRecursively(item);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setQueryFromClipboard', async () => {
            const clipboardText = await vscode.env.clipboard.readText();
            
            if (!clipboardText) {
                vscode.window.showWarningMessage('Clipboard is empty');
                return;
            }

            // Try to extract query info from clipboard
            const parsed = extractQueryInfoFromUrl(clipboardText.trim());
            
            // Ask for a name for this query
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a display name for this query',
                placeHolder: 'e.g., Sprint Tasks, My Bugs, etc.',
                value: 'New Query'
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

            // Add to existing queries
            const existingQueries = Settings.queries;
            const updatedQueries = [...existingQueries, newQuery];
            
            await vscode.workspace.getConfiguration('adoQueries').update(
                'queries', 
                updatedQueries, 
                vscode.ConfigurationTarget.Global
            );

            vscode.window.showInformationMessage(`Added query: ${name}`);
            treeProvider?.forceRefresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setQueryManual', async () => {
            // Ask for a name for this query
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

            // Build new query definition with explicit groupBy
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

            // Add to existing queries
            const existingQueries = Settings.queries;
            const updatedQueries = [...existingQueries, newQuery];
            
            await vscode.workspace.getConfiguration('adoQueries').update(
                'queries', 
                updatedQueries, 
                vscode.ConfigurationTarget.Global
            );

            vscode.window.showInformationMessage(`Added query: ${name}`);
            treeProvider?.forceRefresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.setGroupBy', async () => {
            // Open settings UI for the groupBy configuration
            vscode.commands.executeCommand('workbench.action.openSettings', 'adoQueries.groupBy');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.openWorkItem', async (node: WorkItemNode | AdoTreeItem) => {
            // Handle both direct node and tree item wrapper
            let workItemNode: WorkItemNode | undefined;
            
            if ('type' in node && node.type === 'workItem') {
                workItemNode = node;
            } else if ('node' in node && node.node !== 'configure' && node.node !== 'error' && 
                       node.node !== 'loading' && node.node !== 'empty' && node.node.type === 'workItem') {
                workItemNode = node.node;
            }

            if (workItemNode) {
                await treeProvider?.openWorkItem(workItemNode);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.openQueryInBrowser', (node?: QueryNode | AdoTreeItem) => {
            let queryId: string | undefined;
            let org: string | undefined;
            let project: string | undefined;
            
            // Handle query node passed from context menu
            if (node) {
                if ('type' in node && node.type === 'query') {
                    queryId = node.queryId;
                    org = node.organization;
                    project = node.project;
                } else if ('node' in node && node.node !== 'configure' && node.node !== 'error' && 
                           node.node !== 'loading' && node.node !== 'empty' && node.node.type === 'query') {
                    queryId = node.node.queryId;
                    org = node.node.organization;
                    project = node.node.project;
                }
            }
            
            treeProvider?.openQueryInBrowser(queryId, org, project);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.copyWorkItemId', async (node: WorkItemNode | AdoTreeItem) => {
            let workItemNode: WorkItemNode | undefined;
            
            if ('type' in node && node.type === 'workItem') {
                workItemNode = node;
            } else if ('node' in node && node.node !== 'configure' && node.node !== 'error' && 
                       node.node !== 'loading' && node.node !== 'empty' && node.node.type === 'workItem') {
                workItemNode = node.node;
            }

            if (workItemNode) {
                await treeProvider?.copyWorkItemId(workItemNode);
            }
        })
    );

    // Initial refresh
    treeProvider.refresh();
}

/**
 * Parsed query URL info
 */
interface ParsedQueryUrl {
    organization?: string;
    project?: string;
    queryId?: string;
}

/**
 * Extract query info from an ADO URL
 * Examples:
 * - https://dev.azure.com/org/project/_queries/query/12345678-1234-1234-1234-123456789012
 * - https://org.visualstudio.com/project/_queries/query/12345678-1234-1234-1234-123456789012
 */
function extractQueryInfoFromUrl(text: string): ParsedQueryUrl {
    // Pattern for dev.azure.com URLs
    const devAzurePattern = /https?:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_queries\/query(?:-edit)?\/([0-9a-fA-F-]{36})/i;
    // Pattern for org.visualstudio.com URLs
    const vstsPattern = /https?:\/\/([^\.]+)\.visualstudio\.com\/([^\/]+)\/_queries\/query(?:-edit)?\/([0-9a-fA-F-]{36})/i;
    
    let match = text.match(devAzurePattern);
    if (match) {
        return { organization: match[1], project: decodeURIComponent(match[2]), queryId: match[3] };
    }
    
    match = text.match(vstsPattern);
    if (match) {
        return { organization: match[1], project: decodeURIComponent(match[2]), queryId: match[3] };
    }
    
    // Just a GUID
    const guidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (guidPattern.test(text.trim())) {
        return { queryId: text.trim() };
    }
    
    return {};
}

/**
 * Recursively expand a tree item and all its children
 */
async function expandItemRecursively(item: AdoTreeItem): Promise<void> {
    if (!treeView || !treeProvider) return;
    
    // Only expand if it has children
    const node = item.node;
    if (node === 'configure' || node === 'error' || node === 'loading' || node === 'empty') {
        return;
    }
    
    if (node.type === 'workItem') {
        return; // Leaf node, nothing to expand
    }
    
    // Reveal this item with expand=true
    try {
        await treeView.reveal(item, { expand: true, select: false, focus: false });
        
        // Get children and expand them too
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
