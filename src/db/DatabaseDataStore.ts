import { CliResult } from '../ado/AzCliRunner';
import { WorkItem, AdoClient, WorkItemTypeState } from '../ado/AdoClient';
import { QueryDefinition, Settings } from '../config/Settings';
import { DataStore } from '../data/DataStore';
import { Database } from './Database';
import { WorkItemRepository, workItemRowFromAdo } from './repositories/WorkItemRepository';
import { TaskRepository } from './repositories/TaskRepository';

interface QueryCacheRow {
    key: string;
    items: WorkItem[];
}

/**
 * Phase 1 DataStore: the local database is the read source of truth.
 *
 * On each fetch we ask ADO (via the live client), upsert the results into the
 * DB (work_items + reconciled tasks + a per-query snapshot), and return the
 * fresh data. If ADO is unreachable, we serve the last persisted snapshot so the
 * UI works fully offline and across reloads.
 */
export class DatabaseDataStore implements DataStore {
    private readonly workItems: WorkItemRepository;
    private readonly tasks: TaskRepository;

    constructor(
        private readonly db: Database,
        private readonly live: AdoClient
    ) {
        this.workItems = new WorkItemRepository(db);
        this.tasks = new TaskRepository(db);
    }

    private cacheKey(queryDef: QueryDefinition): string {
        return JSON.stringify({
            org: queryDef.organization ?? Settings.organization,
            project: queryDef.project ?? Settings.project,
            queryId: queryDef.queryId,
            queryPath: queryDef.queryPath,
            name: queryDef.name
        });
    }

    private readSnapshot(key: string): WorkItem[] {
        const row = this.db.table<QueryCacheRow>('query_cache').find(r => r.key === key);
        return row?.items ?? [];
    }

    private writeSnapshot(key: string, items: WorkItem[]): void {
        const rows = this.db.table<QueryCacheRow>('query_cache');
        const existing = rows.find(r => r.key === key);
        if (existing) {
            existing.items = items;
        } else {
            rows.push({ key, items });
        }
        this.db.save();
    }

    async getWorkItemsForQuery(queryDef: QueryDefinition): Promise<CliResult<WorkItem[]>> {
        const key = this.cacheKey(queryDef);
        const result = await this.live.getWorkItemsForQuery(queryDef);

        if (result.success && result.data) {
            const org = queryDef.organization ?? Settings.organization;
            const project = queryDef.project ?? Settings.project;

            // Mirror into the DB and reconcile tasks.
            for (const wi of result.data) {
                this.workItems.upsert(workItemRowFromAdo(wi.id, wi.fields, 0, org, project, wi.url));
                const title = typeof wi.fields['System.Title'] === 'string' ? (wi.fields['System.Title'] as string) : `#${wi.id}`;
                const state = typeof wi.fields['System.State'] === 'string' ? (wi.fields['System.State'] as string) : undefined;
                this.tasks.reconcileFromWorkItem(wi.id, title, state);
            }

            this.writeSnapshot(key, result.data);
            return result;
        }

        // Offline / failure: serve the last persisted snapshot.
        const snapshot = this.readSnapshot(key);
        if (snapshot.length > 0) {
            return { success: true, data: snapshot, exitCode: 0 };
        }
        return result;
    }

    getWorkItemUrl(id: number): Promise<string | undefined> {
        const cached = this.workItems.getById(id);
        if (cached?.fields?.['_url'] && typeof cached.fields['_url'] === 'string') {
            return Promise.resolve(cached.fields['_url'] as string);
        }
        return this.live.getWorkItemUrl(id);
    }

    getQueryUrl(queryId?: string, org?: string, project?: string): string | undefined {
        return this.live.getQueryUrl(queryId, org, project);
    }

    fetchWorkItemTypeStates(workItemType: string, org?: string, project?: string): Promise<WorkItemTypeState[]> {
        return this.live.fetchWorkItemTypeStates(workItemType, org, project);
    }

    clearCacheForQuery(queryDef: QueryDefinition): void {
        this.live.clearCacheForQuery(queryDef);
    }

    clearCache(): void {
        this.live.clearCache();
    }

    /** Expose repositories for later phases (sync engine, UI). */
    get taskRepository(): TaskRepository {
        return this.tasks;
    }

    get workItemRepository(): WorkItemRepository {
        return this.workItems;
    }
}
