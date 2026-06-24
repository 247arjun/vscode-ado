import * as vscode from 'vscode';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { ViewId } from './protocol';

interface NavEntry {
    id: ViewId;
    label: string;
    icon: string;
    count: () => number;
}

/** A node in the Things-style navigator. */
export class NavItem extends vscode.TreeItem {
    constructor(public readonly viewId: ViewId, label: string, icon: string, count: number) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        if (count > 0) {
            this.description = String(count);
        }
        this.command = {
            command: 'adoThings.openList',
            title: 'Open',
            arguments: [viewId]
        };
        this.contextValue = 'navList';
    }
}

/**
 * The sidebar navigator: a fixed Things-style rail —
 * Inbox · Today · Upcoming · Anytime · Someday · Logbook.
 *
 * (Projects & Areas are added in Phase 5.) Clicking an entry opens the
 * corresponding workbench tab.
 */
export class NavigatorProvider implements vscode.TreeDataProvider<NavItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly entries: NavEntry[];

    constructor(private readonly tasks: TaskRepository) {
        this.entries = [
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

    getChildren(): NavItem[] {
        return this.entries.map(e => new NavItem(e.id, e.label, e.icon, e.count()));
    }
}
