# Phase 4: Runtime Source And Cleanup

## Objective

Track whether a running dev server was started by Command Center or adopted
from an external process, while allowing automatic shutdown for both sources.

Policy: automatic shutdown of adopted servers is allowed. The safety boundary is
verified worktree ownership, not source.

## Current Risk

- CC does not expose whether a server was CC-started or externally adopted.
- Cleanup behavior is source-blind and ownership-blind.
- Users and agents cannot tell whether a server was reused or spawned.

## Files To Update

- `src/lib/dev-server/schemas.ts`
- `src/lib/dev-server/registry.ts`
- `src/lib/dev-server/registry.test.ts`
- `src/lib/dev-server/liveness.ts`
- `src/lib/dev-server/liveness.test.ts`
- `src/app/api/projects/[name]/sessions/[session]/dev-servers/route.ts`
- `src/components/DevServerDrawer.tsx`
- `src/components/DevServerDrawer.stories.tsx`

## Schema Additions

Add runtime fields:

```ts
source: "cc-started" | "external-adopted" | null
ownedByThisSession: boolean
worktreePath: string | null
ownerPid: number | null
```

Notes:

- `source` is descriptive, not a cleanup policy gate.
- `ownedByThisSession` is the safety gate.
- `ownerPid` is best-effort diagnostic data. It may be null.

## Red Tests First

1. CC-started source
   - Starting a new process records `source: "cc-started"`.

2. External adopted source
   - Reusing an existing owned listener records `source: "external-adopted"`.

3. Automatic cleanup includes adopted servers
   - `stopAllForSession()` includes adopted entries.
   - Stop only signals verified owned listener PIDs.

4. Cleanup refuses unowned entries
   - If ownership verification later fails, automatic cleanup does not kill.
   - The entry records a warning/error diagnostic.

5. API response exposes source and ownership
   - GET status includes source, ownership, worktree path, and owner PID.

## Implementation Steps

1. Extend Zod schemas and exported types.

2. Update registry entry creation:
   - New process: `source = "cc-started"`.
   - Reused owned listener: `source = "external-adopted"`.

3. Store `worktreePath` on each runtime entry.

4. Store `ownerPid` when the ownership service can identify one.

5. Update stop and cleanup:
   - Stop both CC-started and externally adopted servers.
   - Before port-based stop, verify ownership using the Phase 2 service.
   - If verification fails, skip kill and log.

6. Update UI to optionally display a subtle "adopted" diagnostic in detailed
   output, not as a primary status.

## Logging Requirements

Add structured events:

- `dev-server.source.cc_started`
- `dev-server.source.external_adopted`
- `dev-server.cleanup.stop_adopted`
- `dev-server.cleanup.ownership_failed`

## Acceptance Criteria

- Runtime API clearly distinguishes source and ownership.
- Automatic cleanup stops adopted servers when ownership is verified.
- Automatic cleanup does not kill unverified or conflicting listeners.
- UI and stories handle the new fields.

## Residual Risk

An externally adopted server may have multiple listener PIDs. The first
implementation should stop all verified owned listener PIDs for that port.
