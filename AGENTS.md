# Command Center

Command Center is a Next.js control plane for running Claude and Codex agent sessions in isolated git worktrees. This file is the tool-agnostic engineering contract for every agent in this repository.

Address the user as Alex. Be direct about uncertainty or technical disagreement. Lead with the result, use plain language, and include the evidence and limitations needed to assess it.

## Initiative and completion

- Treat requests to build or fix something as authorization to do the work. Use the conversation's existing decisions and make routine, reversible choices without asking again.
- Ask when a missing answer materially changes scope, architecture, or an action's authorization. Prepare the authorized work up to a real approval boundary before presenting it for review. When a CC command requires ending the turn to deliver an answer, follow that protocol.
- Apply skills in service of the request. Explicit user instructions override skill guidelines within the system/developer rules and tool permissions. If an instruction requires a pause, cite its file and exact rule, and distinguish an explicit restriction from your interpretation.
- Delegate independent, bounded tasks when that improves quality or completion time. Give each agent clear ownership, continue useful work, then review and integrate its result.
- Finish when the requested result is implemented or delivered, relevant checks pass, and unresolved limitations are reported. Repeat or broaden checks only for a new change, failure, or unresolved concern.

## Operating model

Command Center is a local tool for one operator: one machine, one user, one SQLite database, and a person watching the logs who can retry. Design for that reality, not for a distributed database or a multi-tenant service. The complexity here is real — many sessions, workflows, and backends coordinated at once — so the code must work end to end and stay maintainable; spend the complexity budget there. Fight for simplicity: choose the simplest design that fully solves the problem, and add a guard, fallback, retry, or abstraction only for a failure mode that can occur here and is worth handling. Let everything else fail fast with a clear error, and name the edge cases you chose to leave unhandled.

## Commands

Run commands from the assigned session worktree root.

```bash
bun install
cctl validate list
cctl validate run test --queue-if-busy --json
cctl validate run test --queue-if-busy --require-match --json -- src/cli/commands/validate.test.ts
cctl validate run test --scope full --queue-if-busy --json
cctl validate run typecheck --queue-if-busy --json
cctl validate run seams --queue-if-busy --json
cctl validate run lint --queue-if-busy --json
```

`test` defaults to `--scope changed`, narrowing to the diff against the target branch, so a green run speaks for the changed files rather than the branch.

For explicit test paths, use `--require-match` and inspect the verdict and matched-file count. `--json` preserves the verdict and run ID; runner output may follow the envelope, so parse the first JSON object when automating. A client timeout leaves the server run active: recover it with `cctl validate status <runId>`.

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

- For behavioral changes, follow the TDD procedure and exceptions in `.kiro/steering/engineering-principles.md`. Documentation and prompt wording changes need consistency and contract checks where applicable, not tests that merely pin prose.
- For work governed by `.kiro/specs/`, preserve the Requirements → Design → Tasks → Implementation approvals. Check the active spec before implementation and write spec artifacts in the language declared by its `spec.json`.
- Prefer small, focused changes and early returns over nested conditionals. When a request is an audit or diagnosis, report findings without mutating external state or implementing an unrequested fix.

### Native specifications

New specifications use `cctl spec`; `.kiro/specs/` retains legacy governed work. Use the `native-sdd-authoring` skill for spec authoring and delivery, and read the relevant `cctl spec` leaf help before composing payloads.

- Before creating a spec, run `cctl spec list` and `cctl spec search --all <query>` to find existing work. Use `cctl spec status <slug>` to check phase and gates for governed changes.
- Author Requirements → Design → delivery plan, within the server's stage boundaries. `cctl spec propose` and `cctl spec plan propose` submit concrete artifacts for review.
- Approvals, plan sign-off, and assumption disposition are human-only Spec Studio actions; an agent cannot perform them on Alex's behalf.
- Write spec artifacts in the spec's configured language. Ordinary repository documentation and responses use English unless requested otherwise.

## Canonical architecture boundaries

- Start with `CONTEXT.md` for current domain vocabulary and ownership. A decision has one canonical owner exposed through a deep semantic interface.
- Backend-neutral code composes registered descriptors, conversation/task facets, capabilities, failure policy, and opaque continuity handles. Read `.kiro/steering/agent-backends.md` before changing agent execution, structured output, continuity, MCP behavior, models, or capabilities.
- Workflow features compose the supported modules in `.kiro/steering/workflows.md`; the adoption matrix decides which paths are canonical, experimental, or migration-only. XState and other orchestration mechanisms stay private behind lifecycle modules. Graph control flow has single owners: route semantics in `workflow-graph/route-projection.ts`, guard/predicate documents evaluated only through `workflows/primitives/output-schema-subset.ts`, and every structural mutation of a launched execution through the one live-edit core.
- Server events publish through `src/lib/events/publication.ts`; never import the raw broadcaster from domain code. Read `.kiro/steering/data-fetching-and-sse.md` before adding mutations, query hooks, or SSE behavior.
- API handlers compose `RouteResolution` and domain route adapters rather than rebuilding project/session/ticket 404 ladders. See `.kiro/steering/structure.md`.
- New UI uses existing primitives and Tailwind utilities. Tone-coded lifecycle/status pills use `src/components/ui/StatusChip.tsx`; `layoutClassName` is for external layout only. Read `docs/tailwind-conventions.md` before authoring or migrating UI.
- Run the registered `seams` validation command (alongside `typecheck`) when touching any architecture boundary above. Do not raise a seam ceiling to make a failure disappear; migrate the new site or document an approved survivor and deletion condition.

## TypeScript, schemas, and persistence

- Keep strict typing. Do not use `any`, non-null assertions (`value!`), `@ts-ignore`, or `@ts-expect-error` to silence failures. Narrow `unknown` with runtime checks; a cast needs a verified invariant or a demonstrably incorrect external type. Const assertions (`as const`) preserve literal types and are appropriate.
- Each domain owns its schemas in `src/lib/<domain>/schemas.ts`; derive types with `z.infer`. Shared primitives belong in `src/lib/shared/schemas.ts` only when genuinely cross-domain.
- Use `safeParse` for external input and `parse` for trusted internal data. Preserve the strict compiler settings in `tsconfig.json`.
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
- Add diagnostics at meaningful operation, failure, and state-transition boundaries. A pure function or wording-only change does not need logging solely because it was edited.
- Comments explain constraints, business reasons, or non-obvious edge cases. Do not narrate visible code, describe prior versions, or add temporal claims. Preserve existing comments unless they are demonstrably false.

## Read on demand

- `.kiro/steering/engineering-principles.md` — TDD procedure, dependency-injection examples, composition philosophy
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
- Use `ui-design` for feature design and `ui-primitive` for reusable primitives. An explicit `/ui-design` invocation starts with a proposal for review. Existing approval covers implementing that design; routine fixes within an approved interaction/API do not need a second design approval.
- UI work follows `cc-design-system` and `docs/tailwind-conventions.md`.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
