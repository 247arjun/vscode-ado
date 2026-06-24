import { AdoRestClient } from '../ado/AdoRestClient';
import { WorkItemRepository } from '../db/repositories/WorkItemRepository';
import { SyncOp } from '../model/types';

export type ConflictChoice = 'mine' | 'theirs';

/**
 * Asked to resolve a same-field conflict. The host wires this to a UI prompt;
 * tests inject a deterministic resolver. Returning 'theirs' is the safe default.
 */
export type ConflictPrompt = (info: {
    adoId: number;
    field: string;
    mine: unknown;
    theirs: unknown;
}) => Promise<ConflictChoice>;

export interface ConflictOutcome {
    /** Re-attempt the push with this fresh etag. */
    retryWithEtag?: string;
    /** The op is resolved and should be marked done (no push needed). */
    resolved?: boolean;
}

/**
 * Handles HTTP 412 (the item changed on the server since we read it).
 *
 * Strategy:
 *  - Re-fetch the item to learn its current value and fresh ETag.
 *  - If the server's value for our target field already equals what we wanted,
 *    the change is effectively applied -> resolved.
 *  - If the server changed a DIFFERENT field, our change still applies cleanly
 *    -> retry with the fresh ETag (field-level merge).
 *  - If the server changed the SAME field to a different value, prompt the user
 *    (Keep Mine / Keep Theirs), defaulting to Theirs.
 */
export class ConflictResolver {
    constructor(
        private readonly rest: AdoRestClient,
        private readonly workItems: WorkItemRepository,
        private readonly prompt: ConflictPrompt,
        private readonly log: (msg: string) => void
    ) {}

    async resolveStateConflict(op: SyncOp, org: string, project: string): Promise<ConflictOutcome> {
        const adoId = Number(op.targetId);
        const desired = op.payload['state'];
        const fresh = await this.rest.getWorkItem(org, project, adoId);
        if (!fresh) {
            // Can't re-read; leave it pending for a later attempt.
            return {};
        }

        const serverState = fresh.workItem.fields?.['System.State'];
        // Mirror the fresh server truth locally regardless of outcome.
        this.workItems.upsert({
            adoId,
            rev: fresh.rev ?? 0,
            etag: fresh.etag,
            fields: fresh.workItem.fields ?? {},
            org,
            project,
            state: typeof serverState === 'string' ? serverState : undefined,
            deleted: 0
        });

        if (serverState === desired) {
            this.log(`Conflict on #${adoId}: server already at desired state "${desired}" — resolved.`);
            return { resolved: true };
        }

        // Same field changed to a different value -> ask the user.
        const choice = await this.prompt({ adoId, field: 'System.State', mine: desired, theirs: serverState });
        if (choice === 'theirs') {
            this.log(`Conflict on #${adoId}: kept server value "${String(serverState)}".`);
            return { resolved: true };
        }
        this.log(`Conflict on #${adoId}: keeping local value "${String(desired)}" — retrying with fresh etag.`);
        return { retryWithEtag: fresh.etag };
    }
}
