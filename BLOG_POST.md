# Building a VS Code Extension to Manage Engineering Work: A Manager's Journey

As an engineering manager, I found myself constantly context-switching between VS Code and Azure DevOps (ADO) to track work items, check on team progress, and manage my own tasks. Every time I needed to see what was on someone's plate or check the status of a bug, I'd have to open a browser, navigate to Azure DevOps, wait for the page to load, and then find the right query. It was a small friction, but it happened dozens of times per day.

So I decided to build a VS Code extension that would bring Azure DevOps queries directly into my editor. This is the story of how I built [Azure DevOps Queries](https://marketplace.visualstudio.com/items?itemName=ArjunGopalakrishna.azure-devops-queries), and the lessons I learned along the way.

## The Problem: Too Much Context Switching

Engineering management involves a constant dance between coding, reviewing, planning, and tracking. My typical workflow looked like this:

1. Working in VS Code, reviewing a pull request
2. Need to check if a related bug is assigned
3. Switch to browser, navigate to Azure DevOps
4. Find the right query, check the status
5. Switch back to VS Code
6. Repeat 10-20 times per day

This constant context switching was killing my flow state. More importantly, it made me less accessible to my team. When someone asked "what should I work on next?" I couldn't give them an instant answer without breaking my own focus.

## The Vision: Lightweight, Read-Only, Always Available

I didn't want to rebuild Azure DevOps inside VS Code. I wanted something lightweight that would:

1. **Display query results as a tree view** - Just like ADO's queries, but always visible in my sidebar
2. **Support multiple queries** - Different views for different contexts (sprint tasks, bugs, my items, team items)
3. **Group intelligently** - By assignee, priority, state, due date - whatever makes sense for each query
4. **Stay out of the way** - Read-only, minimal UI, keyboard shortcuts
5. **Open in browser for details** - When I need to edit or see full context, one click takes me to ADO

The key insight: I didn't need to edit work items in VS Code. I just needed visibility.

## The Architecture: Keep It Simple

### Azure CLI as the Backend

Rather than implementing my own Azure DevOps authentication and API client, I built on top of the Azure CLI. This decision saved weeks of development time:

- **Authentication is solved**: `az login` handles Entra ID, PATs, and refresh tokens
- **API access is abstracted**: The `az devops` extension handles all the REST calls
- **No credentials in my code**: Security is delegated to a battle-tested tool
- **Works everywhere**: macOS, Windows, Linux - wherever Azure CLI runs

### TypeScript and VS Code Extension API

The extension is built with TypeScript and the VS Code Extension API. Key architectural decisions:

1. **TreeDataProvider pattern**: VS Code's built-in tree view API made the UI almost trivial
2. **Lazy loading**: Query results are fetched on-demand and cached for 30 seconds
3. **Batch fetching**: Work items are fetched in batches of 200 to handle large queries
4. **Sequential query loading**: Multiple queries load one at a time to avoid overwhelming the CLI

### Modular Design

The codebase is organized into logical modules:

```
src/
  ado/          # Azure CLI wrapper and API calls
  config/       # Settings and configuration management
  grouping/     # Work item grouping and tree building logic
  tree/         # VS Code tree view provider
  utils/        # URL parsing, date bucketing, helpers
```

This separation made testing easier and kept the code maintainable as features grew.

## The Features: Built for Daily Use

### 1. Multiple Queries as Top-Level Nodes

The first version supported a single query. But as a manager, I need multiple views:

- **Sprint Work**: All tasks in the current sprint, grouped by assignee and state
- **Bugs**: All active bugs, grouped by priority and owner
- **My Items**: Just my work, grouped by due date
- **Unassigned**: Items waiting for someone to pick them up

Each query appears as a collapsible node in the tree, with its own refresh button and context menu.

### 2. Flexible Grouping

Work items can be grouped by up to 5 levels. Some grouping strategies I use:

**For sprint planning**:
```json
[
  { "field": "System.AssignedTo", "projection": "displayName" },
  { "field": "System.State" },
  { "field": "Microsoft.VSTS.Common.Priority" }
]
```

**For bug triage**:
```json
[
  { "field": "Microsoft.VSTS.Common.Priority" },
  { "field": "System.AssignedTo", "projection": "displayName" }
]
```

**For deadline tracking**:
```json
[
  { "field": "Microsoft.VSTS.Scheduling.DueDate", "bucket": "date" }
]
```

The date bucketing feature automatically groups items into:
- 🔴 Overdue
- 📅 Today  
- 📆 This Week
- 📅 Future
- ❓ No Due Date

### 3. Quick Actions

Right-click context menus provide one-click access to common actions:

- **Open in Browser**: Jump to the full work item in ADO
- **Copy Work Item ID**: Quick reference for slack messages
- **Copy Work Item URL**: Share links with the team
- **Refresh This Query**: Update just one view without refreshing everything
- **Rename Query**: Customize display names without changing ADO
- **Remove Query**: Clean up your sidebar

### 4. Smart URL Parsing

Adding a query is as simple as:

1. Copy a query URL from Azure DevOps (from your browser)
2. Run: `Azure DevOps: Add Query From Clipboard`
3. Done

The extension automatically extracts:
- Organization name (works with both `dev.azure.com` and `*.visualstudio.com`)
- Project name
- Query ID
- Even fetches the query name from ADO

### 5. Status Bar Integration

A status bar item shows the total work item count across all queries and the last refresh time. At a glance, I can see: "42 items • Updated 2m ago"

### 6. Keyboard Shortcuts

`Cmd+Shift+R` (macOS) / `Ctrl+Shift+R` (Windows/Linux) refreshes all queries. When you're reviewing work and want the latest, no need to reach for the mouse.

## The Challenges: What I Learned

### 1. Performance with Large Queries

Early versions had terrible performance with queries returning 200+ items. The Azure CLI doesn't have a batch work item fetch API, so I was making one API call per work item.

**Solution**: I discovered `az devops invoke`, which lets you make raw REST API calls. I switched to calling the batch work items API directly via POST, reducing 200 API calls to just one. Query loading went from 30+ seconds to under 2 seconds.

### 2. Too Many Concurrent CLI Processes

When I added support for multiple queries, users with 5+ queries would get "too many concurrent CLI processes" errors. The CLI has internal rate limiting.

**Solution**: Changed from parallel (`Promise.all`) to sequential loading. Queries now load one at a time. The total time is slightly longer, but it's reliable and still fast enough.

### 3. State Management

VS Code tree views are stateful - they remember expansion state, selection, and focus. But when you refresh data, you lose all that state by default.

**Solution**: I track query indices and use stable IDs for tree items. The tree view can restore expansion state even after a full refresh. Users don't lose their place when data updates.

### 4. Testing Without ADO Access

Unit testing an extension that depends on external services is tricky. I can't assume developers have Azure DevOps accounts or want to configure credentials.

**Solution**: I extracted pure logic into testable modules:
- `GroupingEngine`: Builds the tree from work items (no I/O)
- `urlParser`: Extracts info from URLs (no I/O)
- Mocked the ADO API layer for integration tests

This let me build comprehensive test coverage for the complex logic without needing ADO credentials.

## The Impact: Measuring Success

After using this extension for several weeks, I've noticed:

### Time Savings
- **~15 minutes per day** saved from context switching
- **~2 hours per week** saved during sprint planning (everyone can see the board in VS Code)
- **Faster responses** to team questions about work status

### Improved Awareness
- I check work status **3-4x more frequently** because there's no friction
- I catch blockers **earlier** because work items are always visible
- I make **better prioritization decisions** because I can see the full picture while coding

### Team Adoption
What surprised me most: my team started using it too. Engineers love having their task list in VS Code, and it's sparked interesting conversations:

- "Should we group by state or priority?"
- "What date bucketing makes sense for our team?"
- "Can we create a query for items ready for review?"

The extension became a catalyst for better work item hygiene and process discussions.

## Lessons for Aspiring Extension Authors

### 1. Start with Your Own Pain

I didn't build this extension because I thought it would be popular. I built it because I was frustrated. That authentic need guided every design decision and kept me motivated when things got hard.

### 2. Leverage Existing Tools

By building on Azure CLI instead of implementing my own auth and API client, I saved weeks of work. Look for what's already solved before writing code.

### 3. Read-Only is a Superpower

The hardest part of many integrations is handling writes - validation, conflict resolution, error handling. By keeping this extension read-only, I eliminated 80% of the complexity while delivering 90% of the value.

### 4. Make It Configurable

What works for me won't work for everyone. By making grouping, queries, and display options configurable, the extension serves many workflows without becoming bloated.

### 5. Polish Matters

Little touches made a big difference:
- Auto-detecting organization from URLs
- Fetching query names automatically  
- Date bucketing for due dates
- Keyboard shortcuts
- Status bar integration

These weren't hard to implement, but they transformed the extension from "functional" to "delightful."

### 6. Test the Hard Parts

You don't need 100% test coverage, but test the complex logic - the stuff that's hard to verify manually. For me, that was the grouping engine and URL parsing. Those tests caught numerous bugs and gave me confidence to refactor.

## What's Next

The extension is feature-complete for my needs, but there are interesting directions it could go:

- **Work item preview pane**: Show full details without opening browser
- **Filtering**: Hide certain work item types or states
- **Search**: Quick find across all queries
- **Comments**: Show recent comments on work items
- **Notifications**: Alert when assigned new items

But honestly? I'm happy with where it is. It solves my problem, it's stable, and it stays out of the way.

## Try It Yourself

If you're an engineering manager (or engineer) working with Azure DevOps and VS Code, give [Azure DevOps Queries](https://marketplace.visualstudio.com/items?itemName=ArjunGopalakrishna.azure-devops-queries) a try:

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ArjunGopalakrishna.azure-devops-queries)
2. Install Azure CLI and authenticate: `az login`
3. Copy a query URL from Azure DevOps
4. Run: `Azure DevOps: Add Query From Clipboard`
5. Configure grouping to match your workflow

The [source code is on GitHub](https://github.com/247arjun/vscode-ado) if you want to learn from it or contribute.

## Final Thoughts

Building this extension taught me that the best tools often come from personal frustration. As managers, we spend a lot of time optimizing our team's workflows, but we sometimes neglect our own. This extension made me more effective, more available, and more in-tune with what my team is working on.

More importantly, it reminded me why I love programming: you can build solutions to problems you care about, and then share them with others who have the same struggles.

If you're sitting on a problem that bugs you every day, maybe it's time to build the tool that solves it. You might be surprised by the impact.

---

*Arjun Gopalakrishna is an engineering manager who believes the best tools are the ones you build for yourself.*
