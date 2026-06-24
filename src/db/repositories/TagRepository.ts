import { Database } from '../Database';
import { Tag } from '../../model/types';

/** Local-only tags. */
export class TagRepository {
    constructor(private readonly db: Database) {}

    private rows(): Tag[] {
        return this.db.table<Tag>('tags');
    }

    all(): Tag[] {
        return [...this.rows()];
    }

    /** Find a tag by name (case-insensitive) or create it. */
    getOrCreate(name: string): Tag {
        const existing = this.rows().find(t => t.name.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
        const id = this.rows().reduce((max, t) => Math.max(max, t.id), 0) + 1;
        const tag: Tag = { id, name };
        this.rows().push(tag);
        this.db.save();
        return tag;
    }

    namesFor(ids: number[]): string[] {
        const byId = new Map(this.rows().map(t => [t.id, t.name]));
        return ids.map(id => byId.get(id)).filter((n): n is string => !!n);
    }
}
