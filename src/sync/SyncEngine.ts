import * as vscode from 'vscode';
import { AdoRestClient } from '../ado/AdoRestClient';
import { Database } from '../db/Database';
import { WorkItemRepository, workItemRowFromAdo } from '../db/repositories/WorkItemRepository';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { SyncStateRepository } from '../db/repositories/SyncStateRepository';
import { OutboxProcessor } from './OutboxProcessor';
import { ConflictResolver, ConflictPrompt } from './ConflictResolver';
import { QueryDefinition, Settings } from '../config/Settings';

/** Standard set of fields we mirror for every work item. */
export const DEFAULT_FIELDS = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.Reason',
    'System.WorkItemType',
    'System.AssignedTo',
    'System.AreaPath',
    'System.IterationPath',
    'System.Tags',
    'System.Description',
    'System.CreatedBy',
    'System.CreatedDate',
    'System.ChangedBy',
    'System.ChangedDate',
    'Microsoft.VSTS.Common.Priority',
    'Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.Effort',
    'Microsoft.VSTS.Scheduling.StoryPoints',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.StartDate',
    'Microsoft.VSTS.Scheduling.DueDate'
];

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
    phase: SyncPhase;
    lastSyncedUtc?: string;
    pendingCount: number;
    message?: string;
}

/**
 * Owns all reconciliation between ADO and the local DB.
 *
 * Phase 2 implements the PULL half: for each configured query it fetches IDs via
 * REST, batch-fetches changed work items, mirrors them into the DB, and
 * reconciles tasks (preserving local-only fields). The outbox/push half is added
 * in Phase 3.
 */
export class SyncEngine {
    private readonly workItems: WorkItemRepository;
    private readonly tasks: TaskRepository;
    private readonly syncState: SyncStateRepository;
    private readonly outbox: OutboxProcessor;

    private _status: SyncStatus = { phase: 'idle', pendingCount: 0 };
    private readonly _onDidChangeStatus = new vscode.EventEmitter<SyncStatus>();
    readonly onDidChangeStatus = this._onDidChangeStatus.event;

    private generation = 0;

    constructor(
        private readonly db: Database,
        private readonly rest: AdoRestClient,
        private readonly outputChannel: vscode.OutputChannel,
        prompt?: ConflictPrompt
    ) {
        this.workItems = new WorkItemRepository(db);
        this.tasks = new TaskRepository(db);
        this.syncState = new SyncStateRepository(db);
        const defaultPrompt: ConflictPrompt = async () => 'theirs';
        const resolver = new ConflictResolver(rest, this.workItems, prompt ?? defaultPrompt, (m) => this.log(m));
        this.outbox = new OutboxProcessor(db, rest, resolver, (m) => this.log(m));
        this.setStatus({ pendingCount: this.outbox.pendingCount });
    }

    get status(): SyncStatus {
        return this._status;
    }

    get taskRepository(): TaskRepository {
        return this.tasks;
    }

    /** Optimistically enqueue an ADO state change and drain the outbox. */
    async enqueueStateChange(adoId: number, newState: string): Promise<void> {
        this.outbox.enqueueStateChange(adoId, newState);
        this.setStatus({ pendingCount: this.outbox.pendingCount });
        await this.processOutbox();
    }

    /** Create a new ADO work item from a local task, then drain the outbox. */
    async pushTaskToAdo(taskUuid: string, type: string, org: string, project: string): Promise<void> {
        const task = this.tasks.getByUuid(taskUuid);
        if (!task) return;
        this.outbox.enqueueCreate(taskUuid, type, org, project, task.title);
        this.setStatus({ pendingCount: this.outbox.pendingCount });
        await this.processOutbox();
    }

    /** Drain the outbox once and refresh the pending count. */
    async processOutbox(): Promise<void> {
        await this.outbox.process();
        this.setStatus({ pendingCount: this.outbox.pendingCount });
    }

    private setStatus(patch: Partial<SyncStatus>): void {
        this._status = { ...this._status, ...patch };
        this._onDidChangeStatus.fire(this._status);
    }

    private log(msg: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] [sync] ${msg}`);
    }

    private sourceKey(q: QueryDefinition): string {
        return `${q.organization ?? Settings.organization}/${q.project ?? Settings.project}/${q.queryId ?? q.queryPath ?? q.name}`;
    }

    /**
     * Pull all REST-eligible queries (those with org + project + queryId).
     * Queries that can only be resolved by path are left to the CLI path.
     */
    async pull(queries: QueryDefinition[]): Promise<void> {
        const myGen = ++this.generation;
        this.setStatus({ phase: 'syncing', message: 'Syncing…' });
        let anyOnline = false;
        let anyError = false;

        for (const q of queries) {
            if (myGen !== this.generation) return; // superseded
            const org = q.organization ?? Settings.organization;
            const project = q.project ?? Settings.project;
            if (!org || !project || !q.queryId) {
                continue; // not REST-eligible; CLI fallback handles it
            }

            try {
                const ids = await this.rest.runSavedQuery(org, project, q.queryId);
                if (ids === undefined) {
                    anyError = true;
                    continue;
                }
                anyOnline = true;
                const limited = ids.slice(0, Settings.maxItems);
                const items = await this.rest.batchGetWorkItems(org, project, limited, DEFAULT_FIELDS);
                if (!items) {
                    anyError = true;
                    continue;
                }

                let maxChanged = this.syncState.get(this.sourceKey(q))?.watermark;
                for (const wi of items) {
                    const rev = (wi as { rev?: number }).rev ?? 0;
                    this.workItems.upsert(workItemRowFromAdo(wi.id, wi.fields, rev, org, project));
                    const title = typeof wi.fields['System.Title'] === 'string' ? (wi.fields['System.Title'] as string) : `#${wi.id}`;
                    const state = typeof wi.fields['System.State'] === 'string' ? (wi.fields['System.State'] as string) : undefined;
                    this.tasks.reconcileFromWorkItem(wi.id, title, state);

                    const changed = wi.fields['System.ChangedDate'];
                    if (typeof changed === 'string' && (!maxChanged || changed > maxChanged)) {
                        maxChanged = changed;
                    }
                }
                this.syncState.set(this.sourceKey(q), maxChanged);
                this.log(`Pulled ${items.length} items for "${q.name}"`);
            } catch (err) {
                anyError = true;
                this.log(`Pull failed for "${q.name}": ${String(err)}`);
            }
        }

        if (myGen !== this.generation) return;

        // Drain any pending local changes as part of each sync cycle.
        await this.processOutbox();

        if (!anyOnline && anyError) {
            this.setStatus({ phase: 'offline', message: 'Offline — showing cached data' });
        } else if (anyError) {
            this.setStatus({ phase: 'error', message: 'Some queries failed', lastSyncedUtc: new Date().toISOString() });
        } else {
            this.setStatus({ phase: 'idle', message: undefined, lastSyncedUtc: new Date().toISOString() });
        }
    }

    dispose(): void {
        this._onDidChangeStatus.dispose();
    }
}
