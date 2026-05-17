---
name: setup
description: >-
  This skill should be used when the user wants to configure a project for
  Command Center, set up CommandCenter.json, create worktree init scripts,
  create pre-merge validation scripts, configure dev servers for CC, or
  optimize test runner output for AI agents. Triggered by "set up CC",
  "configure for command center", "create CommandCenter.json",
  "add CC config", "set up worktree init", "set up pre-merge validation",
  "configure dev servers for CC", "initialize project for CC",
  "CC project setup", or "set up command center config".
---

# CC Project Setup

Analyze the target project's tech stack and generate a complete Command Center configuration: `CommandCenter.json`, worktree init script, pre-merge validation script, dev server scripts, and AI-optimal test runner configuration.

**Workflow: Analyze → Propose → Approve → Write**

Do NOT write any files until the user explicitly approves.

## Step 1: Analyze the Project

Run all detection steps silently. Do not ask questions during analysis.

### 1.1 Package Manager

Check for lock files at the project root (in order of precedence):

| Lock File | Package Manager | Install Command |
|---|---|---|
| `bun.lockb` or `bun.lock` | bun | `bun install` |
| `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile` |
| `yarn.lock` | yarn | `yarn install --frozen-lockfile` (or `--immutable` if `.yarnrc.yml` exists) |
| `package-lock.json` | npm | `npm ci` |
| `package.json` only | npm (fallback) | `npm install` |

If no `package.json` exists, this is not a JS/TS project — skip to Step 2 with a minimal config.

### 1.2 Read package.json

Read `package.json` and extract `dependencies` and `devDependencies`.

### 1.3 Frameworks (from dependencies)

| Dependency | Framework | Command Template | Base Port |
|---|---|---|---|
| `next` | Next.js | `npx next dev --port $CC_ASSIGNED_PORT` | 3000 |
| `storybook` or `@storybook/*` | Storybook | `npx storybook dev --port $CC_ASSIGNED_PORT --no-open` | 6006 |

These use the `cc-assigned` port strategy — CC picks the port and injects it via `$CC_ASSIGNED_PORT`. No shell helpers are written. See `references/dev-servers.md` for the legacy `stdout-cc-port` strategy if a project requires custom startup logic.

### 1.4 Tools (from dependencies + devDependencies)

Check for the presence of:
- `eslint` — linter
- `prettier` — formatter
- `typescript` — type checker (also check for `tsconfig.json`)
- `vitest` — test runner
- `jest` — test runner (alternative to vitest)
- `@prisma/client` or `prisma` — ORM (init script needs `prisma generate`)

### 1.5 Existing Configuration

Check for:
- `CommandCenter.json` — if it exists, read it (offer to update, never silently overwrite)
- `scripts/worktree-init.sh` — existing init script
- `scripts/pre-merge-validate.sh` — existing pre-merge script
- `.cc/dev-servers/` — existing dev server scripts

### 1.6 Test Runner Config

Check for `vitest.config.ts`, `vitest.config.js`, `jest.config.ts`, `jest.config.js`:
- If found, check whether it already contains `CLAUDECODE` detection
- If it does, skip the test config modification proposal

### 1.7 Monorepo Detection

Check for:
- `workspaces` field in `package.json` (npm/yarn workspaces)
- `pnpm-workspace.yaml` (pnpm workspaces)
- `turbo.json` (Turborepo)
- `nx.json` (Nx)

If monorepo detected, note it in the analysis. For dev servers, you will need to ask the user which subdirectory contains the main application.

## Step 2: Propose Configuration

Present the analysis results and proposed files to the user.

### 2.1 Analysis Summary

Show a table:

```
## Project Analysis

| Aspect | Detected |
|--------|----------|
| Package manager | bun |
| Frameworks | Next.js, Storybook |
| Linter | ESLint |
| Formatter | Prettier |
| Type checker | TypeScript |
| Test runner | Vitest |
| ORM | Prisma |
| Monorepo | No |
| Existing CC config | No |
```

### 2.2 Proposed Files

Show each file that will be created, with full content in fenced code blocks. The files to generate:

**Always:**
- `CommandCenter.json` — with fields set based on what was detected

**If package.json exists:**
- `scripts/worktree-init.sh` — install command for the detected package manager, plus any code generation steps

**If any of eslint, prettier, typescript, vitest, or jest detected:**
- `scripts/pre-merge-validate.sh` — validation pipeline with only the detected tools, in correct order (formatters → checkers → tests)

**If frameworks detected:**
- Add a `cc-assigned` entry per framework to `CommandCenter.json`. No shell scripts are written for the default presets.

**If vitest/jest detected AND config doesn't already have CLAUDECODE detection:**
- Proposed modification to the test runner config file

### 2.3 Generation Rules

**CommandCenter.json:**
```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    {
      "name": "<framework-id>",
      "command": "<framework command using $CC_ASSIGNED_PORT>",
      "port": { "strategy": "cc-assigned", "base": <base-port>, "range": 100 }
    }
  ]
}
```
- Set `initScriptPath` to `"scripts/worktree-init.sh"` if package.json exists, otherwise `null`
- Set `preMergeCommand` to `"scripts/pre-merge-validate.sh"` if validation tools detected, otherwise omit
- Set `devServers` array with one `cc-assigned` entry per detected framework using the commands from §1.3, otherwise omit
- For monorepos, also set `cwd` on the entry to the subdirectory (e.g. `"cwd": "apps/web"`)

**Init script:** Use the template from `references/init-script.md` matching the detected package manager. Add prisma generate if prisma detected. Add `.env.example` copy if the file exists.

**Pre-merge script:** Use the template from `references/pre-merge-script.md`. Include only the tools that were detected. Order: Prettier → ESLint → TypeScript → Vitest/Jest.

**Dev server entries:** See `references/dev-servers.md` for the full field reference and the legacy `stdout-cc-port` flow. The default presets do not write shell scripts.

**Test runner config:** Use the pattern from `references/ai-test-config.md`. For existing config files, show the modification as an addition to the existing config, not a replacement.

### 2.4 Monorepo Handling

If a monorepo was detected:
- Ask the user which subdirectory contains the main application (e.g., `apps/web`)
- Set `cwd` on each dev server entry to that subdirectory — CC will spawn the command there and scope port-ownership checks to that directory
- The init script runs at the repository root (workspace-level install handles all packages)

## Step 3: Get Approval

Use `AskUserQuestion` to ask the user to approve the proposed configuration. Offer these options:
- **Approve all** — write everything as proposed
- **Approve with changes** — user specifies modifications before writing

If the user wants changes, incorporate them and show the updated proposal before writing.

## Step 4: Write Files

After approval:

1. Create directories: `mkdir -p scripts` (and `.cc/dev-servers` only if the user opts in to the legacy `stdout-cc-port` strategy)
2. Write each approved file using the Write tool
3. Set executable permissions on shell scripts that were written: `chmod +x scripts/*.sh` (and `.cc/dev-servers/*.sh` if applicable)
4. For test runner config modifications: use the Edit tool to add the AI detection block to the existing config file

## Step 5: Verify

After writing:
1. Read back each created file to confirm content is correct
2. List the files with permissions to verify they are executable
3. Present a summary of what was created

## Step 6: Summary

Present:
- List of all created/modified files
- Reminder to commit the new files to the repository
- Reminder to verify the init script by creating a test session in CC
- If test runner config was modified, remind user to run tests locally to verify

## References

Load these on demand when you need the exact templates and contracts:

- `references/commandcenter-json.md` — schema, field types, path resolution, examples
- `references/init-script.md` — execution contract, environment variables, per-package-manager templates
- `references/pre-merge-script.md` — merge pipeline position, auto-fix behavior, tool ordering, templates
- `references/dev-servers.md` — CC_PORT protocol, _helpers.sh content, preset scripts, monorepo variant
- `references/ai-test-config.md` — CLAUDECODE detection for Vitest and Jest, integration patterns

## Edge Cases

**No package.json:** Generate a minimal `CommandCenter.json` with `initScriptPath: null` and no other fields. Inform the user that no JS/TS tooling was detected.

**Existing CommandCenter.json:** Read it, diff against proposed config, show what would change. Offer to merge (add new entries) rather than overwrite. Never silently replace.

**Existing scripts:** If `scripts/worktree-init.sh` or `scripts/pre-merge-validate.sh` already exist, show the diff between existing and proposed. Ask whether to replace or skip.

**Both Vitest and Jest:** Unusual but possible. Generate pre-merge script with both. For test config, prioritize vitest if both are present.

**No validation tools detected:** Skip `preMergeCommand` entirely. The user can add it later when they add linting/testing.
