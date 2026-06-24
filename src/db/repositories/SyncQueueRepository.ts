import { Database } from '../Database';
import { SyncOp, SyncOpStatus, SyncOpType } from '../../model/types';
import { newUuid } from './WorkItemRepository';

/** Persistence for the outbox (`sync_queue`). */
export class SyncQueueRepository {
    constructor(private readonly db: Database) {}

    private rows(): SyncOp[] {
        return this.db.table<SyncOp>('sync_queue');
    }

    enqueue(op: { entity: 'workitem' | 'task'; targetId: string; opType: SyncOpType; payload: Record<string, unknown>; baseEtag?: string }): SyncOp {
        const row: SyncOp = {
            opId: newUuid(),
            entity: op.entity,
            targetId: op.targetId,
            opType: op.opType,
            payload: op.payload,
            baseEtag: op.baseEtag,
            status: 'pending',
            attempts: 0,
            createdAt: new Date().toISOString()
        };
        this.rows().push(row);
        this.db.save();
        return row;
    }

    /** Pending ops in FIFO order. */
    pending(): SyncOp[] {
        return this.rows()
            .filter(o => o.status === 'pending')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    pendingCount(): number {
        return this.rows().filter(o => o.status === 'pending' || o.status === 'inflight').length;
    }

    failed(): SyncOp[] {
        return this.rows().filter(o => o.status === 'failed');
    }

    setStatus(opId: string, status: SyncOpStatus, lastError?: string): void {
        const op = this.rows().find(o => o.opId === opId);
        if (!op) return;
        op.status = status;
        if (lastError !== undefined) op.lastError = lastError;
        this.db.save();
    }

    incrementAttempts(opId: string): number {
        const op = this.rows().find(o => o.opId === opId);
        if (!op) return 0;
        op.attempts += 1;
        this.db.save();
        return op.attempts;
    }

    updateBaseEtag(opId: string, etag: string): void {
        const op = this.rows().find(o => o.opId === opId);
        if (op) {
            op.baseEtag = etag;
            this.db.save();
        }
    }

    /** Remove ops that completed (housekeeping). */
    purgeDone(): void {
        this.db.setTable('sync_queue', this.rows().filter(o => o.status !== 'done'));
        this.db.save();
    }
}
