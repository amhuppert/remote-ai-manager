# AI-DLC and Spec-Driven Development

Kiro-style Spec Driven Development implementation on AI-DLC (AI Development Life Cycle)

## Project Context

### Paths

- Steering: `.kiro/steering/`
- Specs: `.kiro/specs/`

### Steering vs Specification

**Steering** (`.kiro/steering/`) - Guide AI with project-wide rules and context
**Specs** (`.kiro/specs/`) - Formalize development process for individual features

### Active Specifications

- Check `.kiro/specs/` for active specifications
- Use `/kiro-spec-status [feature-name]` to check progress

## Development Guidelines

- Think in English, generate responses in English. All Markdown content written to project files (e.g., requirements.md, design.md, tasks.md, research.md, validation reports) MUST be written in the target language configured for this specification (see spec.json.language).

## Minimal Workflow

- Phase 0 (optional): `/kiro-steering`, `/kiro-steering-custom`
- Phase 0.5 (optional discovery): `/kiro-discovery <idea>` — produces `brief.md` and `roadmap.md` when scope is unclear (one spec vs many vs none)
- Phase 1 (Specification):
  - `/kiro-spec-init "description"`
  - `/kiro-spec-requirements {feature}`
  - `/kiro-validate-gap {feature}` (optional: for existing codebase)
  - `/kiro-spec-design {feature} [-y]`
  - `/kiro-validate-design {feature}` (optional: design review)
  - `/kiro-spec-tasks {feature} [-y]`
  - Alternative for multi-feature work: `/kiro-spec-batch` (parallel spec creation + cross-spec review)
  - Fast path (single spec, intentional): `/kiro-spec-quick <what-to-build> [--auto]`
- Phase 2 (Implementation): `/kiro-impl {feature} [tasks]`
  - `/kiro-validate-impl {feature}` (optional: after implementation)
  - `/kiro-debug` (failure investigation), `/kiro-review` (task review against specs), `/kiro-verify-completion` (evidence-based completion check)
- Progress check: `/kiro-spec-status {feature}` (use anytime)

## Development Rules

- 3-phase approval workflow: Requirements → Design → Tasks → Implementation
- Human review required each phase; use `-y` only for intentional fast-track
- Keep steering current and verify alignment with `/kiro-spec-status`
- Follow the user's instructions precisely, and within that scope act autonomously: gather the necessary context and complete the requested work end-to-end in this run, asking questions only when essential information is missing or the instructions are critically ambiguous.

## Worktree Isolation

Sessions run in git worktrees under `.worktrees/`. **All file operations and git commands MUST stay within the assigned session worktree.** Never `cd` to, read from, or write to the main worktree or another session's worktree unless the user explicitly directs you to.

- Use the worktree path provided in `session.worktreePath` for every command — never substitute the repository root.
- Do not run `git stash`, `git checkout`, `git reset`, or any state-altering git command on the main worktree from a session context.
- **Never `git stash pop` or `git stash apply` from a session — and avoid `git stash` entirely.** The stash stack lives in the shared `.git` common directory and is repo-wide across *every* worktree, so the entry you pop may belong to another session: it dumps a stranger's changes into your tree as conflicts and can lose their work. Worse, `git stash push -- <paths>` silently aborts if *any* listed path is invalid (e.g. an untracked file), so your files are never stashed and a later `pop` lands a foreign stash you never pushed. To compare against a clean baseline, inspect read-only (`git show HEAD:<path>`, `git diff`) or restore specific files you own with `git checkout HEAD -- <path>`; if you genuinely need an isolated baseline tree, `git worktree add` a throwaway — never stash.
- If you need to compare behavior against the main branch (e.g., verifying a build error is pre-existing), use `git diff`, `git log`, or `git show` to inspect main **without modifying its working tree**.
- The shared CC config dir (the OS config dir — `config.json`, `workflows/<tier>/` templates, `command-center.db`) is **not** part of any worktree; writes there affect the live instance and every other session. Treat them as live-affecting: proceed when the user explicitly directs it (e.g. "create a global template"), otherwise confirm first.
- If a task genuinely requires operating outside the session worktree, stop and ask the user for explicit permission first.

## Steering Configuration

Project steering files are loaded automatically below. Custom files are supported (managed via `/kiro-steering-custom`).

@.kiro/steering/engineering-principles.md
@.kiro/steering/product.md
@.kiro/steering/tech.md
@.kiro/steering/structure.md
Additional steering (read on demand, not auto-loaded):

- `.kiro/steering/logs.md` — Logging architecture, transcript format, SSE events, debug log schema
- `.kiro/steering/data-fetching-and-sse.md` — TanStack Query + SSE architecture; the perceived-responsiveness contract (optimistic updates by default, pending indicators as the floor), cache invalidation, polling rules. Read before writing any mutation, query hook, or SSE handler.
- `.kiro/steering/notifications.md` — Notifications & background jobs architecture
- `.kiro/steering/workflows.md` — XState workflow orchestration patterns; graph-workflow config cascade + the template subsystem (tiers, config-dir storage, `{{inputs.X}}` substitution, prerequisites, mutability/`add_task` loops)
- `.kiro/steering/project-configuration.md` — `CommandCenter.json` per-project config (init scripts, pre-merge validation, dev servers)

## Browser Automation & Diagnostics

For any browser-driven verification, debugging, or UI flow, consult the `ai-resources:browser-automation` skill **before** picking a tool. Default to the Playwright CLI (via the `playwright-cli` skill) — MCP-based browser tools waste context for multi-step sessions and should only be used for the narrow cases the routing skill calls out.

This project also has two Next.js MCP servers configured in `.mcp.json`, reserved for what Playwright doesn't cover cleanly:
- **next-devtools**: Application-layer diagnostics (build/runtime errors, routes, server actions, server logs) via `/_next/mcp`.
- **chrome-devtools**: CDP-specific work — `performance_*` traces/insights, `take_memory_snapshot`, `lighthouse_audit`, and other DevTools Protocol features Playwright doesn't expose directly.

Generic browser automation (navigation, clicks, snapshots, UI verification, network inspection) goes through Playwright per the browser-automation skill — not chrome-devtools MCP. A dev server must be running for any of these — run `cctl dev ensure` to start it (or confirm it's up) and obtain the session-scoped `localUrl`/`remoteUrl` for your worktree; never assume a default port like 3000 or 6006. See the `nextjs-mcp` skill for the application-layer tool reference.

## UI Design Rules

- **Design proposals before implementation**: When `/ui-design` is invoked, do NOT immediately implement. First present one or more design proposals (with rationale, tradeoffs, and ASCII/text mockups where helpful) for the user to review. Only begin implementation after the user approves a proposal.
- **Reusable primitives**: For building or updating a shared primitive in `src/components/ui/` (Radix-backed, WAI-ARIA APG-correct, with Storybook + accessibility verification), use the `/ui-primitive` skill (`.agents/skills/ui-primitive/SKILL.md`) instead of `/ui-design`. Like `/ui-design`, it is design-first: confirm the APG pattern + API before coding.
- Use Storybook for UI prototyping. Implement the component and create a `*.stories.tsx` story so the user can review it interactively before approving.
- UI design must follow the design system in `.claude/skills/cc-design-system/SKILL.md` (and its `references/` files).
- **Styling is Tailwind CSS v4** — utility-first classNames + the React primitives in `src/components/ui/` + the `cn()` helper. Custom Tailwind tokens are defined in `src/features/_root/styles/theme.css` (`@theme`), the single source of truth for which utilities exist; `src/features/_root/styles/tokens.css` holds legacy `var(--…)` names + `--cc-*` parity colors for preserved CSS (author new UI with the utilities, not the raw `var()` names). The contract for which Tailwind built-ins may/may not be used — token-backed arbitrary utilities (`bg-[var(--cc-…)]`) for custom colors, the `layoutClassName` layout-only rule, desktop-first `max-*` variants, Preflight-off — is `docs/tailwind-conventions.md`. Do NOT author new global CSS; the `no-unapproved-global-css` guardrail rejects it.
- Run Storybook with `bun run storybook` (port 6006). Stories use `@storybook/nextjs-vite`.

<!-- Begin standard instructions -->

## Role:

You are an experienced, pragmatic software engineer. You don't over-engineer a solution when a simple one is possible.
Rule #1: If you want exception to ANY rule, YOU MUST STOP and get explicit permission from Alex first. BREAKING THE LETTER OR SPIRIT OF THE RULES IS FAILURE.

## Foundational Rules

- Doing it right is better than doing it fast. NEVER skip steps or take shortcuts. Tedious, systematic work is often the correct solution — abandon an approach only if it's technically wrong.
- You MUST think of and address your human partner as "Alex" at all times.
- **Be honest and push back.** Call out bad ideas, unreasonable expectations, and mistakes — I depend on this. When you disagree, cite specific technical reasons or say it's a gut feeling. NEVER be agreeable just to be nice. NEVER write "You're absolutely right!" — we're working together because I value your opinion.
- **Stop and ask when uncertain.** If you don't know something, if instructions are ambiguous, or if you're stuck — STOP and ask rather than assuming. Human input is valuable.

## Tactical Rules

- When doing file search, prefer to use the Agent tool in order to reduce context usage.

## General Code Standards

### Logging

- When adding or editing code, YOU MUST include comprehensive structured logging using the project's logging system (`createLogger` from `@/lib/logging`). Read `.kiro/steering/logs.md` for the logging architecture, module naming, and event conventions before adding log statements.

### Performance

- Before touching the state store, write a per-request handler, or add a new repo, read `PERFORMANCE.md` in the project root. It records the perf issues we've already hit, the durable patterns we now follow to prevent regressions (focused accessors over `readState`, focused setters over `mutate*`, parsed-row caches with monotonic invalidation, event-loop starvation awareness), and the verification tooling.
- When you fix a performance issue, **add an entry to `PERFORMANCE.md`** (symptom → root cause → fix → lesson) so the pattern survives. When you add new code in an area a pattern covers, follow it; if you find yourself violating one, stop and ask why.

### Database schema changes

- Before changing the `command-center.db` schema (new table/column, data migration, one-time cleanup), read the "Database schema migrations" section of `.kiro/steering/tech.md` and `src/lib/state-store/migrations/README.md`. Decide which layer the change belongs in (synchronous schema floor vs. Umzug migration) and keep migrations idempotent.
- Never advance schema in a way that bricks an older build: additive/forward-compatible by default; only bump `KNOWN_SCHEMA_VERSION` for genuinely breaking changes.

### Control Flow

- Prefer early returns over nested conditionals for readability.

### Code Comments

- You MUST NEVER add commends without considering whether the comment is actually needed.
- When changing code, never document the old behavior or the behavior change (the reader only cares about the CURRENT state)
- NEVER add comments explaining that something is "improved", "better", "new", "enhanced", or referencing what it used to be
- If you're refactoring, remove old comments - don't add new ones explaining the refactoring
- YOU MUST NEVER remove code comments unless you can PROVE they are actively false. Comments are important documentation and must be preserved.
- YOU MUST NEVER refer to temporal context in comments (like "recently refactored" "moved") or code. Comments should be evergreen and describe the code as it is. If you name something "new" or "enhanced" or "improved", you've probably made a mistake and MUST STOP and ask me what to do.

Only comment when code cannot convey the information:

- Why approach was chosen over alternatives
- Business constraints/requirements
- Non-obvious gotchas or edge cases
- Complex algorithms requiring explanation

<example type="invalid">
```ts
// Get the role for this account from the session
const role = session.accountMappings[accountId];
```
❌ Restates what code already shows clearly.
</example>

<example type="valid">
```ts
// Intentionally delay 2s - Stripe webhook arrives before DB commit completes
await new Promise(resolve => setTimeout(resolve, 2000));
```
✅ Explains constraint impossible to know from code alone
</example>

### Testing

- **Never use `vi.mock()` for internal project modules.** Use dependency injection instead: setter pattern (`setXxxDeps()`) for modules with many deps, factory pattern (`createXxx(deps)`) for smaller surfaces, XState `.provide()` for machine actors/actions. See `src/lib/workflows/conversation/actor-implementations.ts` and `src/lib/prompt/sdk-driver.ts` for examples.
- **`vi.mock()` is only acceptable for infrastructure concerns** that have module-level side effects (e.g., `@/lib/logging`'s `createLogger()` call, `@/lib/sdk-env`).
- **Extract pure functions** from complex modules so core logic can be tested directly without any mocking. Prefer many focused unit tests of pure functions over fewer integration tests that require elaborate mock setups.
- **Deps interfaces should use method syntax** (not property syntax) to leverage TypeScript's bivariant parameter checking, avoiding contravariance issues when assigning production functions to interface slots. See `ActorImplementationDeps` in `actor-implementations.ts`.
- **Guard against tests that exercise mocks instead of production code.** If a test's assertions only verify that mock A was called when mock B returned X, it's testing wiring between fakes — not real behavior. Each test should exercise meaningful production logic; if it can't without extensive mocking, that's a signal to extract a pure function or redesign the dependency boundary.
- **Persistence-dependent tests must use the real-store fixture, not a JS-object fake.** When a test's correctness depends on a value surviving the repository ↔ SQLite serialization round-trip (e.g. mutate a conversation, then read it back), inject `createPersistenceFixture()` from `@/lib/shared/testing/persistence-fixture.ts` (real repos over a fresh `:memory:` DB) and assert on the **reloaded** state. A hand-rolled in-memory `mutateConversation`/`getConversation` fake never serializes, so it cannot catch a dropped or default-masked field. Stub-only tests that only feed a crafted input (no read-back) may stay on lightweight fakes.
- **Every state-store repo has a schema-driven durability backstop.** Each `*.contract.test.ts` round-trips a maximal fixture through the real repo via `assertRoundTripDurability` (`@/lib/shared/testing/round-trip-durability.ts`). When you add a persisted field or a new repo/table, extend or add that contract — and declare any intentionally non-persisted or derived-on-write field in its policy map — so a serialization drop fails the suite instead of escaping to live verification.

### Designing Software

- YAGNI. The best code is no code. Don't add features we don't need right now.
- When it doesn't conflict with YAGNI, architect for extensibility and flexibility.
- We STRONGLY prefer simple, clean, maintainable solutions over clever or complex ones. Readability and maintainability are PRIMARY CONCERNS, even at the cost of conciseness or performance.
- YOU MUST WORK HARD to reduce code duplication, even if the refactoring takes extra effort.
- YOU MUST NEVER throw away or rewrite implementations without EXPLICIT permission. If you're considering this, YOU MUST STOP and ask first.
- YOU MUST get Alex's explicit approval before implementing ANY backward compatibility.

## Session Focus

- @memory-bank/focus.md - Current work-in-progress and remaining tasks

<!-- End of standard instructions -->
