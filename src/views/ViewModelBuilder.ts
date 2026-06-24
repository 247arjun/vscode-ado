import { TaskRepository } from '../db/repositories/TaskRepository';
import { WorkItemRepository } from '../db/repositories/WorkItemRepository';
import { TagRepository } from '../db/repositories/TagRepository';
import { Task } from '../model/types';
import { ViewId, TaskVM, ViewSnapshot, TaskGroupVM, TaskDetailVM, DetailField } from './protocol';

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

    /** Build the read-only detail for a single task (rich ADO + local fields). */
    buildDetail(uuid: string): TaskDetailVM | undefined {
        const task = this.tasks.getByUuid(uuid);
        if (!task) return undefined;

        const detail: TaskDetailVM = {
            uuid: task.uuid,
            title: task.title,
            adoId: task.adoId,
            notes: task.notes,
            fields: []
        };

        const fields = detail.fields;
        const localTags = this.tags?.namesFor(task.tagIds) ?? [];

        if (task.adoId !== undefined) {
            const wi = this.workItems.getById(task.adoId);
            const f = wi?.fields ?? {};
            detail.type = wi?.type;
            detail.state = wi?.state;

            const desc = f['System.Description'];
            if (typeof desc === 'string' && desc.trim()) detail.description = desc;

            const push = (label: string, raw: unknown, kind?: DetailField['kind']) => {
                const value = this.formatFieldValue(raw, kind);
                if (value) fields.push({ label, value, kind });
            };

            push('Type', wi?.type);
            push('State', wi?.state);
            push('Reason', f['System.Reason']);
            push('Assigned To', f['System.AssignedTo'], 'identity');
            push('Area Path', f['System.AreaPath']);
            push('Iteration', f['System.IterationPath']);
            push('Priority', f['Microsoft.VSTS.Common.Priority']);
            push('Severity', f['Microsoft.VSTS.Common.Severity']);
            push('Story Points', f['Microsoft.VSTS.Scheduling.StoryPoints']);
            push('Effort', f['Microsoft.VSTS.Scheduling.Effort']);
            push('Remaining Work', f['Microsoft.VSTS.Scheduling.RemainingWork']);
            push('Start Date', f['Microsoft.VSTS.Scheduling.StartDate'], 'date');
            push('Due Date', f['Microsoft.VSTS.Scheduling.DueDate'], 'date');
            const adoTags = typeof f['System.Tags'] === 'string' ? (f['System.Tags'] as string) : '';
            if (adoTags) push('ADO Tags', adoTags.split(';').map(t => t.trim()).filter(Boolean).join(', '));
            push('Created By', f['System.CreatedBy'], 'identity');
            push('Created', f['System.CreatedDate'], 'date');
            push('Changed By', f['System.ChangedBy'], 'identity');
            push('Changed', f['System.ChangedDate'], 'date');

            detail.url = wi?.fields?.['_url'] && typeof wi.fields['_url'] === 'string' ? (wi.fields['_url'] as string) : undefined;
        } else {
            fields.push({ label: 'Source', value: 'Local-only task (not in Azure DevOps)' });
        }

        // Local-only fields always shown.
        if (task.whenDate) fields.push({ label: 'When', value: task.whenDate, kind: 'date' });
        if (task.deadline) fields.push({ label: 'Deadline', value: task.deadline, kind: 'date' });
        if (localTags.length > 0) fields.push({ label: 'Tags', value: localTags.join(', ') });

        return detail;
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
