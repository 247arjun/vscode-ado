/**
 * Test runner – executes all test suites that don't depend on the VS Code API.
 *
 * Usage:  npm test          (runs the compiled JS in out/)
 *         npx ts-node src/test/runTests.ts   (runs directly via ts-node)
 */

import { runTests as runGroupingEngineTests } from './groupingEngine.test';
import { runTests as runUrlParsingTests } from './urlParsing.test';
import { runTests as runDatabaseTests } from './database.test';
import { runTests as runOutboxTests } from './outbox.test';

async function main(): Promise<void> {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   Azure DevOps Queries – Tests       ║');
    console.log('╚══════════════════════════════════════╝');

    runGroupingEngineTests();
    runUrlParsingTests();
    await runDatabaseTests();
    await runOutboxTests();

    console.log('\n✔  All test suites passed.\n');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
