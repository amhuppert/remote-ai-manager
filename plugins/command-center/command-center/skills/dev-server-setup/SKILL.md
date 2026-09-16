---
name: dev-server-setup
description: >-
  Configure Command Center devServers entries: framework commands, assigned
  ports, and monorepo working directories. For init scripts or validation
  registration, use project-setup.
---

# CC Dev Server Setup

Add or update `devServers` entries in `CommandCenter.json` so Command Center can start, monitor, and stop dev servers for each session worktree.

**Outcome:** valid dev-server entries that preserve unrelated configuration and honor CC-assigned ports.

A request to add or configure a server authorizes the local configuration edit. If the user asks only for a proposal, present it and stop. Ask through `cctl ask` only when a missing choice materially affects the result; follow its end-turn protocol. Existing authorization does not need reconfirmation.

CC owns port assignment. CC scans a port range, picks an owned-or-free port, injects it via `$CC_ASSIGNED_PORT` (and `$PORT`), and waits for TCP readiness. No shell helper scripts are required.

## Step 1: Detect Frameworks

Inspect the project before asking about facts its configuration can answer.

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

If monorepo detected, list the candidate app directories (e.g., `apps/web`, `apps/admin`) by reading their `package.json` files. Use the directories named in the request or existing configuration; ask through `cctl ask` if several apps remain plausible targets. Each subdirectory entry needs a `cwd` field.

### 1.4 Existing Configuration

Check for an existing `CommandCenter.json`:
- If absent, the proposal will create one with only a `devServers` field. Recommend running `project-setup` separately if the project also needs an init script or registered validation commands.
- If present, read it. Preserve `initScriptPath`, `validation`, and every other field untouched. Only add or merge into the `devServers` array.

## Step 2: Load Reference

Load `references/dev-servers.md` for the full schema, examples, and lifecycle details. Load [the top-level configuration reference](../project-setup/references/commandcenter-json.md) only if you need to refresh the top-level shape (usually unnecessary — this skill only touches `devServers`).

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

## Step 4: Resolve Material Choices

Use the request and detected project conventions to select names, commands, ranges, and `cwd`. If a consequential choice remains unresolved, present the concrete proposed entries through `cctl ask`, then end the turn until the answer arrives. Otherwise continue the authorized edit.

## Step 5: Write

Within the authorized scope:

1. If `CommandCenter.json` does not exist, create it with just `{ "devServers": [...] }` plus any preserved fields.
2. If it exists, merge the new `devServers` entries into the existing object, preserving every other field.
3. Write the file.

No shell scripts are written — CC-assigned ports do not need any helper files.

## Step 6: Verify

After writing:
1. Read back `CommandCenter.json` to confirm the JSON is valid and the array is correct.
2. Summarize the entries that were added or modified.
3. If startup verification is in scope, run `cctl dev ensure <name>` and use its returned session URL; inspect the log on failure.
4. Report which entries changed and whether startup was verified. Configuration is complete when the JSON and command/cwd/port contract are valid; a claimed working server also requires a successful start receipt.

## Edge Cases

**Custom server with no framework:** Read its scripts or launcher for the command and port support; ask only when those cannot be inferred. Default `range` is `100`. If the server only reads `PORT` (no flag), the command can omit the flag — CC always exports `PORT=$CC_ASSIGNED_PORT`.

**Framework that auto-picks its port and cannot accept a flag:** CC requires the framework to honor either `$CC_ASSIGNED_PORT` (via a flag or alias) or `$PORT` (via env). If the framework does neither, surface this as a blocker. Suggest opening an upstream issue or wrapping the framework with a small launcher that respects `$PORT`.
