/**
 * Fractional indexing for manual ordering.
 *
 * To drop an item between `a` and `b`, we pick a number strictly between their
 * sort orders (the midpoint). This avoids renumbering siblings on every reorder.
 * Re-balancing is only needed if floating-point precision is exhausted, which is
 * astronomically unlikely for human-scale lists.
 */

/** Smallest meaningful gap before we'd want to re-balance. */
const EPSILON = 1e-9;

/**
 * Return a sort order strictly between `before` and `after`.
 * - Both omitted -> 1 (first item in an empty list).
 * - Only `after` -> something below it.
 * - Only `before` -> something above it.
 */
export function orderBetween(before?: number, after?: number): number {
    if (before === undefined && after === undefined) return 1;
    if (before === undefined) return (after as number) - 1;
    if (after === undefined) return before + 1;
    return before + (after - before) / 2;
}

/** True if the gap between two orders is too small and a re-balance is advised. */
export function needsRebalance(before: number, after: number): boolean {
    return Math.abs(after - before) < EPSILON;
}

/** Produce evenly spaced orders 1..n for a re-balance pass. */
export function rebalance<T>(items: T[]): { item: T; order: number }[] {
    return items.map((item, i) => ({ item, order: i + 1 }));
}
