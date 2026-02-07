import * as assert from 'assert';
import { extractQueryInfoFromUrl } from '../utils/urlParser';

/**
 * Unit tests for URL parsing
 */
function runUrlParsingTests(): void {

    // ── dev.azure.com URLs ───────────────────────────────────────────

    test('parses dev.azure.com query URL', () => {
        const result = extractQueryInfoFromUrl(
            'https://dev.azure.com/myorg/myproject/_queries/query/12345678-1234-1234-1234-123456789012'
        );
        assert.strictEqual(result.organization, 'myorg');
        assert.strictEqual(result.project, 'myproject');
        assert.strictEqual(result.queryId, '12345678-1234-1234-1234-123456789012');
    });

    test('parses dev.azure.com query-edit URL', () => {
        const result = extractQueryInfoFromUrl(
            'https://dev.azure.com/myorg/myproject/_queries/query-edit/abcdefab-abcd-abcd-abcd-abcdefabcdef'
        );
        assert.strictEqual(result.organization, 'myorg');
        assert.strictEqual(result.project, 'myproject');
        assert.strictEqual(result.queryId, 'abcdefab-abcd-abcd-abcd-abcdefabcdef');
    });

    test('parses dev.azure.com URL with encoded project name', () => {
        const result = extractQueryInfoFromUrl(
            'https://dev.azure.com/myorg/My%20Project/_queries/query/12345678-1234-1234-1234-123456789012'
        );
        assert.strictEqual(result.organization, 'myorg');
        assert.strictEqual(result.project, 'My Project');
        assert.strictEqual(result.queryId, '12345678-1234-1234-1234-123456789012');
    });

    // ── visualstudio.com URLs ────────────────────────────────────────

    test('parses visualstudio.com query URL', () => {
        const result = extractQueryInfoFromUrl(
            'https://myorg.visualstudio.com/myproject/_queries/query/12345678-1234-1234-1234-123456789012'
        );
        assert.strictEqual(result.organization, 'myorg');
        assert.strictEqual(result.project, 'myproject');
        assert.strictEqual(result.queryId, '12345678-1234-1234-1234-123456789012');
    });

    test('parses visualstudio.com query-edit URL', () => {
        const result = extractQueryInfoFromUrl(
            'https://myorg.visualstudio.com/myproject/_queries/query-edit/abcdefab-abcd-abcd-abcd-abcdefabcdef'
        );
        assert.strictEqual(result.organization, 'myorg');
        assert.strictEqual(result.project, 'myproject');
        assert.strictEqual(result.queryId, 'abcdefab-abcd-abcd-abcd-abcdefabcdef');
    });

    // ── Bare GUID ────────────────────────────────────────────────────

    test('parses bare GUID', () => {
        const result = extractQueryInfoFromUrl('12345678-1234-1234-1234-123456789012');
        assert.strictEqual(result.queryId, '12345678-1234-1234-1234-123456789012');
        assert.strictEqual(result.organization, undefined);
        assert.strictEqual(result.project, undefined);
    });

    test('parses bare GUID with whitespace', () => {
        const result = extractQueryInfoFromUrl('  12345678-1234-1234-1234-123456789012  ');
        assert.strictEqual(result.queryId, '12345678-1234-1234-1234-123456789012');
    });

    // ── Invalid input ────────────────────────────────────────────────

    test('returns empty for invalid URL', () => {
        const result = extractQueryInfoFromUrl('https://google.com');
        assert.strictEqual(result.organization, undefined);
        assert.strictEqual(result.project, undefined);
        assert.strictEqual(result.queryId, undefined);
    });

    test('returns empty for empty string', () => {
        const result = extractQueryInfoFromUrl('');
        assert.strictEqual(result.organization, undefined);
        assert.strictEqual(result.project, undefined);
        assert.strictEqual(result.queryId, undefined);
    });

    test('returns empty for random text', () => {
        const result = extractQueryInfoFromUrl('hello world this is not a url');
        assert.strictEqual(result.queryId, undefined);
    });

    test('returns empty for partial GUID', () => {
        const result = extractQueryInfoFromUrl('12345678-1234');
        assert.strictEqual(result.queryId, undefined);
    });

    // ── Case insensitivity ───────────────────────────────────────────

    test('handles uppercase GUID in URL', () => {
        const result = extractQueryInfoFromUrl(
            'https://dev.azure.com/myorg/myproject/_queries/query/ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF'
        );
        assert.strictEqual(result.queryId, 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF');
    });
}

// ─── Test infrastructure ─────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name: string, fn: () => void): void {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failCount++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err}`);
    }
}

// ─── Run ─────────────────────────────────────────────────────────────

export function runTests(): void {
    console.log('\n=== URL Parsing Tests ===\n');
    runUrlParsingTests();
    console.log(`\n${passCount}/${testCount} passed, ${failCount} failed\n`);
    if (failCount > 0) {
        process.exit(1);
    }
}
