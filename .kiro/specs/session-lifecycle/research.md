# Research & Design Decisions

## Summary

- **Feature**: `session-lifecycle`
- **Discovery Scope**: Extension (existing system — fully implemented)
- **Key Findings**:
  - Session lifecycle is fully implemented in `src/lib/sessions.ts` with `createSession` and `deleteSession` functions
  - State persistence uses atomic write-to-temp-then-rename pattern in `src/lib/state.ts`
  - API routes in `src/app/api/projects/[name]/sessions/route.ts` expose GET/POST/DELETE endpoints

## Research Log

### Existing Architecture Analysis

- **Context**: Session lifecycle is already implemented; need to map the existing implementation against requirements.
- **Sources Consulted**: `src/lib/sessions.ts`, `src/lib/state.ts`, `src/lib/config.ts`, `src/lib/schemas.ts`, `src/types/index.ts`, API routes
- **Findings**:
  - `createSession()` handles validation, worktree creation, init script execution, rollback, and state persistence in a single function
  - `deleteSession()` handles worktree removal and state cleanup
  - `sanitizeBranchName()` and `validateSessionName()` are private helper functions within `sessions.ts`
  - Per-repo config (`ClaudeSessionManager.json`) defines optional `initScriptPath`
  - State is managed through `readState()`/`writeState()` in `state.ts` with atomic writes
- **Implications**: Design documents an existing, stable architecture. No new components needed.

### Git Worktree Strategy

- **Context**: Understanding how worktrees provide session isolation.
- **Findings**:
  - Worktrees are created at `<projectRoot>/.worktrees/<sanitized-name>`
  - Each worktree gets a dedicated branch `csm/<sanitized-name>` branched from `main`
  - Git CLI is invoked via `execFile` (promisified) — no git library dependency
  - Worktree removal uses `git worktree remove --force` with filesystem fallback
- **Implications**: Lightweight, dependency-free approach. Relies on git CLI availability on the host.

### Rollback Strategy

- **Context**: Understanding failure recovery during session creation.
- **Findings**:
  - Try/catch wraps the worktree+init-script block
  - Rollback removes worktree (git then filesystem fallback), then deletes branch
  - Cleanup errors are suppressed; original error is re-thrown
  - State is only written after successful creation (no partial state)
- **Implications**: Two-phase cleanup (worktree then branch) provides defense-in-depth.

## Architecture Pattern Evaluation

| Option                      | Description                                                                           | Strengths                                      | Risks / Limitations                  | Notes                                       |
| --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Current monolithic function | Single `createSession` function with inline validation, git ops, and state management | Simple, easy to follow, all logic in one place | Harder to unit test individual steps | Matches project's flat lib pattern          |
| Service layer extraction    | Separate validation, git ops, and state into services                                 | Better testability, separation of concerns     | Over-engineering for current scale   | Not aligned with project's minimal approach |

## Design Decisions

### Decision: Keep Monolithic Session Functions

- **Context**: Whether to refactor `createSession`/`deleteSession` into smaller services
- **Alternatives Considered**:
  1. Extract GitService, ValidationService, StateService
  2. Keep current monolithic functions
- **Selected Approach**: Keep current monolithic functions
- **Rationale**: Aligns with project's deliberately minimal stack and flat lib structure. Functions are focused and readable at current size.
- **Trade-offs**: Less granular unit testing, but integration tests cover the full flow effectively.

### Decision: Atomic State Writes for Crash Safety

- **Context**: How to persist session state without corruption
- **Selected Approach**: Write-to-temp-then-rename pattern (already implemented in `state.ts`)
- **Rationale**: Rename is atomic on POSIX systems, preventing partial writes from corrupting the state file.

## Risks & Mitigations

- **Git CLI dependency** — Requires `git` to be installed and accessible in PATH. Mitigation: document as a system requirement.
- **Init script security** — Arbitrary script execution with elevated environment variables. Mitigation: 60-second timeout, execution only from explicit config.
- **Concurrent state writes** — Multiple API requests could race on state file. Mitigation: acceptable for local-first single-user tool; no additional locking needed.

## References

- [Git worktree documentation](https://git-scm.com/docs/git-worktree) — core git worktree commands used
- Node.js `child_process.execFile` — subprocess spawning for git and init scripts
