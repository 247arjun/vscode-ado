import * as vscode from 'vscode';
import { TaskRepository } from '../db/repositories/TaskRepository';
import { TagRepository } from '../db/repositories/TagRepository';
import { ViewModelBuilder } from './ViewModelBuilder';
import { parseQuickEntry } from './quickEntry';
import { UndoStack } from '../undo/UndoStack';
import { Settings } from '../config/Settings';
import { ViewId, WebviewToHost, HostToWebview, SyncStatusVM } from './protocol';

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

export interface WorkbenchCallbacks {
    /** User asked to change a linked work item's ADO state. */
    onChangeState(uuid: string): Promise<void> | void;
    /** User asked to open a work item in the browser. */
    onOpenWorkItem(adoId: number): void;
    /** User asked to push a local-only task to ADO as a new work item. */
    onPushToAdo(uuid: string): Promise<void> | void;
    /** User edited an ADO field in the detail pane. */
    onUpdateField(uuid: string, ref: string, value: unknown): Promise<void> | void;
    /** Something changed; refresh the navigator counts. */
    onDataChanged(): void;
}

/**
 * Manages the Things-style workbench webview panel (opened as an editor tab).
 *
 * The host owns all data/business logic; the webview is a pure view that
 * exchanges typed messages (see {@link ./protocol}). Strict CSP + nonce.
 */
export class WorkbenchHost {
    private panel: vscode.WebviewPanel | undefined;
    private currentView: ViewId = 'today';
    private lastStatus: SyncStatusVM = { phase: 'idle', pendingCount: 0 };
    private openDetailUuid: string | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly tasks: TaskRepository,
        private readonly vmBuilder: ViewModelBuilder,
        private readonly callbacks: WorkbenchCallbacks,
        private readonly tags?: TagRepository,
        private readonly undoStack?: UndoStack
    ) {}

    /** Open (or reveal) the workbench focused on a given view. */
    openView(view: ViewId): void {
        this.currentView = view;
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            this.postSnapshot();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'adoThings.workbench',
            'ADO Things',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );

        this.panel.webview.html = this.renderHtml(this.panel.webview);
        this.panel.onDidDispose(() => { this.panel = undefined; });
        this.panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.handleMessage(msg));
    }

    /** Push a fresh snapshot of the current view to the webview. */
    postSnapshot(): void {
        if (!this.panel) return;
        const snapshot = this.vmBuilder.build(this.currentView);
        this.post({ type: 'snapshot', snapshot });
        this.post({ type: 'syncStatus', status: this.lastStatus });
    }

    /** Update the sync status banner in the webview. */
    setSyncStatus(status: SyncStatusVM): void {
        this.lastStatus = status;
        this.post({ type: 'syncStatus', status });
    }

    private post(msg: HostToWebview): void {
        this.panel?.webview.postMessage(msg);
    }

    private async handleMessage(msg: WebviewToHost): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.postSnapshot();
                break;
            case 'loadView':
                this.currentView = msg.view;
                this.postSnapshot();
                break;
            case 'completeTask': {
                const snap = this.tasks.snapshot(msg.uuid);
                this.tasks.complete(msg.uuid);
                if (snap) this.undoStack?.push('Complete task', () => this.tasks.restoreSnapshot(snap));
                this.afterMutation();
                break;
            }
            case 'uncompleteTask':
                this.tasks.uncomplete(msg.uuid);
                this.afterMutation();
                break;
            case 'updateTask': {
                const snap = this.tasks.snapshot(msg.uuid);
                this.tasks.update(msg.uuid, msg.patch);
                if (snap) this.undoStack?.push('Edit task', () => this.tasks.restoreSnapshot(snap));
                this.afterMutation();
                break;
            }
            case 'moveToToday':
                this.tasks.moveToToday(msg.uuid);
                this.afterMutation();
                break;
            case 'setWhen':
                this.tasks.setWhen(msg.uuid, msg.date);
                this.afterMutation();
                this.reopenDetail(msg.uuid);
                break;
            case 'setDeadline':
                this.tasks.setDeadline(msg.uuid, msg.date);
                this.afterMutation();
                this.reopenDetail(msg.uuid);
                break;
            case 'createTask': {
                this.createFromQuickEntry(msg.title, msg.view);
                this.afterMutation();
                break;
            }
            case 'changeState':
                await this.callbacks.onChangeState(msg.uuid);
                this.afterMutation();
                break;
            case 'pushToAdo':
                await this.callbacks.onPushToAdo(msg.uuid);
                this.afterMutation();
                break;
            case 'openWorkItem':
                this.callbacks.onOpenWorkItem(msg.adoId);
                break;
            case 'openTask': {
                this.openDetailUuid = msg.uuid;
                const detail = this.vmBuilder.buildDetail(msg.uuid, Settings.detailFields);
                if (detail) this.post({ type: 'taskDetail', detail });
                break;
            }
            case 'closeTask':
                this.openDetailUuid = undefined;
                break;
            case 'updateField':
                await this.callbacks.onUpdateField(msg.uuid, msg.ref, msg.value);
                this.afterMutation();
                this.reopenDetail(msg.uuid);
                break;
            case 'search': {
                const tasks = this.tasks.search(msg.query).map(t => this.vmBuilder.toVM(t));
                this.post({ type: 'searchResults', tasks });
                break;
            }
        }
    }

    private afterMutation(): void {
        this.postSnapshot();
        this.callbacks.onDataChanged();
    }

    /** Re-send the detail snapshot so edited values reflect immediately. */
    private reopenDetail(uuid: string): void {
        const detail = this.vmBuilder.buildDetail(uuid, Settings.detailFields);
        if (detail) this.post({ type: 'taskDetail', detail });
    }

    /** Refresh the currently open detail pane (e.g. after a settings change). */
    refreshOpenDetail(): void {
        if (this.openDetailUuid) this.reopenDetail(this.openDetailUuid);
    }

    /** Create a task from a quick-entry line, applying #tags and today/tomorrow. */
    private createFromQuickEntry(raw: string, view: ViewId): void {
        const parsed = parseQuickEntry(raw);
        const title = parsed.title || raw.trim();
        const list = view === 'someday' ? 'someday' : view === 'anytime' ? 'anytime' : 'inbox';
        const task = this.tasks.createLocal(title, list);
        if (parsed.whenDate) this.tasks.setWhen(task.uuid, parsed.whenDate);
        if (this.tags && parsed.tags.length > 0) {
            const ids = parsed.tags.map(name => this.tags!.getOrCreate(name).id);
            this.tasks.setTags(task.uuid, ids);
        }
        this.undoStack?.push('Add task', () => this.tasks.remove(task.uuid));
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'workbench.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'workbench.js'));
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>ADO Things</title>
</head>
<body>
    <div id="app">
        <header id="view-header">
            <h1 id="view-title">Today</h1>
            <div id="view-subtitle"></div>
        </header>
        <div id="sync-banner" class="hidden"></div>
        <div id="quick-add">
            <input id="quick-add-input" type="text" placeholder="New To-Do" aria-label="New to-do" />
        </div>
        <main id="list"></main>
        <div id="empty-state" class="hidden"></div>
    </div>
    <aside id="detail-pane" class="hidden" aria-label="Task details">
        <div id="detail-header">
            <button id="detail-close" class="action-btn" title="Close details" aria-label="Close details">✕</button>
            <button id="detail-open-ado" class="action-btn hidden" title="Open in browser">Open in ADO ↗</button>
        </div>
        <h2 id="detail-title"></h2>
        <div id="detail-subtitle"></div>
        <div id="detail-description" class="hidden"></div>
        <dl id="detail-fields"></dl>
        <div id="detail-notes-wrap" class="hidden">
            <div class="detail-section-label">Notes</div>
            <div id="detail-notes"></div>
        </div>
    </aside>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }
}
