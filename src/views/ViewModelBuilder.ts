import { TaskRepository } from '../db/repositories/TaskRepository';
import { WorkItemRepository } from '../db/repositories/WorkItemRepository';
import { TagRepository } from '../db/repositories/TagRepository';
import { Task } from '../model/types';
import { ViewId, TaskVM, ViewSnapshot, TaskGroupVM, TaskDetailVM, DetailField } from './protocol';
import { resolveDetailFields } from './detailFields';

const VIEW_TITLES: Record<string, string> = {
    inbox: 'Inbox',
    today: 'Today',
    upcoming: 'Upcoming',
    anytime: 'Anytime',
    someday: 'Someday',
    logbook: 'Logbook'
};

function dateHeader(iso: string): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(iso + 'T00:00:00');
    const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Builds {@link ViewSnapshot}s for the workbench from repositories. */
export class ViewModelBuilder {
    constructor(
        private readonly tasks: TaskRepository,
        private readonly workItems: WorkItemRepository,
        private readonly tags?: TagRepository
    ) {}

    toVM(task: Task): TaskVM {
        let state: string | undefined;
        let type: string | undefined;
        if (task.adoId !== undefined) {
            const wi = this.workItems.getById(task.adoId);
            state = wi?.state;
            type = wi?.type;
        }
        return {
            uuid: task.uuid,
            title: task.title,
            notes: task.notes,
            adoId: task.adoId,
            state,
            type,
            whenDate: task.whenDate,
            deadline: task.deadline,
            completed: !!task.completedAt || !!task.canceledAt,
            today: task.todayFlag === 1,
            tags: this.tags?.namesFor(task.tagIds) ?? []
        };
    }

    build(view: ViewId): ViewSnapshot {
        if (view === 'today') {
            const tasks = this.tasks.getToday().map(t => this.toVM(t));
            return { view, title: 'Today', subtitle: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), groups: [{ tasks }] };
        }

        if (view === 'upcoming') {
            const tasks = this.tasks.getUpcoming();
            const buckets = new Map<string, TaskVM[]>();
            for (const t of tasks) {
                const key = t.whenDate ?? t.deadline ?? '';
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key)!.push(this.toVM(t));
            }
            const groups: TaskGroupVM[] = [...buckets.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([key, t]) => ({ header: key ? dateHeader(key) : 'Scheduled', tasks: t }));
            return { view, title: 'Upcoming', groups };
        }

        if (view === 'logbook') {
            const tasks = this.tasks.getByList('logbook').map(t => this.toVM(t));
            return { view, title: 'Logbook', groups: [{ tasks }] };
        }

        if (view.startsWith('project:')) {
            const uuid = view.slice('project:'.length);
            const tasks = this.tasks.all()
                .filter(t => t.projectUuid === uuid && !t.completedAt && !t.canceledAt)
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map(t => this.toVM(t));
            return { view, title: 'Project', groups: [{ tasks }] };
        }

        // inbox / anytime / someday
        const listName = view as 'inbox' | 'anytime' | 'someday';
        const tasks = this.tasks.getByList(listName).map(t => this.toVM(t));
        return { view, title: VIEW_TITLES[listName] ?? 'Tasks', groups: [{ tasks }] };
    }

    /** Build the detail for a single task, honoring the configured field set. */
    buildDetail(uuid: string, configKeys?: string[]): TaskDetailVM | undefined {
        const task = this.tasks.getByUuid(uuid);
        if (!task) return undefined;

        const detail: TaskDetailVM = {
            uuid: task.uuid,
            title: task.title,
            adoId: task.adoId,
            notes: task.notes,
            fields: []
        };

        const defs = resolveDetailFields(configKeys);
        const localTags = this.tags?.namesFor(task.tagIds) ?? [];
        const wi = task.adoId !== undefined ? this.workItems.getById(task.adoId) : undefined;
        const f = wi?.fields ?? {};
        detail.type = wi?.type;
        detail.state = wi?.state;
        detail.url = typeof f['_url'] === 'string' ? (f['_url'] as string) : undefined;

        if (task.adoId === undefined) {
            detail.fields.push({ label: 'Source', value: 'Local-only task (not in Azure DevOps)' });
        }

        for (const def of defs) {
            // Description renders in its own block, gated by its key being present.
            if (def.key === 'System.Description') {
                const desc = f['System.Description'];
                if (typeof desc === 'string' && desc.trim()) detail.description = desc;
                continue;
            }

            if (def.source === 'local') {
                this.pushLocalField(detail, def, task, localTags);
                continue;
            }

            // ADO field
            if (task.adoId === undefined) continue; // no ADO data for local tasks
            const raw = def.ref ? f[def.ref] : undefined;
            const kind: DetailField['kind'] | undefined =
                def.control === 'date' ? 'date' : def.control === 'identity' ? 'identity' : undefined;
            const value = this.formatFieldValue(raw, kind);
            const editable = def.editable && task.adoId !== undefined;
            // Always show editable fields (so users can set an empty one); only
            // skip empty read-only fields to keep the pane tidy.
            if (!value && !editable) continue;
            // Identity fields edit by unique name (email); display by name.
            const editValue = def.control === 'identity'
                ? this.identityUniqueName(raw)
                : this.editValueFor(raw, def.control);
            detail.fields.push({
                label: def.label,
                value,
                kind,
                key: def.key,
                ref: def.ref,
                source: 'ado',
                control: def.control,
                editable,
                options: def.options,
                editValue
            });
        }

        return detail;
    }

    private pushLocalField(detail: TaskDetailVM, def: { key: string; label: string; control: string; editable: boolean }, task: Task, localTags: string[]): void {
        if (def.key === 'local.when') {
            detail.fields.push({
                label: def.label,
                value: task.whenDate ? this.formatFieldValue(task.whenDate, 'date') : '',
                kind: 'date', key: def.key, source: 'local', control: 'date', editable: true,
                editValue: task.whenDate ?? ''
            });
        } else if (def.key === 'local.deadline') {
            detail.fields.push({
                label: def.label,
                value: task.deadline ? this.formatFieldValue(task.deadline, 'date') : '',
                kind: 'date', key: def.key, source: 'local', control: 'date', editable: true,
                editValue: task.deadline ?? ''
            });
        } else if (def.key === 'local.tags') {
            if (localTags.length > 0) {
                detail.fields.push({ label: def.label, value: localTags.join(', '), key: def.key, source: 'local', control: 'readonly', editable: false });
            }
        }
    }

    /** Extract an identity's unique name (email/UPN) for editing. */
    private identityUniqueName(raw: unknown): string {
        if (raw && typeof raw === 'object') {
            const id = raw as Record<string, unknown>;
            if (typeof id['uniqueName'] === 'string') return id['uniqueName'] as string;
            if (typeof id['displayName'] === 'string') return id['displayName'] as string;
        }
        return typeof raw === 'string' ? raw : '';
    }

    /** Raw value for binding to an editor control. */
    private editValueFor(raw: unknown, control: string): string {
        if (raw === null || raw === undefined) return '';
        if (control === 'date' && typeof raw === 'string') {
            // ADO dates are ISO datetimes; the <input type=date> wants YYYY-MM-DD.
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        }
        if (typeof raw === 'object') return '';
        return String(raw);
    }

    /** Render an ADO field value to a display string. */
    private formatFieldValue(raw: unknown, kind?: DetailField['kind']): string {
        if (raw === null || raw === undefined || raw === '') return '';
        if (kind === 'identity' && typeof raw === 'object') {
            const id = raw as Record<string, unknown>;
            if (typeof id['displayName'] === 'string') return id['displayName'] as string;
        }
        if (kind === 'date' && typeof raw === 'string') {
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        if (typeof raw === 'object') return JSON.stringify(raw);
        return String(raw);
    }
}
