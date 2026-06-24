import * as vscode from 'vscode';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { ProjectRepository } from '../db/repositories/ProjectRepository';
import { ViewId } from './protocol';

interface SmartList {
    id: ViewId;
    label: string;
    icon: string;
    count: () => number;
}

/** A node in the Things-style navigator. */
export class NavItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsible: vscode.TreeItemCollapsibleState,
        public readonly kind: 'list' | 'project' | 'area',
        public readonly viewId?: ViewId,
        public readonly areaUuid?: string
    ) {
        super(label, collapsible);
    }
}

/**
 * The sidebar navigator: a fixed Things-style rail followed by Projects & Areas.
 *
 *   Inbox · Today · Upcoming · Anytime · Someday · Logbook
 *   ──────
 *   Projects (with progress) and Areas (containing projects)
 *
 * Clicking an entry opens the corresponding workbench tab.
 */
export class NavigatorProvider implements vscode.TreeDataProvider<NavItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<NavItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly smartLists: SmartList[];

    constructor(
        private readonly tasks: TaskRepository,
        private readonly projects?: ProjectRepository
    ) {
        this.smartLists = [
            { id: 'inbox', label: 'Inbox', icon: 'inbox', count: () => this.tasks.getByList('inbox').length },
            { id: 'today', label: 'Today', icon: 'star-full', count: () => this.tasks.getToday().length },
            { id: 'upcoming', label: 'Upcoming', icon: 'calendar', count: () => this.tasks.getUpcoming().length },
            { id: 'anytime', label: 'Anytime', icon: 'layers', count: () => this.tasks.getByList('anytime').length },
            { id: 'someday', label: 'Someday', icon: 'archive', count: () => this.tasks.getByList('someday').length },
            { id: 'logbook', label: 'Logbook', icon: 'check-all', count: () => this.tasks.getByList('logbook').length }
        ];
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: NavItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: NavItem): NavItem[] {
        if (!element) {
            return [...this.smartListItems(), ...this.topLevelProjectItems(), ...this.areaItems()];
        }
        if (element.kind === 'area' && element.areaUuid) {
            return this.projectItems(element.areaUuid);
        }
        return [];
    }

    private smartListItems(): NavItem[] {
        return this.smartLists.map(l => {
            const item = new NavItem(l.label, vscode.TreeItemCollapsibleState.None, 'list', l.id);
            item.iconPath = new vscode.ThemeIcon(l.icon);
            const c = l.count();
            if (c > 0) item.description = String(c);
            item.command = { command: 'adoThings.openList', title: 'Open', arguments: [l.id] };
            item.contextValue = 'navList';
            return item;
        });
    }

    private topLevelProjectItems(): NavItem[] {
        if (!this.projects) return [];
        return this.projects.allProjects()
            .filter(p => !p.areaUuid)
            .map(p => this.projectItem(p.uuid, p.name));
    }

    private projectItems(areaUuid: string): NavItem[] {
        if (!this.projects) return [];
        return this.projects.allProjects()
            .filter(p => p.areaUuid === areaUuid)
            .map(p => this.projectItem(p.uuid, p.name));
    }

    private projectItem(uuid: string, name: string): NavItem {
        const item = new NavItem(name, vscode.TreeItemCollapsibleState.None, 'project', `project:${uuid}`);
        item.iconPath = new vscode.ThemeIcon('circle-large-outline');
        const prog = this.projects!.progress(uuid);
        if (prog.total > 0) {
            item.description = `${Math.round(prog.ratio * 100)}%`;
        }
        item.command = { command: 'adoThings.openList', title: 'Open', arguments: [`project:${uuid}` as ViewId] };
        item.contextValue = 'navProject';
        return item;
    }

    private areaItems(): NavItem[] {
        if (!this.projects) return [];
        return this.projects.allAreas().map(a => {
            const item = new NavItem(a.name, vscode.TreeItemCollapsibleState.Collapsed, 'area', undefined, a.uuid);
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'navArea';
            return item;
        });
    }
}
