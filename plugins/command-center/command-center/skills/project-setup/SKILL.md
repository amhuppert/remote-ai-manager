---
name: project-setup
description: >-
  This skill should be used when the user wants to configure a project for
  Command Center: create or update `CommandCenter.json`, write a worktree
  init script, register granular validation commands, or optimize a test
  runner config for AI agents. Triggered by "set up CC",
  "configure for command center", "create CommandCenter.json",
  "add CC config", "set up worktree init", "register validation commands",
  "set up pre-merge validation", "initialize project for CC", "CC project
  setup", or "set up command center config". For configuring dev servers,
  use the `dev-server-setup` skill instead.
---

# CC Project Setup

Analyze the target project's tech stack and generate the non-dev-server portion of its Command Center setup: `CommandCenter.json` (sans `devServers`), a worktree init script, one registered wrapper per validation command, and any test-runner configuration needed for bounded, AI-readable validation.

**Workflow: Analyze → Load tech-specific references → Propose → Approve → Write**

Do NOT write any files until the user explicitly approves.

For dev-server configuration (the `devServers` field in `CommandCenter.json`), use the separate `dev-server-setup` skill.

## Step 1: Analyze the Project

Run all detection steps silently. Do not ask questions during analysis.

### 1.1 Package Manager

Check for lock files at the project root in this order:

| Lock File | Package Manager | Install Command |
|---|---|---|
| `bun.lockb` or `bun.lock` | bun | `bun install` |
| `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile` |
| `yarn.lock` | yarn | `yarn install --frozen-lockfile` (or `--immutable` if `.yarnrc.yml` exists) |
| `package-lock.json` | npm | `npm ci` |
| `package.json` only | npm (fallback) | `npm install` |

If no `package.json` exists, this is not a JS/TS project. Continue with a minimal config and register only validation tools actually present in that project's stack.

### 1.2 Read package.json

Read `package.json` and extract `dependencies`, `devDependencies`, and the package scripts that invoke validation tools.

### 1.3 Detection Table

For each detected dependency, note which reference file to load in Step 2.

| Detected | Concern | Reference to load |
|---|---|---|
| `eslint` | Granular lint command | `references/eslint.md` |
| `prettier` | Granular format command | `references/prettier.md` |
| `typescript` (or `tsconfig.json` present) | Granular typecheck command | `references/typescript.md` |
| `vitest` | Granular test command | `references/vitest.md` |
| `jest` (only if Vitest is absent) | Granular test command | `references/jest.md` |
| `@prisma/client` or `prisma` | Init-script code generation | `references/init-script.md` |

Do not load references for absent tools. When both Vitest and Jest are present, prefer Vitest for the test-runner configuration and note both so the user can override.

### 1.4 Existing Configuration

Check for:

- `CommandCenter.json`; read it and offer a merge, never a silent overwrite;
- `scripts/worktree-init.sh`;
- existing files under `scripts/validate/`;
- any monolithic validation script that must be split into registered commands.

### 1.5 Existing Test Runner Config

Check for `vitest.config.ts`, `vitest.config.js`, `jest.config.ts`, and `jest.config.js`. If found, read it and note:

- whether AI-readable output is already configured;
- its worker count and heap cap;
- whether command-line flags can override those limits.

Merge against an existing config rather than replacing it.

### 1.6 Monorepo Detection

Check for a `workspaces` field, `pnpm-workspace.yaml`, `turbo.json`, and `nx.json`. For a monorepo, identify the narrowest sound affected-package mode for each tool. Dev-server `cwd` selection belongs to the `dev-server-setup` skill.

## Step 2: Load Tech-Specific References

Always load `references/commandcenter-json.md`. When any validation tool is detected, also load `references/pre-merge-script.md` for the shared validation-wrapper contract. Load `references/init-script.md` only when `package.json` exists, then load only the tool references selected in §1.3.

## Register Validation Commands

Register one logical command per tool or fixed resource profile in `CommandCenter.json`. Each profile has a required full wrapper and may have a separate changed wrapper under `scripts/validate/`; every wrapper implements one fixed mode. Typical names are `format`, `lint`, `typecheck`, `test`, and `build`. Scope variants of one logical command share a timeout but need not share a cost: `cost` accepts a table that prices full, changed, and explicit-path executions separately. Two genuinely different resource profiles — a different pinned worker count or heap cap — still remain two logical commands, because a cost table prices the scopes of one wrapper pair, not two wrapper pairs.

Every wrapper must:

- begin with a shebang and be executable because Command Center invokes its configured path with `execFile`, not a shell string;
- run correctly with the target worktree as its working directory;
- for every test command, pin the worker count in the wrapper and overwrite `NODE_OPTIONS` there with a fixed `--max-old-space-size` value so the test parent and spawned workers inherit the heap cap; when candidate configuration can supply worker `execArgv` that takes precedence over `NODE_OPTIONS`, use a wrapper-owned launcher to apply the fixed worker `execArgv` after candidate configuration resolves; runner configuration may mirror values but must not own enforcement;
- emit no color, remain silent on success, and preserve complete output on failure; use quiet flags or capture and replay output on failure instead of discarding diagnostics;
- exit zero only when its command passes.
- never parse or receive Command Center's `changed`/`full` scope value; Command Center selects the executable.

### Scope by default

Wrappers should validate only the branch's affected work wherever that is sound:

1. Read `TARGET_BRANCH`, defaulting only for a standalone diagnostic.
2. Resolve the comparison point with `git merge-base "$TARGET_BRANCH" HEAD`.
3. Include committed changes since the merge base plus staged, unstaged, and untracked files as appropriate. If no merge base resolves, run the full safe check rather than silently skipping validation.

Apply that comparison point as follows:

- format only changed files the formatter supports;
- lint only changed files or affected packages where the dependency model makes that safe;
- run Vitest with `--changed <merge-base>`, Jest with `--changedSince=<merge-base>`, or the runner's equivalent related/affected mode;
- keep a full typecheck or build when file-level or package-level scoping cannot soundly detect breakage in unchanged dependents.

Register the affected-work wrapper as `command.changed` and an unconditional whole-project wrapper as `command.full`. If sound changed execution is unavailable, omit `command.changed`; changed requests then fall back to full automatically. The test profile should declare `pathArgs: "paths"` so `cctl validate run test --scope changed -- path/to/test.ts` supports the TDD inner loop. Only the changed wrapper receives these validated positional paths. Commands that do not need caller-provided paths keep `pathArgs: "forbid"`.

### Declare honest costs

`cost` is a reservation weight, not measured usage. Use about one unit per configured worker for worker-pool tools and one unit for an ordinary single-process tool, adjusting upward for an honestly heavier fixed profile. For example, a wrapper pinned to four Vitest workers should normally declare cost `4`. Apply the same convention across all projects on a machine so the global budget compares like resource profiles.

A scalar `cost` charges that weight for every scope. Where a narrower execution genuinely uses fewer resources, declare the table form instead: `{ "full": 4, "changed": 4, "paths": { "base": 1, "perPath": 1 } }`. `full` is the required honest maximum, `changed` defaults to `full` when omitted, and `paths` charges `base + perPath * N` for N forwarded paths — `base` covering the runner's fixed coordinator process and `perPath` one worker's worth of fan-out, with `perPath: 0` declaring a flat scoped weight. Command Center caps the scoped charge at the changed weight, so narrowing can never cost more than not narrowing and there is no need to hand-clamp. The schema rejects a `paths` block without `pathArgs: "paths"`, a `changed` above `full`, and a `paths.base` above the changed weight.

**Declare a `paths` cost only when the wrapper's explicit-paths branch cannot escalate scope.** The price must describe the worst case of the code path that actually receives the paths: it must run exactly what was forwarded and never widen to a merge-base or whole-tree run when the list is unhelpful, and it must not expand into related or dependent files. A branch that can fall back to a broader run is honestly worth the changed weight — leave that command scalar, or use a table without a `paths` block. A forwarded path may still name a directory, so `perPath` prices one path's worth of fan-out rather than one file's, and `base` must carry the coordinator's real weight so a one-path run is never underpriced to nothing. Where the runner decides its own fan-out — expanding a directory, or treating a path as a pattern that matches unrelated files — do not leave `perPath` as a hope: the wrapper should enforce it by clamping the worker pool to the number of forwarded paths, so a scoped run can never occupy more workers than it was charged for. A broad path then runs slower on fewer workers, which is the correct pressure toward narrower scopes.

Do not derive worker counts from CPU count or available memory at execution time: the declared cost must continue to describe the maximum configured fan-out. The canonical wrapper must own both limits. Declare fixed worker and heap constants in each test wrapper, pass the worker constant through non-forwarded runner flags or wrapper-owned environment variables, and overwrite `NODE_OPTIONS` with the heap constant before invoking the runner. If a runner gives configured worker `execArgv` precedence over inherited `NODE_OPTIONS`, generate a canonical launcher that applies the same heap constant as the final worker `execArgv` after loading candidate configuration. Show both constants next to the proposed cost.

Runner configuration loads from the candidate worktree, so it cannot be the authority for either limit. It may repeat values as defense in depth only when the canonical invocation has higher precedence. Changing, removing, or raising a candidate mirror must not let a test process exceed the wrapper-owned profile.

### Select merge gates

Populate `validation.preMerge` as the ordered command list for Smart Merge and Smart Commit. Populate `validation.laneMerge` when graph lane merges should use a cheaper ordered subset; otherwise omit it and lane merges inherit `preMerge`. Preserve tool dependencies in the order, typically format → lint → typecheck → test/build.

The lists select commands independently of registration: every selected name must exist in `validation.commands`, while registered commands may remain available for agent diagnostics without joining either merge gate.

### Trust boundary

Command Center resolves wrapper paths from the canonical project root and runs them with the session or lane worktree as `cwd`. An unmerged session therefore cannot exercise edits to its own registry or wrappers through `cctl validate`; developing a wrapper is the narrow diagnostic case where running that wrapper directly is legitimate. State that reason first and use the smallest scope.

## Step 3: Propose Configuration

Present the analysis results and the complete proposed content of every created or modified file.

### 3.1 Analysis Summary

Show a table covering package manager, frameworks, linter, formatter, type checker, test runner, ORM, monorepo status, existing CC config, existing wrappers, and current worker/heap limits. Mention that dev-server configuration is handled separately.

### 3.2 Proposed Files

Propose:

- `CommandCenter.json`, preserving any existing `devServers` field untouched;
- `scripts/worktree-init.sh` when `package.json` exists;
- one full wrapper and, where sound, one changed wrapper under `scripts/validate/` for every detected validation command;
- a wrapper-owned launcher for Vitest when needed to apply fixed worker `execArgv` after candidate configuration resolution;
- a merged Vitest or Jest config update when needed to make output quiet and mirror the wrapper-owned resource profile.

For `CommandCenter.json`, use this shape and include only detected commands:

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "validation": {
    "commands": {
      "format": {
        "command": {
          "full": "scripts/validate/format-full.sh",
          "changed": "scripts/validate/format-changed.sh"
        },
        "cost": 1,
        "description": "Format project files",
        "pathArgs": "forbid"
      },
      "lint": {
        "command": {
          "full": "scripts/validate/lint-full.sh",
          "changed": "scripts/validate/lint-changed.sh"
        },
        "cost": 1,
        "pathArgs": "forbid"
      },
      "typecheck": {
        "command": {
          "full": "scripts/validate/typecheck.sh"
        },
        "cost": 1,
        "pathArgs": "forbid"
      },
      "test": {
        "command": {
          "full": "scripts/validate/test-full.sh",
          "changed": "scripts/validate/test-changed.sh"
        },
        "cost": {
          "full": 4,
          "paths": { "base": 1, "perPath": 1 }
        },
        "timeoutMs": 900000,
        "pathArgs": "paths"
      }
    },
    "preMerge": ["format", "lint", "typecheck", "test"],
    "laneMerge": ["typecheck", "test"]
  }
}
```

The `test` table keeps the honest four-worker weight for both full and changed runs — the omitted `changed` defaults to `full` — while `cctl validate run test --scope changed -- a.test.ts b.test.ts` reserves `1 + 1 * 2 = 3`, and a longer path list is capped back at 4.

Set `initScriptPath` to `null` when no init script is needed. `command.full` and `cost` are required; `command.changed`, `pathArgs`, `timeoutMs`, and `description` are optional. `cost` is a scalar or a `{ full, changed?, paths? }` table, and only `cost.full` is required inside it. Omitted `pathArgs` defaults to `"forbid"`. Do not add `devServers`; preserve an existing array and use `dev-server-setup` for additions.

Use the matching tool reference to build each wrapper. The wrapper is authoritative: it must set the fixed worker count and inherited heap cap before invoking the runner, and its launcher must reapply a final worker `execArgv` when the runner gives that field precedence over the inherited cap. Test-runner config may mirror values only below that final override; do not present a cost that assumes fewer workers than the wrapper permits.

## Step 4: Get Approval

Ask the user to approve the proposed configuration inside CC via `cctl ask`. Offer:

- **Approve all** — write everything as proposed.
- **Approve with changes** — incorporate requested modifications and show the updated proposal before writing.

## Step 5: Write Files

After approval:

1. Create `scripts/validate/` and `scripts/` as needed.
2. Write each approved file.
3. Set executable permissions on `scripts/worktree-init.sh` and every `scripts/validate/*` wrapper.
4. Merge approved test-runner changes without replacing unrelated configuration.

## Step 6: Verify

After writing:

1. Read back every created or modified file.
2. Verify wrapper shebangs and executable permissions.
3. Verify every `preMerge` and `laneMerge` name is registered and every command has `command.full`.
4. Verify each declared cost is honest for the scope it prices: a scalar or `cost.full` matches the maximum fixed worker/resource profile of both variants, `cost.changed` matches the changed wrapper's profile, and a `paths` block appears only where the explicit-paths branch cannot widen beyond the forwarded files.
5. Verify every test wrapper pins workers and overwrites `NODE_OPTIONS` with its inherited per-process heap cap; for Vitest, verify the canonical launcher supplies the final `poolOptions.forks.execArgv` after candidate configuration resolution.
6. Verify each wrapper is silent on success, complete on failure, and colorless.

## Step 7: Summary

List all created and modified files, explain the selected cost and scoping for each command, and remind the user to verify the init script in a test session. If a test-runner config changed, ask them to confirm the fixed worker and heap profile fits the project. Suggest `dev-server-setup` when frameworks were detected.

## Edge Cases

**No package.json:** Generate a minimal `CommandCenter.json` with `initScriptPath: null` and register only validation commands supported by the detected stack.

**Existing CommandCenter.json:** Merge the `validation` registry and preserve unrelated fields, especially `devServers`. Never silently overwrite.

**Existing monolithic validation script:** Propose splitting its tool phases into logical commands with fixed full/changed wrappers under `scripts/validate/`, then preserve ordering through `preMerge` and `laneMerge` lists.

**Existing test config with dynamic parallelism:** Make the canonical wrapper enforce a fixed command profile whose maximum worker count and inherited heap match its declared cost. When candidate worker `execArgv` can override the inherited heap, the wrapper-owned launcher must supply the final fixed `execArgv`. Runner config may mirror only beneath that override and cannot own the profile. A separate resource profile becomes a separate registered command.

**Both Vitest and Jest:** Prefer Vitest for the configured `test` command and surface the choice. Register a separate Jest command only when the project genuinely needs both.

**No validation tools detected:** Omit the `validation` block rather than registering placeholders.
