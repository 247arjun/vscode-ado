import { TokenProvider } from '../auth/TokenProvider';
import { WorkItem } from './AdoClient';

export interface RestError {
    status: number;
    message: string;
}

export interface PatchResult {
    success: boolean;
    workItem?: WorkItem;
    etag?: string;
    rev?: number;
    error?: RestError;
    /** True when the server returned 412 (someone else changed the item). */
    conflict?: boolean;
}

/** A single JSON-Patch operation for a work item update. */
export interface JsonPatchOp {
    op: 'add' | 'replace' | 'remove' | 'test';
    path: string;
    value?: unknown;
}

function normalizeOrgUrl(org: string): string {
    org = org.trim();
    if (org.startsWith('http://') || org.startsWith('https://')) {
        return org.replace(/\/$/, '');
    }
    return `https://dev.azure.com/${org}`;
}

/**
 * Pure HTTP transport for Azure DevOps REST APIs.
 *
 * Owns no caching and no business logic — it just authenticates (via
 * {@link TokenProvider}) and shapes requests/responses. The {@link SyncEngine}
 * is the only consumer.
 */
export class AdoRestClient {
    private readonly apiVersion = '7.1';

    constructor(private readonly tokens: TokenProvider) {}

    private async headers(extra?: Record<string, string>): Promise<Record<string, string> | undefined> {
        const token = await this.tokens.getToken();
        if (!token) return undefined;
        return {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...extra
        };
    }

    private baseUrl(org: string, project?: string): string {
        const orgUrl = normalizeOrgUrl(org);
        return project ? `${orgUrl}/${encodeURIComponent(project)}/_apis` : `${orgUrl}/_apis`;
    }

    /** Run a saved query by GUID and return the matching work item IDs. */
    async runSavedQuery(org: string, project: string, queryId: string): Promise<number[] | undefined> {
        const headers = await this.headers();
        if (!headers) return undefined;
        const url = `${this.baseUrl(org, project)}/wit/wiql/${queryId}?api-version=${this.apiVersion}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return undefined;
        const body = (await res.json()) as {
            workItems?: { id: number }[];
            workItemRelations?: { target?: { id: number } }[];
        };
        if (body.workItems) return body.workItems.map((w) => w.id);
        if (body.workItemRelations) {
            return body.workItemRelations
                .map((r) => r.target?.id)
                .filter((id): id is number => typeof id === 'number');
        }
        return [];
    }

    /** Batch-fetch work items by ID (max 200 per call). */
    async batchGetWorkItems(
        org: string,
        project: string,
        ids: number[],
        fields: string[]
    ): Promise<WorkItem[] | undefined> {
        if (ids.length === 0) return [];
        const headers = await this.headers();
        if (!headers) return undefined;
        const all: WorkItem[] = [];
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const url = `${this.baseUrl(org, project)}/wit/workitemsbatch?api-version=${this.apiVersion}`;
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ids: chunk, fields })
            });
            if (!res.ok) return undefined;
            const body = (await res.json()) as { value?: WorkItem[] };
            all.push(...(body.value ?? []));
        }
        return all;
    }

    /** Fetch a single work item and its ETag (for conflict detection). */
    async getWorkItem(org: string, project: string, id: number): Promise<{ workItem: WorkItem; etag?: string; rev?: number } | undefined> {
        const headers = await this.headers();
        if (!headers) return undefined;
        const url = `${this.baseUrl(org, project)}/wit/workitems/${id}?api-version=${this.apiVersion}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return undefined;
        const workItem = (await res.json()) as WorkItem & { rev?: number };
        return { workItem, etag: res.headers.get('etag') ?? undefined, rev: workItem.rev };
    }

    /**
     * PATCH a work item with a JSON-Patch document, optionally guarded by an
     * ETag for optimistic concurrency. Returns conflict=true on HTTP 412.
     */
    async patchWorkItem(
        org: string,
        project: string,
        id: number,
        ops: JsonPatchOp[],
        etag?: string
    ): Promise<PatchResult> {
        const extra: Record<string, string> = { 'Content-Type': 'application/json-patch+json' };
        if (etag) extra['If-Match'] = etag;
        const headers = await this.headers(extra);
        if (!headers) {
            return { success: false, error: { status: 401, message: 'Not authenticated' } };
        }
        const url = `${this.baseUrl(org, project)}/wit/workitems/${id}?api-version=${this.apiVersion}`;
        const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(ops) });

        if (res.status === 412) {
            return { success: false, conflict: true, error: { status: 412, message: 'Precondition failed (item changed on server)' } };
        }
        if (res.status === 429) {
            return { success: false, error: { status: 429, message: 'Throttled' } };
        }
        if (!res.ok) {
            return { success: false, error: { status: res.status, message: `HTTP ${res.status}` } };
        }
        const workItem = (await res.json()) as WorkItem & { rev?: number };
        return { success: true, workItem, etag: res.headers.get('etag') ?? undefined, rev: workItem.rev };
    }
}
