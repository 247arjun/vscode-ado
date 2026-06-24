import * as vscode from 'vscode';
import * as path from 'path';
import { AdoTreeProvider, AdoTreeItem } from './tree/AdoTreeProvider';
import { Settings, QueryDefinition } from './config/Settings';
import { WorkItemNode, QueryNode } from './grouping/GroupingEngine';
import { extractQueryInfoFromUrl } from './utils/urlParser';
import { AzCliRunner } from './ado/AzCliRunner';
import { AdoClient } from './ado/AdoClient';
import { AdoRestClient } from './ado/AdoRestClient';
import { Database } from './db/Database';
import { DatabaseDataStore } from './db/DatabaseDataStore';
import { TokenProvider } from './auth/TokenProvider';
import { SyncEngine, SyncStatus } from './sync/SyncEngine';
import { NavigatorProvider } from './views/NavigatorProvider';
import { WorkbenchHost } from './views/WorkbenchHost';
import { ViewModelBuilder } from './views/ViewModelBuilder';
import { ViewId } from './views/protocol';
import { TagRepository } from './db/repositories/TagRepository';
import { ProjectRepository } from './db/repositories/ProjectRepository';
import { UndoStack } from './undo/UndoStack';
import { parseQuickEntry } from './views/quickEntry';

let treeProvider: AdoTreeProvider | undefined;
let treeView: vscode.TreeView<AdoTreeItem> | undefined;
let database: Database | undefined;
let dataStore: DatabaseDataStore | undefined;
let tokenProvider: TokenProvider | undefined;
let syncEngine: SyncEngine | undefined;
let syncStatusBar: vscode.StatusBarItem | undefined;
let navigatorProvider: NavigatorProvider | undefined;
let workbench: WorkbenchHost | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Azure DevOps Queries extension is now active');

    // ── Local database (source of truth for the UI) ──────────────────
    const outputChannel = vscode.window.createOutputChannel('Azure DevOps Queries');
    const dbPath = path.join(context.globalStorageUri.fsPath, 'adothings.json');
    database = await Database.open(dbPath);
    outputChannel.appendLine(`[${new Date().toISOString()}] Local DB ready (schema v${database.schemaVersion}) at ${dbPath}`);

    const cliRunner = new AzCliRunner();
    const adoClient = new AdoClient(cliRunner, outputChannel);

    // ── Auth + REST transport (no PAT, no app registration) ──────────
    tokenProvider = new TokenProvider(cliRunner);
    context.subscriptions.push({ dispose: () => tokenProvider?.dispose() });
    const restClient = new AdoRestClient(tokenProvider);
    dataStore = new DatabaseDataStore(database, adoClient, restClient);

    // ── Sync engine (pull) + status bar ──────────────────────────────
    syncEngine = new SyncEngine(database, restClient, outputChannel, async (info) => {
        const choice = await vscode.window.showWarningMessage(
            `Conflict on #${info.adoId}: you set ${info.field.split('.').pop()} = "${String(info.mine)}", but ADO now has "${String(info.theirs)}".`,
            { modal: true },
            'Keep Mine',
            'Keep Theirs'
        );
        return choice === 'Keep Mine' ? 'mine' : 'theirs';
    });
    context.subscriptions.push({ dispose: () => syncEngine?.dispose() });
    syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    syncStatusBar.command = 'adoQueries.refresh';
    context.subscriptions.push(syncStatusBar);
    syncEngine.onDidChangeStatus((s) => updateSyncStatusBar(s));
    updateSyncStatusBar(syncEngine.status);

    // Reflect sign-in state in a context key (drives the welcome CTA).
    const refreshAuthContext = async () => {
        const signedIn = (await tokenProvider?.isSignedIn()) ?? false;
        await vscode.commands.executeCommand('setContext', 'adoQueries.signedIn', signedIn);
    };
    tokenProvider.onDidChangeAuth(() => { void refreshAuthContext(); });
    void refreshAuthContext();

    // Sign-in command (interactive).
    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.signIn', async () => {
            const ok = await tokenProvider?.signIn();
            if (ok) {
                vscode.window.showInformationMessage('Signed in to Azure DevOps.');
                treeProvider?.forceRefresh();
            } else {
                vscode.window.showWarningMessage('Azure DevOps sign-in was canceled or failed.');
            }
        })
    );

    // Background pull on activation (after first paint) and on focus.
    const runPull = () => { void syncEngine?.pull(Settings.getActiveQueries()); };
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((st) => { if (st.focused) runPull(); })
    );

    // Create the tree provider, reading through the DB-backed store
    treeProvider = new AdoTreeProvider({ adoClient, dataStore });

    // Register the tree view
    treeView = vscode.window.createTreeView('adoQueries.results', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(treeView);

    // ── Phase 4: Things-style navigator + workbench ──────────────────
    const taskRepo = dataStore.taskRepository;
    const workItemRepo = dataStore.workItemRepository;
    const tagRepo = new TagRepository(database);
    const projectRepo = new ProjectRepository(database, taskRepo);
    const undoStack = new UndoStack();
    const vmBuilder = new ViewModelBuilder(taskRepo, workItemRepo, tagRepo);

    navigatorProvider = new NavigatorProvider(taskRepo, projectRepo);
    const navView = vscode.window.createTreeView('adoThings.navigator', {
        treeDataProvider: navigatorProvider
    });
    context.subscriptions.push(navView);

    workbench = new WorkbenchHost(context.extensionUri, taskRepo, vmBuilder, {
        onChangeState: (uuid) => changeStateForTask(uuid),
        onOpenWorkItem: async (adoId) => {
            const url = await dataStore?.getWorkItemUrl(adoId);
            if (url) { void vscode.env.openExternal(vscode.Uri.parse(url)); }
        },
        onDataChanged: () => navigatorProvider?.refresh()
    }, tagRepo, undoStack);
    context.subscriptions.push({ dispose: () => workbench?.dispose() });

    // Sync status feeds both the workbench banner and the navigator counts.
    syncEngine.onDidChangeStatus((s) => {
        workbench?.setSyncStatus({ phase: s.phase, pendingCount: s.pendingCount, lastSyncedUtc: s.lastSyncedUtc });
        navigatorProvider?.refresh();
        workbench?.postSnapshot();
    });

    // Change a linked task's ADO state via quick-pick, then enqueue to outbox.
    const changeStateForTask = async (uuid: string): Promise<void> => {
        const task = taskRepo.getByUuid(uuid);
        if (!task?.adoId) {
            vscode.window.showInformationMessage('This task is local-only (no Azure DevOps work item).');
            return;
        }
        const wi = workItemRepo.getById(task.adoId);
        const witType = wi?.type;
        if (!witType) {
            vscode.window.showWarningMessage('Work item type is unknown — cannot determine valid states.');
            return;
        }
        const states = await adoClient.fetchWorkItemTypeStates(witType, wi?.org, wi?.project);
        const items = states.filter(s => s.name !== wi?.state).map(s => ({ label: s.name, description: s.category ?? '' }));
        if (items.length === 0) {
            vscode.window.showInformationMessage(`No other states available for "${witType}".`);
            return;
        }
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Change #${task.adoId} from "${wi?.state}" to...`
        });
        if (!picked) return;
        await syncEngine?.enqueueStateChange(task.adoId, picked.label);
    };

    // Open the workbench focused on a given list.
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.openList', (view?: ViewId) => {
            workbench?.openView(view ?? 'today');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.open', () => {
            workbench?.openView('today');
        })
    );

    // Quick capture: type a title -> lands in Inbox. Works from anywhere.
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.quickCapture', async () => {
            const title = await vscode.window.showInputBox({
                prompt: 'New To-Do',
                placeHolder: 'What do you need to do? (try "#tag" or "tomorrow")'
            });
            if (title && title.trim()) {
                const parsed = parseQuickEntry(title.trim());
                const task = taskRepo.createLocal(parsed.title || title.trim(), 'inbox');
                if (parsed.whenDate) taskRepo.setWhen(task.uuid, parsed.whenDate);
                if (parsed.tags.length > 0) {
                    taskRepo.setTags(task.uuid, parsed.tags.map(n => tagRepo.getOrCreate(n).id));
                }
                undoStack.push('Add task', () => taskRepo.remove(task.uuid));
                navigatorProvider?.refresh();
                workbench?.postSnapshot();
                vscode.window.setStatusBarMessage(`Added to Inbox: ${parsed.title || title.trim()}`, 2000);
            }
        })
    );

    // Undo the most recent local change.
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.undo', () => {
            const label = undoStack.undo();
            if (label) {
                navigatorProvider?.refresh();
                workbench?.postSnapshot();
                vscode.window.setStatusBarMessage(`Undid: ${label}`, 2000);
            } else {
                vscode.window.setStatusBarMessage('Nothing to undo', 1500);
            }
        })
    );

    // Create a project / area.
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.newProject', async () => {
            const name = await vscode.window.showInputBox({ prompt: 'New project name' });
            if (name && name.trim()) {
                projectRepo.createProject(name.trim());
                navigatorProvider?.refresh();
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.newArea', async () => {
            const name = await vscode.window.showInputBox({ prompt: 'New area name' });
            if (name && name.trim()) {
                projectRepo.createArea(name.trim());
                navigatorProvider?.refresh();
            }
        })
    );

    // ── Phase 6: hardening — reset DB + overdue notifications ─────────
    context.subscriptions.push(
        vscode.commands.registerCommand('adoThings.resetDatabase', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Reset the local ADO Things database? All local tasks, tags, projects, and cached items will be permanently deleted. This cannot be undone.',
                { modal: true },
                'Reset'
            );
            if (confirm === 'Reset') {
                database?.reset();
                undoStack.clear();
                navigatorProvider?.refresh();
                workbench?.postSnapshot();
                treeProvider?.forceRefresh();
                vscode.window.showInformationMessage('Local database has been reset.');
            }
        })
    );

    // Notify once per day about overdue items.
    const notifyOverdue = () => {
        const overdue = taskRepo.getOverdue();
        if (overdue.length === 0) return;
        const todayKey = new Date().toISOString().slice(0, 10);
        const lastNotified = context.globalState.get<string>('adoThings.lastOverdueNotice');
        if (lastNotified === todayKey) return;
        void context.globalState.update('adoThings.lastOverdueNotice', todayKey);
        void vscode.window.showWarningMessage(
            `You have ${overdue.length} overdue ${overdue.length === 1 ? 'task' : 'tasks'}.`,
            'Show Today'
        ).then(choice => {
            if (choice === 'Show Today') workbench?.openView('today');
        });
    };

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

    // ── Change State ─────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('adoQueries.changeState', async (node?: WorkItemNode | AdoTreeItem) => {
            if (!treeProvider) return;

            const workItemNode = extractWorkItemNode(node);
            if (!workItemNode) return;

            const adoClient = treeProvider.getAdoClient();

            // Find the parent query to get org/project context
            const parentQuery = treeProvider.findParentQuery(workItemNode.id);
            const org = parentQuery?.organization;
            const project = parentQuery?.project;

            // Get the work item type – required to look up valid states
            const witType = workItemNode.workItemType;
            if (!witType) {
                vscode.window.showWarningMessage('Work item type is unknown — cannot determine valid states.');
                return;
            }

            // Fetch valid states for this work item type
            const states = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Loading states...' },
                () => adoClient.fetchWorkItemTypeStates(witType, org, project)
            );

            if (states.length === 0) {
                vscode.window.showWarningMessage(`Could not fetch states for type "${witType}".`);
                return;
            }

            // Build QuickPick items, excluding the current state
            const currentState = workItemNode.state;
            const items = states
                .filter(s => s.name !== currentState)
                .map(s => ({
                    label: s.name,
                    description: s.category ?? ''
                }));

            if (items.length === 0) {
                vscode.window.showInformationMessage(`No other states available for "${witType}".`);
                return;
            }

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `Change #${workItemNode.id} from "${currentState}" to...`,
                title: `Change State — #${workItemNode.id} ${workItemNode.title}`
            });

            if (!picked) return;

            // Optimistic local update + enqueue to the outbox (Phase 3). The DB
            // reflects the change immediately; the push (with conflict handling)
            // happens in the background via the sync engine.
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Updating #${workItemNode.id}...` },
                async () => {
                    await syncEngine?.enqueueStateChange(workItemNode.id, picked.label);
                }
            );

            vscode.window.showInformationMessage(`#${workItemNode.id} → ${picked.label}`);

            // Refresh the parent query to reflect the change
            if (parentQuery) {
                const index = treeProvider.findQueryIndex(parentQuery);
                if (index >= 0) {
                    dataStore?.clearCacheForQuery({
                        name: parentQuery.name,
                        queryId: parentQuery.queryId,
                        queryPath: parentQuery.queryPath,
                        organization: org,
                        project
                    });
                    await treeProvider.refreshSingleQuery(index);
                }
            }
        })
    );

    // Initial refresh
    treeProvider.refresh();
    // Background pull (non-blocking) once the view is up.
    runPull();
    // Surface overdue items shortly after startup.
    setTimeout(notifyOverdue, 1500);
}

// ─── Helper functions ────────────────────────────────────────────────

/**
 * Render the sync engine status into the dedicated status bar item.
 */
function updateSyncStatusBar(status: SyncStatus): void {
    if (!syncStatusBar) return;
    switch (status.phase) {
        case 'syncing':
            syncStatusBar.text = '$(sync~spin) ADO: syncing…';
            break;
        case 'offline':
            syncStatusBar.text = '$(cloud-offline) ADO: offline';
            break;
        case 'error':
            syncStatusBar.text = '$(warning) ADO: sync issue';
            break;
        default: {
            const when = status.lastSyncedUtc ? new Date(status.lastSyncedUtc).toLocaleTimeString() : 'never';
            const pending = status.pendingCount > 0 ? ` · ${status.pendingCount} pending` : '';
            syncStatusBar.text = `$(check) ADO: synced ${when}${pending}`;
        }
    }
    syncStatusBar.tooltip = status.message ?? 'Azure DevOps sync';
    syncStatusBar.show();
}

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
    if (database) {
        database.close();
        database = undefined;
    }
}
