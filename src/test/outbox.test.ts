import * as assert from 'assert';
import { Database } from '../db/Database';
import { WorkItemRepository, workItemRowFromAdo } from '../db/repositories/WorkItemRepository';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { OutboxProcessor } from '../sync/OutboxProcessor';
import { ConflictResolver, ConflictChoice } from '../sync/ConflictResolver';
import type { AdoRestClient, PatchResult } from '../ado/AdoRestClient';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \u2717 ${name}`);
        console.error(`    ${(err as Error).message}`);
        failed++;
    }
}

/** A scriptable fake REST client. */
class FakeRest {
    patchResults: PatchResult[] = [];
    patchCalls: { id: number; etag?: string }[] = [];
    serverState = 'Active';
    serverEtag = 'etag-2';

    async patchWorkItem(_org: string, _project: string, id: number, _ops: unknown, etag?: string): Promise<PatchResult> {
        this.patchCalls.push({ id, etag });
        const next = this.patchResults.shift();
        if (next) return next;
        return { success: true, workItem: { id, fields: {} } as any, etag: 'etag-new', rev: 2 };
    }

    async getWorkItem(_org: string, _project: string, id: number) {
        return { workItem: { id, fields: { 'System.State': this.serverState } } as any, etag: this.serverEtag, rev: 2 };
    }
}

function seedWorkItem(db: Database): void {
    const repo = new WorkItemRepository(db);
    const row = workItemRowFromAdo(55, { 'System.Title': 'Do thing', 'System.State': 'New' }, 1, 'org', 'proj', undefined);
    row.etag = 'etag-1';
    repo.upsert(row);
    const tasks = new TaskRepository(db);
    tasks.reconcileFromWorkItem(55, 'Do thing', 'New');
}

export async function runTests(): Promise<void> {
    console.log('\nOutbox / Conflict resolution');

    await test('successful push marks op done and updates local state', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: true, workItem: { id: 55, fields: {} } as any, etag: 'etag-9', rev: 3 }];
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueStateChange(55, 'Active');
        assert.strictEqual(proc.pendingCount, 1);
        await proc.process();
        assert.strictEqual(proc.pendingCount, 0);
        const wi = new WorkItemRepository(db).getById(55)!;
        assert.strictEqual(wi.state, 'Active');
        assert.strictEqual(wi.etag, 'etag-9');
    });

    await test('412 conflict, server already at desired state -> resolved', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: false, conflict: true, error: { status: 412, message: 'conflict' } }];
        rest.serverState = 'Active'; // server already moved to what we wanted
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueStateChange(55, 'Active');
        await proc.process();
        assert.strictEqual(proc.pendingCount, 0, 'op should be resolved');
    });

    await test('412 conflict, keep mine -> retries with fresh etag', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [
            { success: false, conflict: true, error: { status: 412, message: 'conflict' } },
            { success: true, workItem: { id: 55, fields: {} } as any, etag: 'etag-final', rev: 4 }
        ];
        rest.serverState = 'Resolved'; // different from our desired "Done"
        rest.serverEtag = 'etag-fresh';
        const choice: ConflictChoice = 'mine';
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => choice, () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueStateChange(55, 'Done');
        await proc.process();
        assert.strictEqual(proc.pendingCount, 0, 'op should be done after retry');
        // second patch call used the fresh etag
        assert.strictEqual(rest.patchCalls[1].etag, 'etag-fresh');
    });

    await test('transient failure keeps op pending', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: false, error: { status: 429, message: 'throttled' } }];
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueStateChange(55, 'Active');
        await proc.process();
        assert.strictEqual(proc.pendingCount, 1, 'op should remain pending for retry');
    });

    console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
    if (failed > 0) {
        throw new Error(`${failed} outbox test(s) failed`);
    }
}
