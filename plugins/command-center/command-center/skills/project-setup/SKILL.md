---
name: project-setup
description: >-
  This skill should be used when the user wants to configure a project for
  Command Center: create or update `CommandCenter.json`, write a worktree
  init script, write a pre-merge validation script, or optimize a test
  runner config for AI agents. Triggered by "set up CC",
  "configure for command center", "create CommandCenter.json",
  "add CC config", "set up worktree init", "set up pre-merge validation",
  "initialize project for CC", "CC project setup", or "set up command
  center config". For configuring dev servers, use the
  `dev-server-setup` skill instead.
---

# CC Project Setup

Analyze the target project's tech stack and generate the non-dev-server portion of a Command Center configuration: `CommandCenter.json` (sans `devServers`), worktree init script, pre-merge validation script, and any test runner config tweaks needed for AI-friendly output.

**Workflow: Analyze → Load tech-specific references → Propose → Approve → Write**

Do NOT write any files until the user explicitly approves.

For dev server configuration (the `devServers` field in `CommandCenter.json`), use the separate `dev-server-setup` skill — it loads dev-server-specific guidance independently so this skill stays focused.

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

### 1.3 Detection Table

For each detected dependency, note which reference file you will need to load in Step 2.

| Detected | Concern | Reference to load (Step 2) |
|---|---|---|
| `eslint` | Pre-merge linter | `references/eslint.md` |
| `prettier` | Pre-merge formatter | `references/prettier.md` |
| `typescript` (or `tsconfig.json` present) | Pre-merge type checker | `references/typescript.md` |
| `vitest` | Pre-merge test runner | `references/vitest.md` |
| `jest` (only if vitest absent) | Pre-merge test runner | `references/jest.md` |
| `@prisma/client` or `prisma` | Init script (code gen) | `references/init-script.md` |

**Do NOT load reference files for tools that are not detected.** The whole point of progressive disclosure is to keep the context clean. If the project has no Jest, do not load `references/jest.md`.

When both Vitest and Jest are present (unusual but possible), prefer Vitest for the test runner config slot and skip Jest's reference. Note both in the analysis summary so the user can override.

### 1.4 Existing Configuration

Check for:
- `CommandCenter.json` — if it exists, read it (offer to update, never silently overwrite)
- `scripts/worktree-init.sh` — existing init script
- `scripts/pre-merge-validate.sh` — existing pre-merge script

### 1.5 Existing Test Runner Config

Check for `vitest.config.ts`, `vitest.config.js`, `jest.config.ts`, `jest.config.js`:
- If found, read it
- Note whether it already contains `CLAUDECODE` detection
- Note whether it already caps parallelism (`maxForks`/`maxWorkers`/`execArgv`)

You'll merge against existing config rather than replacing it.

### 1.6 Monorepo Detection

Check for:
- `workspaces` field in `package.json` (npm/yarn workspaces)
- `pnpm-workspace.yaml` (pnpm workspaces)
- `turbo.json` (Turborepo)
- `nx.json` (Nx)

If monorepo detected, note it in the analysis. (Dev-server `cwd` selection is handled by the separate `dev-server-setup` skill.)

## Step 2: Load Tech-Specific References

Based on the detection table in §1.3, load only the reference files for tools that are present. Always load:

- `references/commandcenter-json.md` — schema and field types
- `references/pre-merge-script.md` — script contract, scoping pattern, shared shell prelude (only if any of eslint/prettier/typescript/vitest/jest was detected)
- `references/init-script.md` — per-package-manager templates (only if `package.json` exists)

Conditionally load:

- `references/eslint.md` — only if ESLint detected
- `references/prettier.md` — only if Prettier detected
- `references/typescript.md` — only if TypeScript detected
- `references/vitest.md` — only if Vitest detected
- `references/jest.md` — only if Jest detected AND Vitest absent

## Step 3: Propose Configuration

Present the analysis results and proposed files to the user.

### 3.1 Analysis Summary

Show a table of detected aspects (package manager, frameworks, linter, formatter, type checker, test runner, ORM, monorepo, existing CC config). If frameworks were detected, mention that dev-server configuration is handled separately via the `dev-server-setup` skill.

### 3.2 Proposed Files

Show each file that will be created, with full content in fenced code blocks. The files to generate:

**Always:**
- `CommandCenter.json` — with fields set based on what was detected (see `references/commandcenter-json.md`). Do NOT include a `devServers` array here — that is added by the `dev-server-setup` skill.

**If package.json exists:**
- `scripts/worktree-init.sh` — install command for the detected package manager, plus any code generation steps from `references/init-script.md`

**If any of eslint, prettier, typescript, vitest, or jest detected:**
- `scripts/pre-merge-validate.sh` — built from the shared shell prelude in `references/pre-merge-script.md` plus each detected tool's invocation block from its reference. Order: Prettier → ESLint → TypeScript → Vitest/Jest. Include only blocks for tools that were detected.

**If vitest detected:**
- Proposed `vitest.config.ts` modification (or new file) from `references/vitest.md`. Includes AI-optimal output AND `pool: "forks"` + `maxForks` cap + `execArgv` heap cap. Merge against any existing config.

**If jest detected (and vitest absent):**
- Proposed `jest.config.ts` modification (or new file) from `references/jest.md`. Includes AI-optimal output AND `maxWorkers: "50%"` + `workerIdleMemoryLimit`. Merge against any existing config.

### 3.3 Generation Rules

**CommandCenter.json:**
```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh"
}
```
- Set `initScriptPath` to `"scripts/worktree-init.sh"` if package.json exists, otherwise `null`.
- Set `preMergeCommand` to `"scripts/pre-merge-validate.sh"` if any validator was detected, otherwise omit.
- Do NOT include a `devServers` field. If the user wants dev servers, invoke `dev-server-setup` after this skill completes.

**Init script:** Use the template from `references/init-script.md` matching the detected package manager. Add `prisma generate` if Prisma detected. Add `.env.example` copy if the file exists.

**Pre-merge script:** Start with the shared shell prelude from `references/pre-merge-script.md`. Then append, in order, the invocation block from each detected tool's reference file. The result must contain only the blocks for tools that were actually detected — no placeholders for absent tools.

**Test runner config:** Use the pattern from `references/vitest.md` or `references/jest.md`. For existing config files, show the modification as a merge against the existing config, not a replacement.

## Step 4: Get Approval

Use `AskUserQuestion` to ask the user to approve the proposed configuration. Offer:
- **Approve all** — write everything as proposed
- **Approve with changes** — user specifies modifications before writing

If the user wants changes, incorporate them and show the updated proposal before writing.

## Step 5: Write Files

After approval:

1. Create directories: `mkdir -p scripts`.
2. Write each approved file using the Write tool.
3. Set executable permissions on shell scripts: `chmod +x scripts/*.sh`.
4. For test runner config modifications: use the Edit tool to merge the AI detection + parallelism cap blocks into the existing config file.

## Step 6: Verify

After writing:
1. Read back each created file to confirm content is correct.
2. List the files with permissions to verify they are executable.
3. Present a summary of what was created.

## Step 7: Summary

Present:
- List of all created/modified files.
- Reminder to commit the new files to the repository.
- Reminder to verify the init script by creating a test session in CC.
- If a test runner config was modified, remind the user to run tests locally to confirm the new pool/worker caps don't conflict with project-specific test needs.
- If frameworks (Next.js, Storybook, etc.) were detected, suggest running the `dev-server-setup` skill next to add `devServers` entries.

## Edge Cases

**No package.json:** Generate a minimal `CommandCenter.json` with `initScriptPath: null` and no other fields. Inform the user that no JS/TS tooling was detected.

**Existing CommandCenter.json:** Read it, diff against proposed config, show what would change. Offer to merge (add or update `initScriptPath` / `preMergeCommand`) rather than overwrite. Never silently replace. Preserve any existing `devServers` field untouched — it is owned by the `dev-server-setup` skill.

**Existing scripts:** If `scripts/worktree-init.sh` or `scripts/pre-merge-validate.sh` already exist, show the diff between existing and proposed. Ask whether to replace or skip. Pay particular attention to whether the existing pre-merge script already scopes to changed files — if not, the proposal should highlight that as the main change.

**Existing test runner config without parallelism cap:** This is the common upgrade case. The proposal should explicitly call out that the change adds `maxForks`/`maxWorkers` and a per-worker memory cap, citing the rationale from the relevant reference file.

**Both Vitest and Jest:** Unusual but possible. Prefer Vitest for the test runner config slot; skip Jest's config modification. Pre-merge script can call both if the user wants — surface the choice.

**No validation tools detected:** Skip `preMergeCommand` entirely. Do not write `scripts/pre-merge-validate.sh`. The user can add it later when they add linting/testing.
