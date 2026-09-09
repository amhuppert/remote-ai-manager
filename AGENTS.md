# Command Center

Command Center is a Next.js control plane for running Claude and Codex agent sessions in isolated git worktrees. This file is the tool-agnostic engineering contract for every agent in this repository.

Address the user as Alex. Be direct about uncertainty or technical disagreement, and ask before making a consequential choice that the request does not settle.

## Operating model

Command Center is a local tool for one operator: one machine, one user, one SQLite database, and a person watching the logs who can retry. Design for that reality, not for a distributed database or a multi-tenant service. The complexity here is real — many sessions, workflows, and backends coordinated at once — so the code must work end to end and stay maintainable; spend the complexity budget there. Fight for simplicity: choose the simplest design that fully solves the problem, and add a guard, fallback, retry, or abstraction only for a failure mode that can occur here and is worth handling. Let everything else fail fast with a clear error, and name the edge cases you chose to leave unhandled.

## Commands

Run commands from the assigned session worktree root.

```bash
bun install
cctl validate list
cctl validate run test --queue-if-busy
cctl validate run test --queue-if-busy -- src/cli/commands/validate.test.ts
cctl validate run test --scope full --queue-if-busy
cctl validate run typecheck --queue-if-busy
cctl validate run seams --queue-if-busy
cctl validate run lint --queue-if-busy
```

`test` defaults to `--scope changed`, narrowing to the diff against the target branch, so a green run speaks for the changed files rather than the branch.

Registered command names are project configuration; use `cctl validate list` when a name above is absent. Run registered validation only through `cctl validate run <name>`. Do not invoke Vitest, ESLint, TypeScript, formatters, their package-script aliases, or registered validation scripts directly. Never bypass the wrapper to avoid a queue or an execution-context policy. A direct invocation is allowed only for a narrow diagnostic the registered commands cannot express — state the reason first and use the smallest possible scope. If it is resource-intensive or repeatable, register a command instead.

These package-script forms remain available only for that compelling-reason diagnostic bypass, never as the default validation path:

```bash
bun run test <specific test file paths> --bail=0
bun run lint
bun run typecheck
```

`bun run lint` also runs the architecture seam ratchet; the registered `lint` command does not, because `seams` owns it. Database migrations run during server startup; before changing persistence, follow `.kiro/steering/tech.md` and `src/lib/state-store/migrations/README.md`.

In Command Center sessions, run `cctl dev ensure` before browser, Playwright, Storybook, or Next.js diagnostics. Use the returned session-scoped URL; never assume a port. That dev server is a **separate CC instance** with its own database, logs, transcripts, and api-token: anything you create through the ambient `cctl` lands on the managing server and will never appear in it. To produce state inside it, use `cctl fixture`; to see both instances side by side, `cctl dev doctor`.

## Worktree and live-state safety

- Keep every file and git operation inside the assigned session worktree. Do not read from or modify the main worktree or another session's worktree unless Alex explicitly directs it.
- Do not use `git stash`, `git checkout`, or `git reset` to clean or restore files unless Alex explicitly requests that exact operation. The stash is shared across worktrees. Compare read-only with `git diff`, `git log`, or `git show`.
- Preserve unrelated and pre-existing changes. Do not discard or rewrite an implementation unless Alex explicitly approves it.
- The OS-level CC config directory (`config.json`, `workflows/`, `command-center.db`) is shared live state, not worktree state. Change it only when the request explicitly places it in scope; otherwise ask first.
- Backward-compatibility shims require Alex's explicit approval.

## Development process

- Use red-green-refactor TDD: add a failing behavior-level test, confirm it fails for the right reason (the assertion, not an import error or broken setup — scaffold the minimal skeleton first when needed), implement the minimum fix, refactor with tests green, then run proportionate regression checks. Skip test-first only where there is no behavior to pin — pure scaffolding, type/config changes, mechanical renames or wiring, throwaway spikes, visual-only UI tweaks — and say so; bug fixes always start from a failing reproduction test. In the TDD loop, scope the test command to the single test file you are iterating on (`cctl validate run test --queue-if-busy -- <test-file>`) — a file path, never a directory path. Changed-scope runs are not part of the TDD loop; use them strategically at checkpoints.
- For work governed by `.kiro/specs/`, preserve the Requirements → Design → Tasks → Implementation approvals. Check the active spec before implementation and write spec artifacts in the language declared by its `spec.json`.
- Prefer small, focused changes. When a request is an audit or diagnosis, report findings without mutating external state or implementing an unrequested fix.

## Canonical architecture boundaries

- Start with `CONTEXT.md` for current domain vocabulary and ownership. A decision has one canonical owner exposed through a deep semantic interface.
- Backend-neutral code composes registered descriptors, conversation/task facets, capabilities, failure policy, and opaque continuity handles. Read `.kiro/steering/agent-backends.md` before changing agent execution, structured output, continuity, MCP behavior, models, or capabilities.
- Workflow features compose the supported modules in `.kiro/steering/workflows.md`; the adoption matrix decides which paths are canonical, experimental, or migration-only. XState and other orchestration mechanisms stay private behind lifecycle modules. Graph control flow has single owners: route semantics in `workflow-graph/route-projection.ts`, guard/predicate documents evaluated only through `workflows/primitives/output-schema-subset.ts`, and every structural mutation of a launched execution through the one live-edit core.
- Server events publish through `src/lib/events/publication.ts`; never import the raw broadcaster from domain code. Read `.kiro/steering/data-fetching-and-sse.md` before adding mutations, query hooks, or SSE behavior.
- API handlers compose `RouteResolution` and domain route adapters rather than rebuilding project/session/ticket 404 ladders. See `.kiro/steering/structure.md`.
- New UI uses existing primitives and Tailwind utilities. Tone-coded lifecycle/status pills use `src/components/ui/StatusChip.tsx`; `layoutClassName` is for external layout only. Read `docs/tailwind-conventions.md` before authoring or migrating UI.
- Run the registered `seams` validation command (alongside `typecheck`) when touching any architecture boundary above. Do not raise a seam ceiling to make a failure disappear; migrate the new site or document an approved survivor and deletion condition.

## TypeScript, schemas, and persistence

- Keep strict typing. Do not use `any`, `!`, `@ts-ignore`, unchecked external casts, or hand-written types that duplicate Zod schemas. Narrow `unknown` with runtime checks.
- Each domain owns its schemas in `src/lib/<domain>/schemas.ts`; derive types with `z.infer`. Shared primitives belong in `src/lib/shared/schemas.ts` only when genuinely cross-domain.
- Persist through the state-store repositories and focused mutation APIs. Never instantiate a second state manager or write directly to the database from feature code.
- A persisted-field change must update its repository mapping, maximal round-trip contract fixture, and migration/floor behavior as applicable.

## Testing boundaries

- Before adding a test that scans repository or toolchain files, or changing a test's environment or isolation profile, follow `.kiro/steering/tech.md#test-execution-profiles`.
- Unit tests must not import Storybook or `*.stories.*` modules. Test production components directly with Testing Library and Storybook-free fixtures/providers; keep CSF composition, play functions, and story interaction coverage in the Storybook browser project.
- Never use `vi.mock()` for internal project modules. Use dependency injection, factories, XState `.provide()`, or extracted pure functions. Infrastructure modules with import-time side effects are the narrow exception.
- Dependency interfaces use method syntax when production functions must satisfy them.
- If correctness depends on SQLite serialization, use `createPersistenceFixture()` from `src/lib/shared/testing/persistence-fixture.ts`, reload through the repository, and assert on the reloaded state. JS-object fakes cannot prove durability.
- Every state-store repository has a `*.contract.test.ts` maximal round-trip backstop using `assertRoundTripDurability`. Extend it for every persisted field or table and declare intentionally derived/non-persisted fields in its policy.
- Avoid tests that only prove one fake called another fake. Exercise production logic or extract a pure decision function.
- Do not write tests that assert styles or CSS classes.

## Logging and comments

- Before adding or changing logging, read `.kiro/steering/logs.md`. Use `createLogger` from `@/lib/logging`, stable event names, and structured fields; never log secrets, tokens, or full prompt contents.
- Comments explain constraints, business reasons, or non-obvious edge cases. Do not narrate visible code, describe prior versions, or add temporal claims. Preserve existing comments unless they are demonstrably false.

## Read on demand

- `.kiro/steering/engineering-principles.md` — type safety, TDD, module depth, composition philosophy
- `.kiro/steering/product.md` — current product scope and capabilities
- `.kiro/steering/tech.md` — stack and version-sensitive constraints; read before changing dependencies, migrations, or test execution profiles
- `.kiro/steering/structure.md` — directory, route, schema, and import boundaries
- `.kiro/steering/agent-backends.md` — backend descriptors, facets, continuity, failures, structured output
- `.kiro/steering/workflows.md` — lifecycle shapes, workflow modules, adoption matrix, graph configuration
- `.kiro/steering/data-fetching-and-sse.md` — React Query, responsiveness, typed publication
- `.kiro/steering/logs.md` — logging architecture and event conventions
- `.kiro/steering/cli.md` — read before changing `cctl` commands, flags, help, query output, response envelopes, or hints
- `.kiro/steering/notifications.md` — jobs, notifications, and their publication flow
- `.kiro/steering/project-configuration.md` — `CommandCenter.json` and dev-server behavior

Read only the task-relevant steering documents listed in `AGENTS.md`; do not load the whole steering directory into every turn.

## Skill Routing

- For browser-driven UI verification, run `cctl dev ensure`, then use the `playwright-cli` skill. Use the `nextjs-mcp` skill for Next.js runtime/build diagnostics or Chrome DevTools-only profiling.
- Use `ui-design` for feature UI and `ui-primitive` for reusable primitives. Both are design-first; obtain approval for the proposed interaction/API before implementation.
- UI work follows `cc-design-system` and `docs/tailwind-conventions.md`.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
