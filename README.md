# Azure DevOps Queries

A VS Code extension that displays Azure DevOps query results as a grouped tree view, providing a lightweight to-do-style read-only view of your work items.

## Features

- View Azure DevOps query results directly in VS Code
- **Multiple queries** as top-level expandable nodes with custom names
- Group work items by multiple fields (up to 5 levels)
- Per-query or global grouping configuration
- Support for identity, priority, date, and custom fields
- Date bucketing (overdue, today, this week, future)
- Click to open work items in your browser
- Auto-refresh capability

## Prerequisites

### 1. Install Azure CLI

The extension requires Azure CLI with the DevOps extension:

```bash
# Install Azure CLI
# macOS
brew install azure-cli

# Windows
winget install -e --id Microsoft.AzureCLI

# Linux
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

### 2. Install Azure DevOps Extension

```bash
az extension add --name azure-devops
```

### 3. Authenticate

Log in with one of these methods:

```bash
# Using Entra ID (recommended)
az login

# Using Personal Access Token
az devops login
```

## Configuration

### Required Settings

Set these in your VS Code settings (`settings.json`) or through the Settings UI:

```json
{
  "adoQueries.organization": "YourOrg",
  "adoQueries.project": "YourProject",
  "adoQueries.queries": [
    {
      "name": "Sprint Tasks",
      "queryId": "12345678-1234-1234-1234-123456789012"
    },
    {
      "name": "My Bugs",
      "queryId": "abcdefab-abcd-abcd-abcd-abcdefabcdef"
    }
  ]
}
```

### Query Configuration

Each query in the `adoQueries.queries` array supports:

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Custom display name for the query |
| `queryId` | One of these | Query GUID (recommended) |
| `queryPath` | One of these | Query path (e.g., "Shared Queries/My Query" or "My Queries/Active") |
| `groupBy` | No | Per-query grouping (overrides global `adoQueries.groupBy`) |
| `collapsed` | No | Start this query collapsed (default: false) |

**Example with per-query grouping:**

```json
{
  "adoQueries.queries": [
    {
      "name": "Sprint Tasks",
      "queryId": "abc-123...",
      "groupBy": [
        { "field": "System.AssignedTo", "projection": "displayName" },
        { "field": "System.State" }
      ]
    },
    {
      "name": "Bugs by Priority",
      "queryId": "def-456...",
      "groupBy": [
        { "field": "Microsoft.VSTS.Common.Priority" }
      ],
      "collapsed": true
    }
  ]
}
```

> **Important**: Only flat queries are supported. If you have a "Tree of work items" query, change it to "Flat list of work items" in Azure DevOps.

### Group By Configuration

Customize how work items are grouped:

```json
{
  "adoQueries.groupBy": [
    {
      "field": "System.AssignedTo",
      "projection": "displayName",
      "missingLabel": "(unassigned)"
    },
    {
      "field": "Microsoft.VSTS.Common.Priority",
      "missingLabel": "(no priority)"
    },
    {
      "field": "Microsoft.VSTS.Scheduling.DueDate",
      "bucket": "date"
    }
  ]
}
```

#### Group By Options

| Property | Description |
|----------|-------------|
| `field` | Work item field reference name |
| `projection` | For identity fields: `displayName`, `uniqueName`, etc. |
| `missingLabel` | Label shown when field value is missing |
| `bucket` | Set to `"date"` for date bucketing |

### Performance Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `adoQueries.maxItems` | 500 | Maximum work items to fetch |
| `adoQueries.refreshIntervalSeconds` | 0 | Auto-refresh interval (0 = manual only) |
| `adoQueries.cacheTtlSeconds` | 30 | Cache time-to-live |
| `adoQueries.batchSize` | 200 | Batch size for fetching (max 200) |

## Commands

| Command | Description |
|---------|-------------|
| `Azure DevOps: Add Query From Clipboard` | Add query from a copied Azure DevOps URL or ID |
| `Azure DevOps: Add Query` | Manually enter query ID or path |
| `Azure DevOps: Configure Grouping` | Open group-by settings |
| `Azure DevOps: Refresh Queries` | Refresh all queries |
| `Azure DevOps: Open Query in Browser` | Open the query in Azure DevOps web |

## Usage

1. **Set up authentication**: Run `az login` or `az devops login` in your terminal
2. **Configure the extension**: Set organization, project, and queries
3. **View work items**: Open the Azure DevOps Queries view in the sidebar
4. **Click to open**: Click any work item to open it in your browser

### Quick Setup

1. Copy a query URL from Azure DevOps (e.g., from your browser address bar)
2. Run command: `Azure DevOps: Add Query From Clipboard`
3. The extension will extract the query ID and configure itself

## Troubleshooting

### "Azure CLI not found"

Make sure Azure CLI is installed and in your PATH. Restart VS Code after installation.

### "Not authenticated"

Run `az login` or `az devops login` in your terminal.

### "Query must be a flat list query"

Your query is configured as a tree or one-hop query. Edit the query in Azure DevOps and change it to "Flat list of work items".

### "Permission denied"

Ensure you have read access to the Azure DevOps project and query.

## Known Limitations

- Read-only: work item editing is done in the browser
- Only flat queries are supported (no tree or one-hop queries)
- Maximum 5 grouping levels
- Batch fetching limited to 200 items per request

## License

MIT
