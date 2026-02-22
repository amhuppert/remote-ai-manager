# Gap Analysis: Dev Containers (Updated)

## Analysis Summary

- **Scope**: 10 requirements covering container lifecycle, default config, per-project customization, containerized prompt execution, workspace mounting, credential management, transcript access, hook integration, Docker prerequisites, and container status observability.
- **Current State**: The codebase already contains **substantial implementation** for nearly all requirements. The `devcontainer.ts` module, default container config (Dockerfile + firewall + devcontainer.json), schemas, session lifecycle, prompt execution, hooks, and SSE broadcasting are already modified to support containers.
- **Key Finding**: This is a nearly-complete implementation, not a greenfield feature. The gap is primarily in **untested integration paths**, **missing UI updates**, **startup reconciliation wiring**, and **devcontainer config change detection**.
- **Effort**: M (3-7 days) — mostly integration testing, UI work, and wiring existing pieces together.
- **Risk**: Medium — core container mechanics (devcontainer CLI, Docker) are already integrated; remaining work is incremental.

---

## Requirement-to-Asset Map

### Requirement 1: Container Lifecycle Management

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 1.1 Build + start container on session create | **Implemented** | `sessions.ts:createSession()` calls `checkPrerequisites()`, `resolveConfig()`, `prepareSessionEnvironment()`, `startContainer()` with full rollback on failure |
| 1.2 Stop + remove container on session delete | **Implemented** | `sessions.ts:deleteSession()` calls `stopAndRemoveContainer()` before worktree cleanup |
| 1.3 Report container status during build/start | **Implemented** | `updateContainerStatus()` helper persists status + broadcasts SSE `container-status` events |
| 1.4 Report error with logs on start failure | **Partial** | Error message is captured and stored in `containerError`. `getContainerLogs()` exists but is not called during creation failure to attach build logs |
| 1.5 Startup reconciliation | **Partial** | `reconcileContainers()` in `devcontainer.ts` checks running state and marks unhealthy. **Gap**: Not wired into app startup (no Next.js server-start hook calling it) |
| 1.6 Independent per-session lifecycle | **Implemented** | Each session gets its own `containerId`; operations are per-session |

**Gaps**:
- AC 1.4: Build logs not captured on container start failure — need to pipe `devcontainer up` stderr or call `getContainerLogs()` on failure
- AC 1.5: `reconcileContainers()` exists but no startup trigger wires it

### Requirement 2: Default Container Configuration

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 2.1 Default devcontainer config | **Implemented** | `devcontainer-defaults/devcontainer.json`, `Dockerfile`, `init-firewall.sh` |
| 2.2 Firewall with domain allowlist | **Implemented** | `init-firewall.sh` with Anthropic API, npm, GitHub, PyPI, etc. |
| 2.3 NET_ADMIN + NET_RAW capabilities | **Implemented** | `devcontainer.json` has `capAdd: ["NET_ADMIN", "NET_RAW"]` |
| 2.4 Non-root user | **Implemented** | Dockerfile `USER node`, devcontainer.json `remoteUser: "node"` |
| 2.5 Claude Code CLI pre-installed | **Implemented** | `RUN npm install -g @anthropic-ai/claude-code` |
| 2.6 Default-deny firewall | **Implemented** | `init-firewall.sh` with iptables REJECT default policy + verification |

**Gaps**: None — fully implemented.

### Requirement 3: Per-Project Container Customization

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 3.1 Use project `.devcontainer/devcontainer.json` | **Implemented** | `resolveConfig()` checks project first, falls back to default |
| 3.2 Fall back to default when no project config | **Implemented** | `resolveConfig()` fallback logic |
| 3.3 Support standard devcontainer features | **Implemented** | Uses `devcontainer up` CLI which handles Dockerfiles, Compose, features, post-create commands natively |
| 3.4 Report build errors, no silent fallback | **Implemented** | `startContainer()` throws on failure; `createSession()` rolls back completely |
| 3.5 Rebuild on config change | **Missing** | No file watcher or content hash comparison to detect devcontainer config changes |

**Gaps**:
- AC 3.5: No mechanism to detect config file changes and trigger rebuild. **Research Needed**: Evaluate approaches (content hash at session start, file watcher, manual rebuild API).

### Requirement 4: Prompt Execution Inside Containers

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 4.1 Execute Claude CLI inside container | **Implemented** | `prompt.ts` calls `execInContainer()` with `["claude", ...args]` |
| 4.2 Stream NDJSON output via SSE | **Implemented** | `execInContainer()` returns `ChildProcess` with piped stdio; `readline` + SSE emit pattern preserved |
| 4.3 Pass model, prompt, flags | **Implemented** | `prompt.ts` builds args with `--model`, `-p`, `--dangerously-skip-permissions`, `--output-format stream-json`, `--verbose`, `--max-turns` |
| 4.4 Resume conversations (`--resume`) | **Implemented** | `prompt.ts` uses `--resume` with `claudeSessionId`; container retains state via `.claude/` bind-mount |
| 4.5 Single-flight locking (HTTP 409) | **Implemented** | `lock.ts` + prompt route returns 409 |
| 4.6 Timeout enforcement in container | **Implemented** | `setTimeout` sends SIGTERM to the `devcontainer exec` child process |

**Gaps**: None — fully implemented.

### Requirement 5: Workspace Mounting

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 5.1 Bind-mount worktree into container | **Implemented** | `startContainer()` passes `--workspace-folder worktreePath` to `devcontainer up` |
| 5.2 File changes reflected on host | **Implemented** | Bind mount provides bidirectional filesystem access |
| 5.3 Read-write access | **Implemented** | Default bind mount is read-write |
| 5.4 Git operations on host | **Implemented** | Git commands in `sessions.ts` and API routes use host paths |

**Gaps**: None — fully implemented.

### Requirement 6: Credential and Environment Management

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 6.1 Pass API key via env var | **Implemented** | `buildContainerEnv()` passes `ANTHROPIC_API_KEY` via `--remote-env` |
| 6.2 Strip CLAUDE* env vars | **Implemented** | `buildContainerEnv()` only includes explicit whitelist (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CSM_*`, `DEVCONTAINER`) — does not pass through host env |
| 6.3 Clear error when no API key | **Implemented** | `buildContainerEnv()` throws with descriptive message listing all auth options |

**Gaps**: None — fully implemented. Also supports OAuth token and `.credentials.json` bind-mount.

### Requirement 7: Transcript and Session State Access

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 7.1 Transcripts accessible from host | **Implemented** | `.claude/` dir is bind-mounted from `claudeHostDir`; `getClaudeProjectDir()` in `conversations.ts` resolves correct path for containerized sessions |
| 7.2 Persist .claude/ across container restarts | **Implemented** | Host directory (`containers/<session-hash>`) persists; re-mounted on container restart |
| 7.3 Retain transcripts on session deletion | **Implemented** | `deleteSession()` comment: "session's .claude/ host directory is NOT deleted" |
| 7.4 Parse transcripts identically | **Implemented** | `conversations.ts` detects containerized sessions via `claudeHostDir` and adjusts path encoding to `/workspace` |

**Gaps**: None — fully implemented.

### Requirement 8: Hook Integration

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 8.1 Configure hooks inside container | **Implemented** | `prepareSessionEnvironment()` writes `settings.json` with `UserPromptSubmit` + `Stop` hooks pointing to `csm-hook.sh` |
| 8.2 Network path from container to CSM | **Implemented** | `devcontainer.json` has `--add-host=host.docker.internal:host-gateway`; hook script uses `host.docker.internal`; firewall allows host IP |
| 8.3 Match hook events to sessions | **Implemented** | Hook script injects `CSM_PROJECT_PATH`/`CSM_SESSION_NAME` via `jq`; `hooks.ts:findSessionByIdentity()` matches by direct project+session identity |
| 8.4 Non-blocking on hook delivery failure | **Implemented** | Hook script runs `curl ... &` (background), non-blocking |

**Gaps**: None — fully implemented.

### Requirement 9: Docker Prerequisites and Error Handling

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 9.1 Verify Docker on startup | **Partial** | `checkPrerequisites()` exists but is only called per-session during `createSession()`, not at app startup |
| 9.2 Clear error when Docker unavailable | **Implemented** | Specific error messages for daemon not running, not installed |
| 9.3 Permission-specific error | **Implemented** | Detects "permission denied" and provides `usermod` guidance |
| 9.4 Docker errors include logs | **Partial** | Build failures include error message but not full container build logs |

**Gaps**:
- AC 9.1: No app-startup Docker check. Could display status on dashboard.
- AC 9.4: Build failure logs could be richer (capture stderr from `devcontainer up`).

### Requirement 10: Container Status Observability

| Criterion | Status | Asset / Gap |
|-----------|--------|-------------|
| 10.1 Expose container status in API/UI | **Partial** | API exposes `containerStatus` field on `SessionState`. **Gap**: UI components (SessionsList, SessionDetailPage) don't visually render container status yet |
| 10.2 SSE notifications on state transitions | **Implemented** | `broadcastContainerStatus()` sends SSE events on transitions; `containerStatusEventSchema` defined |
| 10.3 Container logs API endpoint | **Implemented** | `GET /api/projects/[name]/sessions/[session]/container-logs` route exists, calls `getContainerLogs()` |

**Gaps**:
- AC 10.1: No UI components render `containerStatus`. Need visual indicators in session list and detail pages.

---

## Implementation Approach Options

### Option A: Extend Existing Components (Recommended)

**Rationale**: The codebase already has ~90% of the container feature implemented. The remaining work is:

1. **Wire startup reconciliation** — Call `reconcileContainers()` from a server-initialization path or on first API request
2. **UI container status indicators** — Add status badges/indicators to `SessionsList.tsx` and `SessionDetailPage.tsx`
3. **Enrich build error reporting** — Capture `devcontainer up` stderr on failure and attach to error response
4. **Config change detection** (AC 3.5) — Add content hash comparison at session creation time (simplest approach)
5. **Integration tests** — End-to-end test with Docker (requires Docker in CI)

**Trade-offs**:
- Minimal new files — mostly extending existing modules
- Leverages all existing patterns (SSE, state management, schemas)
- Low risk of breaking existing functionality

### Option B: Create New Components

Not warranted — the architecture is already established. Creating new modules would duplicate existing patterns.

### Option C: Hybrid Approach

Not applicable — this is a completion/polish task, not a new architectural effort.

---

## Effort & Risk

| Dimension | Rating | Justification |
|-----------|--------|---------------|
| **Effort** | **M** (3-7 days) | Core container mechanics exist; remaining work is UI, wiring, error enrichment, and integration testing |
| **Risk** | **Medium** | Docker/devcontainer CLI are external dependencies with known behavior; integration testing requires Docker daemon; UI changes are incremental |

---

## Recommendations for Design Phase

### Preferred Approach
**Option A: Extend Existing Components** — finish the remaining ~10% by extending existing modules and adding UI components.

### Key Decisions Needed
1. **Startup reconciliation trigger**: `instrumentation.ts` vs. middleware vs. on-first-request lazy init
2. **Config change detection strategy**: Content hash at session create vs. file watcher vs. manual rebuild API
3. **UI design for container status**: Badge placement, color scheme, container log viewer integration

### Research Items
- **Config change detection** (AC 3.5): How should CSM detect devcontainer config changes? Content hash comparison at session creation is simplest but doesn't cover live changes.
- **Startup reconciliation timing** (AC 1.5, 9.1): Next.js App Router doesn't have a server-start hook. Need to evaluate `instrumentation.ts`, middleware, or lazy initialization patterns.
- **Build log capture** (AC 1.4, 9.4): `devcontainer up` outputs to stderr during build. Need to determine if `execFileAsync` captures this adequately or if streaming capture is needed.

---

## Existing Asset Summary

| Module | Role | Status |
|--------|------|--------|
| `src/lib/devcontainer.ts` | Container lifecycle (prerequisites, config, start, exec, stop, logs, reconcile) | **Complete** |
| `src/lib/devcontainer.test.ts` | Unit tests for devcontainer module | **Complete** (8 describe blocks) |
| `src/lib/devcontainer-defaults/` | Default Dockerfile, devcontainer.json, firewall script | **Complete** |
| `src/lib/sessions.ts` | Session create/delete with full container integration | **Complete** |
| `src/lib/prompt.ts` | Containerized prompt execution via `execInContainer()` | **Complete** |
| `src/lib/hooks.ts` | Container-aware hook matching (`findSessionByIdentity`) | **Complete** |
| `src/lib/schemas.ts` | `containerStatusSchema`, `containerStatusEventSchema`, `SessionState` fields | **Complete** |
| `src/lib/sse-broadcaster.ts` | `broadcastContainerStatus()` | **Complete** |
| `src/lib/conversations.ts` | Container-aware transcript discovery (`claudeHostDir` support) | **Complete** |
| `src/app/api/.../container-logs/route.ts` | Container logs API endpoint | **Complete** |
| UI components for container status | Visual rendering of container status in session views | **Missing** |
| Startup reconciliation wiring | App-init trigger for `reconcileContainers()` | **Missing** |
| Config change detection | Rebuild trigger when devcontainer config changes | **Missing** |
