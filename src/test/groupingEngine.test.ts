import * as assert from 'assert';
import { GroupingEngine } from '../grouping/GroupingEngine';
import { WorkItem } from '../ado/AdoClient';
import { GroupSpec } from '../config/Settings';

/**
 * Unit tests for GroupingEngine
 */
function runGroupingEngineTests(): void {
    const engine = new GroupingEngine();

    // ── buildTree with no grouping ───────────────────────────────────

    test('buildTree with no grouping returns flat work items', () => {
        const items = makeWorkItems([
            { id: 1, title: 'Task A', state: 'Active' },
            { id: 2, title: 'Task B', state: 'Closed' }
        ]);

        const tree = engine.buildTree(items, []);
        assert.strictEqual(tree.length, 2);
        assert.strictEqual(tree[0].type, 'workItem');
        assert.strictEqual(tree[1].type, 'workItem');
    });

    // ── buildTree with single group ──────────────────────────────────

    test('buildTree groups by single field', () => {
        const items = makeWorkItems([
            { id: 1, title: 'A', state: 'Active' },
            { id: 2, title: 'B', state: 'Active' },
            { id: 3, title: 'C', state: 'Closed' }
        ]);

        const specs: GroupSpec[] = [{ field: 'System.State' }];
        const tree = engine.buildTree(items, specs);

        assert.strictEqual(tree.length, 2); // Active + Closed
        const activeGroup = tree.find(n => n.type === 'group' && n.key === 'Active');
        const closedGroup = tree.find(n => n.type === 'group' && n.key === 'Closed');
        assert.ok(activeGroup);
        assert.ok(closedGroup);
        if (activeGroup.type === 'group') {
            assert.strictEqual(activeGroup.count, 2);
            assert.strictEqual(activeGroup.children.length, 2);
        }
        if (closedGroup.type === 'group') {
            assert.strictEqual(closedGroup.count, 1);
        }
    });

    // ── buildTree with nested grouping ───────────────────────────────

    test('buildTree supports nested grouping', () => {
        const items = makeWorkItems([
            { id: 1, title: 'A', state: 'Active', priority: 1 },
            { id: 2, title: 'B', state: 'Active', priority: 2 },
            { id: 3, title: 'C', state: 'Closed', priority: 1 }
        ]);

        const specs: GroupSpec[] = [
            { field: 'System.State' },
            { field: 'Microsoft.VSTS.Common.Priority' }
        ];
        const tree = engine.buildTree(items, specs);

        assert.strictEqual(tree.length, 2); // Active + Closed
        const activeGroup = tree.find(n => n.type === 'group' && n.key === 'Active');
        assert.ok(activeGroup);
        if (activeGroup.type === 'group') {
            assert.strictEqual(activeGroup.children.length, 2); // Priority 1 + Priority 2
        }
    });

    // ── getFieldValue with missing values ────────────────────────────

    test('getFieldValue returns missingLabel for missing fields', () => {
        const item: WorkItem = { id: 1, fields: {} };
        const spec: GroupSpec = { field: 'System.AssignedTo', missingLabel: '(unassigned)' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, '(unassigned)');
    });

    test('getFieldValue defaults missingLabel to (none)', () => {
        const item: WorkItem = { id: 1, fields: {} };
        const spec: GroupSpec = { field: 'System.AssignedTo' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, '(none)');
    });

    // ── getFieldValue with identity fields ───────────────────────────

    test('getFieldValue extracts displayName from identity', () => {
        const item: WorkItem = {
            id: 1,
            fields: {
                'System.AssignedTo': { displayName: 'Alice', uniqueName: 'alice@example.com' }
            }
        };
        const spec: GroupSpec = { field: 'System.AssignedTo', projection: 'displayName' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, 'Alice');
    });

    test('getFieldValue extracts uniqueName with projection', () => {
        const item: WorkItem = {
            id: 1,
            fields: {
                'System.AssignedTo': { displayName: 'Alice', uniqueName: 'alice@example.com' }
            }
        };
        const spec: GroupSpec = { field: 'System.AssignedTo', projection: 'uniqueName' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, 'alice@example.com');
    });

    // ── getFieldValue with primitives ────────────────────────────────

    test('getFieldValue stringifies numeric values', () => {
        const item: WorkItem = {
            id: 1,
            fields: { 'Microsoft.VSTS.Common.Priority': 2 }
        };
        const spec: GroupSpec = { field: 'Microsoft.VSTS.Common.Priority' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, '2');
    });

    // ── getFieldValue with date bucketing ────────────────────────────

    test('getFieldValue buckets past dates as overdue', () => {
        const item: WorkItem = {
            id: 1,
            fields: { 'DueDate': '2020-01-01T00:00:00Z' }
        };
        const spec: GroupSpec = { field: 'DueDate', bucket: 'date' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, 'overdue');
    });

    test('getFieldValue buckets far future dates as future', () => {
        const item: WorkItem = {
            id: 1,
            fields: { 'DueDate': '2099-12-31T00:00:00Z' }
        };
        const spec: GroupSpec = { field: 'DueDate', bucket: 'date' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, 'future');
    });

    test('getFieldValue buckets missing dates as none', () => {
        const item: WorkItem = {
            id: 1,
            fields: { 'DueDate': null }
        };
        const spec: GroupSpec = { field: 'DueDate', bucket: 'date' };
        const value = engine.getFieldValue(item, spec);
        assert.strictEqual(value, '(none)');
    });

    // ── Sorting ──────────────────────────────────────────────────────

    test('work items sorted by priority then id', () => {
        const items = makeWorkItems([
            { id: 3, title: 'C', priority: 2 },
            { id: 1, title: 'A', priority: 1 },
            { id: 2, title: 'B', priority: 1 }
        ]);

        const tree = engine.buildTree(items, []);
        assert.strictEqual(tree.length, 3);
        if (tree[0].type === 'workItem' && tree[1].type === 'workItem' && tree[2].type === 'workItem') {
            assert.strictEqual(tree[0].id, 1); // priority 1, id 1
            assert.strictEqual(tree[1].id, 2); // priority 1, id 2
            assert.strictEqual(tree[2].id, 3); // priority 2, id 3
        }
    });

    test('groups sorted alphabetically by key', () => {
        const items = makeWorkItems([
            { id: 1, title: 'A', state: 'Closed' },
            { id: 2, title: 'B', state: 'Active' },
            { id: 3, title: 'C', state: 'New' }
        ]);

        const specs: GroupSpec[] = [{ field: 'System.State' }];
        const tree = engine.buildTree(items, specs);
        assert.strictEqual(tree.length, 3);
        if (tree[0].type === 'group') {
            assert.strictEqual(tree[0].key, 'Active');
        }
        if (tree[1].type === 'group') {
            assert.strictEqual(tree[1].key, 'Closed');
        }
        if (tree[2].type === 'group') {
            assert.strictEqual(tree[2].key, 'New');
        }
    });

    // ── Empty input ──────────────────────────────────────────────────

    test('buildTree handles empty work items', () => {
        const tree = engine.buildTree([], [{ field: 'System.State' }]);
        assert.strictEqual(tree.length, 0);
    });

    test('buildTree handles empty work items with no specs', () => {
        const tree = engine.buildTree([], []);
        assert.strictEqual(tree.length, 0);
    });
}

// ─── Test helpers ────────────────────────────────────────────────────

interface MockWorkItemData {
    id: number;
    title: string;
    state?: string;
    priority?: number;
    workItemType?: string;
}

function makeWorkItems(data: MockWorkItemData[]): WorkItem[] {
    return data.map(d => ({
        id: d.id,
        fields: {
            'System.Id': d.id,
            'System.Title': d.title,
            'System.State': d.state ?? 'Active',
            'System.WorkItemType': d.workItemType ?? 'Task',
            'Microsoft.VSTS.Common.Priority': d.priority ?? 2
        }
    }));
}

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name: string, fn: () => void): void {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failCount++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err}`);
    }
}

// ─── Run ─────────────────────────────────────────────────────────────

export function runTests(): void {
    console.log('\n=== GroupingEngine Tests ===\n');
    runGroupingEngineTests();
    console.log(`\n${passCount}/${testCount} passed, ${failCount} failed\n`);
    if (failCount > 0) {
        process.exit(1);
    }
}
