import * as assert from 'assert';
import { orderBetween, needsRebalance } from '../views/ordering';
import { parseQuickEntry } from '../views/quickEntry';
import { Database } from '../db/Database';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { WorkItemRepository, workItemRowFromAdo } from '../db/repositories/WorkItemRepository';
import { ProjectRepository } from '../db/repositories/ProjectRepository';
import { TagRepository } from '../db/repositories/TagRepository';
import { ViewModelBuilder } from '../views/ViewModelBuilder';
import { UndoStack } from '../undo/UndoStack';

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

export async function runTests(): Promise<void> {
    console.log('\nPhase 5 — ordering / quick entry / projects / undo');

    await test('orderBetween produces a value strictly between neighbours', () => {
        assert.strictEqual(orderBetween(undefined, undefined), 1);
        assert.strictEqual(orderBetween(2, undefined), 3);
        assert.strictEqual(orderBetween(undefined, 5), 4);
        const mid = orderBetween(1, 2);
        assert.ok(mid > 1 && mid < 2, 'midpoint between 1 and 2');
    });

    await test('needsRebalance flags exhausted precision', () => {
        assert.strictEqual(needsRebalance(1, 2), false);
        assert.strictEqual(needsRebalance(1, 1 + 1e-12), true);
    });

    await test('parseQuickEntry extracts tags and tomorrow', () => {
        const now = new Date('2026-06-24T12:00:00');
        const parsed = parseQuickEntry('Email Bob #work tomorrow', now);
        assert.strictEqual(parsed.title, 'Email Bob');
        assert.deepStrictEqual(parsed.tags, ['work']);
        assert.strictEqual(parsed.whenDate, '2026-06-25');
    });

    await test('parseQuickEntry handles today and multiple tags', () => {
        const now = new Date('2026-06-24T12:00:00');
        const parsed = parseQuickEntry('#a Plan sprint #b today', now);
        assert.strictEqual(parsed.title, 'Plan sprint');
        assert.deepStrictEqual(parsed.tags.sort(), ['a', 'b']);
        assert.strictEqual(parsed.whenDate, '2026-06-24');
    });

    await test('TaskRepository.reorder positions between siblings', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const a = tasks.createLocal('A'); // order 1
        const b = tasks.createLocal('B'); // order 2
        const c = tasks.createLocal('C'); // order 3
        tasks.reorder(c.uuid, a.uuid, b.uuid); // move C between A and B
        const order = tasks.getByList('inbox').map(t => t.title);
        assert.deepStrictEqual(order, ['A', 'C', 'B']);
    });

    await test('ProjectRepository progress reflects completion', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const projects = new ProjectRepository(db, tasks);
        const p = projects.createProject('Launch');
        const t1 = tasks.createLocal('one');
        const t2 = tasks.createLocal('two');
        tasks.assignToProject(t1.uuid, p.uuid);
        tasks.assignToProject(t2.uuid, p.uuid);
        tasks.complete(t1.uuid);
        const prog = projects.progress(p.uuid);
        assert.strictEqual(prog.total, 2);
        assert.strictEqual(prog.done, 1);
        assert.strictEqual(prog.ratio, 0.5);
    });

    await test('TagRepository.getOrCreate is idempotent (case-insensitive)', async () => {
        const db = await Database.openInMemory();
        const tags = new TagRepository(db);
        const a = tags.getOrCreate('Work');
        const b = tags.getOrCreate('work');
        assert.strictEqual(a.id, b.id);
        assert.deepStrictEqual(tags.namesFor([a.id]), ['Work']);
    });

    await test('UndoStack restores a completed task', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const undo = new UndoStack();
        const t = tasks.createLocal('Reversible');
        const snap = tasks.snapshot(t.uuid)!;
        tasks.complete(t.uuid);
        undo.push('Complete task', () => tasks.restoreSnapshot(snap));
        assert.strictEqual(tasks.getByList('logbook').length, 1);
        undo.undo();
        assert.strictEqual(tasks.getByList('logbook').length, 0);
        assert.strictEqual(tasks.getByList('inbox').length, 1);
    });

    await test('buildDetail exposes rich ADO fields for a linked task', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const wi = new WorkItemRepository(db);
        const tags = new TagRepository(db);
        wi.upsert(workItemRowFromAdo(321, {
            'System.Title': 'Investigate latency',
            'System.State': 'Active',
            'System.WorkItemType': 'Bug',
            'System.Description': '<div>Page loads slowly</div>',
            'System.AssignedTo': { displayName: 'Ada Lovelace' },
            'System.AreaPath': 'Contoso\\Web',
            'System.IterationPath': 'Contoso\\Sprint 5',
            'Microsoft.VSTS.Common.Priority': 1
        }, 3, 'Contoso', 'Web'));
        tasks.reconcileFromWorkItem(321, 'Investigate latency', 'Active');

        const builder = new ViewModelBuilder(tasks, wi, tags);
        const task = tasks.getByAdoId(321)!;
        const detail = builder.buildDetail(task.uuid)!;

        assert.strictEqual(detail.adoId, 321);
        assert.strictEqual(detail.type, 'Bug');
        assert.ok(detail.description && detail.description.includes('slowly'));
        const byLabel = (l: string) => detail.fields.find(f => f.label === l)?.value;
        assert.strictEqual(byLabel('Assigned To'), 'Ada Lovelace');
        assert.strictEqual(byLabel('Area Path'), 'Contoso\\Web');
        assert.strictEqual(byLabel('Iteration'), 'Contoso\\Sprint 5');
        assert.strictEqual(byLabel('Priority'), '1');
    });

    await test('buildDetail marks a local-only task as not in ADO', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const wi = new WorkItemRepository(db);
        const builder = new ViewModelBuilder(tasks, wi, new TagRepository(db));
        const t = tasks.createLocal('Just local');
        const detail = builder.buildDetail(t.uuid)!;
        assert.strictEqual(detail.adoId, undefined);
        assert.ok(detail.fields.some(f => f.value.includes('Local-only')));
    });

    await test('buildDetail honors a custom field list and marks editability', async () => {
        const db = await Database.openInMemory();
        const tasks = new TaskRepository(db);
        const wi = new WorkItemRepository(db);
        wi.upsert(workItemRowFromAdo(50, {
            'System.Title': 'X', 'System.State': 'Active', 'System.WorkItemType': 'Task',
            'Microsoft.VSTS.Common.Priority': 2, 'System.AssignedTo': { displayName: 'Bob' }
        }, 1, 'Org', 'Proj'));
        tasks.reconcileFromWorkItem(50, 'X', 'Active');
        const builder = new ViewModelBuilder(tasks, wi, new TagRepository(db));
        const t = tasks.getByAdoId(50)!;
        // Only Priority + AssignedTo, in that order.
        const detail = builder.buildDetail(t.uuid, ['Microsoft.VSTS.Common.Priority', 'System.AssignedTo'])!;
        assert.strictEqual(detail.fields.length, 2);
        assert.strictEqual(detail.fields[0].label, 'Priority');
        assert.strictEqual(detail.fields[0].editable, true);
        assert.strictEqual(detail.fields[0].editValue, '2');
        assert.strictEqual(detail.fields[1].label, 'Assigned To');
        assert.strictEqual(detail.fields[1].editable, false);
    });

    console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
    if (failed > 0) {
        throw new Error(`${failed} phase-5 test(s) failed`);
    }
}
