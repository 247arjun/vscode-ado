import * as vscode from 'vscode';

/**
 * Group-by specification for a single grouping level
 */
export interface GroupSpec {
    field: string;
    projection?: string;
    missingLabel?: string;
    bucket?: 'date';
    dateBucket?: string;
}

/**
 * Query definition for multi-query support
 */
export interface QueryDefinition {
    name: string;
    organization?: string;
    project?: string;
    queryId?: string;
    queryPath?: string;
    groupBy?: GroupSpec[];
    collapsed?: boolean;
}

/**
 * Full extension settings
 */
export interface AdoSettings {
    organization: string;
    project: string;
    detectFromGit: boolean;
    queries: QueryDefinition[];
    groupBy: GroupSpec[];
    maxItems: number;
    refreshIntervalSeconds: number;
    cacheTtlSeconds: number;
    batchSize: number;
}

/**
 * Typed accessor for extension settings
 */
export class Settings {
    private static readonly SECTION = 'adoQueries';

    private static getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(this.SECTION);
    }

    static get organization(): string {
        return this.getConfig().get<string>('organization', '');
    }

    static set organization(value: string) {
        this.getConfig().update('organization', value, vscode.ConfigurationTarget.Global);
    }

    static get project(): string {
        return this.getConfig().get<string>('project', '');
    }

    static set project(value: string) {
        this.getConfig().update('project', value, vscode.ConfigurationTarget.Global);
    }

    static get detectFromGit(): boolean {
        return this.getConfig().get<boolean>('detectFromGit', true);
    }

    static get groupBy(): GroupSpec[] {
        const defaultGroupBy: GroupSpec[] = [
            { field: 'System.State', missingLabel: '(no state)' }
        ];
        const groups = this.getConfig().get<GroupSpec[]>('groupBy', defaultGroupBy);
        // Limit to 5 levels
        return groups.slice(0, 5);
    }

    /**
     * Get configured queries (new multi-query format)
     */
    static get queries(): QueryDefinition[] {
        return this.getConfig().get<QueryDefinition[]>('queries', []);
    }

    /**
     * Get all active query definitions
     */
    static getActiveQueries(): QueryDefinition[] {
        return this.queries;
    }

    static get maxItems(): number {
        return this.getConfig().get<number>('maxItems', 500);
    }

    static get refreshIntervalSeconds(): number {
        return this.getConfig().get<number>('refreshIntervalSeconds', 0);
    }

    static get cacheTtlSeconds(): number {
        return this.getConfig().get<number>('cacheTtlSeconds', 30);
    }

    static get batchSize(): number {
        const size = this.getConfig().get<number>('batchSize', 200);
        // Max 200 per API requirement
        return Math.min(size, 200);
    }

    /**
     * Check if the extension is properly configured
     */
    static isConfigured(): boolean {
        const hasQueries = this.queries.length > 0;
        const hasConnection = !!(this.organization && this.project) || this.detectFromGit;
        return hasQueries && hasConnection;
    }

    /**
     * Validate settings and return any issues
     */
    static validate(): string[] {
        const issues: string[] = [];

        if (this.queries.length === 0) {
            issues.push('No queries configured. Add queries to adoQueries.queries');
        }

        if (!this.organization && !this.detectFromGit) {
            issues.push('Organization not set and detectFromGit is disabled');
        }

        if (!this.project && !this.detectFromGit) {
            issues.push('Project not set and detectFromGit is disabled');
        }

        if (this.groupBy.length === 0) {
            issues.push('No groupBy fields configured');
        }

        return issues;
    }

    /**
     * Get all settings as an object
     */
    static getAll(): AdoSettings {
        return {
            organization: this.organization,
            project: this.project,
            detectFromGit: this.detectFromGit,
            queries: this.queries,
            groupBy: this.groupBy,
            maxItems: this.maxItems,
            refreshIntervalSeconds: this.refreshIntervalSeconds,
            cacheTtlSeconds: this.cacheTtlSeconds,
            batchSize: this.batchSize
        };
    }

    /**
     * Get the list of fields needed for the tree view
     */
    static getRequiredFields(): string[] {
        const fields = new Set<string>([
            'System.Id',
            'System.Title',
            'System.State',
            'System.WorkItemType'
        ]);

        for (const group of this.groupBy) {
            fields.add(group.field);
        }

        return Array.from(fields);
    }

    /**
     * Get required fields for a specific query definition
     */
    static getRequiredFieldsForQuery(queryDef: QueryDefinition): string[] {
        const fields = new Set<string>([
            'System.Id',
            'System.Title',
            'System.State',
            'System.WorkItemType'
        ]);

        const groupBy = queryDef.groupBy ?? this.groupBy;
        for (const group of groupBy) {
            fields.add(group.field);
        }

        return Array.from(fields);
    }
}
