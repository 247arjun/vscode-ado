/**
 * Natural-language quick entry, à la Things.
 *
 * From a single typed line we extract:
 *  - inline `#tag` tokens
 *  - scheduling keywords `today` / `tomorrow` (as a do-date)
 * leaving a clean title behind.
 */

export interface ParsedQuickEntry {
    title: string;
    /** ISO date for the do-date, if a scheduling keyword was present. */
    whenDate?: string;
    tags: string[];
}

function isoDate(d: Date): string {
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

export function parseQuickEntry(raw: string, now: Date = new Date()): ParsedQuickEntry {
    let text = raw.trim();
    const tags: string[] = [];

    // Extract #tags (letters, digits, dash, underscore).
    text = text.replace(/#([\w-]+)/g, (_m, tag) => {
        tags.push(String(tag));
        return '';
    });

    let whenDate: string | undefined;
    // Scheduling keywords as standalone words (case-insensitive).
    const todayRe = /\btoday\b/i;
    const tomorrowRe = /\btomorrow\b/i;
    if (tomorrowRe.test(text)) {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        whenDate = isoDate(d);
        text = text.replace(tomorrowRe, '');
    } else if (todayRe.test(text)) {
        whenDate = isoDate(new Date(now));
        text = text.replace(todayRe, '');
    }

    // Collapse leftover whitespace.
    const title = text.replace(/\s{2,}/g, ' ').trim();

    return { title, whenDate, tags };
}
