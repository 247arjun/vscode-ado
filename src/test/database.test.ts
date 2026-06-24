import * as assert from 'assert';
import { Database, LATEST_SCHEMA_VERSION } from '../db/Database';
import { TaskRepository, isDoneState } from '../db/repositories/TaskRepository';
import { WorkItemRepository, workItemRowFromAdo } from '../db/repositories/WorkItemRepository';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`  \u2713 ${name}`);
            passed++;
        })
        .catch((err) => {
            console.error(`  \u2717 ${name}`);
            console.error(`    ${err.message}`);
            failed++;
        });
}

export async function runTests(): Promise<void> {
    console.log('\nDatabase / Repositories');

    await test('fresh in-memory DB reaches latest schema version', async () => {
        const db = await Database.openInMemory();
        assert.strictEqual(db.schemaVersion, LATEST_SCHEMA_VERSION);
    });

    await test('TaskRepository.createLocal adds an inbox task', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const t = tasks.createLocal('Buy milk');
        assert.strictEqual(t.title, 'Buy milk');
        assert.strictEqual(t.list, 'inbox');
        assert.strictEqual(tasks.getByList('inbox').length, 1);
    });

    await test('reconcileFromWorkItem creates a linked task, then preserves local fields', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        tasks.reconcileFromWorkItem(42, 'Original title', 'Active');
        const t1 = tasks.getByAdoId(42)!;
        // user edits local-only fields
        tasks.update(t1.uuid, { notes: 'my notes', todayFlag: 1, whenDate: '2099-01-01' });
        // ADO pull updates the title (mirrored) but must NOT clobber local fields
        tasks.reconcileFromWorkItem(42, 'New ADO title', 'Active');
        const t2 = tasks.getByAdoId(42)!;
        assert.strictEqual(t2.title, 'New ADO title');
        assert.strictEqual(t2.notes, 'my notes');
        assert.strictEqual(t2.todayFlag, 1);
        assert.strictEqual(t2.whenDate, '2099-01-01');
    });

    await test('closed ADO state auto-completes the task into the logbook', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        tasks.reconcileFromWorkItem(7, 'Fix bug', 'Active');
        tasks.reconcileFromWorkItem(7, 'Fix bug', 'Closed');
        const t = tasks.getByAdoId(7)!;
        assert.ok(t.completedAt, 'expected completedAt to be set');
        assert.strictEqual(t.list, 'logbook');
        assert.strictEqual(tasks.getByList('logbook').length, 1);
    });

    await test('getToday includes today-flagged and past when-dates', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const a = tasks.createLocal('Flagged');
        tasks.moveToToday(a.uuid);
        const b = tasks.createLocal('Past when');
        tasks.setWhen(b.uuid, '2000-01-01');
        const c = tasks.createLocal('Future when');
        tasks.setWhen(c.uuid, '2999-01-01');
        const today = tasks.getToday();
        const titles = today.map(t => t.title).sort();
        assert.deepStrictEqual(titles, ['Flagged', 'Past when']);
    });

    await test('search matches title and notes', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const t = tasks.createLocal('Deploy service');
        tasks.update(t.uuid, { notes: 'remember the rollback plan' });
        assert.strictEqual(tasks.search('rollback').length, 1);
        assert.strictEqual(tasks.search('deploy').length, 1);
        assert.strictEqual(tasks.search('nonexistent').length, 0);
    });

    await test('WorkItemRepository.upsert + workItemRowFromAdo extracts fields', async () => {
        const db = await Database.openInMemory();
        const repo = new WorkItemRepository(db);
        const row = workItemRowFromAdo(100, {
            'System.Title': 'Hello',
            'System.State': 'Active',
            'System.WorkItemType': 'Bug',
            'System.AssignedTo': { displayName: 'Ada Lovelace' }
        }, 1, 'org', 'proj');
        repo.upsert(row);
        const got = repo.getById(100)!;
        assert.strictEqual(got.state, 'Active');
        assert.strictEqual(got.type, 'Bug');
        assert.strictEqual(got.assignedTo, 'Ada Lovelace');
    });

    await test('isDoneState recognizes closed/done states', () => {
        assert.strictEqual(isDoneState('Closed'), true);
        assert.strictEqual(isDoneState('Done'), true);
        assert.strictEqual(isDoneState('Active'), false);
        assert.strictEqual(isDoneState(undefined), false);
    });

    console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
    if (failed > 0) {
        throw new Error(`${failed} database test(s) failed`);
    }
}
