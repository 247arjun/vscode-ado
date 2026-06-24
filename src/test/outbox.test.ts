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

    await test('update_fields op pushes a field and updates the mirror', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: true, workItem: { id: 55, fields: {} } as any, etag: 'etag-7', rev: 4 }];
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueFieldUpdate(55, 'Microsoft.VSTS.Common.Priority', 1);
        assert.strictEqual(proc.pendingCount, 1);
        await proc.process();
        assert.strictEqual(proc.pendingCount, 0);
        const wi = new WorkItemRepository(db).getById(55)!;
        assert.strictEqual(wi.fields['Microsoft.VSTS.Common.Priority'], 1);
        assert.strictEqual(wi.etag, 'etag-7');
    });

    await test('update_fields with empty value clears the field', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: true, workItem: { id: 55, fields: {} } as any, etag: 'etag-8', rev: 5 }];
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        const wiRepo = new WorkItemRepository(db);
        wiRepo.getById(55)!.fields['Microsoft.VSTS.Common.Priority'] = 2;
        proc.enqueueFieldUpdate(55, 'Microsoft.VSTS.Common.Priority', '');
        await proc.process();
        assert.strictEqual(wiRepo.getById(55)!.fields['Microsoft.VSTS.Common.Priority'], undefined);
    });

    await test('create_work_item op creates and links a new ADO work item', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const local = tasks.createLocal('Follow-up with Sana');
        assert.strictEqual(local.adoId, undefined);

        const rest = {
            async createWorkItem(_o: string, _p: string, _type: string, fields: Record<string, unknown>) {
                return { success: true, workItem: { id: 9001, fields: { 'System.Title': fields['System.Title'], 'System.State': 'New', 'System.WorkItemType': 'Task' } } as any, etag: 'e1', rev: 1 } as PatchResult;
            },
            async patchWorkItem() { return { success: true } as PatchResult; },
            async getWorkItem() { return undefined; }
        };
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueCreate(local.uuid, 'Task', 'org', 'proj', local.title);
        await proc.process();

        const linked = tasks.getByUuid(local.uuid)!;
        assert.strictEqual(linked.adoId, 9001, 'task should be linked to the new work item');
        assert.strictEqual(proc.pendingCount, 0);
        assert.ok(new WorkItemRepository(db).getById(9001), 'work item mirror row should exist');
    });

    await test('create_work_item passes the assignee through to ADO', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const local = tasks.createLocal('Assign me');
        let capturedFields: Record<string, unknown> = {};
        const rest = {
            async createWorkItem(_o: string, _p: string, _type: string, fields: Record<string, unknown>) {
                capturedFields = fields;
                return { success: true, workItem: { id: 4242, fields } as any, etag: 'e', rev: 1 } as PatchResult;
            },
            async patchWorkItem() { return { success: true } as PatchResult; },
            async getWorkItem() { return undefined; }
        };
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueCreate(local.uuid, 'Task', 'org', 'proj', local.title, 'me@contoso.com');
        await proc.process();
        assert.strictEqual(capturedFields['System.AssignedTo'], 'me@contoso.com');
        assert.strictEqual(tasks.getByUuid(local.uuid)!.adoId, 4242);
    });

    await test('update_fields can set System.AssignedTo', async () => {
        const db = await Database.openInMemory();
        seedWorkItem(db);
        const rest = new FakeRest();
        rest.patchResults = [{ success: true, workItem: { id: 55, fields: {} } as any, etag: 'etag-a', rev: 6 }];
        const resolver = new ConflictResolver(rest as unknown as AdoRestClient, new WorkItemRepository(db), async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, rest as unknown as AdoRestClient, resolver, () => {});
        proc.enqueueFieldUpdate(55, 'System.AssignedTo', 'someone@contoso.com');
        await proc.process();
        assert.strictEqual(new WorkItemRepository(db).getById(55)!.fields['System.AssignedTo'], 'someone@contoso.com');
    });

    await test('soak: many ops with intermittent throttling eventually drain', async () => {
        const db = await Database.openInMemory();
        const wiRepo = new WorkItemRepository(db);
        for (let i = 1; i <= 20; i++) {
            const row = workItemRowFromAdo(i, { 'System.Title': `t${i}`, 'System.State': 'New' }, 1, 'org', 'proj');
            row.etag = `e${i}`;
            wiRepo.upsert(row);
        }
        // Fail the first attempt of each op (throttling), succeed on retry —
        // this proves every op eventually drains with no data loss.
        const attemptsById: Record<number, number> = {};
        const flaky = {
            async patchWorkItem(_o: string, _p: string, id: number) {
                attemptsById[id] = (attemptsById[id] ?? 0) + 1;
                if (attemptsById[id] === 1) {
                    return { success: false, error: { status: 429, message: 'throttled' } } as PatchResult;
                }
                return { success: true, workItem: { id, fields: {} } as any, etag: `new${id}`, rev: 2 } as PatchResult;
            },
            async getWorkItem(_o: string, _p: string, id: number) {
                return { workItem: { id, fields: { 'System.State': 'New' } } as any, etag: 'x', rev: 2 };
            }
        };
        const resolver = new ConflictResolver(flaky as unknown as AdoRestClient, wiRepo, async () => 'theirs', () => {});
        const proc = new OutboxProcessor(db, flaky as unknown as AdoRestClient, resolver, () => {});
        for (let i = 1; i <= 20; i++) proc.enqueueStateChange(i, 'Active');

        // Drain across multiple cycles, as transient failures are retried.
        for (let cycle = 0; cycle < 10 && proc.pendingCount > 0; cycle++) {
            await proc.process();
        }
        assert.strictEqual(proc.pendingCount, 0, 'all ops should eventually drain');
    });

    console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
    if (failed > 0) {
        throw new Error(`${failed} outbox test(s) failed`);
    }
}
