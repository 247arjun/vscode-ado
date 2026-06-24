import { Database } from '../Database';
import { Project, Area } from '../../model/types';
import { TaskRepository } from './TaskRepository';
import { newUuid } from './WorkItemRepository';

/** Projects and Areas (Things' "Areas of Responsibility"). */
export class ProjectRepository {
    constructor(private readonly db: Database, private readonly tasks: TaskRepository) {}

    private projects(): Project[] {
        return this.db.table<Project>('projects');
    }

    private areas(): Area[] {
        return this.db.table<Area>('areas');
    }

    allProjects(): Project[] {
        return [...this.projects()].sort((a, b) => a.sortOrder - b.sortOrder);
    }

    allAreas(): Area[] {
        return [...this.areas()].sort((a, b) => a.sortOrder - b.sortOrder);
    }

    getProject(uuid: string): Project | undefined {
        return this.projects().find(p => p.uuid === uuid);
    }

    createProject(name: string, areaUuid?: string, adoBinding?: Record<string, unknown>): Project {
        const sortOrder = this.projects().reduce((m, p) => Math.max(m, p.sortOrder), 0) + 1;
        const project: Project = { uuid: newUuid(), name, areaUuid, adoBinding, sortOrder };
        this.projects().push(project);
        this.db.save();
        return project;
    }

    createArea(name: string): Area {
        const sortOrder = this.areas().reduce((m, a) => Math.max(m, a.sortOrder), 0) + 1;
        const area: Area = { uuid: newUuid(), name, sortOrder };
        this.areas().push(area);
        this.db.save();
        return area;
    }

    /** Completion ratio 0..1 for a project's tasks. */
    progress(projectUuid: string): { done: number; total: number; ratio: number } {
        const all = this.tasks.all().filter(t => t.projectUuid === projectUuid);
        const total = all.length;
        const done = all.filter(t => t.completedAt || t.canceledAt).length;
        return { done, total, ratio: total === 0 ? 0 : done / total };
    }
}
