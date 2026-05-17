# Phase 3: External Server Discovery

## Objective

Correctly reuse dev servers that were started outside Command Center, including
servers running on non-base ports. CC should prefer an existing owned server
before choosing a free port and starting a duplicate.

## Current Risk

- Generated scripts check the base port first.
- If the base port is free, CC starts a new server immediately.
- If the base port conflicts, the scan returns the first free port or owned port
  encountered.
- A correct-worktree server on a later port can be missed, causing duplicate
  dev servers in the same worktree.

## Files To Create

- `src/lib/dev-server-port-selection.ts`
- `src/lib/dev-server-port-selection.test.ts`

## Files To Update

- `src/lib/dev-server-presets.ts`
- `src/lib/dev-server-presets.test.ts`
- `.cc/dev-servers/_helpers.sh`
- `.cc/dev-servers/nextjs.sh`
- `.cc/dev-servers/storybook.sh`
- `docs/project-configuration.md`
- `plugins/command-center/command-center/skills/setup/references/dev-servers.md`

## Selection Algorithm

Use a two-pass algorithm.

1. Scan the configured range for owned listeners.
   - If any owned port is found, reuse it.
   - Prefer the lowest owned port in the range.

2. If no owned listener exists, scan for the first available port.
   - Use the base port first.
   - Then scan upward.

3. If no port is available, return an actionable error.

This avoids duplicate servers when an externally started server already exists
for the same worktree.

## Red Tests First

1. Base free, owned server later
   - Base port `3000` available.
   - Port `3004` owned by this worktree.
   - Expected selection: `3004`, source `external-adopted`.

2. Early free port before owned server
   - Port `3000` conflicts.
   - Port `3001` available.
   - Port `3004` owned.
   - Expected selection: `3004`, not `3001`.

3. No owned server, first free selected
   - Port `3000` conflicts.
   - Port `3001` available.
   - Expected selection: `3001`.

4. Unknown ownership is not available
   - Port `3000` has listener with unknown cwd.
   - Expected: keep scanning, do not select `3000`.

5. No ports available
   - Entire range conflicts or unknown.
   - Expected: error with diagnostic list.

## Implementation Steps

1. Add `selectDevServerPort()` in TypeScript using the Phase 2 ownership
   service.

2. Update generated helper script behavior to match the same two-pass logic:
   - Add `find_owned_port`.
   - Change `find_available_port` to only find free ports.
   - In generated preset scripts, call owned scan before available scan.

3. Regenerate checked-in `.cc/dev-servers` scripts for this repository.

4. Update docs and setup skill reference templates.

5. Add tests that execute helper logic where feasible, not only string
   assertions.

## Logging Requirements

Add structured events where TypeScript selection is used:

- `dev-server.port_selection.start`
- `dev-server.port_selection.owned_found`
- `dev-server.port_selection.available_found`
- `dev-server.port_selection.exhausted`

## Acceptance Criteria

- CC does not start a duplicate server when an owned external server exists
  anywhere in the configured scan range.
- Generated scripts and TypeScript selection use the same ordering semantics.
- Unknown ownership never causes a port to be selected as safe.
- Preset docs explain that owned ports are preferred over available ports.

## Residual Risk

The shell implementation remains limited by platform tooling. Later phases move
more of the start flow into CC-managed TypeScript services.
