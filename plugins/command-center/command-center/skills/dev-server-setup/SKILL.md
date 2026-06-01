---
name: dev-server-setup
description: >-
  This skill should be used when the user wants to add, modify, or
  configure dev servers in Command Center: writing `devServers` entries
  in `CommandCenter.json`, picking a base port, choosing a `cwd` for a
  monorepo subdirectory, or wiring a custom server into CC. Triggered by
  "add dev server", "set up dev server for CC", "configure dev servers",
  "wire Next.js into CC", "wire Storybook into CC", "add CC dev server
  entry", or "make Command Center manage <framework>". For broader
  project setup (init script, pre-merge, test runner config), use the
  `project-setup` skill instead.
---

# CC Dev Server Setup

Add or update `devServers` entries in `CommandCenter.json` so Command Center can start, monitor, and stop dev servers for each session worktree.

**Workflow: Detect → Propose entries → Approve → Write**

Do NOT write any files until the user explicitly approves.

CC owns port assignment. CC scans a port range, picks an owned-or-free port, injects it via `$CC_ASSIGNED_PORT` (and `$PORT`), and waits for TCP readiness. No shell helper scripts are required.

## Step 1: Detect Frameworks

Run silently. Do not ask questions during detection.

### 1.1 Read package.json

Read `package.json` (and any `apps/*/package.json` files for monorepos) and extract `dependencies` and `devDependencies`.

### 1.2 Detection Table

| Detected dependency | Suggested entry name | Suggested base port | Suggested command |
|---|---|---|---|
| `next` | `nextjs` | `3000` | `npx next dev --port $CC_ASSIGNED_PORT` |
| `storybook` or `@storybook/*` | `storybook` | `6006` | `npx storybook dev --port $CC_ASSIGNED_PORT --no-open` |
| `vite` (app, not a Vitest-only dep) | `vite` | `5173` | `npx vite --port $CC_ASSIGNED_PORT` |
| Custom server (`server.js`, `server.ts`, etc.) | user-chosen | user-chosen | `node server.js --port $CC_ASSIGNED_PORT` |

If no frameworks are detected, ask the user whether they have a custom server to wire up. If not, exit with a note that no `devServers` entries are needed.

### 1.3 Monorepo Detection

Check for:
- `workspaces` field in `package.json` (npm/yarn workspaces)
- `pnpm-workspace.yaml` (pnpm workspaces)
- `turbo.json` (Turborepo)
- `nx.json` (Nx)

If monorepo detected, list the candidate app directories (e.g., `apps/web`, `apps/admin`) by reading their `package.json` files. Use `AskUserQuestion` to confirm which subdirectory(ies) should get dev server entries — each entry will need a `cwd` field.

### 1.4 Existing Configuration

Check for an existing `CommandCenter.json`:
- If absent, the proposal will create one with only a `devServers` field. Recommend running `project-setup` separately if the project also needs an init script or pre-merge command.
- If present, read it. Preserve `initScriptPath`, `preMergeCommand`, and any other fields untouched. Only add or merge into the `devServers` array.

## Step 2: Load Reference

Load `references/dev-servers.md` for the full schema, examples, and lifecycle details. Load `references/commandcenter-json.md` only if you need to refresh the top-level shape (usually unnecessary — this skill only touches `devServers`).

## Step 3: Propose Entries

Present the analysis and a draft `devServers` array.

### 3.1 Detection Summary

Show a table of detected frameworks and the proposed entry for each:

| Framework | Entry name | Command | Base port | `cwd` |
|---|---|---|---|---|

### 3.2 Proposed `devServers` Array

Show the full draft array in a fenced JSON block. Each entry uses:

```json
{
  "name": "<unique-id>",
  "command": "<command using $CC_ASSIGNED_PORT>",
  "port": { "base": <base-port>, "range": 100 }
}
```

For monorepo entries, include `"cwd": "<subdir>"`.

If the project already has a `devServers` array, show:
- The merged result (existing + new entries).
- A diff or callout for any entries you are modifying or replacing.

### 3.3 Conflict Handling

- Entry names must be unique. If a name collision exists in the existing config, suggest a suffix (e.g., `nextjs-web`, `nextjs-admin`) or ask the user.
- Port ranges should not overlap between entries. If two frameworks want the same base port (rare), offer non-overlapping ranges (e.g., `base: 3000, range: 50` and `base: 3050, range: 50`).

## Step 4: Get Approval

Use `AskUserQuestion` to confirm. Offer:
- **Approve all** — write the merged `CommandCenter.json`.
- **Approve with changes** — user adjusts names, ports, ranges, commands, or `cwd` before writing.

## Step 5: Write

After approval:

1. If `CommandCenter.json` does not exist, create it with just `{ "devServers": [...] }` plus any preserved fields.
2. If it exists, merge the new `devServers` entries into the existing object, preserving every other field.
3. Write the file using the Write tool.

No shell scripts are written — CC-assigned ports do not need any helper files.

## Step 6: Verify

After writing:
1. Read back `CommandCenter.json` to confirm the JSON is valid and the array is correct.
2. Summarize the entries that were added or modified.
3. Remind the user to commit the change.
4. Remind the user that the dev server can be started from the session UI (Command Center will pick a port in the configured range the first time it is launched).

## Edge Cases

**Custom server with no framework:** Ask the user for the command and a base port. Default `range` is `100`. If the server only reads `PORT` (no flag), the command can omit the flag — CC always exports `PORT=$CC_ASSIGNED_PORT`.

**Framework that auto-picks its port and cannot accept a flag:** CC requires the framework to honor either `$CC_ASSIGNED_PORT` (via a flag or alias) or `$PORT` (via env). If the framework does neither, surface this as a blocker. Suggest opening an upstream issue or wrapping the framework with a small launcher that respects `$PORT`.
