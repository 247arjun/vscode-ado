import * as vscode from 'vscode';
import { AzCliRunner } from '../ado/AzCliRunner';

/**
 * The well-known Azure DevOps application (resource) ID. Requesting a token for
 * this resource is how first-party apps (including the official Azure DevOps
 * extension) authenticate — no app registration and no PAT required.
 */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

/** Scope string for the VS Code Microsoft auth provider. */
const ADO_SCOPES = [`${ADO_RESOURCE_ID}/.default`];

interface CachedToken {
    token: string;
    /** epoch ms */
    expiresAt: number;
}

/**
 * Single source of bearer tokens for Azure DevOps.
 *
 * Primary: VS Code's built-in **Microsoft authentication provider** — reuses the
 * user's interactive corporate sign-in (MFA / Conditional Access / device
 * compliance all handled by VS Code), silently refreshed, no app registration,
 * no PAT.
 *
 * Fallback: the **Azure CLI** access token (the extension already depends on
 * `az login`), used only when the VS Code provider can't return a session.
 *
 * The rest of the app depends only on {@link getToken}; it never knows or cares
 * which source produced the token.
 */
export class TokenProvider {
    private cached: CachedToken | undefined;
    private readonly _onDidChangeAuth = new vscode.EventEmitter<void>();
    readonly onDidChangeAuth = this._onDidChangeAuth.event;

    constructor(private readonly cliRunner: AzCliRunner = new AzCliRunner()) {
        // React to the user signing in/out elsewhere in VS Code.
        try {
            vscode.authentication.onDidChangeSessions((e) => {
                if (e.provider.id === 'microsoft') {
                    this.cached = undefined;
                    this._onDidChangeAuth.fire();
                }
            });
        } catch {
            // authentication API may be unavailable in some hosts; degrade gracefully.
        }
    }

    /** True if we currently hold (or can silently obtain) a session. */
    async isSignedIn(): Promise<boolean> {
        const session = await this.getMicrosoftSession(false);
        return !!session;
    }

    /**
     * Return a valid bearer token, or undefined if none can be obtained without
     * interaction. Callers should degrade to offline mode on undefined.
     */
    async getToken(): Promise<string | undefined> {
        const now = Date.now();
        if (this.cached && this.cached.expiresAt - now > 5 * 60 * 1000) {
            return this.cached.token;
        }

        // Primary: VS Code Microsoft provider (silent).
        const session = await this.getMicrosoftSession(false);
        if (session?.accessToken) {
            // VS Code refreshes silently; we cache for an hour minus a margin.
            this.cached = { token: session.accessToken, expiresAt: now + 55 * 60 * 1000 };
            return session.accessToken;
        }

        // Fallback: Azure CLI token.
        const cliToken = await this.getCliToken();
        if (cliToken) {
            this.cached = cliToken;
            return cliToken.token;
        }

        return undefined;
    }

    /** Force an interactive sign-in (e.g. from a "Sign in" button). */
    async signIn(): Promise<boolean> {
        const session = await this.getMicrosoftSession(true);
        if (session?.accessToken) {
            this.cached = { token: session.accessToken, expiresAt: Date.now() + 55 * 60 * 1000 };
            this._onDidChangeAuth.fire();
            return true;
        }
        return false;
    }

    private async getMicrosoftSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
        try {
            return await vscode.authentication.getSession('microsoft', ADO_SCOPES, {
                createIfNone,
                silent: !createIfNone
            });
        } catch {
            return undefined;
        }
    }

    private async getCliToken(): Promise<CachedToken | undefined> {
        try {
            const result = await this.cliRunner.execute<{ accessToken: string; expiresOn?: string; expires_on?: number }>(
                ['account', 'get-access-token', '--resource', ADO_RESOURCE_ID]
            );
            if (result.success && result.data?.accessToken) {
                let expiresAt = Date.now() + 50 * 60 * 1000;
                if (result.data.expiresOn) {
                    const parsed = Date.parse(result.data.expiresOn);
                    if (!Number.isNaN(parsed)) expiresAt = parsed;
                }
                return { token: result.data.accessToken, expiresAt };
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    dispose(): void {
        this._onDidChangeAuth.dispose();
    }
}
