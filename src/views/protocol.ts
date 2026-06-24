/**
 * Typed, versioned message contract between the extension host and the webview.
 *
 * The webview is sandboxed: it never touches the DB or the network. It sends
 * INTENTS and receives STATE. The host validates every inbound message.
 */

export const PROTOCOL_VERSION = 1;

/** Identifier for a view shown in the workbench. */
export type ViewId =
    | 'inbox'
    | 'today'
    | 'upcoming'
    | 'anytime'
    | 'someday'
    | 'logbook'
    | `project:${string}`;

/** A task as presented to the UI (no local-only internals leak unnecessarily). */
export interface TaskVM {
    uuid: string;
    title: string;
    notes: string;
    adoId?: number;
    state?: string;
    type?: string;
    whenDate?: string;
    deadline?: string;
    completed: boolean;
    today: boolean;
    tags: string[];
}

/** A labelled group of tasks (e.g. a date header in Upcoming). */
export interface TaskGroupVM {
    header?: string;
    tasks: TaskVM[];
}

export interface ViewSnapshot {
    view: ViewId;
    title: string;
    subtitle?: string;
    groups: TaskGroupVM[];
}

export interface SyncStatusVM {
    phase: 'idle' | 'syncing' | 'offline' | 'error';
    pendingCount: number;
    lastSyncedUtc?: string;
}

/** A single field shown in the task detail pane. */
export interface DetailField {
    label: string;
    /** Formatted display value. */
    value: string;
    /** 'html' values are ADO rich text; the webview renders them sanitized. */
    kind?: 'text' | 'html' | 'date' | 'identity';
    /** Settings/field key (ADO ref name or `local.*`). */
    key?: string;
    /** ADO field reference name, when this maps to an ADO field. */
    ref?: string;
    source?: 'ado' | 'local';
    /** Editor control to render; absent/`readonly` = display only. */
    control?: 'text' | 'date' | 'number' | 'enum' | 'identity' | 'html' | 'readonly';
    editable?: boolean;
    options?: string[];
    /** Raw value bound to the editor control (e.g. YYYY-MM-DD for dates). */
    editValue?: string;
}

/** Full read-only detail for one task (rich ADO fields + local fields). */
export interface TaskDetailVM {
    uuid: string;
    title: string;
    adoId?: number;
    type?: string;
    state?: string;
    /** Local-only markdown notes. */
    notes: string;
    /** ADO rich-text description (HTML), if any. */
    description?: string;
    /** Ordered, present-only metadata fields for display. */
    fields: DetailField[];
    url?: string;
}

/** Webview -> Host */
export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'loadView'; view: ViewId }
    | { type: 'completeTask'; uuid: string }
    | { type: 'uncompleteTask'; uuid: string }
    | { type: 'updateTask'; uuid: string; patch: { title?: string; notes?: string } }
    | { type: 'moveToToday'; uuid: string }
    | { type: 'setWhen'; uuid: string; date?: string }
    | { type: 'setDeadline'; uuid: string; date?: string }
    | { type: 'createTask'; title: string; view: ViewId }
    | { type: 'openWorkItem'; adoId: number }
    | { type: 'changeState'; uuid: string }
    | { type: 'pushToAdo'; uuid: string }
    | { type: 'openTask'; uuid: string }
    | { type: 'closeTask' }
    | { type: 'updateField'; uuid: string; ref: string; value: unknown }
    | { type: 'search'; query: string };

/** Host -> Webview */
export type HostToWebview =
    | { type: 'snapshot'; snapshot: ViewSnapshot }
    | { type: 'syncStatus'; status: SyncStatusVM }
    | { type: 'taskUpdated'; task: TaskVM }
    | { type: 'taskDetail'; detail: TaskDetailVM }
    | { type: 'searchResults'; tasks: TaskVM[] };
