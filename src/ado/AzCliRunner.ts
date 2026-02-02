import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

/**
 * Result from CLI execution
 */
export interface CliResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: CliError;
    exitCode: number;
}

/**
 * Classified CLI error
 */
export interface CliError {
    type: 'cli_not_found' | 'not_authenticated' | 'permission_denied' | 'flat_query_required' | 'query_not_found' | 'unknown';
    message: string;
    stderr: string;
    command: string;
}

/**
 * Active process tracking for cancellation
 */
interface ActiveProcess {
    process: ChildProcess;
    generationId: number;
}

/**
 * Azure CLI runner for executing az commands
 */
export class AzCliRunner {
    private activeProcesses: Map<string, ActiveProcess> = new Map();
    private currentGeneration = 0;
    private concurrentProcesses = 0;
    private readonly maxConcurrent = 2;

    /**
     * Execute an az command and parse JSON output
     */
    async execute<T = unknown>(args: string[], options?: { timeout?: number }): Promise<CliResult<T>> {
        // Add standard flags for JSON output and reduced noise
        const fullArgs = [...args, '--output', 'json', '--only-show-errors'];
        const command = `az ${args.join(' ')}`;

        // Check concurrency limit
        if (this.concurrentProcesses >= this.maxConcurrent) {
            return {
                success: false,
                exitCode: -1,
                error: {
                    type: 'unknown',
                    message: 'Too many concurrent CLI processes',
                    stderr: '',
                    command
                }
            };
        }

        return new Promise((resolve) => {
            this.concurrentProcesses++;
            let stdout = '';
            let stderr = '';
            let resolved = false;

            const cleanup = () => {
                this.concurrentProcesses--;
                resolved = true;
            };

            try {
                const proc = spawn('az', fullArgs, {
                    shell: true,
                    env: process.env
                });

                proc.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                proc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                proc.on('error', (err) => {
                    if (resolved) return;
                    cleanup();
                    
                    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                        resolve({
                            success: false,
                            exitCode: -1,
                            error: {
                                type: 'cli_not_found',
                                message: 'Azure CLI (az) not found. Please install it and restart VS Code.',
                                stderr: err.message,
                                command
                            }
                        });
                    } else {
                        resolve({
                            success: false,
                            exitCode: -1,
                            error: {
                                type: 'unknown',
                                message: err.message,
                                stderr: err.message,
                                command
                            }
                        });
                    }
                });

                proc.on('close', (exitCode) => {
                    if (resolved) return;
                    cleanup();

                    if (exitCode === 0) {
                        try {
                            // Handle empty output
                            const data = stdout.trim() ? JSON.parse(stdout) : null;
                            resolve({
                                success: true,
                                data: data as T,
                                exitCode: exitCode ?? 0
                            });
                        } catch (parseError) {
                            resolve({
                                success: false,
                                exitCode: exitCode ?? 0,
                                error: {
                                    type: 'unknown',
                                    message: `Failed to parse JSON output: ${parseError}`,
                                    stderr: stdout,
                                    command
                                }
                            });
                        }
                    } else {
                        const error = this.classifyError(stderr, command);
                        resolve({
                            success: false,
                            exitCode: exitCode ?? 1,
                            error
                        });
                    }
                });

                // Handle timeout
                if (options?.timeout) {
                    setTimeout(() => {
                        if (!resolved) {
                            proc.kill();
                            cleanup();
                            resolve({
                                success: false,
                                exitCode: -1,
                                error: {
                                    type: 'unknown',
                                    message: 'Command timed out',
                                    stderr: '',
                                    command
                                }
                            });
                        }
                    }, options.timeout);
                }
            } catch (err) {
                if (!resolved) {
                    cleanup();
                    resolve({
                        success: false,
                        exitCode: -1,
                        error: {
                            type: 'unknown',
                            message: String(err),
                            stderr: '',
                            command
                        }
                    });
                }
            }
        });
    }

    /**
     * Classify error based on stderr content
     */
    private classifyError(stderr: string, command: string): CliError {
        const lowerStderr = stderr.toLowerCase();

        if (lowerStderr.includes('az login') || lowerStderr.includes('not logged in') || 
            lowerStderr.includes('please run az login') || lowerStderr.includes('authentication')) {
            return {
                type: 'not_authenticated',
                message: 'Not authenticated. Please run "az login" or "az devops login" in your terminal.',
                stderr: this.redactSensitiveInfo(stderr),
                command: this.redactSensitiveInfo(command)
            };
        }

        if (lowerStderr.includes('permission') || lowerStderr.includes('unauthorized') || 
            lowerStderr.includes('403') || lowerStderr.includes('access denied')) {
            return {
                type: 'permission_denied',
                message: 'Permission denied. Check your access to the Azure DevOps project.',
                stderr: this.redactSensitiveInfo(stderr),
                command: this.redactSensitiveInfo(command)
            };
        }

        if (lowerStderr.includes('flat') || lowerStderr.includes('only supports flat queries')) {
            return {
                type: 'flat_query_required',
                message: 'Query must be a flat list query. Tree or one-hop queries are not supported.',
                stderr: this.redactSensitiveInfo(stderr),
                command: this.redactSensitiveInfo(command)
            };
        }

        if (lowerStderr.includes('not found') || lowerStderr.includes('does not exist') ||
            lowerStderr.includes('could not be found')) {
            return {
                type: 'query_not_found',
                message: 'Query not found. Please check the query ID or path.',
                stderr: this.redactSensitiveInfo(stderr),
                command: this.redactSensitiveInfo(command)
            };
        }

        return {
            type: 'unknown',
            message: stderr || 'Unknown error occurred',
            stderr: this.redactSensitiveInfo(stderr),
            command: this.redactSensitiveInfo(command)
        };
    }

    /**
     * Redact potentially sensitive information from output
     */
    private redactSensitiveInfo(text: string): string {
        // Redact PAT tokens (base64 strings that look like auth tokens)
        let redacted = text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED]');
        // Redact bearer tokens
        redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
        return redacted;
    }

    /**
     * Cancel any active process with the given key
     */
    cancelProcess(key: string): void {
        const active = this.activeProcesses.get(key);
        if (active) {
            active.process.kill();
            this.activeProcesses.delete(key);
        }
    }

    /**
     * Get a new generation ID for tracking stale requests
     */
    newGeneration(): number {
        return ++this.currentGeneration;
    }

    /**
     * Check if a generation is still current
     */
    isCurrentGeneration(generationId: number): boolean {
        return generationId === this.currentGeneration;
    }

    /**
     * Show error message with appropriate actions
     */
    async showError(error: CliError): Promise<void> {
        let actions: string[] = [];
        
        switch (error.type) {
            case 'cli_not_found':
                actions = ['Install Azure CLI'];
                const result = await vscode.window.showErrorMessage(error.message, ...actions);
                if (result === 'Install Azure CLI') {
                    vscode.env.openExternal(vscode.Uri.parse('https://docs.microsoft.com/cli/azure/install-azure-cli'));
                }
                break;
            
            case 'not_authenticated':
                actions = ['Show Command'];
                const authResult = await vscode.window.showErrorMessage(error.message, ...actions);
                if (authResult === 'Show Command') {
                    vscode.window.showInformationMessage('Run in terminal: az login  OR  az devops login');
                }
                break;
            
            default:
                vscode.window.showErrorMessage(error.message);
        }
    }
}
