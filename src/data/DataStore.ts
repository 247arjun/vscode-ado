import { CliResult } from '../ado/AzCliRunner';
import { WorkItem, AdoClient, WorkItemTypeState } from '../ado/AdoClient';
import { QueryDefinition } from '../config/Settings';

/**
 * DataStore is the seam between the UI and the underlying source of work items.
 *
 * Phase 0: a thin pass-through over {@link AdoClient} (no behavior change).
 * Phase 1+: a database-backed implementation becomes the source of truth, with
 * ADO demoted to a sync target.
 *
 * The tree/navigator must depend ONLY on this interface, never on AdoClient
 * directly, so the backing store can be swapped without touching the UI.
 */
export interface DataStore {
    /** Fetch the work items for a single query definition. */
    getWorkItemsForQuery(queryDef: QueryDefinition): Promise<CliResult<WorkItem[]>>;

    /** Resolve the canonical browser URL for a work item. */
    getWorkItemUrl(id: number): Promise<string | undefined>;

    /** Build the browser URL for a query. */
    getQueryUrl(queryId?: string, org?: string, project?: string): string | undefined;

    /** Fetch the valid states for a work item type (for the state changer). */
    fetchWorkItemTypeStates(workItemType: string, org?: string, project?: string): Promise<WorkItemTypeState[]>;

    /** Invalidate any cached data for a query. */
    clearCacheForQuery(queryDef: QueryDefinition): void;

    /** Invalidate everything. */
    clearCache(): void;
}

/**
 * Phase 0 implementation: delegates directly to {@link AdoClient}.
 *
 * This deliberately changes no behavior — it simply gives us an injection point
 * so later phases can substitute a {@link DatabaseDataStore} without the tree
 * ever knowing.
 */
export class LiveDataStore implements DataStore {
    constructor(private readonly adoClient: AdoClient) {}

    getWorkItemsForQuery(queryDef: QueryDefinition): Promise<CliResult<WorkItem[]>> {
        return this.adoClient.getWorkItemsForQuery(queryDef);
    }

    getWorkItemUrl(id: number): Promise<string | undefined> {
        return this.adoClient.getWorkItemUrl(id);
    }

    getQueryUrl(queryId?: string, org?: string, project?: string): string | undefined {
        return this.adoClient.getQueryUrl(queryId, org, project);
    }

    fetchWorkItemTypeStates(workItemType: string, org?: string, project?: string): Promise<WorkItemTypeState[]> {
        return this.adoClient.fetchWorkItemTypeStates(workItemType, org, project);
    }

    clearCacheForQuery(queryDef: QueryDefinition): void {
        this.adoClient.clearCacheForQuery(queryDef);
    }

    clearCache(): void {
        this.adoClient.clearCache();
    }
}
