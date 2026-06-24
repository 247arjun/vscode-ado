/**
 * A small bounded undo stack.
 *
 * Each entry pairs a human-readable label with an inverse operation captured at
 * mutation time. Because local mutations are cheap and snapshot-based, undo is
 * simply "run the inverse". Redo is intentionally out of scope for v1.
 */
export interface UndoEntry {
    label: string;
    undo: () => void;
}

export class UndoStack {
    private readonly entries: UndoEntry[] = [];

    constructor(private readonly limit = 50) {}

    push(label: string, undo: () => void): void {
        this.entries.push({ label, undo });
        if (this.entries.length > this.limit) {
            this.entries.shift();
        }
    }

    get canUndo(): boolean {
        return this.entries.length > 0;
    }

    /** Pop and run the most recent inverse. Returns its label, if any. */
    undo(): string | undefined {
        const entry = this.entries.pop();
        if (!entry) return undefined;
        entry.undo();
        return entry.label;
    }

    clear(): void {
        this.entries.length = 0;
    }
}
