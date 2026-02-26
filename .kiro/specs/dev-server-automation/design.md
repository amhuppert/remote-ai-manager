# Design Document: Dev Server Automation

## Overview

**Purpose**: This feature delivers automated dev server lifecycle management within CSM sessions, enabling users to launch, monitor, and stop project-defined dev servers directly from the session overview page without manual terminal setup.

**Users**: CSM users managing coding sessions across projects will use this to spin up dev servers (e.g., Next.js, Storybook) in a session's worktree and access them over the Tailscale network from any device.

**Impact**: Introduces a new in-memory process management subsystem, new API routes, new SSE event types, Tailscale Serve integration, and a UI control panel on the session overview page. No changes to the existing `state.json` persistence model.

### Goals
- Enable per-project, multi-server dev server configuration via `ClaudeSessionManager.json`
- Provide start/stop/status lifecycle management with real-time SSE-driven UI updates
- Expose dev servers over the tailnet via Tailscale Serve with zero manual setup
- Auto-cleanup dev servers on session delete, merge, or CSM shutdown
- Maintain port isolation across worktrees without CSM-managed port allocation

### Non-Goals
- CSM-managed port allocation (dev servers choose their own ports; CSM discovers them via `CSM_PORT=` protocol)
- Persistent dev server state across CSM restarts (in-memory only, per requirement 5.3)
- Auto-start dev servers on session creation (user-initiated only)
- Support for dev server log streaming to the UI beyond recent diagnostic output
- Dev server process restart/retry logic (manual restart via UI)

## Architecture

### Existing Architecture Analysis

CSM is a server-rendered Next.js application with API routes as the backend. Key patterns relevant to this feature:

- **In-memory singletons**: 7 modules use `globalThis`-backed singletons with `__csm_*` keys for HMR-safe state (SSE clients, abort controllers, background jobs, locks, query registry, state mutex, merge detection)
- **SSE broadcasting**: `sse-broadcaster.ts` broadcasts typed events to all connected clients; the `SSEEvent` union in `schemas.ts` defines allowed event types
- **Session lifecycle**: `sessions.ts` handles create/delete; `background-jobs.ts` handles merge via `setSessionFinished`; no existing shutdown hook
- **Process execution**: All subprocess calls use `execFile` (promisified) for short-lived commands; no long-lived `spawn` usage exists
- **Per-repo config**: `ClaudeSessionManager.json` parsed via `perRepoConfigSchema` in `schemas.ts`, read by `readRepoConfig()` in `repo-config.ts`

### Architecture Pattern & Boundary Map

```mermaid
graph TB
    subgraph UI
        Panel[DevServerPanel]
        Hook[useDevServers hook]
    end

    subgraph API[API Routes]
        GetStatus[GET dev-servers]
        Start[POST start]
        Stop[POST stop]
        StartAll[POST start-all]
        StopAll[POST stop-all]
    end

    subgraph Core[Domain Logic]
        Registry[DevServerRegistry]
        Tailscale[TailscaleService]
        Liveness[LivenessPoller]
    end

    subgraph External
        Process[Child Processes]
        TailscaleCLI[Tailscale CLI]
        SSE[SSE Broadcaster]
    end

    Panel --> Hook
    Hook --> GetStatus
    Hook --> Start
    Hook --> Stop
    Hook --> StartAll
    Hook --> StopAll

    GetStatus --> Registry
    Start --> Registry
    Stop --> Registry
    StartAll --> Registry
    StopAll --> Registry

    Registry --> Process
    Registry --> Tailscale
    Registry --> SSE
    Tailscale --> TailscaleCLI
    Liveness --> Registry
```

**Architecture Integration**:
- **Selected pattern**: In-memory registry with globalThis singleton — consistent with all existing CSM runtime state management
- **Domain boundaries**: `dev-server-registry.ts` owns all process state and lifecycle; `tailscale.ts` encapsulates CLI interactions; API routes are thin orchestration
- **Existing patterns preserved**: `withTracing` route wrappers, `broadcast()` for SSE, Zod schema-first types, `readRepoConfig()` for project config
- **New components rationale**: Registry (process lifecycle), TailscaleService (CLI abstraction), LivenessPoller (health monitoring), DevServerPanel (UI)
- **Steering compliance**: TypeScript strict mode, Zod schemas, colocated components, lib module per domain concept

### Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|-------|------------------|-----------------|-------|
| Frontend | React 19, TanStack Query | DevServerPanel component, useDevServers hook | Consistent with existing session UI |
| Backend | Next.js 15 API Routes | REST endpoints for start/stop/status | `withTracing` wrapper, `force-dynamic` |
| Process Mgmt | Node.js `child_process.spawn` with `shell: true` | Long-lived dev server process management | First `spawn` usage in codebase; `shell: true` gives Node.js direct handle for clean termination |
| Networking | Tailscale CLI (`tailscale serve`, `tailscale status`) | HTTPS exposure over tailnet | Requires `--operator` pre-configured |
| Events | SSE via `sse-broadcaster.ts` | Real-time status updates to UI | New `dev-server-status` event type |
| State | `globalThis` Map singleton | In-memory process registry, HMR-safe | Matches 7 existing `__csm_*` singletons |
| Validation | Zod v4 | Schema-first types for config, API, events | `devServerConfigSchema`, `devServerStatusEventSchema` |

## System Flows

### Dev Server Start Flow

```mermaid
sequenceDiagram
    participant UI as DevServerPanel
    participant API as POST start
    participant Reg as Registry
    participant Proc as Child Process
    participant TS as TailscaleService
    participant SSE as SSE Broadcaster

    UI->>API: POST /dev-servers/{name}/start
    API->>Reg: startServer(project, session, serverName)
    Reg->>Reg: Validate not already running
    Reg->>Reg: Set status = starting
    Reg->>SSE: broadcast(starting)
    Reg->>Proc: spawn(command, shell: true, cwd: worktreePath)
    API-->>UI: 202 Accepted

    loop stdout scanning
        Proc->>Reg: stdout line
        Reg->>Reg: Match CSM_PORT=port
    end

    Reg->>Reg: Set status = running, record port
    Reg->>TS: tailscale serve --https=port --bg localhost:port
    Reg->>Reg: Record remoteUrl
    Reg->>SSE: broadcast(running, port, url)
```

Key decisions:
- API returns 202 immediately; the `starting` → `running` transition is async and communicated via SSE
- Tailscale registration happens after port discovery, not before
- If Tailscale registration fails, the server continues running (req 4.4); the URL is omitted from the SSE event

### Dev Server Stop Flow

```mermaid
sequenceDiagram
    participant UI as DevServerPanel
    participant API as POST stop
    participant Reg as Registry
    participant Proc as Child Process
    participant TS as TailscaleService
    participant SSE as SSE Broadcaster

    UI->>API: POST /dev-servers/{name}/stop
    API->>Reg: stopServer(project, session, serverName)
    Reg->>TS: tailscale serve --https=port off
    Reg->>Proc: kill SIGTERM
    Reg->>Reg: Wait for exit (5s timeout)
    alt Process exits gracefully
        Proc->>Reg: exit event
    else Timeout
        Reg->>Proc: kill SIGKILL
    end
    Reg->>Reg: Set status = stopped
    Reg->>SSE: broadcast(stopped)
    API-->>UI: 200 OK
```

### Dev Server Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> stopped: configured
    stopped --> starting: user starts
    starting --> running: CSM_PORT detected
    starting --> error: process exits or timeout
    running --> stopped: user stops
    running --> stopped: process exits
    running --> stopped: session deleted/merged
    error --> starting: user retries
    error --> stopped: user stops
```

## Requirements Traceability

| Requirement | Summary | Components | Interfaces | Flows |
|-------------|---------|------------|------------|-------|
| 1.1 | devServers array in ClaudeSessionManager.json | perRepoConfigSchema, readRepoConfig | Config schema | — |
| 1.2 | Missing config = zero servers | readRepoConfig, DevServerPanel | Config schema | — |
| 1.3 | Validate name + command non-empty | devServerConfigSchema | Config schema | — |
| 1.4 | Multiple servers per project | devServers array, Registry keying | Config schema, Registry | — |
| 2.1 | Spawn in worktree cwd | DevServerRegistry.startServer | Service interface | Start flow |
| 2.2 | CSM_PORT stdout parsing | DevServerRegistry (stdout scanner) | — | Start flow |
| 2.3 | starting → running transition | DevServerRegistry, SSE | Event contract | Start flow |
| 2.4 | Exit before CSM_PORT → error | DevServerRegistry | Event contract | Start flow |
| 2.5 | No duplicate start | DevServerRegistry.startServer guard | Service interface | Start flow |
| 2.6 | Capture recent output | DevServerRegistry (output buffer) | Service interface | — |
| 3.1 | Stop = terminate + status change | DevServerRegistry.stopServer | Service interface | Stop flow |
| 3.2 | Remove Tailscale on stop | TailscaleService.unregister | Service interface | Stop flow |
| 3.3 | Stop All | DevServerRegistry.stopAllForSession | Service interface | — |
| 4.1 | Register with Tailscale Serve | TailscaleService.register | Service interface | Start flow |
| 4.2 | Unregister on stop/exit | TailscaleService.unregister | Service interface | Stop flow |
| 4.3 | Resolve hostname for URL | TailscaleService.getHostname | Service interface | Start flow |
| 4.4 | Tailscale failure = non-blocking | TailscaleService (try/catch + log) | — | Start flow |
| 4.5 | No root access required | TailscaleService (--operator prereq) | — | — |
| 5.1 | globalThis-backed Map registry | DevServerRegistry | State management | — |
| 5.2 | No persistence to state.json | DevServerRegistry (in-memory only) | — | — |
| 5.3 | Clean slate on restart | DevServerRegistry (globalThis init) | — | — |
| 5.4 | Per-server runtime state fields | DevServerEntry type | State management | — |
| 6.1 | Periodic liveness checks | LivenessPoller | — | — |
| 6.2 | Dead process → stopped + cleanup | LivenessPoller, TailscaleService, SSE | Event contract | — |
| 6.3 | 5-10s polling interval | LivenessPoller (configurable) | — | — |
| 7.1 | SSE dev-server-status event | devServerStatusEventSchema, SSE | Event contract | All flows |
| 7.2 | Broadcast on all transitions | DevServerRegistry → broadcast() | Event contract | All flows |
| 8.1 | GET status endpoint | GET /dev-servers route | API contract | — |
| 8.2 | POST start endpoint | POST /dev-servers/[serverName]/start | API contract | Start flow |
| 8.3 | POST stop endpoint | POST /dev-servers/[serverName]/stop | API contract | Stop flow |
| 8.4 | Error for missing config | GET/POST routes (404 check) | API contract | — |
| 9.1 | Control panel when configured | DevServerPanel | — | — |
| 9.2 | Status indicators | DevServerPanel | — | — |
| 9.3 | Clickable remote URL | DevServerPanel | — | — |
| 9.4 | Per-server start/stop buttons | DevServerPanel | — | — |
| 9.5 | Start All / Stop All buttons | DevServerPanel | — | — |
| 9.6 | Real-time SSE updates | useDevServers hook | Event contract | — |
| 9.7 | Hidden when no config | DevServerPanel | — | — |
| 10.1 | Stop on session delete | deleteSession hook | Service interface | — |
| 10.2 | Stop on session merge | setSessionFinished hook | Service interface | — |
| 10.3 | Stop on CSM exit | process SIGTERM handler | Service interface | — |

## Components and Interfaces

| Component | Domain/Layer | Intent | Req Coverage | Key Dependencies | Contracts |
|-----------|-------------|--------|--------------|------------------|-----------|
| DevServerRegistry | Core/Process Mgmt | Manage dev server process lifecycle | 2.1–2.6, 3.1, 3.3, 5.1–5.4, 7.2, 10.1–10.3 | TailscaleService (P0), SSE Broadcaster (P0) | Service, State |
| TailscaleService | Core/Networking | Encapsulate Tailscale CLI interactions | 4.1–4.5 | Tailscale CLI (P0, External) | Service |
| LivenessPoller | Core/Monitoring | Detect dead dev server processes | 6.1–6.3 | DevServerRegistry (P0) | Service |
| Dev Server API Routes | API Layer | REST endpoints for start/stop/status | 8.1–8.4 | DevServerRegistry (P0), readRepoConfig (P1) | API |
| DevServerPanel | UI/Session Page | Control panel for managing dev servers | 9.1–9.7 | useDevServers hook (P0) | — |
| useDevServers | UI/Hook | Data fetching + SSE subscription for dev server state | 9.6 | API Routes (P0), SSE (P0) | — |

### Core / Process Management

#### DevServerRegistry

| Field | Detail |
|-------|--------|
| Intent | Manage dev server process spawning, stdout parsing, graceful shutdown, and in-memory state tracking |
| Requirements | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.3, 5.1, 5.2, 5.3, 5.4, 7.2, 10.1, 10.2, 10.3 |

**Responsibilities & Constraints**
- Owns all dev server child process references and runtime state
- Enforces single-instance-per-server (no duplicate starts for the same server name in a session)
- Broadcasts SSE events on every status transition
- Captures last N lines of stdout/stderr per server in a circular buffer
- Registers a `process.on('SIGTERM')` handler at module init for CSM shutdown cleanup

**Dependencies**
- Outbound: TailscaleService — register/unregister on port discovery/stop (P0)
- Outbound: `broadcast()` from `sse-broadcaster.ts` — SSE events (P0)
- Outbound: `readRepoConfig()` from `repo-config.ts` — validate server config (P1)
- Outbound: `createLogger()` from `logging/` — structured logging (P2)

**Contracts**: Service [x] / State [x]

##### Service Interface
```typescript
interface DevServerRegistryService {
  /** Start a dev server for a session. Returns immediately; status updates via SSE. */
  startServer(params: {
    projectPath: string;
    sessionName: string;
    serverName: string;
    command: string;
    worktreePath: string;
  }): Promise<void>;

  /** Stop a specific dev server. Removes Tailscale registration. */
  stopServer(params: {
    projectPath: string;
    sessionName: string;
    serverName: string;
  }): Promise<void>;

  /** Stop all dev servers for a session. */
  stopAllForSession(params: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;

  /** Stop all dev servers across all sessions (CSM shutdown). */
  stopAll(): Promise<void>;

  /** Get runtime state for all dev servers in a session. */
  getSessionServers(params: {
    projectPath: string;
    sessionName: string;
  }): DevServerEntry[];

  /** Get runtime state for a specific dev server. */
  getServer(params: {
    projectPath: string;
    sessionName: string;
    serverName: string;
  }): DevServerEntry | undefined;
}
```
- Preconditions: `startServer` — server must not be in `starting` or `running` status; `command` and `worktreePath` must be non-empty
- Postconditions: `startServer` — entry created in registry with status `starting`; SSE event broadcast. `stopServer` — entry removed or set to `stopped`; Tailscale unregistered; SSE event broadcast
- Invariants: At most one running/starting process per `(projectPath, sessionName, serverName)` tuple

##### State Management

```typescript
/** In-memory state for a single dev server */
interface DevServerEntry {
  serverName: string;
  projectPath: string;
  sessionName: string;
  command: string;
  pid: number;
  status: "starting" | "running" | "stopped" | "error";
  port: number | null;
  remoteUrl: string | null;
  startedAt: string;
  errorMessage: string | null;
  recentOutput: string[];
}
```

- **State model**: `Map<string, DevServerEntry>` keyed by `${projectPath}::${sessionName}::${serverName}`
- **Persistence**: None — in-memory only via `globalThis.__csm_dev_servers`
- **Concurrency**: Single-threaded Node.js; no mutex needed for the registry Map itself; async operations (Tailscale CLI) are fire-and-forget with error logging

**Implementation Notes**
- Use `spawn(command, { shell: true, cwd: worktreePath, stdio: 'pipe' })` for arbitrary shell commands — `shell: true` lets Node.js manage shell invocation and provides a direct `ChildProcess` handle where `child.kill()` targets the shell process directly, avoiding the signal-forwarding problem of explicit `spawn('sh', ['-c', ...])` where SIGTERM may not reach the actual dev server
- Stdout scanning: line-buffer stdout, match `^CSM_PORT=(\d+)$`, transition to `running`
- Startup timeout: 60s default; if `CSM_PORT` not detected, transition to `error` with captured output
- Graceful kill: `child.kill('SIGTERM')` → 5s wait → `child.kill('SIGKILL')`
- Output buffer: Circular buffer of last 50 lines (combined stdout + stderr)
- Shutdown handler: `process.on('SIGTERM', () => registry.stopAll())` registered once at module init

---

### Core / Networking

#### TailscaleService

| Field | Detail |
|-------|--------|
| Intent | Encapsulate all Tailscale CLI interactions for dev server exposure |
| Requirements | 4.1, 4.2, 4.3, 4.4, 4.5 |

**Responsibilities & Constraints**
- Owns Tailscale Serve registration and unregistration
- Caches the Tailscale hostname for the process lifetime
- All failures are logged but never propagated (non-blocking per req 4.4)

**Dependencies**
- External: Tailscale CLI (`tailscale`) — must be on PATH (P0)
- Outbound: `createLogger()` — structured logging (P2)

**Contracts**: Service [x]

##### Service Interface
```typescript
interface TailscaleService {
  /** Register a local port with Tailscale Serve. Returns the remote URL or null on failure. */
  register(port: number): Promise<string | null>;

  /** Unregister a Tailscale Serve entry for the given port. */
  unregister(port: number): Promise<void>;

  /** Get the Tailscale hostname (cached). Returns null if Tailscale is unavailable. */
  getHostname(): Promise<string | null>;
}
```
- Preconditions: `register` — port must be a positive integer; Tailscale daemon must be running with `--operator` configured
- Postconditions: `register` — `tailscale serve --https=<port> --bg localhost:<port>` executed; returns `https://<hostname>:<port>` or null. `unregister` — `tailscale serve --https=<port> off` executed
- Invariants: Hostname is resolved once and cached; all errors caught and logged

**Implementation Notes**
- Use `execFile('tailscale', [...args])` (not `spawn`) since these are short-lived commands
- Hostname resolution: `execFile('tailscale', ['status', '--json'])` → parse `Self.DNSName` → strip trailing dot → cache
- If Tailscale CLI is not found or returns an error, log and return null (graceful degradation)

---

### Core / Monitoring

#### LivenessPoller

| Field | Detail |
|-------|--------|
| Intent | Periodically verify dev server processes are still alive |
| Requirements | 6.1, 6.2, 6.3 |

**Responsibilities & Constraints**
- Runs a `setInterval` loop checking all registered dev servers
- Detects exited processes via `process.kill(pid, 0)` (signal 0 = existence check)
- On dead process detection: transitions status to `stopped`, triggers Tailscale unregistration, broadcasts SSE event

**Dependencies**
- Inbound: DevServerRegistry — reads process entries (P0)
- Outbound: TailscaleService — cleanup dead server registrations (P1)
- Outbound: `broadcast()` — notify UI of status changes (P0)

**Contracts**: Service [x]

##### Service Interface
```typescript
interface LivenessPoller {
  /** Start the polling loop. Idempotent — calling when already running is a no-op. */
  start(): void;

  /** Stop the polling loop. */
  stop(): void;
}
```
- Preconditions: None
- Postconditions: `start` — interval timer active at 5s cadence. `stop` — interval cleared
- Invariants: Exactly one interval timer active at a time (guarded by globalThis key)

**Implementation Notes**
- Use `globalThis.__csm_dev_server_liveness` to store the interval ID (HMR-safe)
- Auto-start when the first dev server is registered; auto-stop when the registry empties
- `process.kill(pid, 0)` throws if the process does not exist — catch `ESRCH` to detect dead processes
- Polling interval: 5 seconds

---

### API Layer

#### Dev Server API Routes

| Field | Detail |
|-------|--------|
| Intent | REST endpoints for dev server start, stop, and status queries |
| Requirements | 8.1, 8.2, 8.3, 8.4 |

**Responsibilities & Constraints**
- Thin orchestration: validate input, delegate to DevServerRegistry, return response
- Follow existing API route patterns: `withTracing`, `export const dynamic = "force-dynamic"`, decoded params

**Dependencies**
- Inbound: DevServerPanel (via fetch) (P0)
- Outbound: DevServerRegistry — all lifecycle operations (P0)
- Outbound: `readRepoConfig()` — validate project has dev server config (P1)
- Outbound: `resolveProjectPath()` — resolve project name to path (P0)

**Contracts**: API [x]

##### API Contract

| Method | Endpoint | Request | Response | Errors |
|--------|----------|---------|----------|--------|
| GET | `/api/projects/[name]/sessions/[session]/dev-servers` | — | `DevServersStatusResponse` | 404 (project/session not found) |
| POST | `/api/projects/[name]/sessions/[session]/dev-servers/[serverName]/start` | — | `{ status: "accepted" }` | 404, 409 (already running), 400 (no config) |
| POST | `/api/projects/[name]/sessions/[session]/dev-servers/[serverName]/stop` | — | `{ status: "ok" }` | 404 (not running) |
| POST | `/api/projects/[name]/sessions/[session]/dev-servers/start-all` | — | `{ status: "accepted" }` | 404, 400 (no config) |
| POST | `/api/projects/[name]/sessions/[session]/dev-servers/stop-all` | — | `{ status: "ok" }` | 404 |

**Implementation Notes**
- GET response merges configured servers (from `ClaudeSessionManager.json`) with runtime state (from registry) — a configured-but-not-started server appears with status `stopped`
- POST start returns 202 (async operation); POST stop returns 200 (synchronous)
- All routes resolve project path via `resolveProjectPath(name)` and session via `getSession(projectPath, sessionName)`

---

### UI / Session Page

#### DevServerPanel

| Field | Detail |
|-------|--------|
| Intent | Control panel UI for launching, stopping, and monitoring dev servers within a session |
| Requirements | 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7 |

**Responsibilities & Constraints**
- Renders only when the project has `devServers` configured (req 9.7)
- Displays per-server status indicators, start/stop buttons, and Tailscale remote URLs
- Updates in real-time via SSE events

**Dependencies**
- Inbound: SessionDetailPage — renders panel when config available (P0)
- Outbound: useDevServers hook — data and mutation functions (P0)

**Implementation Notes**
- Colocated with session page components: `src/app/projects/[name]/[session]/DevServerPanel.tsx`
- Status indicators: colored dot (gray=stopped, yellow=starting, green=running, red=error)
- Remote URL: clickable link with `target="_blank"` and `rel="noopener noreferrer"` (req 9.3)
- Start All / Stop All buttons enabled based on aggregate state
- Error state shows truncated recent output for diagnostics
- Summary-only component — no new boundaries introduced beyond what `useDevServers` provides

#### useDevServers Hook

| Field | Detail |
|-------|--------|
| Intent | Data fetching and SSE subscription for dev server state |
| Requirements | 9.6 |

**Implementation Notes**
- TanStack Query for initial data fetch (`GET /dev-servers`) with SSE event listener for real-time cache invalidation
- Exposes: `servers` (array), `startServer(name)`, `stopServer(name)`, `startAll()`, `stopAll()`, `isLoading`
- SSE subscription filters for `dev-server-status` events matching current project + session
- Mutation functions call the corresponding POST endpoints and optimistically update status

## Data Models

### Domain Model

The dev server domain introduces one new aggregate (`DevServerEntry`) and extends one existing entity (`PerRepoConfig`):

```mermaid
erDiagram
    PerRepoConfig ||--o{ DevServerConfig : "devServers[]"
    DevServerConfig {
        string name
        string command
    }
    Session ||--o{ DevServerEntry : "runtime only"
    DevServerEntry {
        string serverName
        string projectPath
        string sessionName
        string command
        int pid
        string status
        int port
        string remoteUrl
        string startedAt
        string errorMessage
        string[] recentOutput
    }
```

- **PerRepoConfig** (persisted in `ClaudeSessionManager.json`): Extended with optional `devServers` array
- **DevServerEntry** (in-memory only): Runtime process state, not persisted

### Logical Data Model

**Configuration (persisted)**:

```typescript
/** Extension to perRepoConfigSchema */
const devServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});
type DevServerConfig = z.infer<typeof devServerConfigSchema>;

/** Updated perRepoConfigSchema */
const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable(),
  preMergeCommand: z.string().nullable().optional(),
  devServers: z.array(devServerConfigSchema).optional(),
});
```

**Runtime state (in-memory)**:

```typescript
const devServerStatusSchema = z.enum(["starting", "running", "stopped", "error"]);
type DevServerStatus = z.infer<typeof devServerStatusSchema>;
```

Registry key: `${projectPath}::${sessionName}::${serverName}` — guarantees uniqueness across worktrees.

### Data Contracts & Integration

**SSE Event Schema**:

```typescript
const devServerStatusEventSchema = z.object({
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  sessionName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
type DevServerStatusEvent = z.infer<typeof devServerStatusEventSchema>;
```

Added to the `SSEEvent` union in `schemas.ts`.

**API Response Schema**:

```typescript
const devServerRuntimeStateSchema = z.object({
  serverName: z.string(),
  command: z.string(),
  status: devServerStatusSchema,
  pid: z.number().nullable(),
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recentOutput: z.array(z.string()),
});

const devServersStatusResponseSchema = z.object({
  servers: z.array(devServerRuntimeStateSchema),
});
type DevServersStatusResponse = z.infer<typeof devServersStatusResponseSchema>;
```

## Error Handling

### Error Strategy

Errors are categorized by their source and handled with appropriate recovery:

- **Process spawn failure** (command not found, permission denied): Transition to `error` status immediately with the error message; broadcast SSE event
- **CSM_PORT timeout**: After 60s without a `CSM_PORT=` line, transition to `error` with captured stdout/stderr for diagnostics
- **Process unexpected exit**: Liveness poller detects; transitions to `stopped`; cleans up Tailscale registration
- **Tailscale CLI failure**: Logged and swallowed; dev server continues running locally; `remoteUrl` set to null in SSE event and API response
- **Tailscale unavailable**: `getHostname()` returns null; all `register`/`unregister` calls become no-ops with warning logs

### Error Categories and Responses

**User Errors (4xx)**:
- 404: Project or session not found → standard `ApiError` response
- 400: No `devServers` configured for project → `{ error: "No dev servers configured for this project" }`
- 409: Server already running/starting → `{ error: "Server is already running" }`

**System Errors (5xx)**:
- Process spawn failure → 500 with error message (unlikely if config is valid)

**Process Errors (runtime, not HTTP)**:
- Unexpected exit → `stopped` status via SSE
- CSM_PORT timeout → `error` status via SSE with diagnostic output

### Monitoring

All operations log structured events via `createLogger("dev-server")`:

| Event | Level | Fields |
|-------|-------|--------|
| `dev-server.start` | info | serverName, command, worktreePath, pid |
| `dev-server.port_discovered` | info | serverName, port |
| `dev-server.running` | info | serverName, port, remoteUrl |
| `dev-server.stop` | info | serverName, pid |
| `dev-server.exit` | info | serverName, pid, code, signal |
| `dev-server.error` | error | serverName, error, recentOutput |
| `dev-server.tailscale_failure` | warn | serverName, port, error |
| `dev-server.liveness_dead` | warn | serverName, pid |
| `dev-server.startup_timeout` | warn | serverName, timeoutMs |

## Testing Strategy

### Unit Tests
- **DevServerRegistry**: Test state transitions (starting → running → stopped), duplicate start prevention, `CSM_PORT` parsing, startup timeout, output buffer
- **TailscaleService**: Test hostname caching, CLI command construction, graceful degradation on Tailscale unavailability
- **LivenessPoller**: Test dead process detection, auto-start/auto-stop behavior
- **Schema validation**: Test `devServerConfigSchema` with valid/invalid inputs

### Integration Tests
- **Start → port discovery → Tailscale register → SSE broadcast**: End-to-end flow using a mock dev server script that emits `CSM_PORT=<port>`
- **Stop → Tailscale unregister → process kill → SSE broadcast**: Verify cleanup order
- **Session delete cleanup**: Verify `stopAllForSession` is called before worktree removal
- **API route validation**: Test GET/POST routes with mock registry

### E2E / UI Tests
- **DevServerPanel renders when config exists**: Verify panel visibility with/without `devServers` config
- **Start/stop button interactions**: Verify correct API calls and optimistic updates
- **SSE-driven real-time updates**: Verify status indicators update without page refresh
- **Remote URL opens in new tab**: Verify link target and href

## Security Considerations

- **Command injection**: Dev server commands come from the project's `ClaudeSessionManager.json`, which is under the repository maintainer's control. CSM passes the command string to `spawn` with `shell: true` without modification. This is acceptable because CSM already runs arbitrary code (Claude Agent SDK with `bypassPermissions` mode). No user-supplied input reaches the command string.
- **Tailscale --operator**: CSM relies on the system's Tailscale `--operator` configuration for rootless operation. CSM does not attempt to elevate privileges.
- **Port exposure**: Tailscale Serve exposes ports only to the tailnet (not the public internet), matching the existing security boundary for CSM.
