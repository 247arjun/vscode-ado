import * as vscode from 'vscode';
import { AdoClient, WorkItem } from '../ado/AdoClient';
import { AzCliRunner } from '../ado/AzCliRunner';
import { GroupingEngine, TreeNode, GroupNode, WorkItemNode, QueryNode } from '../grouping/GroupingEngine';
import { Settings, QueryDefinition } from '../config/Settings';

/**
 * Tree item for display in VS Code
 */
export class AdoTreeItem extends vscode.TreeItem {
    constructor(
        public readonly node: TreeNode | 'configure' | 'error' | 'loading' | 'empty',
        public readonly message?: string
    ) {
        let label: string;
        let collapsibleState: vscode.TreeItemCollapsibleState;

        if (node === 'configure') {
            label = 'Configure queries in settings...';
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node === 'error') {
            label = message ?? 'Error loading work items';
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node === 'loading') {
            label = 'Loading...';
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node === 'empty') {
            label = 'No work items found';
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node.type === 'query') {
            // Query node (top-level container)
            label = `${node.name} (${node.count})`;
            collapsibleState = node.collapsed 
                ? vscode.TreeItemCollapsibleState.Collapsed 
                : vscode.TreeItemCollapsibleState.Expanded;
        } else if (node.type === 'group') {
            label = `${node.label} (${node.count})`;
            collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        } else {
            // Work item
            label = `#${node.id} ${node.title}`;
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        }

        super(label, collapsibleState);

        if (node === 'configure') {
            this.command = {
                command: 'workbench.action.openSettings',
                title: 'Configure Queries',
                arguments: ['adoQueries.queries']
            };
            this.iconPath = new vscode.ThemeIcon('gear');
        } else if (node === 'error') {
            this.iconPath = new vscode.ThemeIcon('error');
        } else if (node === 'loading') {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
        } else if (node === 'empty') {
            this.iconPath = new vscode.ThemeIcon('info');
        } else if (node.type === 'query') {
            // Query node
            this.contextValue = 'query';
            if (node.error) {
                this.iconPath = new vscode.ThemeIcon('error');
                this.tooltip = node.error;
            } else if (node.loading) {
                this.iconPath = new vscode.ThemeIcon('loading~spin');
            } else {
                this.iconPath = new vscode.ThemeIcon('search');
            }
        } else if (node.type === 'group') {
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'group';
        } else {
            // Work item
            this.contextValue = 'workItem';
            this.tooltip = this.createWorkItemTooltip(node);
            this.iconPath = this.getWorkItemIcon(node);
            
            // Add state as description
            if (node.state) {
                this.description = `[${node.state}]`;
            }

            // Click to open in browser
            this.command = {
                command: 'adoQueries.openWorkItem',
                title: 'Open Work Item',
                arguments: [node]
            };
        }
    }

    private createWorkItemTooltip(node: WorkItemNode): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**#${node.id}** ${node.title}\n\n`);
        
        if (node.workItemType) {
            md.appendMarkdown(`Type: ${node.workItemType}\n\n`);
        }
        if (node.state) {
            md.appendMarkdown(`State: ${node.state}\n\n`);
        }
        if (node.priority) {
            md.appendMarkdown(`Priority: ${node.priority}\n\n`);
        }
        
        md.appendMarkdown('*Click to open in browser*');
        return md;
    }

    private getWorkItemIcon(node: WorkItemNode): vscode.ThemeIcon {
        const type = node.workItemType?.toLowerCase() ?? '';
        
        if (type.includes('bug')) {
            return new vscode.ThemeIcon('bug', new vscode.ThemeColor('charts.red'));
        } else if (type.includes('task')) {
            return new vscode.ThemeIcon('tasklist', new vscode.ThemeColor('charts.blue'));
        } else if (type.includes('user story') || type.includes('story')) {
            return new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.green'));
        } else if (type.includes('feature')) {
            return new vscode.ThemeIcon('rocket', new vscode.ThemeColor('charts.purple'));
        } else if (type.includes('epic')) {
            return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.orange'));
        } else {
            return new vscode.ThemeIcon('circle-filled');
        }
    }
}

/**
 * Tree data provider for ADO query results
 */
export class AdoTreeProvider implements vscode.TreeDataProvider<AdoTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AdoTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cliRunner: AzCliRunner;
    private adoClient: AdoClient;
    private groupingEngine: GroupingEngine;
    
    private cachedQueries: QueryNode[] = [];
    private isLoading = false;
    private lastError: string | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private currentGeneration = 0;

    constructor() {
        this.cliRunner = new AzCliRunner();
        this.adoClient = new AdoClient(this.cliRunner);
        this.groupingEngine = new GroupingEngine();
        
        // Setup auto-refresh if configured
        this.setupAutoRefresh();
        
        // Watch for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('adoQueries')) {
                this.setupAutoRefresh();
                this.forceRefresh();
            }
        });
    }

    private setupAutoRefresh(): void {
        // Clear existing timer
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        const interval = Settings.refreshIntervalSeconds;
        if (interval > 0) {
            this.refreshTimer = setInterval(() => {
                this.refresh();
            }, interval * 1000);
        }
    }

    getTreeItem(element: AdoTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AdoTreeItem): Promise<AdoTreeItem[]> {
        // Root level
        if (!element) {
            // Check if configured
            if (!Settings.isConfigured()) {
                return [new AdoTreeItem('configure')];
            }

            // Show loading state
            if (this.isLoading && this.cachedQueries.length === 0) {
                return [new AdoTreeItem('loading')];
            }

            // Show error state
            if (this.lastError && this.cachedQueries.length === 0) {
                return [new AdoTreeItem('error', this.lastError)];
            }

            // Return cached queries as top-level nodes
            if (this.cachedQueries.length === 0) {
                return [new AdoTreeItem('empty')];
            }

            return this.cachedQueries.map(node => new AdoTreeItem(node));
        }

        // Children of a tree node
        const node = element.node;
        if (node === 'configure' || node === 'error' || node === 'loading' || node === 'empty') {
            return [];
        }

        // Query node children
        if (node.type === 'query') {
            if (node.error) {
                return [new AdoTreeItem('error', node.error)];
            }
            if (node.loading) {
                return [new AdoTreeItem('loading')];
            }
            if (node.children.length === 0) {
                return [new AdoTreeItem('empty')];
            }
            return node.children.map(child => new AdoTreeItem(child));
        }

        // Group node children
        if (node.type === 'group') {
            return node.children.map(child => new AdoTreeItem(child));
        }

        return [];
    }

    /**
     * Refresh the tree data
     */
    async refresh(): Promise<void> {
        if (this.isLoading) {
            return; // Skip if already loading
        }

        // Track generation for stale request handling
        const generation = ++this.currentGeneration;
        
        const queries = Settings.getActiveQueries();
        if (queries.length === 0) {
            this.cachedQueries = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        this.isLoading = true;
        this.lastError = undefined;
        this._onDidChangeTreeData.fire();

        try {
            const queryNodes: QueryNode[] = [];

            for (const queryDef of queries) {
                // Check if this request is still relevant
                if (generation !== this.currentGeneration) {
                    return;
                }

                const queryNode = await this.loadQueryNode(queryDef);
                queryNodes.push(queryNode);
            }

            // Check if this request is still relevant
            if (generation !== this.currentGeneration) {
                return;
            }

            this.cachedQueries = queryNodes;
            console.log(`[ADO] Loaded ${queryNodes.length} queries`);

        } catch (err) {
            console.error('[ADO] Refresh error:', err);
            if (generation === this.currentGeneration) {
                this.lastError = String(err);
            }
        } finally {
            if (generation === this.currentGeneration) {
                this.isLoading = false;
                this._onDidChangeTreeData.fire();
            }
        }
    }

    /**
     * Load a single query and build its tree
     */
    private async loadQueryNode(queryDef: QueryDefinition): Promise<QueryNode> {
        const result = await this.adoClient.getWorkItemsForQuery(queryDef);

        if (!result.success) {
            return {
                type: 'query',
                name: queryDef.name,
                organization: queryDef.organization,
                project: queryDef.project,
                queryId: queryDef.queryId,
                queryPath: queryDef.queryPath,
                count: 0,
                children: [],
                error: result.error?.message ?? 'Failed to load query',
                collapsed: queryDef.collapsed
            };
        }

        const workItems = result.data ?? [];
        const groupBy = queryDef.groupBy ?? Settings.groupBy;
        const children = this.groupingEngine.buildTree(workItems, groupBy);
        const count = this.countWorkItems(children);

        console.log(`[ADO] Query "${queryDef.name}": ${workItems.length} items, ${children.length} groups`);

        return {
            type: 'query',
            name: queryDef.name,
            organization: queryDef.organization,
            project: queryDef.project,
            queryId: queryDef.queryId,
            queryPath: queryDef.queryPath,
            count,
            children,
            collapsed: queryDef.collapsed
        };
    }

    /**
     * Count work items in tree
     */
    private countWorkItems(nodes: TreeNode[]): number {
        let count = 0;
        for (const node of nodes) {
            if (node.type === 'workItem') {
                count++;
            } else if (node.type === 'group' || node.type === 'query') {
                count += this.countWorkItems(node.children);
            }
        }
        return count;
    }

    /**
     * Open a work item in the browser
     */
    async openWorkItem(node: WorkItemNode): Promise<void> {
        let url = node.url;
        
        if (!url) {
            url = await this.adoClient.getWorkItemUrl(node.id);
        }
        
        if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
            vscode.window.showErrorMessage('Could not determine work item URL');
        }
    }

    /**
     * Open a query in browser
     */
    openQueryInBrowser(queryId?: string, org?: string, project?: string): void {
        const url = this.adoClient.getQueryUrl(queryId, org, project);
        
        if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
            vscode.window.showWarningMessage('Query URL could not be determined. Ensure organization, project, and query ID are configured.');
        }
    }

    /**
     * Copy work item ID to clipboard
     */
    async copyWorkItemId(node: WorkItemNode): Promise<void> {
        await vscode.env.clipboard.writeText(String(node.id));
        vscode.window.showInformationMessage(`Copied work item ID: ${node.id}`);
    }

    /**
     * Clear cache and force refresh
     */
    forceRefresh(): void {
        this.adoClient.clearCache();
        this.cachedQueries = [];
        this.refresh();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this._onDidChangeTreeData.dispose();
    }
}
