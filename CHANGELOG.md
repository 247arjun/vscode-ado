# Changelog

All notable changes to the "Azure DevOps Queries" extension will be documented in this file.

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
