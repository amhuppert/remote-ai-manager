---
name: cc-rebuild-restart
description: Rebuild and restart the live main-worktree Command Center server
  when the user explicitly requests production maintenance. Uses the bundled
  build/restart scripts; session dev servers use cctl dev instead.
---

# Rebuild & Restart Command Center

Rebuilds the production CC bundle in the **main worktree** and restarts the live server so it serves the freshly built code.

## Authorization and target

This workflow writes to the main worktree, runs installation/build steps, and restarts the managing server. Use it only when the user's request explicitly authorizes that production operation and leaving the assigned worktree. Existing authorization satisfies this boundary; ordinary feature implementation or verification does not. Before running, establish the intended checkout, port, and build configuration. The build inherits the caller's environment; only the restarted server gets the script's sanitized environment.

An in-place build can replace live `.next` files while the old server is still serving them. A failed build leaves the server process running but does not guarantee the old app remains healthy. Include that concrete downtime risk in the maintenance handoff.

## The core problem this solves

The Claude session invoking this skill runs as a **child of the very CC server being restarted**:

```
bun run start  ─┐
 └─ next-server  ┤  ← the CC server (holds the port)
     └─ claude   ┤  ← the session running THIS skill
         └─ bash ┘  ← where the skill's commands run
```

If the process that kills and restarts the server lived anywhere in that tree, killing the server would kill the restarter too — and the server would never come back. So the restarter is launched as a **fully-detached daemon** (its own session, reparented to launchd) via `spawn({ detached: true }).unref()` — the macOS-safe stand-in for `setsid` (macOS ships no `setsid`). Once detached, the daemon's only ancestor is launchd, so it survives the kill it performs and then brings the server back up.

The build/restart gating, process discovery, signal handling, and detachment are all deterministic, so they live in scripts rather than in agent free-text (per the Agent-Offloading Principle).

## How to run it

Invoke the entry script. It does everything: install → build → (on success only) schedule the detached restart.

```bash
bash .claude/skills/cc-rebuild-restart/scripts/rebuild-and-restart.sh
```

What happens:

1. `bun install` in the main worktree.
2. `bun run build`.
3. **Only if the build succeeds**, it launches the detached restart daemon and returns. The daemon waits a few seconds (so this turn and its SSE can flush), then:
   - kills the running main-worktree server (the listener on the detected port **and** any leaked `next-server` orphans whose cwd is the main root), and
   - starts a fresh `bun run start` — detached, with a **sanitized env** (strips `CC_CONFIG_DIR`/`CC_ENV` so the production server never inherits a worktree's config/database).

If `bun install` or `bun run build` fails, the script exits non-zero and **nothing is restarted** — report the build failure.

### Tell the user what to expect

Because the server is the parent of this session, **the CC UI will briefly disconnect when the restart fires, then reconnect** once the new server is listening. Say this in your final message before the restart lands. Don't try to push a notification after scheduling the restart — that path goes through the server you're about to kill.

## Preview the restart after a real install and build

The `CC_RESTART_DRY_RUN` option simulates only process termination/restart. It still writes dependency/build artifacts in the main worktree and can affect live `.next` files, so it requires the same checkout/build authorization:

```bash
CC_RESTART_DRY_RUN=1 bash .claude/skills/cc-rebuild-restart/scripts/rebuild-and-restart.sh
# then read the plan:
cat /tmp/command-center-restart.log
```

(Note: a dry run still runs `bun install` + `bun run build`; only the kill/restart is simulated.)

## Verifying the restart

The daemon logs every step. After scheduling:

```bash
cat /tmp/command-center-restart.log        # daemon: kill targets, SUCCESS/WARNING line
cat /tmp/command-center-server.log         # the restarted server's own stdout/stderr
lsof -ti tcp:<reported-port> -sTCP:LISTEN  # use the port printed by the script
```

The daemon's `SUCCESS` line proves that a process is listening on the port. Verify the returned application/build identity and a working page or health response before claiming the deployment is healthy.

## Knobs (env overrides)

| Var | Default | Purpose |
|---|---|---|
| `CC_PORT` | detected, else `3000` | Force the server port. |
| `CC_RESTART_DELAY_MS` | `5000` | Grace period before the kill (lets the triggering turn flush). |
| `CC_RESTART_DRY_RUN` | `0` | `1` = preview plan, don't kill/restart. |
| `CC_RESTART_LOG` | `/tmp/command-center-restart.log` | Daemon log path. |
| `CC_SERVER_LOG` | `/tmp/command-center-server.log` | Restarted-server log path. |

## Files

- `scripts/rebuild-and-restart.sh` — entry point: resolves the main worktree, installs, builds, gates, and launches the detached daemon.
- `scripts/restart-server.ts` — the detached daemon: discovers the server PIDs (by port + by main-root cwd), kills them (SIGTERM → SIGKILL), waits for the port to free, then relaunches a fresh detached server and confirms it is listening.

## Notes & boundaries

- This skill deliberately operates on the **main worktree**. It never touches session-worktree dev servers: those run with their worktree as cwd, while the kill logic only targets processes whose cwd is the main root.
- It signals specific server PIDs rather than process groups. Do not infer that every active agent turn survives or reconnects from that alone; report observed post-restart state.
