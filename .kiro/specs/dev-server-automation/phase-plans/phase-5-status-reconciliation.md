# Phase 5: Status Reconciliation

## Objective

Make status queries accurate on demand. A status query should verify current
runtime state, detect stale registry entries, and discover externally started
servers when the project configuration provides enough information.

## Current Risk

- GET status only merges configured servers with the in-memory registry.
- Externally started servers are invisible until the start path is invoked.
- A stale running entry can stay running as long as some process listens on the
  recorded port.
- CC restart loses in-memory registry state.

## Files To Create

- `src/lib/dev-server/reconciliation.ts`
- `src/lib/dev-server/reconciliation.test.ts`

## Files To Update

- `src/app/api/projects/[name]/sessions/[session]/dev-servers/route.ts`
- `src/lib/dev-server/registry.ts`
- `src/lib/dev-server/registry.test.ts`
- `src/lib/dev-server-presets.ts`

## Reconciliation Behavior

For each configured server:

1. If registry says running:
   - Verify the port is still alive.
   - Verify listener ownership.
   - If ownership fails, mark stopped or error with diagnostics.

2. If registry has no running entry:
   - If config has a port scan strategy, scan for an owned listener.
   - If found, create or update a runtime entry with
     `source: "external-adopted"`.
   - If not found, report stopped.

3. If config lacks a scan strategy:
   - Do not guess.
   - Report stopped unless registry has a verified running entry.

## Initial Scan Strategies

Before Phase 7 richer config lands, support known preset defaults:

- `nextjs`: base port `3000`, range size `100`
- `storybook`: base port `6006`, range size `100`

Custom servers require explicit config in Phase 7 before external discovery can
work reliably.

## Red Tests First

1. Externally started preset server is discovered
   - No registry entry.
   - Port in preset range is owned by worktree.
   - GET status reports running, external-adopted.

2. Stale registry entry is stopped
   - Registry says running.
   - Port is dead.
   - Reconciliation transitions to stopped.

3. Wrong-worktree listener invalidates running state
   - Registry says running on port.
   - Ownership service reports conflict.
   - Status is not running for this session.

4. Unknown ownership is not adopted
   - Port listener exists, cwd unknown.
   - Status remains stopped or diagnostic error.

5. Custom server without scan config is not guessed
   - Config has only command/name.
   - No registry entry.
   - Status reports stopped.

## Implementation Steps

1. Implement `reconcileSessionDevServers()`.

2. Add a resolver for scan hints:
   - Known preset by server name.
   - Later, explicit config fields from Phase 7.

3. Call reconciliation in the GET status route before mapping response.

4. Optionally call reconciliation before start/ensure paths to avoid duplicates.

5. Broadcast SSE when reconciliation changes state from running to stopped or
   adopts an external server.

6. Add structured diagnostic output to runtime entries when ownership is
   unknown or conflicting.

## Logging Requirements

Add structured events:

- `dev-server.reconcile.start`
- `dev-server.reconcile.verified`
- `dev-server.reconcile.adopted`
- `dev-server.reconcile.stale_stopped`
- `dev-server.reconcile.conflict`
- `dev-server.reconcile.skipped_no_scan_strategy`

## Acceptance Criteria

- GET status is no longer a passive registry read.
- Preset external servers can be discovered without pressing Start first.
- Running status requires live port and verified ownership.
- Custom servers are not guessed without sufficient configuration.

## Residual Risk

After a CC process restart, reconciliation can only recover servers whose config
has enough scan information. Phase 7 addresses this for custom projects.
