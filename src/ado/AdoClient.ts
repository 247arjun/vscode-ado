import { AzCliRunner, CliResult } from './AzCliRunner';
import { Settings, QueryDefinition } from '../config/Settings';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Work item from ADO
 */
export interface WorkItem {
    id: number;
    fields: Record<string, unknown>;
    url?: string;
    _links?: {
        html?: { href: string };
    };
}

/**
 * Query result from az boards query
 */
interface QueryResult {
    id: number;
    url?: string;
    fields?: Record<string, unknown>;
}

/**
 * Batch work items response
 */
interface BatchWorkItemsResponse {
    count: number;
    value: WorkItem[];
}

/**
 * Query metadata from ADO
 */
export interface QueryMetadata {
    id: string;
    name: string;
    path: string;
}

/**
 * ADO client that uses Azure CLI for API calls
 */
export class AdoClient {
    private cliRunner: AzCliRunner;
    private cache: Map<string, { data: WorkItem[]; timestamp: number }> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor(cliRunner?: AzCliRunner, outputChannel?: vscode.OutputChannel) {
        this.cliRunner = cliRunner ?? new AzCliRunner();
        this.outputChannel = outputChannel ?? vscode.window.createOutputChannel('Azure DevOps Queries');
    }

    /**
     * Log a message to the output channel
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    /**
     * Build common CLI args for org/project
     */
    private getConnectionArgs(): string[] {
        const args: string[] = [];
        
        if (Settings.organization) {
            args.push('--org', this.normalizeOrgUrl(Settings.organization));
        }
        
        if (Settings.project) {
            args.push('--project', Settings.project);
        }
        
        if (Settings.detectFromGit && !Settings.organization) {
            args.push('--detect', 'true');
        }

        return args;
    }

    /**
     * Build CLI args for a specific query definition (with fallback to global settings)
     */
    private getConnectionArgsForQuery(queryDef: QueryDefinition): string[] {
        const args: string[] = [];
        
        const org = queryDef.organization ?? Settings.organization;
        const project = queryDef.project ?? Settings.project;
        
        if (org) {
            args.push('--org', this.normalizeOrgUrl(org));
        }
        
        if (project) {
            args.push('--project', project);
        }
        
        if (Settings.detectFromGit && !org) {
            args.push('--detect', 'true');
        }

        return args;
    }

    /**
     * Normalize organization to a full URL
     * Accepts: "myorg", "https://dev.azure.com/myorg", "https://myorg.visualstudio.com"
     */
    private normalizeOrgUrl(org: string): string {
        org = org.trim();
        
        // Already a full URL
        if (org.startsWith('https://') || org.startsWith('http://')) {
            return org;
        }
        
        // Just org name - convert to full URL
        return `https://dev.azure.com/${org}`;
    }

    /**
     * Fetch work items in batches using the REST API via az devops invoke
     */
    async fetchWorkItemsBatch(ids: number[], fields: string[], queryDef?: QueryDefinition): Promise<CliResult<WorkItem[]>> {
        if (ids.length === 0) {
            return { success: true, data: [], exitCode: 0 };
        }

        const batchSize = Settings.batchSize;
        const allWorkItems: WorkItem[] = [];
        const batches = this.chunkArray(ids, batchSize);

        this.log(`Fetching ${ids.length} work items in ${batches.length} batch(es)`);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            
            // Show progress for large fetches
            if (batches.length > 1) {
                vscode.window.setStatusBarMessage(
                    `Fetching work items (${i * batchSize + 1}-${Math.min((i + 1) * batchSize, ids.length)}/${ids.length})...`,
                    2000
                );
            }

            const result = await this.fetchBatch(batch, fields, queryDef);
            
            if (!result.success) {
                this.log(`Batch ${i + 1} failed: ${result.error?.message}`);
                return result as CliResult<WorkItem[]>;
            }
            
            if (result.data) {
                allWorkItems.push(...result.data);
            }
        }

        this.log(`Successfully fetched ${allWorkItems.length} work items`);
        return { success: true, data: allWorkItems, exitCode: 0 };
    }

    /**
     * Fetch a single batch of work items via az devops invoke (POST to workitemsbatch)
     */
    private async fetchBatch(ids: number[], fields: string[], queryDef?: QueryDefinition): Promise<CliResult<WorkItem[]>> {
        // Write POST body to a temp file for az devops invoke --in-file
        const body = JSON.stringify({ ids, fields });
        const tmpFile = path.join(os.tmpdir(), `ado-batch-${Date.now()}.json`);

        try {
            fs.writeFileSync(tmpFile, body, 'utf-8');

            const args = [
                'devops', 'invoke',
                '--area', 'wit',
                '--resource', 'workitemsbatch',
                '--http-method', 'POST',
                '--api-version', '7.1',
                '--in-file', tmpFile
            ];

            args.push(...(queryDef ? this.getConnectionArgsForQuery(queryDef) : this.getConnectionArgs()));

            this.log(`Batch request: ${ids.length} IDs, fields: ${fields.join(', ')}`);
            const result = await this.cliRunner.execute<BatchWorkItemsResponse>(args);

            if (result.success && result.data) {
                const items = result.data.value ?? [];
                return { success: true, data: items, exitCode: 0 };
            }

            // Fallback: if invoke fails (e.g. extension not supporting invoke), use individual fetch
            if (!result.success) {
                this.log(`Batch API failed, falling back to individual fetch: ${result.error?.message}`);
                return this.fetchBatchIndividual(ids, queryDef);
            }

            return { success: true, data: [], exitCode: 0 };
        } finally {
            // Clean up temp file
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    /**
     * Fallback: fetch work items individually when batch API is unavailable
     */
    private async fetchBatchIndividual(ids: number[], queryDef?: QueryDefinition): Promise<CliResult<WorkItem[]>> {
        const workItems: WorkItem[] = [];
        
        for (const id of ids) {
            const result = await this.fetchSingleWorkItem(id, queryDef);
            if (result.success && result.data) {
                workItems.push(result.data);
            }
        }

        return { success: true, data: workItems, exitCode: 0 };
    }

    /**
     * Fetch a single work item
     */
    async fetchSingleWorkItem(id: number, queryDef?: QueryDefinition): Promise<CliResult<WorkItem>> {
        const args = [
            'boards', 'work-item', 'show',
            '--id', id.toString()
        ];

        args.push(...(queryDef ? this.getConnectionArgsForQuery(queryDef) : this.getConnectionArgs()));

        return this.cliRunner.execute<WorkItem>(args);
    }

    /**
     * Fetch query metadata (name, path) from ADO
     */
    async fetchQueryMetadata(queryId: string, org?: string, project?: string): Promise<QueryMetadata | undefined> {
        const args = [
            'devops', 'invoke',
            '--area', 'wit',
            '--resource', 'queries',
            '--route-parameters', `id=${queryId}`,
            '--http-method', 'GET',
            '--api-version', '7.1'
        ];

        if (org) {
            args.push('--org', this.normalizeOrgUrl(org));
        } else if (Settings.organization) {
            args.push('--org', this.normalizeOrgUrl(Settings.organization));
        }
        if (project) {
            args.push('--project', project);
        } else if (Settings.project) {
            args.push('--project', Settings.project);
        }

        this.log(`Fetching query metadata for ${queryId}`);
        const result = await this.cliRunner.execute<QueryMetadata>(args);
        
        if (result.success && result.data) {
            this.log(`Query name: ${result.data.name}`);
            return result.data;
        }
        
        this.log(`Failed to fetch query metadata: ${result.error?.message}`);
        return undefined;
    }

    /**
     * Get the HTML URL for a work item
     */
    async getWorkItemUrl(id: number): Promise<string | undefined> {
        const result = await this.fetchSingleWorkItem(id);
        
        if (result.success && result.data) {
            // Try to get canonical URL from _links
            const htmlLink = result.data._links?.html?.href;
            if (htmlLink) {
                return htmlLink;
            }
            
            // Fallback: construct URL
            return this.constructWorkItemUrl(id);
        }
        
        // Fallback even on failure
        return this.constructWorkItemUrl(id);
    }

    /**
     * Construct a work item URL from settings
     */
    private constructWorkItemUrl(id: number, org?: string, project?: string): string | undefined {
        const effectiveOrg = org ?? Settings.organization;
        const effectiveProject = project ?? Settings.project;
        
        if (!effectiveOrg || !effectiveProject) {
            return undefined;
        }
        
        // Normalize org URL
        let orgUrl = this.normalizeOrgUrl(effectiveOrg);
        if (!orgUrl.endsWith('/')) {
            orgUrl += '/';
        }
        
        return `${orgUrl}${encodeURIComponent(effectiveProject)}/_workitems/edit/${id}`;
    }

    /**
     * Get query URL for opening in browser
     */
    getQueryUrl(queryId?: string, org?: string, project?: string): string | undefined {
        const effectiveOrg = org ?? Settings.organization;
        const effectiveProject = project ?? Settings.project;
        const id = queryId;
        
        if (!effectiveOrg || !effectiveProject || !id) {
            return undefined;
        }
        
        let orgUrl = this.normalizeOrgUrl(effectiveOrg);
        if (!orgUrl.endsWith('/')) {
            orgUrl += '/';
        }
        
        return `${orgUrl}${encodeURIComponent(effectiveProject)}/_queries/query/${id}`;
    }

    /**
     * Execute a specific query definition and return work items
     */
    async getWorkItemsForQuery(queryDef: QueryDefinition, progress?: vscode.Progress<{ message: string }>): Promise<CliResult<WorkItem[]>> {
        // Build cache key for this specific query
        const cacheKey = this.getCacheKeyForQuery(queryDef);
        const cached = this.cache.get(cacheKey);
        const now = Date.now();
        
        if (cached && (now - cached.timestamp) < Settings.cacheTtlSeconds * 1000) {
            this.log(`Cache hit for "${queryDef.name}" (${cached.data.length} items)`);
            return { success: true, data: cached.data, exitCode: 0 };
        }

        this.log(`Loading query "${queryDef.name}"...`);
        progress?.report({ message: `Loading ${queryDef.name}...` });

        // Build query args
        const args = ['boards', 'query'];
        
        if (queryDef.queryId) {
            args.push('--id', queryDef.queryId);
        } else if (queryDef.queryPath) {
            args.push('--path', queryDef.queryPath);
        } else {
            return {
                success: false,
                exitCode: -1,
                error: {
                    type: 'unknown',
                    message: `Query "${queryDef.name}" has no queryId or queryPath configured`,
                    stderr: '',
                    command: ''
                }
            };
        }

        // Use query-specific connection args (with fallback to global)
        args.push(...this.getConnectionArgsForQuery(queryDef));
        
        // Execute query
        this.log(`Executing: az ${args.join(' ')}`);
        const queryResult = await this.cliRunner.execute<QueryResult[]>(args);
        
        if (!queryResult.success) {
            this.log(`Query failed: ${queryResult.error?.message}`);
            return queryResult as CliResult<WorkItem[]>;
        }
        
        if (!queryResult.data || queryResult.data.length === 0) {
            this.log(`Query "${queryDef.name}" returned 0 items`);
            return { success: true, data: [], exitCode: 0 };
        }

        // Limit results
        const maxItems = Settings.maxItems;
        const limitedResults = queryResult.data.slice(0, maxItems);
        this.log(`Query "${queryDef.name}" returned ${queryResult.data.length} items (limited to ${limitedResults.length})`);
        
        // Get effective org/project for URL construction
        const effectiveOrg = queryDef.organization ?? Settings.organization;
        const effectiveProject = queryDef.project ?? Settings.project;
        
        // Query result already contains fields - use them directly
        const workItems: WorkItem[] = limitedResults.map(item => ({
            id: item.id,
            fields: item.fields ?? {},
            url: this.constructWorkItemUrl(item.id, effectiveOrg, effectiveProject)
        }));

        // Cache and return
        this.cache.set(cacheKey, { data: workItems, timestamp: now });
        return { success: true, data: workItems, exitCode: 0 };
    }

    /**
     * Find fields that are missing from work items
     */
    private findMissingFields(workItems: WorkItem[], requiredFields: string[]): string[] {
        if (workItems.length === 0) return requiredFields;
        
        const firstItem = workItems[0];
        const presentFields = Object.keys(firstItem.fields);
        
        return requiredFields.filter(f => !presentFields.includes(f));
    }

    /**
     * Generate cache key from current settings
     */
    private getCacheKey(): string {
        const config = Settings.getAll();
        return JSON.stringify({
            org: config.organization,
            project: config.project,
            queries: config.queries,
            groupBy: config.groupBy.map(g => g.field)
        });
    }

    /**
     * Generate cache key for a specific query definition
     */
    private getCacheKeyForQuery(queryDef: QueryDefinition): string {
        return JSON.stringify({
            org: queryDef.organization ?? Settings.organization,
            project: queryDef.project ?? Settings.project,
            queryId: queryDef.queryId,
            queryPath: queryDef.queryPath,
            name: queryDef.name
        });
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Clear cache for a specific query
     */
    clearCacheForQuery(queryDef: QueryDefinition): void {
        const key = this.getCacheKeyForQuery(queryDef);
        this.cache.delete(key);
    }

    /**
     * Get the output channel for external use
     */
    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }

    /**
     * Split array into chunks
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }
}
