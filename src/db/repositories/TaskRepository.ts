import { Database } from '../Database';
import { Task, ListName } from '../../model/types';
import { newUuid } from './WorkItemRepository';
import { orderBetween } from '../../views/ordering';

const DONE_STATE_CATEGORIES = ['Completed', 'Resolved', 'Closed', 'Done'];

/** States that should auto-complete a task (closed/done category). */
export function isDoneState(state: string | undefined): boolean {
    if (!state) return false;
    const s = state.toLowerCase();
    return ['closed', 'done', 'completed', 'resolved', 'removed'].includes(s);
}

function nowIso(): string {
    return new Date().toISOString();
}

function todayIso(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

/**
 * Persistence + business logic for the user-facing `tasks` collection.
 *
 * This is the source of truth for organization (which list, today-flag, manual
 * order, local notes/tags). Reconciliation from ADO updates ONLY mirrored fields
 * and never clobbers local-only fields.
 */
export class TaskRepository {
    constructor(private readonly db: Database) {}

    private rows(): Task[] {
        return this.db.table<Task>('tasks');
    }

    getByUuid(uuid: string): Task | undefined {
        return this.rows().find(t => t.uuid === uuid);
    }

    getByAdoId(adoId: number): Task | undefined {
        return this.rows().find(t => t.adoId === adoId);
    }

    all(): Task[] {
        return [...this.rows()];
    }

    private active(): Task[] {
        return this.rows().filter(t => !t.completedAt && !t.canceledAt);
    }

    /** Tasks in a stored list (inbox/anytime/someday), sorted by manual order. */
    getByList(list: ListName): Task[] {
        if (list === 'logbook') {
            return this.rows()
                .filter(t => t.completedAt || t.canceledAt)
                .sort((a, b) => (b.completedAt ?? b.canceledAt ?? '').localeCompare(a.completedAt ?? a.canceledAt ?? ''));
        }
        return this.active()
            .filter(t => t.list === list)
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    /** DERIVED: today-flagged OR whenDate on/before today, and still active. */
    getToday(): Task[] {
        const today = todayIso();
        return this.active()
            .filter(t => t.todayFlag === 1 || (t.whenDate !== undefined && t.whenDate <= today))
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    /** DERIVED: future whenDate or deadline, grouped by the caller. */
    getUpcoming(): Task[] {
        const today = todayIso();
        return this.active()
            .filter(t => (t.whenDate !== undefined && t.whenDate > today) || (t.deadline !== undefined && t.deadline > today))
            .sort((a, b) => (a.whenDate ?? a.deadline ?? '').localeCompare(b.whenDate ?? b.deadline ?? ''));
    }

    private nextSortOrder(list: ListName): number {
        const existing = this.active().filter(t => t.list === list);
        if (existing.length === 0) return 1;
        return Math.max(...existing.map(t => t.sortOrder)) + 1;
    }

    /** Create a local-only task (e.g. from quick capture). */
    createLocal(title: string, list: ListName = 'inbox'): Task {
        const task: Task = {
            uuid: newUuid(),
            title,
            notes: '',
            list,
            todayFlag: 0,
            sortOrder: this.nextSortOrder(list),
            tagIds: [],
            createdAt: nowIso(),
            updatedAt: nowIso()
        };
        this.rows().push(task);
        this.db.save();
        return task;
    }

    /**
     * Reconcile a work item into a task. Creates a linked task on first sight;
     * otherwise updates ONLY mirrored fields (title, state) and never touches
     * local-only fields (notes, whenDate, todayFlag, tags, sortOrder, list).
     */
    reconcileFromWorkItem(adoId: number, title: string, state: string | undefined): Task {
        let task = this.getByAdoId(adoId);
        if (!task) {
            task = {
                uuid: newUuid(),
                adoId,
                title,
                notes: '',
                list: 'inbox',
                todayFlag: 0,
                sortOrder: this.nextSortOrder('inbox'),
                tagIds: [],
                createdAt: nowIso(),
                updatedAt: nowIso()
            };
            this.rows().push(task);
        } else {
            task.title = title; // mirrored
            task.updatedAt = nowIso();
        }

        // Auto-complete (move to Logbook) when ADO closes the item, but preserve
        // history — never delete.
        if (isDoneState(state) && !task.completedAt) {
            task.completedAt = nowIso();
            task.list = 'logbook';
        } else if (!isDoneState(state) && task.completedAt && task.list === 'logbook') {
            // Re-opened in ADO: bring it back.
            task.completedAt = undefined;
            task.list = 'inbox';
        }

        this.db.save();
        return task;
    }

    update(uuid: string, patch: Partial<Task>): Task | undefined {
        const task = this.getByUuid(uuid);
        if (!task) return undefined;
        Object.assign(task, patch, { updatedAt: nowIso() });
        this.db.save();
        return task;
    }

    complete(uuid: string): void {
        const task = this.getByUuid(uuid);
        if (!task) return;
        task.completedAt = nowIso();
        task.list = 'logbook';
        task.todayFlag = 0;
        task.updatedAt = nowIso();
        this.db.save();
    }

    uncomplete(uuid: string): void {
        const task = this.getByUuid(uuid);
        if (!task) return;
        task.completedAt = undefined;
        task.canceledAt = undefined;
        task.list = 'inbox';
        task.updatedAt = nowIso();
        this.db.save();
    }

    moveToToday(uuid: string): void {
        this.update(uuid, { todayFlag: 1 });
    }

    setWhen(uuid: string, whenDate: string | undefined): void {
        this.update(uuid, { whenDate });
    }

    setDeadline(uuid: string, deadline: string | undefined): void {
        this.update(uuid, { deadline });
    }

    /** Simple offline full-text search over title + notes. */
    search(query: string): Task[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return this.rows().filter(t =>
            t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q)
        );
    }

    /** Manually reposition a task between two siblings (fractional indexing). */
    reorder(uuid: string, beforeUuid?: string, afterUuid?: string): void {
        const before = beforeUuid ? this.getByUuid(beforeUuid)?.sortOrder : undefined;
        const after = afterUuid ? this.getByUuid(afterUuid)?.sortOrder : undefined;
        this.update(uuid, { sortOrder: orderBetween(before, after) });
    }

    /** Replace the local-only tag set on a task. */
    setTags(uuid: string, tagIds: number[]): void {
        this.update(uuid, { tagIds });
    }

    addTag(uuid: string, tagId: number): void {
        const task = this.getByUuid(uuid);
        if (!task) return;
        if (!task.tagIds.includes(tagId)) {
            this.update(uuid, { tagIds: [...task.tagIds, tagId] });
        }
    }

    /** Move a task into (or out of) a project. */
    assignToProject(uuid: string, projectUuid: string | undefined): void {
        this.update(uuid, { projectUuid });
    }

    /** Deep-clone a task for undo snapshots. */
    snapshot(uuid: string): Task | undefined {
        const task = this.getByUuid(uuid);
        return task ? JSON.parse(JSON.stringify(task)) as Task : undefined;
    }

    /** Restore a previously captured snapshot (re-inserting if it was removed). */
    restoreSnapshot(snap: Task): void {
        const rows = this.rows();
        const idx = rows.findIndex(t => t.uuid === snap.uuid);
        if (idx >= 0) {
            rows[idx] = snap;
        } else {
            rows.push(snap);
        }
        this.db.save();
    }

    /** Remove a task entirely (used to undo a creation). */
    remove(uuid: string): void {
        this.db.setTable('tasks', this.rows().filter(t => t.uuid !== uuid));
        this.db.save();
    }
}
