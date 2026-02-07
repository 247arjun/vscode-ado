/**
 * Parsed query URL info
 */
export interface ParsedQueryUrl {
    organization?: string;
    project?: string;
    queryId?: string;
}

/**
 * Extract query info from an ADO URL
 * Examples:
 * - https://dev.azure.com/org/project/_queries/query/12345678-1234-1234-1234-123456789012
 * - https://org.visualstudio.com/project/_queries/query/12345678-1234-1234-1234-123456789012
 */
export function extractQueryInfoFromUrl(text: string): ParsedQueryUrl {
    // Pattern for dev.azure.com URLs
    const devAzurePattern = /https?:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_queries\/query(?:-edit)?\/([0-9a-fA-F-]{36})/i;
    // Pattern for org.visualstudio.com URLs
    const vstsPattern = /https?:\/\/([^\.]+)\.visualstudio\.com\/([^\/]+)\/_queries\/query(?:-edit)?\/([0-9a-fA-F-]{36})/i;
    
    let match = text.match(devAzurePattern);
    if (match) {
        return { organization: match[1], project: decodeURIComponent(match[2]), queryId: match[3] };
    }
    
    match = text.match(vstsPattern);
    if (match) {
        return { organization: match[1], project: decodeURIComponent(match[2]), queryId: match[3] };
    }
    
    // Just a GUID
    const guidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (guidPattern.test(text.trim())) {
        return { queryId: text.trim() };
    }
    
    return {};
}
