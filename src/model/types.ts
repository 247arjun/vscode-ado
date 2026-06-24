/**
 * Domain model for the local-first task manager.
 *
 * These types are the persisted shape of rows in the local store. They are the
 * source of truth for the UI; ADO is a sync target that maps onto them.
 */

/** Things-style smart buckets. `today`/`upcoming` are DERIVED, never stored. */
export type ListName = 'inbox' | 'anytime' | 'someday' | 'logbook';

/** The user-facing task. Usually linked to an ADO work item, but may be local-only. */
export interface Task {
    uuid: string;
    /** Work item ID if linked; undefined for local-only tasks. */
    adoId?: number;
    title: string;
    /** Markdown. Local-only in v1. */
    notes: string;
    list: ListName;
    /** 0/1 — set when the user pulls a task into Today. */
    todayFlag: number;
    /** ISO date (do-date). Drives Today/Upcoming. Local concept. */
    whenDate?: string;
    /** ISO date. Maps to ADO due-date when present. */
    deadline?: string;
    /** ISO timestamp; set = completed -> Logbook. */
    completedAt?: string;
    /** ISO timestamp; set = canceled. */
    canceledAt?: string;
    projectUuid?: string;
    /** Manual ordering within a list/project (fractional indexing). */
    sortOrder: number;
    /** Local-only tag ids. */
    tagIds: number[];
    createdAt: string;
    updatedAt: string;
}

/** Canonical ADO mirror — one row per linked work item. */
export interface WorkItemRow {
    adoId: number;
    rev: number;
    /** For optimistic concurrency on push. */
    etag?: string;
    /** Full ADO fields object. */
    fields: Record<string, unknown>;
    org?: string;
    project?: string;
    type?: string;
    state?: string;
    assignedTo?: string;
    updatedUtc?: string;
    /** 0/1 tombstone. */
    deleted: number;
}

export interface Project {
    uuid: string;
    name: string;
    areaUuid?: string;
    /** How it maps to ADO (area path / iteration / parent work item). */
    adoBinding?: Record<string, unknown>;
    sortOrder: number;
}

export interface Area {
    uuid: string;
    name: string;
    sortOrder: number;
}

export interface Tag {
    id: number;
    name: string;
    color?: string;
}

export interface ChecklistItem {
    id: number;
    taskUuid: string;
    text: string;
    done: number;
    sortOrder: number;
}

export interface SavedView {
    id: number;
    name: string;
    filter?: Record<string, unknown>;
    group?: unknown;
    sort?: unknown;
}

export type SyncOpType = 'update_state' | 'update_fields' | 'link';
export type SyncOpStatus = 'pending' | 'inflight' | 'failed' | 'done';

/** The outbox — local changes waiting to be pushed to ADO. */
export interface SyncOp {
    opId: string;
    entity: 'workitem' | 'task';
    targetId: string;
    opType: SyncOpType;
    payload: Record<string, unknown>;
    baseEtag?: string;
    status: SyncOpStatus;
    attempts: number;
    createdAt: string;
    lastError?: string;
}

/** How far we've pulled from a given source, for incremental sync. */
export interface SyncStateRow {
    sourceKey: string;
    watermark?: string;
    lastSyncedUtc?: string;
}
