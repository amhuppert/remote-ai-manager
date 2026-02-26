# Research & Design Decisions

## Summary
- **Feature**: dev-server-automation
- **Discovery Scope**: New Feature (greenfield with complex integration)
- **Key Findings**:
  - CSM already uses a consistent `globalThis`-backed singleton pattern for HMR-safe in-memory state; the dev server process registry follows this pattern directly
  - `tailscale serve` supports `--https=<port> --bg` for persistent background registrations and `tailscale serve status --json` for machine-readable status; the `--operator` flag must be pre-configured for rootless execution
  - The codebase exclusively uses `execFile` (promisified) for short-lived processes; long-lived dev servers require `spawn` with streaming stdout — this is the first `spawn`-based process in the codebase

## Research Log

### Tailscale Serve CLI Behavior
- **Context**: Requirements 4.1–4.5 specify Tailscale Serve integration for exposing dev servers over the tailnet
- **Sources Consulted**: [tailscale serve command docs](https://tailscale.com/kb/1242/tailscale-serve), [Tailscale Serve examples](https://tailscale.com/kb/1313/serve-examples), [Machine names](https://tailscale.com/kb/1098/machine-names)
- **Findings**:
  - Register: `tailscale serve --https=<tsPort> --bg localhost:<localPort>` — the `--bg` flag makes the registration persistent (survives reboots)
  - Unregister: `tailscale serve --https=<tsPort> off`
  - Status: `tailscale serve status --json` — returns machine-readable JSON of all active registrations
  - Hostname: `tailscale status --json` returns `Self.DNSName` (e.g., `machine.tailnet-name.ts.net.`) — strip trailing dot
  - Full URL: `https://<hostname>:<tsPort>`
  - HTTPS certificates are auto-provisioned by Tailscale; the daemon terminates TLS
  - Rootless operation requires `--operator=<user>` pre-configured on the Tailscale daemon
- **Implications**:
  - The `--bg` flag is appropriate since dev servers are long-lived; cleanup must explicitly run `off` on stop/session-delete
  - The Tailscale HTTPS port and the local dev server port can differ, enabling multiple worktree dev servers on the same project
  - Tailscale hostname resolution is a one-time operation (cacheable for the CSM process lifetime)

### Node.js Long-Lived Process Management
- **Context**: Dev servers are long-running child processes requiring stdout streaming, PID tracking, and graceful shutdown
- **Sources Consulted**: [Node.js child_process docs](https://nodejs.org/api/child_process.html), [Graceful Shutdown in Node.js](https://dtrunin.github.io/2022/04/05/nodejs-graceful-shutdown.html)
- **Findings**:
  - `spawn()` (not `execFile`) is required for streaming stdout/stderr from long-lived processes
  - `child.kill('SIGTERM')` sends graceful termination; if not responsive, follow up with `SIGKILL` after a timeout
  - `child.on('exit', (code, signal))` fires when the process terminates — use this to transition status and clean up Tailscale registrations
  - `child.on('error', ...)` fires if the process cannot be spawned (e.g., command not found)
  - Two approaches for running shell commands: `spawn('sh', ['-c', command])` creates an intermediate `sh` process (SIGTERM sent to `sh` may not propagate to the actual dev server); `spawn(command, { shell: true })` lets Node.js manage the shell invocation and gives a direct `ChildProcess` handle where `child.kill()` targets the shell process directly
  - `process.on('exit', ...)` is synchronous-only and cannot run async cleanup; use `process.on('beforeExit', ...)` or `process.on('SIGTERM', ...)` for CSM-level shutdown hooks
- **Implications**:
  - Use `spawn(command, { shell: true, cwd, env, stdio: 'pipe' })` — Node.js handles shell invocation and `child.kill()` directly targets the spawned shell process, avoiding the signal-forwarding problem of explicit `spawn('sh', ['-c', ...])` where SIGTERM may not reach the actual dev server
  - Implement a two-phase shutdown: SIGTERM → wait 5s → SIGKILL
  - Register a `process.on('SIGTERM')` handler at module init to trigger cleanup of all registered dev servers

### CSM_PORT Stdout Protocol
- **Context**: Requirement 2.2 specifies a structured stdout line `CSM_PORT=<port>` for port discovery
- **Sources Consulted**: Internal analysis of similar patterns (webpack-dev-server, Vite, Next.js dev output)
- **Findings**:
  - Dev server wrapper scripts (or the user's command) must emit `CSM_PORT=<port>` on stdout after binding
  - Parsing strategy: scan each stdout line for a regex match `^CSM_PORT=(\d+)$`
  - This is a simple, framework-agnostic protocol that works with any tech stack
  - The user's configured command can be a wrapper script that starts the real server, detects the port, and emits the line
- **Implications**:
  - CSM only transitions to `running` after seeing this line; no timeout-based guessing
  - A startup timeout (e.g., 60s) prevents indefinite `starting` state if the line never appears
  - Recent stdout/stderr is captured in a circular buffer for diagnostic display

### Existing Codebase Integration Points
- **Context**: Where to hook dev server lifecycle into existing session management
- **Sources Consulted**: `src/lib/sessions.ts`, `src/lib/background-jobs.ts`, `src/lib/sse-broadcaster.ts`, `src/lib/schemas.ts`
- **Findings**:
  - **Session delete** (`deleteSession` in `sessions.ts`): Hook before `git worktree remove` to stop dev servers
  - **Session merge** (`setSessionFinished` called from `background-jobs.ts`): Hook after merge to stop dev servers
  - **CSM shutdown**: No existing shutdown hook; needs a new `process.on('SIGTERM')` handler in the registry module
  - **SSE pattern**: Add `DevServerStatusEvent` to the `SSEEvent` union in `schemas.ts`; call `broadcast()` on all status transitions
  - **globalThis pattern**: 7 existing modules use `__csm_*` keys; new registry at `__csm_dev_servers`
  - **API routes**: Follow `withTracing` + `export const dynamic = "force-dynamic"` convention; place under `/api/projects/[name]/sessions/[session]/dev-servers/`
  - **Config**: Extend `perRepoConfigSchema` with an optional `devServers` array
- **Implications**:
  - Dev server cleanup is a cross-cutting concern touching `sessions.ts`, `background-jobs.ts`, and a new shutdown handler
  - The cleanup function must be importable as a standalone utility to avoid circular dependencies

### Port Management Strategy
- **Context**: Multiple worktrees of the same project can run dev servers simultaneously, requiring unique ports
- **Sources Consulted**: Internal analysis, Node.js `net` module
- **Findings**:
  - **Option A**: User specifies port per server in config — simple but requires manual coordination across worktrees
  - **Option B**: CSM auto-assigns ports from a range — complex but avoids conflicts
  - **Option C**: Let the dev server pick its own port (port 0 / auto-increment) and report via `CSM_PORT=<port>` — framework-native, zero config
  - Most modern dev servers (Next.js, Vite, Storybook) auto-increment ports when the default is taken
- **Implications**:
  - Option C is the cleanest: the user's command handles port selection, and CSM discovers the port via `CSM_PORT=<port>` protocol
  - CSM does not need to manage port allocation — it only needs to record what the dev server reported
  - The Tailscale HTTPS port should match the local port for simplicity (same `--https=<port>` as local port)

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| In-memory registry with globalThis | Map of session keys to process state, HMR-safe via globalThis | Consistent with 7 existing CSM modules; simple; no persistence needed | Lost on CSM restart (by design per req 5.3) | **Selected** |
| State.json persistence | Store dev server config in session state | Survives restart | Stale data on restart; process PID meaningless after restart | Rejected for runtime state; config stays in `ClaudeSessionManager.json` |
| Separate process manager (PM2-style) | External process supervisor | Independent lifecycle | Over-engineered for CSM's single-machine model | Rejected |

## Design Decisions

### Decision: In-Memory-Only Registry via globalThis
- **Context**: Dev server runtime state (PID, port, status) must be tracked but not persisted (req 5.1–5.3)
- **Alternatives Considered**:
  1. Persist to `state.json` alongside session state
  2. Use a separate JSON file for dev server state
  3. In-memory `globalThis` singleton (matching existing pattern)
- **Selected Approach**: globalThis-backed `Map<string, DevServerEntry>` at `__csm_dev_servers`, keyed by `${projectPath}::${sessionName}::${serverName}`
- **Rationale**: Matches all 7 existing CSM HMR-safe singletons; clean-slate on restart aligns with requirement 5.3; no stale PID references
- **Trade-offs**: No crash recovery of dev server state (acceptable per requirements)
- **Follow-up**: Ensure liveness polling handles edge cases (zombie processes)

### Decision: spawn with shell: true
- **Context**: Dev server commands are arbitrary strings configured per-project (e.g., `bun run dev`, `npm run storybook`)
- **Alternatives Considered**:
  1. `execFile` with command splitting — does not support shell features (pipes, env expansion)
  2. `spawn('sh', ['-c', command])` — creates an intermediate `sh` process; SIGTERM sent to `sh` may not forward to the actual dev server, leading to orphaned processes
  3. `spawn(command, { shell: true })` — Node.js manages shell invocation; `child.kill()` directly targets the shell process
- **Selected Approach**: `spawn(command, { shell: true })` — Node.js manages shell invocation and provides a direct `ChildProcess` handle
- **Rationale**: `child.kill('SIGTERM')` targets the shell process directly, avoiding the signal-forwarding problem of explicit `spawn('sh', ['-c', ...])`. Node.js handles platform-appropriate shell selection. Shell features (pipes, env vars) are supported.
- **Trade-offs**: Platform-dependent shell (`/bin/sh` on Linux/macOS, `cmd.exe` on Windows) — acceptable since CSM targets Linux only
- **Follow-up**: Two-phase shutdown: `child.kill('SIGTERM')` → 5s wait → `child.kill('SIGKILL')`

### Decision: Tailscale Port = Local Port
- **Context**: Each dev server needs a unique Tailscale HTTPS port mapping
- **Alternatives Considered**:
  1. Fixed Tailscale port, different local ports
  2. Tailscale port = local port (1:1 mapping)
  3. Separate Tailscale port allocation
- **Selected Approach**: Use the discovered local port as the Tailscale HTTPS port: `tailscale serve --https=<port> --bg localhost:<port>`
- **Rationale**: Simple 1:1 mapping; avoids additional port allocation; the port is unique because the dev server already bound to it
- **Trade-offs**: Port must be above 1024 for non-root; restricted ports may fail Tailscale registration
- **Follow-up**: Log Tailscale failures without blocking dev server operation (req 4.4)

### Decision: API Route Structure
- **Context**: The UI needs endpoints to start, stop, and query dev server status
- **Alternatives Considered**:
  1. Single endpoint with action parameter (`POST /dev-servers { action: "start" | "stop" }`)
  2. RESTful sub-routes (`POST /dev-servers/start`, `POST /dev-servers/stop`)
  3. Resource-based REST (`POST /dev-servers/:name/start`, `POST /dev-servers/:name/stop`)
- **Selected Approach**: Resource-based REST routes under `/api/projects/[name]/sessions/[session]/dev-servers/`
  - `GET /dev-servers` — list all configured servers with runtime status
  - `POST /dev-servers/[serverName]/start` — start a specific server
  - `POST /dev-servers/[serverName]/stop` — stop a specific server
  - `POST /dev-servers/start-all` — start all configured servers
  - `POST /dev-servers/stop-all` — stop all running servers
- **Rationale**: Consistent with CSM's existing REST resource hierarchy; clear separation of concerns; server name in the URL path
- **Trade-offs**: More route files than a single endpoint
- **Follow-up**: None

## Risks & Mitigations
- **Zombie processes on CSM crash** — Process group kill with SIGTERM + SIGKILL timeout; liveness polling detects orphaned PIDs via `process.kill(pid, 0)`
- **Tailscale not available** — Graceful degradation: dev server runs locally, Tailscale URL shown as "unavailable"; log warning
- **Port conflict** — Dev server fails to start and exits; CSM detects exit before `CSM_PORT` line and transitions to `error` status
- **CSM_PORT never emitted** — Startup timeout (60s default) transitions to `error` with diagnostic output from captured stdout/stderr
- **HMR re-evaluation** — globalThis singleton pattern prevents duplicate registries across module re-evaluations

## References
- [tailscale serve command](https://tailscale.com/kb/1242/tailscale-serve) — CLI syntax, flags, and behavior
- [Tailscale Serve examples](https://tailscale.com/kb/1313/serve-examples) — practical usage examples
- [Node.js child_process docs](https://nodejs.org/api/child_process.html) — spawn, kill, signals
- [Graceful Shutdown in Node.js](https://dtrunin.github.io/2022/04/05/nodejs-graceful-shutdown.html) — shutdown patterns
