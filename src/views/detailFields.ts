/**
 * Catalog of fields that can be surfaced in the task detail pane.
 *
 * The user chooses which of these appear (and in what order) via the
 * `adoQueries.detailFields` setting. Each entry's `key` is what the setting
 * stores: an ADO field reference name for ADO fields, or a `local.*` key for
 * the extension's own fields.
 *
 * This module is intentionally free of any `vscode` dependency so it can be
 * unit-tested and used by the (vscode-free) ViewModelBuilder.
 */

export type DetailControl = 'text' | 'date' | 'number' | 'enum' | 'identity' | 'html' | 'readonly';

export interface DetailFieldDef {
    /** Stored in settings; ADO ref name, or `local.*`. */
    key: string;
    /** ADO field reference name (undefined for local fields). */
    ref?: string;
    label: string;
    source: 'ado' | 'local';
    control: DetailControl;
    editable: boolean;
    /** For enum controls. */
    options?: string[];
}

export const DETAIL_FIELD_CATALOG: DetailFieldDef[] = [
    { key: 'System.Description', ref: 'System.Description', label: 'Description', source: 'ado', control: 'html', editable: false },
    { key: 'System.State', ref: 'System.State', label: 'State', source: 'ado', control: 'readonly', editable: false },
    { key: 'System.Reason', ref: 'System.Reason', label: 'Reason', source: 'ado', control: 'text', editable: true },
    { key: 'System.AssignedTo', ref: 'System.AssignedTo', label: 'Assigned To', source: 'ado', control: 'identity', editable: false },
    { key: 'System.AreaPath', ref: 'System.AreaPath', label: 'Area Path', source: 'ado', control: 'readonly', editable: false },
    { key: 'System.IterationPath', ref: 'System.IterationPath', label: 'Iteration', source: 'ado', control: 'readonly', editable: false },
    { key: 'Microsoft.VSTS.Common.Priority', ref: 'Microsoft.VSTS.Common.Priority', label: 'Priority', source: 'ado', control: 'enum', editable: true, options: ['1', '2', '3', '4'] },
    { key: 'Microsoft.VSTS.Common.Severity', ref: 'Microsoft.VSTS.Common.Severity', label: 'Severity', source: 'ado', control: 'enum', editable: true, options: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] },
    { key: 'Microsoft.VSTS.Scheduling.StoryPoints', ref: 'Microsoft.VSTS.Scheduling.StoryPoints', label: 'Story Points', source: 'ado', control: 'number', editable: true },
    { key: 'Microsoft.VSTS.Scheduling.Effort', ref: 'Microsoft.VSTS.Scheduling.Effort', label: 'Effort', source: 'ado', control: 'number', editable: true },
    { key: 'Microsoft.VSTS.Scheduling.RemainingWork', ref: 'Microsoft.VSTS.Scheduling.RemainingWork', label: 'Remaining Work', source: 'ado', control: 'number', editable: true },
    { key: 'Microsoft.VSTS.Scheduling.OriginalEstimate', ref: 'Microsoft.VSTS.Scheduling.OriginalEstimate', label: 'Original Estimate', source: 'ado', control: 'number', editable: true },
    { key: 'Microsoft.VSTS.Scheduling.StartDate', ref: 'Microsoft.VSTS.Scheduling.StartDate', label: 'Start Date', source: 'ado', control: 'date', editable: true },
    { key: 'Microsoft.VSTS.Scheduling.DueDate', ref: 'Microsoft.VSTS.Scheduling.DueDate', label: 'Due Date', source: 'ado', control: 'date', editable: true },
    { key: 'System.Tags', ref: 'System.Tags', label: 'ADO Tags', source: 'ado', control: 'text', editable: true },
    { key: 'System.CreatedBy', ref: 'System.CreatedBy', label: 'Created By', source: 'ado', control: 'identity', editable: false },
    { key: 'System.CreatedDate', ref: 'System.CreatedDate', label: 'Created', source: 'ado', control: 'readonly', editable: false },
    { key: 'System.ChangedBy', ref: 'System.ChangedBy', label: 'Changed By', source: 'ado', control: 'identity', editable: false },
    { key: 'System.ChangedDate', ref: 'System.ChangedDate', label: 'Changed', source: 'ado', control: 'readonly', editable: false },
    { key: 'local.when', label: 'When', source: 'local', control: 'date', editable: true },
    { key: 'local.deadline', label: 'Deadline', source: 'local', control: 'date', editable: true },
    { key: 'local.tags', label: 'Tags', source: 'local', control: 'readonly', editable: false }
];

/** Sensible default: a useful subset rather than every field. */
export const DEFAULT_DETAIL_KEYS: string[] = [
    'System.Description',
    'System.State',
    'System.AssignedTo',
    'System.AreaPath',
    'System.IterationPath',
    'Microsoft.VSTS.Common.Priority',
    'Microsoft.VSTS.Scheduling.DueDate',
    'local.when',
    'local.deadline',
    'local.tags',
    'System.ChangedDate'
];

const BY_KEY = new Map(DETAIL_FIELD_CATALOG.map(d => [d.key, d]));

export function getFieldDef(key: string): DetailFieldDef | undefined {
    return BY_KEY.get(key);
}

/** Resolve which field defs to show, in the user's configured order. */
export function resolveDetailFields(configKeys?: string[]): DetailFieldDef[] {
    const keys = configKeys && configKeys.length > 0 ? configKeys : DEFAULT_DETAIL_KEYS;
    const out: DetailFieldDef[] = [];
    for (const key of keys) {
        const def = BY_KEY.get(key);
        if (def) out.push(def);
    }
    return out;
}
