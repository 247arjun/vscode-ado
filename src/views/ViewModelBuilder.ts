import { TaskRepository } from '../db/repositories/TaskRepository';
import { WorkItemRepository } from '../db/repositories/WorkItemRepository';
import { TagRepository } from '../db/repositories/TagRepository';
import { Task } from '../model/types';
import { ViewId, TaskVM, ViewSnapshot, TaskGroupVM } from './protocol';

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
}
