# Engineering Principles

## Code Quality

Type safety and test-boundary requirements live in [AGENTS.md](../../AGENTS.md). Read this document before behavioral implementation for the TDD procedure and before choosing dependency-injection or workflow-composition patterns.

### Red-Green-Refactor TDD by default

1. Failing behavior-level test pinning the desired behavior, confirmed to fail for the right reason — the assertion, not an import error or broken setup. Scaffold the minimal skeleton first when the test could only fail on a missing import.
2. Smallest implementation that passes.
3. Refactor with tests green.

Run loop tests scoped to the single test file being iterated on (`cctl validate run test --queue-if-busy --require-match --json -- <test-file>`), never a directory path. Changed-scope runs are strategic checkpoints, not part of the loop.

For executable behavior bugs, confirm a failing reproduction before the fix. Documentation corrections use source verification; prompt wording changes use relevant contract checks without freezing prose in tests.

Skip test-first only where there is no behavior to pin: pure scaffolding, type/config changes, mechanical renames/wiring, throwaway spikes and Storybook prototyping, visual-only UI tweaks. Say so when you skip.

### Dependency injection — never `vi.mock()` internal modules

Use these dependency-injection patterns within the testing boundaries in AGENTS.md:

| Pattern | When | Reference |
|---|---|---|
| Factory `createX(deps)` | Small surface, clear constructor moment | `src/lib/prompt/sdk-driver.ts` |
| XState `.provide()` | Workflow actors/actions | `src/lib/workflows/conversation/actor-host.ts` |
| Setter `setXxxDeps()` + `_resetDepsForTesting()` | Module-scoped singletons, many call sites | `src/lib/dev-server/liveness.ts`, `src/lib/workflows/conversation/persistence.ts` |
| Fetch fixture + injectable QueryClient | Component/hook tests over React Query | `src/test/fetch-fixture.ts`, `src/test/component-mocks.tsx` (`renderWithQuery`/`createTestQueryClient`) |

**Client (component/hook) tests never `vi.mock` internal query/mutation/store modules.** Run the real hooks — real React Query, real `src/lib/api/fetcher.ts` validation, real Zod schemas, real Zustand stores — and fake only the genuinely-external network boundary with `installFetchFixture()` from `@/test/fetch-fixture` (register routes, assert mutations by observing the wire). Client state (Zustand) is owned code, not a boundary: use the real store; seed or read its state, don't mock it. External framework modules (`next/link`, `next/navigation`) and browser-only integration hooks (voice/hotkey) may keep their `@/test/component-mocks` stubs — those are not internal seams.

Deps interfaces use **method syntax** (bivariant), not property syntax:

```typescript
// ✅
interface Deps { load(path: string): Promise<X>; }

// ❌
interface Deps { load: (path: string) => Promise<X>; }
```

Test smell: assertions that only verify "mock A called when mock B returned X". Extract a pure function and test it directly.

---

## Command Center Design Philosophy

Value grows by adding sophisticated/autonomous workflows without codebase sprawl. New features earn complexity by being **composable**, not standalone.

### Composable modules, not feature silos

**"Composable module"** is the umbrella term at every scale; **"primitive"** is reserved for the lowest level (`src/lib/workflows/primitives/`).

Existing composable modules: the conversation-actor spine (`src/lib/workflows/conversation/`), the graph engine (`src/lib/workflow-graph/`), the agent backend abstraction (`src/lib/agent-backends/`), typed SSE publication (`src/lib/events/publication.ts`) with its private lifecycle projection, and the workflow primitives — AgentCall (`primitives/agent-call-facade.ts`), Lane (`lane-service`/`lane-scheduler`/`workflow-agent-caller`), ArtifactRegistry, WorkflowEnvelope, and the adopted gates (human-approval, circuit-breaker, structured-output) — plus the dual-validator model, iteration policy, and config cascade (global → workflow → per-context). Per-concept adoption status (supported / experimental / migration-only, competing paths, deletion conditions): the adoption matrix in `.kiro/steering/workflows.md`.

When adding workflow features:

1. **Specify by what makes it different** — a new actor, validator type, or context shape, not a parallel orchestrator.
2. **Reuse composable modules** — the primitives above and the per-machine patterns in `conversation/{persistence,runtime-state}.ts`. Extend, don't fork; a competing path in the adoption matrix is a migration to finish, not a precedent to follow.
3. **Push variation to the edges** — config cascade, validator `type` discriminators, and `.provide()` exist so the core stays small.

If a feature can't be expressed as composition: surface it. Either the abstraction is missing or the scoping is wrong.

### Pre-implementation checklist for workflow features

- Which existing composable modules does it compose?
- What is genuinely new and why can't it be expressed in existing modules?
- Is the change additive (new actors/validator types/context blocks) or a structural rewrite?

---

## Agent-Offloading Principle

Maximally useful AI-assisted dev = offload as much as possible from the agent onto deterministic code. Reserve the agent for judgment, language understanding, code synthesis.

| Deterministic code | Agent |
|---|---|
| Git ops, file I/O, JSONL parsing | Writing/editing source |
| Registered validation command + exit code | Judging intent match |
| Iteration accounting, circuit breaker, locks | Producing next plan step |
| Zod-validating agent output | Interpreting ambiguous prompts |
| SDK message routing | Design review |

### Heuristics

- Binary + reproducible check → code, not prompt. "Build passed?" = script. "Matches intent?" = agent.
- Validate agent output with Zod, then act deterministically. Orchestrator decides retries, not the agent.
- No agent bookkeeping — summarizing iterations, tracking remaining tasks, deciding to halt all belong in workflow context.
- Narrow prompts. Fewer asks + deterministic scaffolding > sprawling omnibus prompts.

Worked example: script validator runs **before** agent validator — if the tree doesn't compile, no LLM turn helps. Cheaper deterministic gate burns first.

---

For a material conflict, identify the competing constraints and the decision needed. Resolve routine choices within the request using the initiative policy in AGENTS.md.
