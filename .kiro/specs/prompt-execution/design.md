# Technical Design: Prompt Execution

## Overview

**Purpose**: The Prompt Execution feature delivers the core interaction mechanism between CSM and Claude Code. It enables developers to send prompts to Claude Code CLI processes running within session worktrees, with concurrency control and lifecycle management.

**Users**: Developers managing Claude Code sessions will use this to submit prompts via the API (triggered by the dashboard UI or external tools).

**Impact**: This is the primary execution engine of CSM. It depends on the session lifecycle feature for worktree context and is consumed by the dashboard UI for prompt submission.

### Goals

- Execute Claude CLI prompts within the correct session worktree context
- Maintain conversation continuity across sequential prompts via the `-c` flag
- Prevent concurrent prompt execution per session via single-flight locking
- Track session status (running/ready) and prompt counts in real time
- Handle errors and timeouts gracefully with guaranteed resource cleanup

### Non-Goals

- Streaming/real-time output from Claude CLI (output captured after completion)
- Prompt queuing (rejected immediately if busy)
- Prompt history storage (handled by transcript viewer feature)
- Claude CLI installation management

## Architecture

### Existing Architecture Analysis

The prompt execution is fully implemented across three modules:

- **`src/lib/prompt.ts`** — Contains `executePrompt()` orchestrating the full lifecycle and `mutateSession()` helper for state mutations
- **`src/lib/lock.ts`** — Provides `acquireSessionLock()` and `isSessionBusy()` for single-flight concurrency control
- **`src/app/api/projects/[name]/sessions/[session]/prompt/route.ts`** — REST API layer exposing the POST endpoint with request validation and error mapping

Key patterns preserved:

- Flat `src/lib/` module structure
- `execFile` for subprocess spawning (no shell injection risk)
- Atomic state mutations via read→mutate→persist pattern
- In-memory lock map for concurrency control

### Architecture Pattern & Boundary Map

```mermaid
graph TB
    subgraph API_Layer
        PromptRoute[Prompt API Route]
    end

    subgraph Domain_Layer
        Prompt[prompt.ts]
        Lock[lock.ts]
        State[state.ts]
        Config[config.ts]
    end

    subgraph External
        ClaudeCLI[Claude CLI Process]
        FileSystem[Filesystem - State]
    end

    PromptRoute --> Prompt
    PromptRoute --> Lock
    PromptRoute --> State
    Prompt --> Lock
    Prompt --> State
    Prompt --> Config
    Prompt --> ClaudeCLI
    State --> FileSystem
    Config --> FileSystem
```

**Architecture Integration**:

- Selected pattern: Layered architecture with flat domain modules
- Domain boundaries: API route handles HTTP; `prompt.ts` owns execution orchestration; `lock.ts` owns concurrency; `state.ts` owns persistence
- Existing patterns preserved: Schema-first validation, atomic state writes, `execFile` for subprocesses
- Steering compliance: Flat lib, Zod v4, TypeScript strict mode

### Technology Stack

| Layer       | Choice / Version        | Role in Feature                                    | Notes                              |
| ----------- | ----------------------- | -------------------------------------------------- | ---------------------------------- |
| Backend     | Next.js 15 App Router   | POST endpoint for prompt execution                 | `force-dynamic`                    |
| Language    | TypeScript 5.7 (strict) | All prompt and lock logic                          | `noUncheckedIndexedAccess`         |
| Validation  | Zod v4                  | Request body validation (`runPromptRequestSchema`) | `z.string().trim().min(1)`         |
| Process     | Node.js `child_process` | Claude CLI spawning via `execFile`                 | Promisified, with timeout          |
| Concurrency | In-memory `Map`         | Single-flight lock per session                     | Promise-based with release closure |
| Storage     | JSON filesystem         | Session state persistence                          | Atomic writes via `state.ts`       |

## System Flows

### Prompt Execution Flow

```mermaid
sequenceDiagram
    participant Client
    participant API as Prompt API Route
    participant Lock as lock.ts
    participant PE as prompt.ts
    participant CLI as Claude CLI
    participant State as state.ts

    Client->>API: POST /api/.../prompt
    API->>API: Validate request body
    API->>State: getSession()
    API->>Lock: isSessionBusy()
    alt Session is busy
        API-->>Client: 409 SESSION_BUSY
    end
    API->>PE: executePrompt(projectPath, session, prompt)
    PE->>Lock: acquireSessionLock()
    PE->>State: mutateSession(status = running)
    PE->>CLI: execFile claude [-c] -p prompt
    CLI-->>PE: stdout output
    PE->>State: mutateSession(promptCount++)
    PE->>State: mutateSession(status = ready)
    PE->>Lock: release()
    PE-->>API: { output: string }
    API-->>Client: 200 { success: true }
```

### Error Recovery Flow

```mermaid
flowchart TD
    A[Start Execution] --> B[Acquire Lock]
    B --> C[Set Status: running]
    C --> D[Spawn Claude CLI]
    D --> E{Success?}
    E -->|Yes| F[Increment promptCount]
    F --> G[Set Status: ready]
    G --> H[Release Lock]
    H --> I[Return Output]
    E -->|No| J[Wrap Error]
    J --> K[Best-effort: Set Status ready]
    K --> L[Release Lock - always]
    L --> M[Throw Error]
```

## Requirements Traceability

| Requirement | Summary                       | Components                   | Interfaces | Flows          |
| ----------- | ----------------------------- | ---------------------------- | ---------- | -------------- |
| 1.1         | Spawn claude with -p flag     | executePrompt                | execFile   | Execution      |
| 1.2         | Set CWD to worktree path      | executePrompt                | execFile   | Execution      |
| 1.3         | Set CI=1 environment variable | executePrompt                | execFile   | Execution      |
| 1.4         | Inherit parent env            | executePrompt                | execFile   | Execution      |
| 1.5         | Capture stdout                | executePrompt                | execFile   | Execution      |
| 2.1         | No -c flag on first prompt    | executePrompt                | —          | Execution      |
| 2.2         | Add -c flag on subsequent     | executePrompt                | —          | Execution      |
| 2.3         | Increment prompt count        | executePrompt, mutateSession | State      | Execution      |
| 3.1         | Acquire in-memory lock        | acquireSessionLock           | Lock Map   | Execution      |
| 3.2         | Reject if busy                | acquireSessionLock           | —          | Execution      |
| 3.3         | Release lock on completion    | executePrompt finally        | Lock Map   | Error Recovery |
| 3.4         | Query lock status             | isSessionBusy                | Lock Map   | Execution      |
| 4.1         | Status → running on start     | executePrompt, mutateSession | State      | Execution      |
| 4.2         | Status → ready on success     | executePrompt finally        | State      | Execution      |
| 4.3         | Status → ready on failure     | executePrompt finally        | State      | Error Recovery |
| 4.4         | Update lastActivityAt         | mutateSession                | State      | Execution      |
| 5.1         | Configurable timeout          | executePrompt                | Config     | Execution      |
| 5.2         | Terminate on timeout          | executePrompt                | execFile   | Execution      |
| 5.3         | 10 MB max buffer              | executePrompt                | execFile   | Execution      |
| 6.1         | Wrap error with prefix        | executePrompt catch          | —          | Error Recovery |
| 6.2         | Best-effort status reset      | executePrompt finally        | State      | Error Recovery |
| 6.3         | Guaranteed lock release       | executePrompt finally        | Lock       | Error Recovery |
| 6.4         | No count increment on failure | executePrompt                | —          | Error Recovery |
| 7.1         | POST endpoint                 | Prompt API Route             | HTTP       | Execution      |
| 7.2         | 400 for missing prompt        | Prompt API Route             | HTTP       | Execution      |
| 7.3         | 404 for missing project       | Prompt API Route             | HTTP       | Execution      |
| 7.4         | 404 for missing session       | Prompt API Route             | HTTP       | Execution      |
| 7.5         | 409 for busy session          | Prompt API Route             | HTTP       | Execution      |
| 7.6         | 200 with output length header | Prompt API Route             | HTTP       | Execution      |
| 7.7         | 500 for execution errors      | Prompt API Route             | HTTP       | Error Recovery |

## Components and Interfaces

| Component          | Domain/Layer       | Intent                                 | Req Coverage  | Key Dependencies                                    | Contracts |
| ------------------ | ------------------ | -------------------------------------- | ------------- | --------------------------------------------------- | --------- |
| executePrompt      | Domain / prompt.ts | Orchestrate prompt execution lifecycle | 1.1–6.4       | Lock (P0), State (P0), Config (P0), Claude CLI (P0) | Service   |
| mutateSession      | Domain / prompt.ts | Atomic session state mutation helper   | 4.1–4.4, 2.3  | State (P0)                                          | Service   |
| acquireSessionLock | Domain / lock.ts   | Acquire single-flight lock for session | 3.1, 3.2, 3.3 | None                                                | Service   |
| isSessionBusy      | Domain / lock.ts   | Check if session has active lock       | 3.4           | None                                                | Service   |
| Prompt API Route   | API / route.ts     | HTTP endpoint for prompt submission    | 7.1–7.7       | prompt.ts (P0), lock.ts (P0), state.ts (P0)         | API       |

### Domain Layer

#### executePrompt

| Field        | Detail                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- |
| Intent       | Orchestrate full prompt execution: lock → status → CLI → count → recovery                     |
| Requirements | 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4 |

**Responsibilities & Constraints**

- Acquires session lock, transitions status, spawns CLI, increments count, releases lock
- Uses `finally` block for guaranteed cleanup (status reset + lock release)
- CLI args built dynamically based on `promptCount`

**Dependencies**

- Outbound: `lock.ts` — `acquireSessionLock()` (P0)
- Outbound: `state.ts` — `getSession()`, `updateSession()` (P0)
- Outbound: `config.ts` — `readConfig()` for timeout (P0)
- External: Claude CLI — subprocess via `execFile` (P0)

##### Service Interface

```typescript
function executePrompt(
  projectPath: string,
  session: SessionState,
  promptText: string,
): Promise<{ output: string }>;
```

- Preconditions: Session exists and is in "ready" state
- Postconditions: `promptCount` incremented, status back to "ready", lock released
- Error envelope: Throws `Error` with "Prompt execution failed: ..." prefix

#### mutateSession

| Field        | Detail                                                           |
| ------------ | ---------------------------------------------------------------- |
| Intent       | Read session, apply mutation callback, update timestamp, persist |
| Requirements | 4.1, 4.2, 4.3, 4.4, 2.3                                          |

##### Service Interface

```typescript
function mutateSession(
  projectPath: string,
  sessionName: string,
  mutate: (session: SessionState) => void,
): Promise<void>;
```

- Preconditions: Session must exist in state
- Postconditions: Session mutated, `lastActivityAt` updated, state persisted
- Invariants: No-op if session not found

#### acquireSessionLock

| Field        | Detail                                              |
| ------------ | --------------------------------------------------- |
| Intent       | Acquire single-flight lock, return release function |
| Requirements | 3.1, 3.2, 3.3                                       |

##### Service Interface

```typescript
function acquireSessionLock(
  projectPath: string,
  sessionName: string,
): () => void;
```

- Preconditions: None
- Postconditions: Lock held; returned function releases it
- Error: Throws if lock already held ("Session is busy")

#### isSessionBusy

| Field        | Detail                                        |
| ------------ | --------------------------------------------- |
| Intent       | Non-blocking check if session has active lock |
| Requirements | 3.4                                           |

##### Service Interface

```typescript
function isSessionBusy(projectPath: string, sessionName: string): boolean;
```

- Preconditions: None
- Postconditions: Returns true if lock is held, false otherwise
- Invariants: Pure read, no side effects

### API Layer

#### Prompt API Route

| Field        | Detail                               |
| ------------ | ------------------------------------ |
| Intent       | HTTP interface for prompt submission |
| Requirements | 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7    |

##### API Contract

| Method | Endpoint                                       | Request              | Response                                                    | Errors             |
| ------ | ---------------------------------------------- | -------------------- | ----------------------------------------------------------- | ------------------ |
| POST   | /api/projects/[name]/sessions/[session]/prompt | `{ prompt: string }` | `{ success: true }` (200) + `X-Claude-Output-Length` header | 400, 404, 409, 500 |

## Data Models

### Domain Model

The prompt execution feature operates on existing data models from the session lifecycle feature. No new entities are introduced.

**Key entities used**:

- `SessionState` — status, promptCount, lastActivityAt fields mutated during execution
- `GlobalConfig` — `claudeTimeoutMs` for CLI timeout configuration

**Lock state** (in-memory only):

- `Map<string, Promise<void>>` keyed by `${projectPath}::${sessionName}`
- Not persisted — appropriate for a local tool where locks are transient

### Data Contracts

**API Request Schema** (Zod v4):

```typescript
const runPromptRequestSchema = z.object({
  prompt: z.string().trim().min(1),
});
```

**API Response**:

```typescript
interface RunPromptResponse {
  success: boolean;
  error?: string;
}
```

## Error Handling

### Error Categories and Responses

**User Errors (400)**:

- Missing/empty prompt → `"prompt is required and must be a non-empty string"`

**Not Found (404)**:

- Project not found → `"Project not found"`
- Session not found → `"Session not found"`

**Conflict (409)**:

- Session busy (pre-check) → `{ error: "Session is busy — a prompt is already running", code: "SESSION_BUSY" }`
- Session busy (lock-level) → same message, caught and mapped to 409

**Server Errors (500)**:

- CLI failure → `"Prompt execution failed: <original error>"`
- Timeout → process killed, timeout error propagated

### Recovery Guarantees

The `finally` block in `executePrompt()` ensures:

1. Session status is reset to "ready" (best-effort, errors suppressed)
2. Session lock is always released (guaranteed)

This ordering prevents deadlocks: even if status reset fails, the lock is released.

## Testing Strategy

### Unit Tests

- `acquireSessionLock`: Acquire, check busy, release, re-acquire
- `acquireSessionLock`: Reject when already held
- `isSessionBusy`: True when locked, false when not
- Lock key uniqueness: Different sessions have independent locks

### Integration Tests

- `executePrompt`: Full flow with mocked CLI — verify status transitions, prompt count, lock lifecycle
- `executePrompt`: First prompt vs continuation (no `-c` vs `-c` flag)
- `executePrompt`: Error recovery — CLI failure triggers status reset and lock release
- `executePrompt`: Timeout handling
- `mutateSession`: Read → mutate → persist with timestamp update

### API Tests

- POST valid prompt: 200 with success response and output length header
- POST missing prompt: 400
- POST to missing project: 404
- POST to missing session: 404
- POST to busy session: 409 with SESSION_BUSY code
- POST with CLI failure: 500

## Security Considerations

- **No shell injection**: Uses `execFile` (not `exec`) — prompt text is passed as an argument, not interpolated into a shell command
- **Environment isolation**: `CI=1` prevents interactive behavior; parent env inherited for PATH access
- **Resource limits**: Configurable timeout and 10 MB output buffer cap prevent resource exhaustion
