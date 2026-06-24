import { AdoRestClient, JsonPatchOp } from '../ado/AdoRestClient';
import { Database } from '../db/Database';
import { SyncQueueRepository } from '../db/repositories/SyncQueueRepository';
import { WorkItemRepository, workItemRowFromAdo } from '../db/repositories/WorkItemRepository';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { SyncStateRepository } from '../db/repositories/SyncStateRepository';
import { ConflictResolver } from './ConflictResolver';
import { SyncOp } from '../model/types';

const MAX_ATTEMPTS = 5;

/**
 * Drains the outbox: applies each pending local change to ADO via PATCH with an
 * If-Match ETag, handling conflicts (412), throttling (429), and retries with
 * exponential backoff. Local-only mutations never reach this processor.
 */
export class OutboxProcessor {
    private readonly queue: SyncQueueRepository;
    private readonly workItems: WorkItemRepository;
    private readonly tasks: TaskRepository;
    private readonly syncState: SyncStateRepository;
    private running = false;

    constructor(
        db: Database,
        private readonly rest: AdoRestClient,
        private readonly conflicts: ConflictResolver,
        private readonly log: (msg: string) => void
    ) {
        this.queue = new SyncQueueRepository(db);
        this.workItems = new WorkItemRepository(db);
        this.tasks = new TaskRepository(db);
        this.syncState = new SyncStateRepository(db);
    }

    get pendingCount(): number {
        return this.queue.pendingCount();
    }

    /** Enqueue an ADO state change (optimistic; the DB is already updated). */
    enqueueStateChange(adoId: number, newState: string): void {
        const row = this.workItems.getById(adoId);
        this.queue.enqueue({
            entity: 'workitem',
            targetId: String(adoId),
            opType: 'update_state',
            payload: { state: newState },
            baseEtag: row?.etag
        });
    }

    /** Enqueue a single-field ADO update (optimistic). value === null clears it. */
    enqueueFieldUpdate(adoId: number, field: string, value: unknown): void {
        const row = this.workItems.getById(adoId);
        this.queue.enqueue({
            entity: 'workitem',
            targetId: String(adoId),
            opType: 'update_fields',
            payload: { field, value },
            baseEtag: row?.etag
        });
    }

    /** Enqueue creation of a brand-new ADO work item from a local task. */
    enqueueCreate(taskUuid: string, type: string, org: string, project: string, title: string): void {
        this.queue.enqueue({
            entity: 'task',
            targetId: taskUuid,
            opType: 'create_work_item',
            payload: { type, org, project, title }
        });
    }

    /** Process all pending ops once. Safe to call repeatedly; re-entrancy-guarded. */
    async process(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            for (const op of this.queue.pending()) {
                await this.processOne(op);
            }
            this.queue.purgeDone();
        } finally {
            this.running = false;
        }
    }

    private async processOne(op: SyncOp): Promise<void> {
        if (op.opType === 'create_work_item') {
            await this.processCreate(op);
            return;
        }
        if (op.opType === 'update_fields') {
            await this.processFieldUpdate(op);
            return;
        }
        if (op.opType !== 'update_state') {
            // Unknown op types are skipped for now.
            this.queue.setStatus(op.opId, 'failed', `Unsupported op type ${op.opType}`);
            return;
        }

        const adoId = Number(op.targetId);
        const row = this.workItems.getById(adoId);
        const org = row?.org;
        const project = row?.project;
        if (!org || !project) {
            this.queue.setStatus(op.opId, 'failed', 'Missing org/project for work item');
            return;
        }

        const newState = String(op.payload['state']);
        const ops: JsonPatchOp[] = [{ op: 'add', path: '/fields/System.State', value: newState }];

        this.queue.setStatus(op.opId, 'inflight');
        const result = await this.rest.patchWorkItem(org, project, adoId, ops, op.baseEtag);

        if (result.success) {
            if (result.etag && result.rev !== undefined) {
                this.workItems.setEtag(adoId, result.etag, result.rev);
            }
            // Reflect the new state locally and reconcile the linked task.
            const updated = this.workItems.getById(adoId);
            if (updated) {
                updated.state = newState;
                updated.fields['System.State'] = newState;
            }
            const title = typeof updated?.fields['System.Title'] === 'string' ? (updated.fields['System.Title'] as string) : `#${adoId}`;
            this.tasks.reconcileFromWorkItem(adoId, title, newState);
            this.queue.setStatus(op.opId, 'done');
            this.log(`Pushed #${adoId} -> ${newState}`);
            return;
        }

        if (result.conflict) {
            const outcome = await this.conflicts.resolveStateConflict(op, org, project);
            if (outcome.resolved) {
                this.queue.setStatus(op.opId, 'done');
                return;
            }
            if (outcome.retryWithEtag) {
                this.queue.updateBaseEtag(op.opId, outcome.retryWithEtag);
                const retry = await this.rest.patchWorkItem(org, project, adoId, ops, outcome.retryWithEtag);
                if (retry.success) {
                    if (retry.etag && retry.rev !== undefined) this.workItems.setEtag(adoId, retry.etag, retry.rev);
                    this.queue.setStatus(op.opId, 'done');
                    this.log(`Pushed #${adoId} -> ${newState} after conflict merge`);
                    return;
                }
            }
            // Leave pending for another cycle if unresolved.
            this.queue.setStatus(op.opId, 'pending', 'Awaiting conflict resolution');
            return;
        }

        // Transient failure (429 / network): backoff via attempts, keep pending.
        const attempts = this.queue.incrementAttempts(op.opId);
        if (attempts >= MAX_ATTEMPTS) {
            this.queue.setStatus(op.opId, 'failed', result.error?.message ?? 'Unknown error');
            this.log(`Giving up on #${adoId} after ${attempts} attempts: ${result.error?.message}`);
        } else {
            this.queue.setStatus(op.opId, 'pending', result.error?.message);
            this.log(`Transient failure on #${adoId} (attempt ${attempts}): ${result.error?.message}`);
        }
    }

    /** Create a new ADO work item for a local task and link them together. */
    private async processCreate(op: SyncOp): Promise<void> {
        const taskUuid = op.targetId;
        const task = this.tasks.getByUuid(taskUuid);
        if (!task) {
            this.queue.setStatus(op.opId, 'failed', 'Local task no longer exists');
            return;
        }
        if (task.adoId !== undefined) {
            // Already linked (e.g. a duplicate op) — nothing to do.
            this.queue.setStatus(op.opId, 'done');
            return;
        }

        const type = String(op.payload['type']);
        const org = String(op.payload['org']);
        const project = String(op.payload['project']);
        const title = String(op.payload['title'] ?? task.title);
        if (!org || !project) {
            this.queue.setStatus(op.opId, 'failed', 'Missing org/project for new work item');
            return;
        }

        this.queue.setStatus(op.opId, 'inflight');
        const result = await this.rest.createWorkItem(org, project, type, { 'System.Title': title });

        if (result.success && result.workItem) {
            const newId = result.workItem.id;
            const fields = result.workItem.fields ?? { 'System.Title': title };
            this.workItems.upsert(workItemRowFromAdo(newId, fields, result.rev ?? 0, org, project, result.etag));
            // Link the local task to its new ADO work item.
            this.tasks.update(taskUuid, { adoId: newId });
            this.queue.setStatus(op.opId, 'done');
            this.log(`Created ADO ${type} #${newId} from local task "${title}"`);
            return;
        }

        const attempts = this.queue.incrementAttempts(op.opId);
        if (attempts >= MAX_ATTEMPTS) {
            this.queue.setStatus(op.opId, 'failed', result.error?.message ?? 'Unknown error');
            this.log(`Giving up creating work item for "${title}" after ${attempts} attempts: ${result.error?.message}`);
        } else {
            this.queue.setStatus(op.opId, 'pending', result.error?.message);
            this.log(`Transient failure creating "${title}" (attempt ${attempts}): ${result.error?.message}`);
        }
    }

    /** Apply a single-field update to an existing ADO work item. */
    private async processFieldUpdate(op: SyncOp): Promise<void> {
        const adoId = Number(op.targetId);
        const row = this.workItems.getById(adoId);
        const org = row?.org;
        const project = row?.project;
        if (!org || !project) {
            this.queue.setStatus(op.opId, 'failed', 'Missing org/project for work item');
            return;
        }

        const field = String(op.payload['field']);
        const value = op.payload['value'];
        const cleared = value === null || value === undefined || value === '';
        const ops: JsonPatchOp[] = cleared
            ? [{ op: 'remove', path: `/fields/${field}` }]
            : [{ op: 'add', path: `/fields/${field}`, value }];

        const applyLocal = () => {
            const updated = this.workItems.getById(adoId);
            if (updated) {
                if (cleared) delete updated.fields[field];
                else updated.fields[field] = value;
                if (field === 'System.State') updated.state = cleared ? undefined : String(value);
            }
            if (field === 'System.State' || field === 'System.Title') {
                const title = typeof updated?.fields['System.Title'] === 'string' ? (updated.fields['System.Title'] as string) : `#${adoId}`;
                const state = typeof updated?.fields['System.State'] === 'string' ? (updated.fields['System.State'] as string) : undefined;
                this.tasks.reconcileFromWorkItem(adoId, title, state);
            }
        };

        this.queue.setStatus(op.opId, 'inflight');
        const result = await this.rest.patchWorkItem(org, project, adoId, ops, op.baseEtag);

        if (result.success) {
            if (result.etag && result.rev !== undefined) this.workItems.setEtag(adoId, result.etag, result.rev);
            applyLocal();
            this.queue.setStatus(op.opId, 'done');
            this.log(`Pushed #${adoId} ${field} = ${cleared ? '(cleared)' : String(value)}`);
            return;
        }

        if (result.conflict) {
            const outcome = await this.conflicts.resolveFieldConflict(op, org, project, field, value);
            if (outcome.resolved) {
                this.queue.setStatus(op.opId, 'done');
                return;
            }
            if (outcome.retryWithEtag) {
                this.queue.updateBaseEtag(op.opId, outcome.retryWithEtag);
                const retry = await this.rest.patchWorkItem(org, project, adoId, ops, outcome.retryWithEtag);
                if (retry.success) {
                    if (retry.etag && retry.rev !== undefined) this.workItems.setEtag(adoId, retry.etag, retry.rev);
                    applyLocal();
                    this.queue.setStatus(op.opId, 'done');
                    this.log(`Pushed #${adoId} ${field} after conflict merge`);
                    return;
                }
            }
            this.queue.setStatus(op.opId, 'pending', 'Awaiting conflict resolution');
            return;
        }

        const attempts = this.queue.incrementAttempts(op.opId);
        if (attempts >= MAX_ATTEMPTS) {
            this.queue.setStatus(op.opId, 'failed', result.error?.message ?? 'Unknown error');
            this.log(`Giving up on #${adoId} ${field} after ${attempts} attempts: ${result.error?.message}`);
        } else {
            this.queue.setStatus(op.opId, 'pending', result.error?.message);
            this.log(`Transient failure on #${adoId} ${field} (attempt ${attempts}): ${result.error?.message}`);
        }
    }
}
