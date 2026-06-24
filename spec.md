# Specification: "ADO Things" — A Things-style Task Manager for VS Code

**Status:** Draft for implementation
**Audience:** Implementing engineer (assume junior; nothing is "obvious")
**Goal:** Evolve the current read-only Azure DevOps query viewer into a full, local-first task manager that **looks and feels like the [Things](https://culturedcode.com/things/) app**, lives entirely inside VS Code (sidebar navigator + main-editor workbench tabs), keeps a **local cached database as the source of truth for the UI**, and uses **Azure DevOps purely as the remote sync target**.

> Read this whole document once before writing any code. Each phase has a **Definition of Done (DoD)** and **acceptance criteria**. Do not start a phase until the previous phase's DoD is met and merged.

---

## 1. Product vision — "Things, but for ADO, inside VS Code"

Things is loved for a few specific reasons. We are deliberately copying these:

1. **Calm, focused, single-column lists.** Lots of whitespace, large hit targets, no visual noise, one clear thing to do next.
2. **A fixed, meaningful left navigator:** **Inbox → Today → Upcoming → Anytime → Someday → Logbook**, then **Projects** and **Areas** below.
3. **Frictionless capture.** Hit one key, type a title, it lands in the Inbox. Triage later.
4. **The "Today" ritual.** A curated list of what you've chosen to do today, hand-picked, not auto-generated.
5. **Checklists inside a task**, a notes field, tags, a "when" date (do-date) that is **separate** from a deadline.
6. **Satisfying completion.** Check a circle, it animates, it moves to the Logbook.
7. **Keyboard-first.** Almost everything has a shortcut.

We layer ADO underneath this: a "task" in our app is usually backed by an ADO work item, but **the local database owns the user-facing organization** (which list it's in, its today-flag, its manual order, its personal tags and notes). ADO owns the canonical work-item fields (title, state, assignee, area, iteration). The sync engine reconciles the two.

**Non-goals (v1):** editing ADO board/process configuration, creating new work item *types*, multi-user collaboration features, mobile, or any server component. Everything is per-user, on-device.

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| **Work item** | The canonical ADO record (Bug, Task, User Story, etc.), identified by an integer ID. |
| **Task** | Our local, user-facing object. Usually linked to a work item (`adoId`), but may be **local-only** (no ADO backing). |
| **List** | A Things-style smart bucket: Inbox, Today, Upcoming, Anytime, Someday, Logbook. Membership is derived from task fields. |
| **Project** | A container of tasks with its own progress ring. Maps to an ADO area path, iteration, or a parent work item — configurable. |
| **Area** | A higher-level grouping of Projects (Things calls these "Areas of Responsibility"). |
| **When / do-date** | The date you *intend* to work on something. Drives Today/Upcoming. Local concept. |
| **Deadline** | A hard due date. Maps to an ADO due-date field when available. |
| **Outbox** | The queue of local changes waiting to be pushed to ADO. |
| **Watermark** | The timestamp/token marking how far we've pulled from ADO, for incremental sync. |
| **Navigator** | The sidebar tree (left rail). |
| **Workbench tab** | A full webview panel opened in the editor area (center). |

---

## 3. Current state (what exists today — reuse it, don't delete it)

The repo is a working VS Code extension. Key modules:

- [src/extension.ts](src/extension.ts) — activation, registers the tree view and all commands.
- [src/ado/AzCliRunner.ts](src/ado/AzCliRunner.ts) — spawns `az` CLI processes, classifies errors, enforces a concurrency limit.
- [src/ado/AdoClient.ts](src/ado/AdoClient.ts) — fetches work items (WIQL → batch), in-memory `Map` cache with TTL, and the one existing **write** path (`updateWorkItemState`).
- [src/grouping/GroupingEngine.ts](src/grouping/GroupingEngine.ts) — turns flat work items into a grouped tree (up to 5 levels, with date-bucketing).
- [src/tree/AdoTreeProvider.ts](src/tree/AdoTreeProvider.ts) — renders the `TreeView`.
- [src/config/Settings.ts](src/config/Settings.ts) — typed access to `settings.json` (org, project, queries, grouping).
- [src/utils/urlParser.ts](src/utils/urlParser.ts) — parses pasted ADO query URLs.
- Tests under [src/test/](src/test/).

**What we keep:** the grouping logic, the URL parser, the query-URL ingestion UX, and the error classification in the CLI runner. **What changes:** the data layer moves from a volatile `Map` to a persistent database; the network layer moves from per-call CLI spawns to token-authenticated REST; the UI gains a webview workbench styled like Things.

---

## 4. Target architecture (the big picture)

Three layers, strictly separated. **The webview never touches the database or the network** — it only sends/receives messages.

```mermaid
flowchart TB
    subgraph Extension Host (Node)
        AUTH[Token Provider<br/>VS Code Microsoft auth]
        REST[AdoRestClient<br/>transport only]
        SYNC[SyncEngine<br/>pull + outbox push + conflicts]
        DB[(Local Database<br/>SQLite - source of truth)]
        REPO[Repositories<br/>tasks, projects, tags, views]
        NAV[Navigator<br/>TreeView]
        HOST[Workbench Host<br/>WebviewPanel manager]
    end
    subgraph Webview (Sandboxed UI)
        UI[Things-style SPA<br/>lists, Today, detail]
    end
    AUTH --> REST --> SYNC --> DB
    DB --> REPO --> NAV
    REPO --> HOST <-->|postMessage protocol| UI
    SYNC -.background loop.-> REST
```

**Golden rules for the implementer:**
1. UI reads from the **database**, never directly from ADO.
2. Every user mutation is written to the DB **immediately** (optimistic), then enqueued in the **outbox**.
3. ADO is reached only by the **SyncEngine**, never from a command handler directly.
4. All ADO calls go through **one** `AdoRestClient` that asks the **TokenProvider** for a bearer token.

---

## 5. Authentication — use the built-in VS Code Microsoft auth provider

**Constraint (read carefully):** We are inside Microsoft corp. **Custom Entra app registrations are not available, and Personal Access Tokens expire in ~7 days** — so neither is usable. We therefore authenticate by **reusing VS Code's own first-party Microsoft sign-in**, which requires no app registration and no PAT.

### 5.1 How it works conceptually
- VS Code ships a built-in **Microsoft authentication provider**. Your extension asks it to sign the user in with their Microsoft work account and return a **session** containing a short-lived **access token**.
- You request a session scoped to the **Azure DevOps resource** (the well-known Azure DevOps application identifier `499b84ac-1321-427f-aa17-267ca6975798`). The token VS Code returns is a standard AAD access token (~1 hour lifetime) that **VS Code refreshes silently**.
- Because this rides on the user's real interactive corporate sign-in, all corp policies (MFA, Conditional Access, compliant-device requirements, broker integration) are satisfied automatically. **You implement none of that.**

### 5.2 What to build — `TokenProvider` (new module: `src/auth/TokenProvider.ts`)
A single abstraction the rest of the app depends on. Its only job: **"give me a valid bearer token for ADO right now."**

Requirements:
1. **Primary source:** the VS Code Microsoft authentication provider.
   - On first need: request a session **with the option that allows an interactive prompt** (so the user sees a sign-in if needed).
   - On subsequent needs: request the session **silently** (no prompt); if a cached valid token exists you get it instantly, otherwise the provider refreshes it transparently. Only fall back to an interactive prompt if silent acquisition fails.
   - Use the scope string for the Azure DevOps resource identifier above (with the `/.default` suffix convention).
2. **Fallback source:** the **Azure CLI token**. Since the extension already depends on the user being signed into `az`, the fallback asks the CLI for an access token for the same ADO resource, caches it in memory until shortly before expiry, and reuses it. Use this only if the VS Code provider cannot return a session.
3. **Caching & expiry:** cache the token in memory with its expiry timestamp. Refresh ~5 minutes before expiry. Never write tokens to disk.
4. **Sign-in state events:** listen for the auth provider's "sessions changed" event so the UI can react to sign-in/sign-out (e.g., show a "Sign in to Azure DevOps" call-to-action in the navigator when no session exists).
5. **Errors:** if no token can be obtained, surface a clear, actionable message ("Sign in to Azure DevOps") with a button that triggers the interactive sign-in. Never crash the sync loop — degrade to offline mode (the DB still serves the UI).

### 5.3 Acceptance criteria for auth
- First launch with no session shows a friendly sign-in prompt; after sign-in, the token is acquired without further prompts for the rest of the session and across reloads (silent refresh).
- Pulling the network cable still lets the app open and show cached data; reconnecting resumes sync.
- No PAT and no app-registration values appear anywhere in the codebase or settings.

---

## 6. Data model & local database

### 6.1 Storage choice
Use an embedded **SQLite** database stored under the extension's **global storage** directory (obtained from the extension context at activation; create the directory if missing). Two acceptable engines:
- **Preferred:** a SQLite library (native). If native-module/ABI bundling proves painful for our VS Code version, switch to a **WebAssembly SQLite** build and persist the database file ourselves. Decide in Phase 1 and document the choice in the repo README.
- Wrap all DB access behind a `Database` class and **repository** classes. **No SQL strings outside the `src/db/` folder.**

### 6.2 Schema (declarative — specify exact columns)

> Implement these as versioned migrations (see §6.3). Column types are SQLite affinities.

**`tasks`** — the user-facing object (local source of truth for organization)

| Column | Type | Notes |
|--------|------|-------|
| `uuid` | TEXT PK | Locally generated, stable forever. |
| `ado_id` | INTEGER NULL | Work item ID if linked; NULL for local-only tasks. |
| `title` | TEXT | Mirrors ADO title when linked; editable locally. |
| `notes` | TEXT | Markdown. **Local-only**, never pushed unless mapped (v1: local-only). |
| `list` | TEXT | One of `inbox`,`anytime`,`someday`,`logbook`. (Today/Upcoming are derived, not stored — see §7.2.) |
| `today_flag` | INTEGER | 0/1. Set when the user pulls a task into Today. |
| `when_date` | TEXT NULL | ISO date (do-date). Drives Today/Upcoming. Local concept. |
| `deadline` | TEXT NULL | ISO date. Maps to ADO due-date field when present. |
| `completed_at` | TEXT NULL | ISO timestamp; non-null = completed → Logbook. |
| `canceled_at` | TEXT NULL | ISO timestamp; non-null = canceled. |
| `project_uuid` | TEXT NULL | FK → `projects.uuid`. |
| `sort_order` | REAL | Manual ordering within a list/project (use fractional indexing — see §8.6). |
| `created_at` | TEXT | ISO timestamp. |
| `updated_at` | TEXT | ISO timestamp, bumped on every local edit. |

**`work_items`** — canonical ADO mirror (one row per linked work item)

| Column | Type | Notes |
|--------|------|-------|
| `ado_id` | INTEGER PK | |
| `rev` | INTEGER | ADO revision number. |
| `etag` | TEXT | For optimistic concurrency on push. |
| `fields_json` | TEXT | Full ADO fields object as JSON. |
| `org` | TEXT | Organization the item belongs to. |
| `project` | TEXT | ADO project. |
| `type` | TEXT | Work item type (Bug, Task…). |
| `state` | TEXT | Current ADO state. |
| `assigned_to` | TEXT NULL | Identity display name. |
| `updated_utc` | TEXT | Last server change we know about. |
| `deleted` | INTEGER | 0/1 tombstone. |

**`projects`**

| Column | Type | Notes |
|--------|------|-------|
| `uuid` | TEXT PK | |
| `name` | TEXT | |
| `area_uuid` | TEXT NULL | FK → `areas.uuid`. |
| `ado_binding_json` | TEXT NULL | How it maps to ADO (area path / iteration / parent work item). |
| `sort_order` | REAL | |

**`areas`** — `uuid` PK, `name`, `sort_order`.

**`tags`** — `id` PK, `name`, `color`. **`task_tags`** — (`task_uuid`, `tag_id`) join. Tags are **local-only** in v1.

**`checklist_items`** — `id` PK, `task_uuid` FK, `text`, `done` (0/1), `sort_order`. Local-only.

**`saved_views`** — `id` PK, `name`, `filter_json`, `group_json`, `sort_json`. Replaces today's `adoQueries.groupBy` config concept; the existing [GroupingEngine](src/grouping/GroupingEngine.ts) consumes `group_json`.

**`sync_queue`** (the outbox) — `op_id` PK, `entity` (`workitem`/`task`), `target_id`, `op_type` (`update_state`/`update_fields`/`link`/…), `payload_json`, `base_etag`, `status` (`pending`/`inflight`/`failed`/`done`), `attempts`, `created_at`, `last_error`.

**`sync_state`** — `source_key` PK (e.g., a query or org+project), `watermark`, `last_synced_utc`.

**`fts_tasks`** — a full-text (FTS) virtual table indexing `title` + `notes` for instant offline search.

### 6.3 Migrations
- Create `src/db/migrations/` with **numbered, append-only** migration units (`001_init`, `002_add_tags`, …).
- On activation, read the DB's current schema version (store it in a `meta` table), then apply any pending migrations **in order, inside a transaction each**.
- **Never edit a shipped migration.** Once users have data, schema changes are forward-only via new migrations.
- Write a tiny migration-runner test that spins up an empty DB and asserts it reaches the latest version cleanly.

### 6.4 Repositories (new: `src/db/repositories/`)
One class per aggregate: `TaskRepository`, `WorkItemRepository`, `ProjectRepository`, `TagRepository`, `ViewRepository`, `SyncQueueRepository`, `SyncStateRepository`. Each exposes intention-revealing methods (e.g., `TaskRepository.moveToToday(uuid)`, `.complete(uuid)`, `.reorder(uuid, beforeUuid, afterUuid)`). **All transactions live here.**

---

## 7. Sync engine (`src/sync/`)

The hardest part. Build it incrementally (Phases 2–3). It owns all reconciliation. Components:

### 7.1 `AdoRestClient` (transport only — `src/ado/AdoRestClient.ts`)
- Pure HTTP. Takes a `TokenProvider`. Adds `Authorization: Bearer <token>`.
- Methods mirror what we need: run a WIQL query (IDs only), batch-fetch work items by ID (respecting the 200-id batch limit already encoded in [Settings](src/config/Settings.ts)), fetch a single work item with its ETag, and **PATCH** a work item with a JSON-Patch document and an `If-Match` ETag header.
- Handle **429 (throttling)**: read the retry-after hint, back off, retry. Handle **412 (precondition failed)** by surfacing a conflict (see §7.4).
- This replaces per-call CLI spawning. Keep [AzCliRunner](src/ado/AzCliRunner.ts) only as the **fallback token source** (via TokenProvider), not for data.

### 7.2 Pull (server → local)
- For each configured source (query/org+project), run the WIQL to get candidate IDs, then **incrementally** fetch items changed since `sync_state.watermark` (use ADO's "changed since" / revision watermark; if unavailable for a source, fall back to full refresh of that source).
- Upsert into `work_items` (bump `rev`, store `etag`, store full `fields_json`).
- **Reconcile to tasks:** for each work item, if no linked `tasks` row exists, create one (default `list = inbox`, `today_flag = 0`). If one exists, update mirrored fields (title, state, assignee) **without** clobbering local-only fields (notes, when_date, today_flag, tags, manual order).
- Handle **deletes/closed items:** if a work item disappears or transitions to a "done" category state, do **not** delete the task; mark it completed (move to Logbook) so the user keeps history.
- Update `sync_state.watermark` and `last_synced_utc`.

**Derived lists (never stored):**
- **Today** = tasks where `today_flag = 1` **or** `when_date <= today`, and not completed/canceled.
- **Upcoming** = tasks with a future `when_date` or future `deadline`, grouped by date.
- **Inbox/Anytime/Someday/Logbook** = by the `list`/completion fields above.

### 7.3 Push (local → server, the outbox)
- Every local mutation that should reach ADO (e.g., state change, assignee change, deadline change) writes the DB row **and** enqueues a `sync_queue` op capturing the `base_etag`.
- An `OutboxProcessor` drains pending ops in order: mark `inflight`, PATCH ADO with `If-Match: base_etag`, on success mark `done` and store the new etag/rev; on failure increment `attempts` with exponential backoff; after N attempts mark `failed` and surface it.
- Local-only changes (notes, tags, today_flag, when_date, manual order, checklist) **do not** enqueue anything — they live purely in the DB.

### 7.4 Conflict resolution (`ConflictResolver`)
- A push returning **412** means ADO changed under us. Re-pull that item, then:
  - If the changed ADO field is **different** from the field we tried to change → apply **field-level merge** (keep both changes) and retry the push with the fresh etag.
  - If the **same** field changed on both sides → surface a **conflict card** in the UI: show "You set State = X, ADO now has State = Y" with **Keep Mine / Keep Theirs** buttons. Default to **Keep Theirs** if the user ignores it for a configurable time, to avoid silent overwrite.
- Log every conflict to the output channel for debuggability.

### 7.5 Triggers & scheduling
- Run pull: on activation (after first paint, not blocking), on a configurable interval (reuse `refreshIntervalSeconds`), on window focus, and on manual refresh.
- Run the outbox: immediately after any enqueue (debounced ~1s) and on each pull cycle.
- All sync runs are **cancelable** and **generation-guarded** (reuse the generation pattern already in [AdoTreeProvider](src/tree/AdoTreeProvider.ts)).
- Show a **status bar item**: "ADO: synced 2m ago" / "Syncing…" / "Offline" / "N pending".

---

## 8. UI — make it feel like Things

Two surfaces: the **navigator** (sidebar tree) and the **workbench** (webview panels in the editor area). The workbench is where the Things look lives.

### 8.1 Navigator (sidebar) — the left rail
Reuse the existing view container. Replace the query-centric tree with Things' fixed structure, in this exact order:

1. **Inbox** (with unread/uncounted badge)
2. **Today** (star icon)
3. **Upcoming** (calendar icon)
4. **Anytime** (stacked-layers icon)
5. **Someday** (box icon)
6. **Logbook** (checkmark icon)
7. — divider —
8. **Projects** (each with a small progress ring showing % complete)
9. **Areas** (collapsible groups containing projects)

Clicking any navigator entry **opens (or focuses) a workbench tab** for that list/project. Counts next to each entry come from the DB. When signed out, show a single "Sign in to Azure DevOps" call-to-action (drives the interactive sign-in from §5).

### 8.2 Workbench (webview panel) — the main view
Implement as one or more `WebviewPanel`s the user opens as editor tabs. Build the UI as a **small single-page app** bundled into `media/` (use a lightweight framework — Svelte, Preact, or Lit — to keep the bundle small; **do not** ship a heavy framework). The webview communicates with the host via a typed `postMessage` protocol (§8.7). **No DB or network in the webview.**

Views to build:
- **List view** (Inbox/Anytime/Someday/Project): a single calm column of task rows.
- **Today view:** the curated list; supports a "This Evening" sub-section like Things.
- **Upcoming view:** tasks grouped under date headers (Today, Tomorrow, weekday names, then dates).
- **Logbook view:** completed/canceled tasks, grouped by completion date, read-mostly.
- **Task detail:** opens inline (expanding row, Things-style) **or** as a focused panel — show title, notes (markdown), checklist, tags, when-date, deadline, project, and the linked ADO work item (type, state, assignee) with a "state changer" and an "open in browser" affordance.

### 8.3 Things visual design language (follow precisely)
- **Layout:** single centered column, generous max-width (~640–720px), lots of horizontal padding, airy line height. Never edge-to-edge dense tables.
- **Task row:** a **circular checkbox** on the left, title in the middle, subtle metadata (tags as small pills, a small calendar chip for when/deadline, a tiny ADO type glyph) trailing. Row height comfortable (~34–40px), large click target.
- **Completion animation:** clicking the circle fills it, briefly shows a check, the row fades and slides into the Logbook. Make it feel rewarding but quick (~250ms).
- **Headers:** big, light-weight list title at the top with the count beside it; date/group headers are small, uppercase, muted.
- **Color:** restrained. Use VS Code **theme tokens / CSS variables** so it adapts to light/dark/high-contrast automatically; accent only for the checkbox, the "Today" star, and overdue dates (red). Match Things' blue-accent feel via the editor accent color.
- **Empty states:** friendly, centered illustration-style text ("Your Inbox is clear." / "Nothing for Today.").
- **Typography:** system font stack; clear hierarchy by weight and size, not by boxes/borders.
- **Motion:** subtle. Reordering animates; adding a task slides in; nothing janky.

### 8.4 Quick capture (the killer feature)
- A command + keybinding (e.g., a "magic plus") that opens a **single-line input** ("New To-Do"). Typing a title and pressing Enter creates a task in the **Inbox** instantly (local-only or staged for ADO linkage during triage).
- Support **inline tokens** like Things' natural-language entry later (e.g., `today`, `tomorrow`, `#tag`) — Phase 5 stretch.
- Capture must work from anywhere (command palette, keybinding) without first opening a workbench tab.

### 8.5 Keyboard-first interactions (specify the defaults)
- New to-do, complete/uncomplete, set when-date ("when" picker), set deadline, move to Today, move to project, delete, search. Provide sensible default keybindings and route them through commands so users can rebind. The webview must also handle arrow-key navigation between rows and Enter to open detail.

### 8.6 Manual ordering
- Use **fractional indexing** for `sort_order`: to drop a task between A and B, set its order to the midpoint of A's and B's orders (a real number). This avoids renumbering siblings on every reorder. Re-balance only if precision runs out.
- Drag-and-drop within a list reorders; dragging onto a project/area in the navigator moves the task.

### 8.7 Host ↔ webview message protocol
Define a **typed, versioned** message contract in a shared types file used by both sides. Two directions:
- **Webview → Host (intents):** load a list, complete a task, reorder, edit a field, set when/deadline, add tag, add checklist item, change ADO state, open work item in browser, request search.
- **Host → Webview (state):** initial snapshot for a view, incremental updates (task changed/added/removed), sync status changes, conflict prompts.
- Each message has a `type` and a payload. **Validate every inbound message** on the host before acting. Persist webview UI state (scroll position, expanded task) so it survives reloads.
- Enforce a strict **Content-Security-Policy** on the webview; only load the bundled local script/style; use a nonce.

---

## 9. Phased implementation plan

Each phase is independently shippable and reversible. **Do not skip the DoD.**

### Phase 0 — Decouple the data layer (no behavior change)
**Goal:** introduce a `DataStore` seam so the tree reads from an abstraction, not directly from `AdoClient`.
**Tasks:**
- Define a `DataStore` interface (get tasks/work items for a source, etc.).
- Implement an in-memory `DataStore` that simply wraps today's `AdoClient` behavior.
- Point [AdoTreeProvider](src/tree/AdoTreeProvider.ts) at the `DataStore` instead of `AdoClient` directly.
**DoD:** existing extension behaves identically; all current tests pass; no user-visible change. This is a pure refactor PR.

### Phase 1 — Persistence (local DB as cache)
**Goal:** make the DB real and the source of truth for reads.
**Tasks:**
- Add SQLite, the `Database` class, migration runner, and the §6.2 schema (start with `work_items`, `tasks`, `sync_state`, `meta`, `fts_tasks`).
- Decide native vs. WASM SQLite; document it.
- Implement `WorkItemRepository` + `TaskRepository` (reads + upserts).
- Change the fetch path so ADO results are **upserted into the DB**, and the tree reads from the DB.
**DoD:** closing and reopening VS Code shows the last-known data **instantly and offline**; FTS search returns results with the network off; migrations run cleanly on a fresh DB and on an existing one.

### Phase 2 — Token auth + REST transport + pull sync
**Goal:** replace per-call CLI data fetching with token-authenticated REST and an incremental pull loop.
**Tasks:**
- Build `TokenProvider` (§5) with VS Code Microsoft provider primary + CLI-token fallback.
- Build `AdoRestClient` (§7.1) with WIQL, batch fetch, single-item-with-etag, and 429 handling.
- Build the **pull** half of `SyncEngine` (§7.2) with watermarks and task reconciliation.
- Status bar sync indicator. Sign-in CTA in navigator when no session.
**DoD:** data refreshes via REST (no `az boards` spawns for reads); incremental pulls only fetch changed items; offline still serves the DB; sign-in works with no PAT and no app registration.

### Phase 3 — Write path: outbox + conflicts
**Goal:** make local edits durable and pushable, with safe concurrency.
**Tasks:**
- Migrate the existing **state-change** write to go through the **outbox** (`sync_queue`) instead of a direct call.
- Build `OutboxProcessor` (§7.3) with retries/backoff and `If-Match` etags.
- Build `ConflictResolver` (§7.4) with the 412 merge/prompt flow.
- Add local-only mutations (notes, tags, today_flag, when_date, checklist) that **don't** enqueue.
**DoD:** changing an ADO state works optimistically and survives a forced conflict (induce a 412 in a test and confirm the prompt); local-only edits never hit the network; pending count shows in the status bar.

### Phase 4 — Things-style workbench UI
**Goal:** the look and feel.
**Tasks:**
- Stand up the webview build pipeline (SPA bundled into `media/`, CSP + nonce).
- Implement the host↔webview protocol (§8.7).
- Build the navigator's fixed list structure (§8.1) and wire clicks to open workbench tabs.
- Build List, Today, Upcoming, Logbook, and Task-detail views with the Things design language (§8.3): circular checkboxes, completion animation, calm single column, theme-aware colors.
- Quick capture (§8.4) and core keybindings (§8.5).
**DoD:** a user can capture to Inbox, triage into Today/Upcoming/projects, complete tasks (with animation into Logbook), edit notes/tags/dates, and it all persists in the DB and (where applicable) syncs to ADO. A screenshot side-by-side with Things should read as clearly inspired by it.

### Phase 5 — Local-first power features
**Goal:** the things ADO can't do.
**Tasks:**
- Projects & Areas with progress rings; bind projects to ADO area/iteration/parent.
- Tags, checklists, manual ordering (fractional indexing + drag-and-drop).
- Saved views / smart lists (reuse [GroupingEngine](src/grouping/GroupingEngine.ts) over DB rows via `saved_views.group_json`).
- Natural-language quick entry tokens (`today`, `tomorrow`, `#tag`).
- Undo (because mutations are queued ops).
**DoD:** each feature works offline and persists; project progress reflects task completion; reordering is smooth and stable across reloads.

### Phase 6 — Polish & hardening
**Goal:** production quality.
**Tasks:**
- Multi-org support; per-source sync settings.
- Notifications for overdue/today; richer empty states; accessibility pass (keyboard, screen-reader labels, high-contrast theme).
- Performance: virtualize long lists in the webview; index hot DB columns.
- Telemetry-free diagnostics via the existing output channel; a "reset local database" command.
- Migration tests, conflict tests, and a sync soak test.
**DoD:** smooth with thousands of tasks; no data loss across reload/offline/conflict scenarios; accessible; documented in README.

---

## 10. Testing strategy
- **Unit:** repositories (with a throwaway DB), `GroupingEngine` (already tested — keep), `urlParser` (already tested — keep), fractional-index ordering, date-bucket/derived-list logic.
- **Migration:** fresh DB → latest; old DB → latest; idempotency.
- **Sync:** mock `AdoRestClient` to simulate incremental pulls, 429s, and 412 conflicts; assert outbox state transitions and reconciliation rules (local-only fields never clobbered).
- **Auth:** mock the token provider; assert silent-then-interactive fallback and offline degradation.
- **Webview:** test the message protocol contract (intents in → state out) with the host logic; snapshot-test key view states.
- Keep [src/test/runTests.ts](src/test/runTests.ts) as the entry point; add suites alongside the new modules.

## 11. Risks & mitigations
| Risk | Mitigation |
|------|------------|
| Native SQLite ABI mismatch with VS Code's Electron | Decide native vs. WASM in Phase 1; prefer WASM if bundling is painful. |
| Sync correctness (watermarks, deletes, conflicts) | Build pull → outbox → conflicts as separate, well-tested phases; never delete tasks, only complete them. |
| Token scope blocked in corp tenant | VS Code's first-party app is approved corp-wide (the official ADO extension uses the same path); CLI-token fallback as backup. |
| Webview complexity (CSP, state, bundling) | Keep the SPA tiny (Svelte/Preact/Lit); strict CSP + nonce; persist webview state. |
| Schema churn after users have data | Append-only migrations from day one; never edit shipped migrations. |
| Losing local-only data on pull | Reconciliation must update only mirrored fields and never touch local-only columns. |

## 12. Definition of done (overall)
A user signs in once (no PAT, no app registration), sees their ADO work items as Things-style tasks in a calm sidebar + workbench, works fully offline, captures and triages tasks, organizes them with local-only projects/tags/notes/checklists/ordering, completes them with a satisfying animation into a Logbook, and has every appropriate change sync back to Azure DevOps safely — with conflicts surfaced, never silently lost.
