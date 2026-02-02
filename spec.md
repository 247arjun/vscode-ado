Implementation spec: “ADO Query Results Tree” VS Code extension

1) Purpose

Provide a lightweight, to-do-style read-only results view inside VS Code:
	•	User creates/edits queries and work items in the Azure DevOps web UI
	•	Extension renders query results in a VS Code Tree View, grouped by configurable work item attributes
	•	Clicking a work item opens that work item in the default browser (no editing in VS Code)

2) Non-goals
	•	No work item editing, creation, or state transitions inside VS Code
	•	No custom ADO server-side changes (no extension install into ADO org)
	•	No OAuth/MSAL/PAT lifecycle implementation inside the extension (delegated to Azure CLI)

⸻

3) User experience

3.1 Primary workflow
	1.	User runs ADO: Set Query From Clipboard (or ADO: Set Query ID/Path) after copying from browser.
	2.	User runs ADO: Refresh (or auto-refresh happens).
	3.	Tree View shows results grouped by selected fields (e.g., Assigned To → Priority → Due Date bucket).
	4.	User clicks a leaf work item; browser opens the work item page.

3.2 View layout
	•	Contribute a view container (optional) or a single view under Explorer.
	•	Tree items:
	•	Group nodes (non-leaf): show group label + count, expandable
	•	Leaf nodes: show #ID Title with optional secondary state (e.g., [Active])

3.3 Commands
	•	adoTodo.setQueryFromClipboard
	•	adoTodo.setQueryManual
	•	adoTodo.setGroupBy
	•	adoTodo.refresh
	•	adoTodo.openWorkItem (invoked on leaf click)
	•	adoTodo.openQueryInBrowser (optional convenience)

⸻

4) External dependencies / prerequisites

4.1 Required tools
	•	Azure CLI (az)
	•	azure-devops extension for Azure CLI (provides az boards ...)  ￼

4.2 Authentication expectation

User is already authenticated via one of:
	•	az login (Entra)
	•	az devops login (PAT)

Extension does not prompt for interactive auth; it detects failures and presents remediation instructions.

4.3 Flat query requirement

az boards query only supports flat queries  ￼
If the user’s saved query is “Tree of work items” in ADO, they must switch it to “Flat list of work items”.

⸻

5) Configuration model (VS Code settings)

All settings prefixed with adoTodo.*:

5.1 Connection settings
	•	adoTodo.organization (string, required)
	•	Example: https://dev.azure.com/MyOrg/
	•	adoTodo.project (string, required)
	•	adoTodo.detectFromGit (boolean, default: true)
	•	If true, allow --detect true behavior (CLI can infer org/project from repo config).

CLI docs note org/project can be set via az devops configure -d ... as defaults.  ￼

5.2 Query source (one of the following)
	•	adoTodo.query.id (string GUID)
	•	adoTodo.query.path (string)
	•	adoTodo.query.wiql (string)

az boards query supports --id, --path, --wiql  ￼

5.3 Group-by specification
	•	adoTodo.groupBy (array of objects, ordered)
	•	Example:
	•	{ "field": "System.AssignedTo", "projection": "displayName", "missingLabel": "(unassigned)" }
	•	{ "field": "Microsoft.VSTS.Common.Priority", "missingLabel": "(no priority)" }
	•	{ "field": "Microsoft.VSTS.Scheduling.DueDate", "bucket": "date", "dateBucket": "overdue|today|thisWeek|future|none" }

Constraints:
	•	Support up to 5 grouping levels
	•	A group field may be identity, string, number, or date

5.4 Performance knobs
	•	adoTodo.maxItems (int, default 500)
	•	adoTodo.refreshIntervalSeconds (int, default 0 = manual only)
	•	adoTodo.cacheTtlSeconds (int, default 30)
	•	adoTodo.batchSize (int, default 200)

Work Items Batch max is 200 per request.  ￼

⸻

6) Data flow and architecture

6.1 Components
	1.	TreeDataProvider: renders grouped tree nodes
	2.	AdoClient (CLI-backed): executes az ... commands, parses JSON
	3.	Grouping engine: converts a flat list of work items into a nested tree model
	4.	Link resolver: determines browser URL per work item (prefers canonical link)

6.2 Command execution strategy

Use Node child_process.spawn (or execFile) from the extension host:
	•	Avoid relying on the integrated terminal (harder to capture structured output)
	•	Always request JSON output: --output json
	•	Reduce noise: --only-show-errors

6.3 Primary retrieval algorithm

Phase A: Get matching work item IDs (and possibly partial fields)
	•	Run:
	•	az boards query --id ... --org ... --project ... --output json
	•	or --path / --wiql

Phase B (recommended for correctness): Fetch required fields in batch
Because the query result may not reliably contain every field needed for grouping across CLI versions, do:
	•	For all IDs, fetch only the fields you need for:
	•	groupBy fields
	•	title/state (for leaf label)
	•	Use Work Items Batch REST API (max 200 IDs per call).  ￼
	•	Execute it via CLI so the extension doesn’t manage tokens:
	•	az devops invoke (generic REST invocation)  ￼

Batch request shape (conceptual)
	•	Endpoint: /_apis/wit/workitemsbatch?api-version=7.1
	•	Body includes ids and fields (only those required)

6.4 Tree model construction

Input: WorkItem[] where each has:
	•	id: number
	•	fields: { [refName: string]: any }

Output: nested nodes:
	•	GroupNode { key: string, label: string, count: number, children: Node[] }
	•	WorkItemNode { id: number, title: string, state?: string, url?: string }

⸻

7) Grouping engine specification

7.1 Field extraction

Implement getFieldValue(workItem, groupSpec):
	•	If groupSpec.field is present in fields:
	•	If identity object and projection is set:
	•	e.g. System.AssignedTo → { displayName, uniqueName, ... }
	•	Use displayName (default) or configured projection
	•	If date:
	•	parse ISO string to Date (fail-safe on invalid)
	•	Else:
	•	stringify primitive
	•	If missing/null/empty:
	•	return missingLabel (default (none))

7.2 Date bucketing

If bucket: "date":
	•	Convert date to local date
	•	Map into one of configured buckets:
	•	overdue (date < today)
	•	today (same calendar day)
	•	thisWeek (today..today+6)
	•	future (>= next week)
	•	none (missing)

7.3 Sorting
	•	Group nodes sorted by:
	•	identity/name: localeCompare
	•	numeric: ascending
	•	date buckets: overdue, today, thisWeek, future, none
	•	Work items within a leaf group sorted by:
	•	priority then ID (configurable)

7.4 Incremental refresh behavior
	•	On refresh:
	•	compute hash of IDs + selected fields
	•	if unchanged and cache TTL not expired: no tree rebuild
	•	otherwise rebuild tree and fire onDidChangeTreeData

⸻

8) Opening work items in browser

8.1 Preferred approach (canonical URL)

On leaf click:
	1.	Fetch work item JSON via:
	•	az boards work-item show --id <id> --org ... --project ... --output json  ￼
	2.	Extract the canonical HTML URL (from the work item representation).
	3.	Open using:
	•	vscode.env.openExternal(vscode.Uri.parse(url))  ￼

8.2 Fallback URL construction

If link extraction fails, construct:
	•	{org}/{project}/_workitems/edit/{id}
and open via openExternal.

⸻

9) VS Code extension implementation details

9.1 Contribution points (package.json)
	•	contributes.views and optionally contributes.viewsContainers
	•	contributes.commands for all commands
	•	contributes.menus:
	•	view title menu: Refresh / Configure
	•	view item context menu: Open in Browser / Copy ID
	•	activationEvents:
	•	onView: onView:adoTodo.results
	•	onCommand: the command set

Tree View implementation is based on TreeDataProvider and contributed views.  ￼

9.2 Extension entry points
	•	activate(context)
	•	instantiate AdoTreeProvider
	•	vscode.window.registerTreeDataProvider(viewId, provider)
	•	register commands
	•	deactivate()
	•	dispose timers/process handles

Tree registration APIs are in the VS Code API reference.  ￼

⸻

10) Error handling and UX states

10.1 “Not configured” state

If org/project/query missing:
	•	Tree shows a single node: “Configure query…”
	•	Clicking runs setQueryFromClipboard

10.2 CLI not found

If az not on PATH:
	•	Show error with:
	•	detected PATH
	•	suggestion to install Azure CLI and restart VS Code

10.3 Not logged in / permission denied

Detect typical failures (non-zero exit, stderr containing auth hints):
	•	Show an error with the exact az command (redacting secrets)
	•	Provide instruction:
	•	az login or az devops login
	•	Do not attempt to open login UI from the extension

10.4 Query fails (non-flat / missing)

If az boards query returns “only supports flat queries” or empty:
	•	Show actionable message: “Query must be a flat list query”  ￼

⸻

11) Security requirements
	•	No token capture or storage
	•	Never log stdout/stderr unredacted in output channel if it could contain auth artifacts
	•	Store only:
	•	org/project
	•	query id/path/wiql (wiql may contain area paths; treat as potentially sensitive but acceptable in VS Code settings)
	•	Run CLI with --only-show-errors where possible

⸻

12) Performance requirements
	•	Initial refresh target: < 2 seconds for <= 200 items (assuming CLI responsiveness)
	•	For > 200 items:
	•	batch in chunks of batchSize (default 200)  ￼
	•	show progress notification “Fetching work items (n/m)…”
	•	Cache:
	•	in-memory cache keyed by (org, project, query, groupBy)
	•	TTL default 30s
	•	Concurrency:
	•	at most 2 simultaneous CLI processes
	•	cancel/ignore stale refreshes (use a refresh “generation id”)

⸻

13) Testing plan

13.1 Unit tests
	•	Grouping engine:
	•	identity projection
	•	missing values
	•	date bucketing
	•	stable sorting
	•	Query parsing:
	•	clipboard URL → query id extraction (best-effort patterns)

13.2 Integration tests (mock CLI)
	•	Replace CLI runner with a fixture provider returning JSON blobs
	•	Validate TreeDataProvider output nodes for a known dataset

13.3 Manual acceptance checklist
	•	Works on macOS with az installed
	•	Handles:
	•	query by --id
	•	query by --path
	•	query by --wiql
	•	Leaf click opens browser via vscode.env.openExternal  ￼
	•	Flat query constraint correctly messaged  ￼

⸻

14) Deliverables / file structure
	•	src/extension.ts (activation, command registration)
	•	src/tree/AdoTreeProvider.ts (TreeDataProvider)
	•	src/ado/AzCliRunner.ts (spawn/execFile wrapper, JSON parsing, error classification)
	•	src/ado/AdoClient.ts (query, batchFetch, showWorkItem)
	•	src/grouping/GroupingEngine.ts (pure functions)
	•	src/config/Settings.ts (typed accessors + validation)
	•	package.json (contributions, commands, activationEvents)
	•	README.md (setup: install az + azure-devops extension, login, configure org/project/query)
	•	CHANGELOG.md

⸻

15) Implementation notes for the engineer

15.1 Prefer query ID/path over WIQL for stability

--id/--path matches what the user created in the browser and avoids embedding long WIQL in settings.  ￼

15.2 Always include org/project explicitly in CLI invocations

Even though az devops configure -d ... can set defaults, explicit flags make the extension deterministic across environments.  ￼

15.3 Keep the extension read-only

Any “edit” ambition quickly pushes you back into:
	•	field rules, transitions, validation
	•	error-prone partial updates
This design deliberately uses browser for edits.
