# Changelog

All notable changes to the "Azure DevOps Queries" extension will be documented in this file.

## [0.8.0] - 2026-02-06

### Fixed

- Queries now load sequentially instead of in parallel to avoid "Too many concurrent CLI processes" errors when multiple queries are configured

## [0.7.0] - 2026-02-03

### Added

- **Batch fetch fix**: Work items are now fetched via `az devops invoke` with a proper POST body, dramatically improving performance for large queries
- **Parallel query loading**: Multiple queries load concurrently using `Promise.allSettled`
- **Per-query refresh**: Right-click a query node → "Refresh This Query" to reload just that query
- **Remove Query**: Right-click a query node → "Remove Query" to delete it from settings
- **Rename Query**: Right-click a query node → "Rename Query" to update its display name
- **Copy Work Item URL**: Right-click a work item → "Copy Work Item URL" to copy the ADO link
- **Output channel**: "Azure DevOps: Show Output Log" command for diagnostics and troubleshooting
- **Welcome view**: Helpful onboarding buttons when no queries are configured
- **Status bar item**: Shows total work item count and last refresh time
- **Auto-fetch query name**: When adding from clipboard, the query name is fetched from ADO automatically
- **Keyboard shortcut**: `Cmd+Shift+R` (macOS) / `Ctrl+Shift+R` (Windows/Linux) to refresh all queries
- **Custom extension icon**: Activity bar and marketplace icons
- **Unit tests**: GroupingEngine and URL parsing test suites with a standalone test runner
- **ESLint + Prettier**: Code quality tooling with TypeScript-specific rules
- **Workspace-scoped settings**: `adoQueries.queries` setting supports workspace-level configuration

### Changed

- Publisher set to `ArjunGopalakrishna`
- Context menu items organized into groups (Copy, Query, Manage)
- URL parsing extracted to `src/utils/urlParser.ts` for testability

### Removed

- `spec.md` removed from repository

## [0.6.0] - 2026-02-02

### Changed

- Group nodes now default to collapsed (only query-level nodes expanded)
- Added "Expand All" button to view title bar

## [0.5.0] - 2026-01-31

### Added

- Multi-query support: configure multiple queries as top-level tree nodes
- Per-query organization and project settings (queries can span different ADO orgs)
- Per-query groupBy configuration
- Smart URL parsing: automatically extracts organization, project, and query ID from clipboard URLs
- Support for both `dev.azure.com` and `*.visualstudio.com` URL formats

### Changed

- Renamed settings prefix from `adoTodo` to `adoQueries`
- Renamed extension from "ADO Query Results Tree" to "Azure DevOps Queries"
- Updated all command names to use "Azure DevOps:" prefix
- Default grouping changed from [AssignedTo, Priority] to [State]
- Removed legacy single-query settings (query.id, query.path, query.wiql)

### Removed

- Legacy single-query configuration (use `adoQueries.queries` array instead)

## [0.0.1] - 2026-01-30

### Added

- Initial release
- Tree view for Azure DevOps query results
- Multi-level grouping by work item fields
- Identity field support with projection (displayName, uniqueName)
- Date bucketing (overdue, today, this week, future)
- Click to open work items in browser
- Copy work item ID to clipboard
- Auto-refresh capability
- In-memory caching with configurable TTL
- Azure CLI integration for authentication
- Query configuration via ID, path, or WIQL
- Configurable maximum items and batch size
- Progress indicators for large fetches
- Error handling with actionable messages
