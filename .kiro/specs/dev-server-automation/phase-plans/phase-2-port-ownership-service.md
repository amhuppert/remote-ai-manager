# Phase 2: Port Ownership Service

## Objective

Move port ownership detection out of generated shell scripts and ad hoc registry
helpers into a tested TypeScript service. The service becomes the canonical way
to answer: "Does this port belong to this session worktree?"

## Current Risk

- Ownership logic exists primarily in generated shell scripts.
- Registry liveness only checks whether a port accepts TCP connections.
- Registry stop logic does not have a reusable ownership model.
- Shell helper tests mostly assert generated text, not behavior.

## Files To Create

- `src/lib/dev-server-port-ownership.ts`
- `src/lib/dev-server-port-ownership.test.ts`

## Files To Update

- `src/lib/dev-server-registry.ts`
- `src/lib/dev-server-liveness.ts`
- `src/lib/dev-server-registry.test.ts`
- `src/lib/dev-server-liveness.test.ts`

## Service Shape

Create a small dependency-injected service:

```ts
export interface PortOwnershipDeps {
  listListeningPids(port: number): Promise<number[]>;
  getProcessCwd(pid: number): Promise<string | null>;
  realpath(path: string): Promise<string | null>;
}

export interface PortOwnershipInput {
  port: number;
  worktreePath: string;
  allowedCwd?: string | null;
}

export type PortOwnershipResult =
  | { status: "available" }
  | { status: "owned"; pid: number; cwd: string }
  | { status: "conflict"; pid: number; cwd: string | null }
  | { status: "unknown"; reason: string };
```

## Red Tests First

1. Available port
   - `listListeningPids()` returns empty.
   - Result is `available`.

2. Exact worktree ownership
   - Listener cwd realpath equals worktree realpath.
   - Result is `owned`.

3. Descendant worktree ownership
   - Listener cwd is a child directory under the worktree.
   - Result is `owned`.

4. Configured app cwd ownership
   - Listener cwd is under `allowedCwd`.
   - Result is `owned`.

5. Different worktree conflict
   - Listener cwd resolves outside the session worktree.
   - Result is `conflict`.

6. Unknown cwd
   - Listener PID exists but cwd cannot be resolved.
   - Result is `unknown`, not `available`.

7. Symlink normalization
   - Worktree and process cwd point to the same real path through different
     symlink paths.
   - Result is `owned`.

## Implementation Steps

1. Implement pure path ownership helpers:
   - `normalizePath()`
   - `isSameOrDescendantPath(candidate, parent)`
   - `isOwnedProcessCwd(candidate, worktreePath, allowedCwd)`

2. Implement production PID lookup:
   - Prefer `ss` on Linux.
   - Fallback to `lsof -ti tcp:<port> -sTCP:LISTEN`.
   - Return an empty array only when the port truly has no listener.
   - Return `unknown` when inspection tooling fails in a way that cannot prove
     availability.

3. Implement production cwd lookup:
   - Linux: `/proc/<pid>/cwd`.
   - macOS: `lsof -a -p <pid> -d cwd -Fn`.

4. Wire registry stop fallback to this service.

5. Wire liveness to use ownership-aware checks where worktree context is
   available.

6. Keep existing shell scripts unchanged in this phase, except tests may begin
   documenting their limitations.

## Logging Requirements

Use structured dev-server events:

- `dev-server.ownership.lookup`
- `dev-server.ownership.available`
- `dev-server.ownership.owned`
- `dev-server.ownership.conflict`
- `dev-server.ownership.unknown`

## Acceptance Criteria

- Ownership semantics are tested in TypeScript.
- Registry stop no longer owns custom cwd/path logic directly.
- Liveness can distinguish "port alive for this worktree" from "port alive".
- Unknown ownership is never treated as available or safe to kill.

## Residual Risk

Some externally started servers may have listener processes whose cwd is not
inside the worktree, even though the command was started from the worktree. Those
cases should report `unknown` or `conflict` until the project config supplies an
explicit app cwd or status strategy.
