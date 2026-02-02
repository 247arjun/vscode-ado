import { GroupSpec, QueryDefinition } from '../config/Settings';
import { WorkItem } from '../ado/AdoClient';

/**
 * A node in the grouped tree
 */
export type TreeNode = QueryNode | GroupNode | WorkItemNode;

/**
 * Query node (top-level container for a query)
 */
export interface QueryNode {
    type: 'query';
    name: string;
    organization?: string;
    project?: string;
    queryId?: string;
    queryPath?: string;
    count: number;
    children: TreeNode[];
    collapsed?: boolean;
    error?: string;
    loading?: boolean;
}

/**
 * Group node (non-leaf)
 */
export interface GroupNode {
    type: 'group';
    key: string;
    label: string;
    count: number;
    children: TreeNode[];
    level: number;
}

/**
 * Work item node (leaf)
 */
export interface WorkItemNode {
    type: 'workItem';
    id: number;
    title: string;
    state?: string;
    workItemType?: string;
    url?: string;
    priority?: number;
}

/**
 * Date bucket types
 */
export type DateBucket = 'overdue' | 'today' | 'thisWeek' | 'future' | 'none';

/**
 * Date bucket sort order
 */
const DATE_BUCKET_ORDER: Record<DateBucket, number> = {
    'overdue': 0,
    'today': 1,
    'thisWeek': 2,
    'future': 3,
    'none': 4
};

/**
 * Grouping engine for converting flat work items into a tree
 */
export class GroupingEngine {
    /**
     * Build a grouped tree from work items
     */
    buildTree(workItems: WorkItem[], groupSpecs: GroupSpec[]): TreeNode[] {
        if (groupSpecs.length === 0) {
            // No grouping - return flat list of work items
            return this.sortWorkItems(workItems.map(wi => this.toWorkItemNode(wi)));
        }

        // Group recursively
        return this.groupRecursive(workItems, groupSpecs, 0);
    }

    /**
     * Recursively group work items
     */
    private groupRecursive(workItems: WorkItem[], groupSpecs: GroupSpec[], level: number): TreeNode[] {
        if (level >= groupSpecs.length) {
            // No more grouping levels - return work items
            return this.sortWorkItems(workItems.map(wi => this.toWorkItemNode(wi)));
        }

        const spec = groupSpecs[level];
        const groups = new Map<string, WorkItem[]>();

        // Group work items by field value
        for (const workItem of workItems) {
            const key = this.getFieldValue(workItem, spec);
            
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(workItem);
        }

        // Convert to group nodes
        const groupNodes: GroupNode[] = [];
        
        for (const [key, items] of groups) {
            const children = this.groupRecursive(items, groupSpecs, level + 1);
            
            groupNodes.push({
                type: 'group',
                key,
                label: key,
                count: this.countWorkItems(children),
                children,
                level
            });
        }

        // Sort groups
        return this.sortGroups(groupNodes, spec);
    }

    /**
     * Extract field value from work item
     */
    getFieldValue(workItem: WorkItem, spec: GroupSpec): string {
        const value = workItem.fields[spec.field];
        const missingLabel = spec.missingLabel ?? '(none)';

        if (value === null || value === undefined || value === '') {
            return missingLabel;
        }

        // Handle identity fields (objects with displayName, uniqueName, etc.)
        if (typeof value === 'object' && value !== null) {
            const identityValue = value as Record<string, unknown>;
            
            // Check for identity object
            if ('displayName' in identityValue || 'uniqueName' in identityValue) {
                const projection = spec.projection ?? 'displayName';
                const projectedValue = identityValue[projection];
                
                if (projectedValue && typeof projectedValue === 'string') {
                    return projectedValue;
                }
                
                // Fallback to displayName
                if (identityValue.displayName && typeof identityValue.displayName === 'string') {
                    return identityValue.displayName;
                }
            }
            
            return JSON.stringify(value);
        }

        // Handle date bucketing
        if (spec.bucket === 'date') {
            return this.getDateBucket(value);
        }

        // Handle primitives
        return String(value);
    }

    /**
     * Get date bucket for a date value
     */
    private getDateBucket(value: unknown): DateBucket {
        if (value === null || value === undefined || value === '') {
            return 'none';
        }

        let date: Date;
        
        if (typeof value === 'string') {
            date = new Date(value);
        } else if (value instanceof Date) {
            date = value;
        } else {
            return 'none';
        }

        if (isNaN(date.getTime())) {
            return 'none';
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const itemDate = new Date(date);
        itemDate.setHours(0, 0, 0, 0);

        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);

        if (itemDate < today) {
            return 'overdue';
        } else if (itemDate.getTime() === today.getTime()) {
            return 'today';
        } else if (itemDate < nextWeek) {
            return 'thisWeek';
        } else {
            return 'future';
        }
    }

    /**
     * Format date bucket for display
     */
    formatDateBucket(bucket: DateBucket): string {
        switch (bucket) {
            case 'overdue': return 'Overdue';
            case 'today': return 'Today';
            case 'thisWeek': return 'This Week';
            case 'future': return 'Future';
            case 'none': return 'No Date';
        }
    }

    /**
     * Convert work item to node
     */
    private toWorkItemNode(workItem: WorkItem): WorkItemNode {
        const fields = workItem.fields;
        
        return {
            type: 'workItem',
            id: workItem.id,
            title: String(fields['System.Title'] ?? 'Untitled'),
            state: fields['System.State'] as string | undefined,
            workItemType: fields['System.WorkItemType'] as string | undefined,
            priority: fields['Microsoft.VSTS.Common.Priority'] as number | undefined,
            url: workItem.url ?? workItem._links?.html?.href
        };
    }

    /**
     * Sort work item nodes by priority then ID
     */
    private sortWorkItems(items: WorkItemNode[]): WorkItemNode[] {
        return items.sort((a, b) => {
            // Sort by priority (lower is higher priority)
            const priorityA = a.priority ?? 999;
            const priorityB = b.priority ?? 999;
            
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            
            // Then by ID
            return a.id - b.id;
        });
    }

    /**
     * Sort group nodes based on field type
     */
    private sortGroups(groups: GroupNode[], spec: GroupSpec): GroupNode[] {
        return groups.sort((a, b) => {
            // Handle date buckets
            if (spec.bucket === 'date') {
                const orderA = DATE_BUCKET_ORDER[a.key as DateBucket] ?? 999;
                const orderB = DATE_BUCKET_ORDER[b.key as DateBucket] ?? 999;
                return orderA - orderB;
            }

            // Handle missing label - always last
            const missingLabel = spec.missingLabel ?? '(none)';
            if (a.key === missingLabel) return 1;
            if (b.key === missingLabel) return -1;

            // Try numeric sort
            const numA = parseFloat(a.key);
            const numB = parseFloat(b.key);
            
            if (!isNaN(numA) && !isNaN(numB)) {
                return numA - numB;
            }

            // String sort
            return a.key.localeCompare(b.key);
        });
    }

    /**
     * Count total work items in a tree
     */
    private countWorkItems(nodes: TreeNode[]): number {
        let count = 0;
        
        for (const node of nodes) {
            if (node.type === 'workItem') {
                count++;
            } else {
                count += node.count;
            }
        }
        
        return count;
    }

    /**
     * Compute a hash of work items for change detection
     */
    computeHash(workItems: WorkItem[], groupSpecs: GroupSpec[]): string {
        const ids = workItems.map(wi => wi.id).sort();
        const fields = groupSpecs.map(g => g.field);
        const fieldValues = workItems.map(wi => {
            return fields.map(f => String(wi.fields[f] ?? '')).join('|');
        });
        
        return JSON.stringify({ ids, fieldValues });
    }
}
