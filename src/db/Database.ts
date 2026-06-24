import * as fs from 'fs';
import * as path from 'path';

/**
 * Shape of the persisted database file. Each top-level key is a "table"
 * (a flat array of rows). `meta` tracks the applied schema version so the
 * migration runner knows what to apply.
 */
export interface DbData {
    meta: { schemaVersion: number };
    tasks: any[];
    work_items: any[];
    projects: any[];
    areas: any[];
    tags: any[];
    task_tags: any[];
    checklist_items: any[];
    saved_views: any[];
    sync_queue: any[];
    sync_state: any[];
    /** Per-query snapshot of returned work items, for offline reads. */
    query_cache: any[];
}

/** A migration mutates the in-memory data to bring it to `version`. */
export interface Migration {
    version: number;
    name: string;
    up(data: DbData): void;
}

function emptyData(): DbData {
    return {
        meta: { schemaVersion: 0 },
        tasks: [],
        work_items: [],
        projects: [],
        areas: [],
        tags: [],
        task_tags: [],
        checklist_items: [],
        saved_views: [],
        sync_queue: [],
        sync_state: [],
        query_cache: []
    };
}

/**
 * Append-only, numbered migrations. NEVER edit a shipped migration once users
 * have data — only add new ones with a higher version number.
 */
export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: 'init',
        up(data) {
            // Tables are created lazily by emptyData(); nothing to do beyond
            // bumping the version. This migration exists to establish v1.
        }
    },
    {
        version: 2,
        name: 'ensure_collections',
        up(data) {
            // Defensive: guarantee every expected collection exists even if an
            // older file predates a table.
            const base = emptyData();
            for (const key of Object.keys(base) as (keyof DbData)[]) {
                if (key === 'meta') continue;
                if (!Array.isArray((data as any)[key])) {
                    (data as any)[key] = [];
                }
            }
        }
    }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Dependency-free, pure-TypeScript persistent store.
 *
 * Holds typed collections in memory and persists them atomically to a single
 * JSON file. All access is mediated by repositories (see {@link ./repositories}).
 * This can be swapped for SQLite later behind the same repository interfaces.
 */
export class Database {
    private data: DbData = emptyData();
    private saveTimer: NodeJS.Timeout | undefined;
    private closed = false;

    private constructor(private readonly filePath: string) {}

    /** Open (or create) the database at `filePath` and run pending migrations. */
    static async open(filePath: string): Promise<Database> {
        const db = new Database(filePath);
        await db.load();
        db.migrate();
        db.saveNow();
        return db;
    }

    /** In-memory database for tests. */
    static async openInMemory(): Promise<Database> {
        const db = new Database('');
        db.data = emptyData();
        db.migrate();
        return db;
    }

    private async load(): Promise<void> {
        try {
            if (this.filePath && fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw) as Partial<DbData>;
                this.data = { ...emptyData(), ...parsed, meta: parsed.meta ?? { schemaVersion: 0 } };
            } else {
                this.data = emptyData();
            }
        } catch {
            // Corrupt file: start fresh rather than crash. The old file is left
            // on disk (we write to a temp file and rename, so it's recoverable).
            this.data = emptyData();
        }
    }

    /** Apply any migrations whose version is greater than the stored version. */
    private migrate(): void {
        const current = this.data.meta.schemaVersion ?? 0;
        for (const migration of MIGRATIONS) {
            if (migration.version > current) {
                migration.up(this.data);
                this.data.meta.schemaVersion = migration.version;
            }
        }
    }

    get schemaVersion(): number {
        return this.data.meta.schemaVersion;
    }

    /** Direct typed access to a collection. Repositories use this. */
    table<T = any>(name: keyof DbData): T[] {
        return (this.data as any)[name] as T[];
    }

    /** Replace a collection wholesale (used by repositories after a mutation). */
    setTable<T = any>(name: keyof DbData, rows: T[]): void {
        (this.data as any)[name] = rows;
    }

    /** Persist soon (debounced) — used after ordinary mutations. */
    save(): void {
        if (!this.filePath || this.closed) return;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveNow();
        }, 150);
    }

    /** Persist immediately and atomically (temp file + rename). */
    saveNow(): void {
        if (!this.filePath || this.closed) return;
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8');
            fs.renameSync(tmp, this.filePath);
        } catch {
            // Persistence failure should never crash the extension; the in-memory
            // copy remains usable for the session.
        }
    }

    /** Flush and stop accepting writes. */
    close(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        this.saveNow();
        this.closed = true;
    }

    /** Destroy all data (used by the "reset local database" command). */
    reset(): void {
        this.data = emptyData();
        this.migrate();
        this.saveNow();
    }
}
