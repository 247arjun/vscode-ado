import { randomUUID } from 'crypto';
import { Database } from '../Database';
import { WorkItemRow } from '../../model/types';

/** Persistence for the canonical ADO mirror (`work_items`). */
export class WorkItemRepository {
    constructor(private readonly db: Database) {}

    getById(adoId: number): WorkItemRow | undefined {
        return this.db.table<WorkItemRow>('work_items').find(w => w.adoId === adoId);
    }

    all(): WorkItemRow[] {
        return this.db.table<WorkItemRow>('work_items').filter(w => !w.deleted);
    }

    /** Insert or update a work item mirror row, then persist. */
    upsert(row: WorkItemRow): void {
        const rows = this.db.table<WorkItemRow>('work_items');
        const idx = rows.findIndex(w => w.adoId === row.adoId);
        if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...row };
        } else {
            rows.push(row);
        }
        this.db.save();
    }

    /** Update only the etag/rev after a successful push. */
    setEtag(adoId: number, etag: string, rev: number): void {
        const row = this.getById(adoId);
        if (row) {
            row.etag = etag;
            row.rev = rev;
            this.db.save();
        }
    }

    markDeleted(adoId: number): void {
        const row = this.getById(adoId);
        if (row) {
            row.deleted = 1;
            this.db.save();
        }
    }
}

/** Build a {@link WorkItemRow} from a raw ADO work item payload. */
export function workItemRowFromAdo(
    adoId: number,
    fields: Record<string, unknown>,
    rev: number,
    org?: string,
    project?: string,
    etag?: string
): WorkItemRow {
    const assigned = fields['System.AssignedTo'];
    let assignedTo: string | undefined;
    if (assigned && typeof assigned === 'object' && 'displayName' in (assigned as any)) {
        assignedTo = String((assigned as any).displayName);
    }
    return {
        adoId,
        rev,
        etag,
        fields,
        org,
        project,
        type: typeof fields['System.WorkItemType'] === 'string' ? (fields['System.WorkItemType'] as string) : undefined,
        state: typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : undefined,
        assignedTo,
        updatedUtc: typeof fields['System.ChangedDate'] === 'string' ? (fields['System.ChangedDate'] as string) : new Date().toISOString(),
        deleted: 0
    };
}

export function newUuid(): string {
    return randomUUID();
}
