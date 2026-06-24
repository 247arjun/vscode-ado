import { Database } from '../Database';
import { SyncStateRow } from '../../model/types';

/** Tracks how far we've pulled from each source, for incremental sync. */
export class SyncStateRepository {
    constructor(private readonly db: Database) {}

    get(sourceKey: string): SyncStateRow | undefined {
        return this.db.table<SyncStateRow>('sync_state').find(s => s.sourceKey === sourceKey);
    }

    set(sourceKey: string, watermark: string | undefined): void {
        const rows = this.db.table<SyncStateRow>('sync_state');
        const existing = rows.find(s => s.sourceKey === sourceKey);
        const lastSyncedUtc = new Date().toISOString();
        if (existing) {
            existing.watermark = watermark;
            existing.lastSyncedUtc = lastSyncedUtc;
        } else {
            rows.push({ sourceKey, watermark, lastSyncedUtc });
        }
        this.db.save();
    }
}
