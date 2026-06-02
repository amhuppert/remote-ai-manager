# Phase 1: Stop Safety

## Objective

Make dev server shutdown safe. Command Center must never kill browser clients,
unrelated processes, or a server that cannot be verified as belonging to the
current session worktree.

This phase fixes the most urgent bug in the current lifecycle path: stopping a
server uses a broad port-based kill command that can match client connections,
not only the listening dev server process.

## Current Risk

- `src/lib/dev-server/registry.ts` uses `lsof -ti :${port}` in `killByPort()`.
- That command can return any process with a connection involving the port,
  including browsers connected to the dev server.
- Stop, Stop All, merge cleanup, archive cleanup, and shutdown cleanup all flow
  through this behavior when a process-group kill is insufficient or when CC
  has adopted an externally started server.

## Files To Touch

- `src/lib/dev-server/registry.ts`
- `src/lib/dev-server/registry.test.ts`
- Potentially new test helper under `src/lib/dev-server/test-helpers.ts`

## Red Tests First

Add tests before changing implementation.

1. Listener-only PID selection
   - Arrange a fake port inspection dependency that returns one listener PID and
     one client PID.
   - Stop must only signal the listener PID.

2. Client connection is ignored
   - Simulate `lsof -ti :3000` style output containing a browser/client PID.
   - Assert the new implementation does not kill it.

3. Unknown ownership does not kill
   - Simulate a listener PID whose cwd cannot be resolved.
   - Assert stop does not send `SIGTERM` or `SIGKILL`.
   - Assert the entry records a warning/error state with diagnostic output.

4. Verified session-owned listener is killed
   - Simulate a listener PID with cwd equal to the session worktree.
   - Assert `SIGTERM` is sent, then `SIGKILL` only if the process remains alive.

## Implementation Steps

1. Introduce injectable process-inspection dependencies in the registry factory.
   Keep production defaults in the registry module for now.

2. Replace `killByPort(port)` with a safer function:

   ```ts
   killListeningProcessForPort({
     port,
     worktreePath,
     allowedCwd,
   })
   ```

3. In production, discover listener PIDs only:
   - Linux: use `ss -tlnp sport = :<port>` and parse listener PIDs.
   - Fallback: use `lsof -ti tcp:<port> -sTCP:LISTEN`.
   - Do not use `lsof -ti :<port>`.

4. Before signaling a PID, resolve its cwd and verify ownership:
   - cwd equals the worktree path, or
   - cwd is inside the worktree path, or
   - cwd equals or is inside an explicitly configured app cwd.

5. If no verified listener is found:
   - Do not kill anything.
   - Log `dev-server.stop.unverified_owner`.
   - Preserve enough error detail for UI/API diagnostics.

6. Keep process-group killing for CC-started servers, but apply verified
   listener killing as the fallback path.

## Logging Requirements

Use `createLogger("dev-server")` and add structured events:

- `dev-server.stop.listener_lookup`
- `dev-server.stop.listener_verified`
- `dev-server.stop.unverified_owner`
- `dev-server.stop.kill_signal`
- `dev-server.stop.kill_skipped`

Read `.kiro/steering/logs.md` before implementation to confirm event naming
and field conventions.

## Acceptance Criteria

- Stopping a dev server never signals client-only PIDs.
- Stopping an adopted server only signals a listener verified to belong to the
  session worktree or configured app directory.
- If ownership cannot be verified, CC reports the problem instead of killing.
- Existing CC-started server stop behavior still works.
- Tests fail before the implementation and pass after it.

## Residual Risk

Process cwd inspection can fail on some platforms or permission configurations.
The safe behavior is to refuse to kill and surface the diagnostic.
