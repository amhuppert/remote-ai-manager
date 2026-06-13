# Graph Workflow Improvement Proposal

Grounded in the AeroTrainer head-to-head (dynamic workflow vs. graph workflow execution `0bfbfb84`), the post-hoc defect analysis of both implementations, and the current Graph workflow architecture (`src/lib/workflow-graph/`, the config cascade, the `collaboration/` package, the `__planner__` session, the shared-documents registry, `add_task` mutability, lanes / land-gate, and the human approval gate). Each idea cites the evidence that motivates it and the existing primitive it composes with — per CC's own principle: **composable primitives, not feature silos.**

**Optimization preferences applied throughout:** quality > friction > alignment > token economy > wall-clock speed. Faster execution is welcome but is not the goal; trading longer runs for fewer tokens and higher quality is acceptable.

---

## 0. What the evidence says

The graph workflow's engine was excellent once running: 13/13 contexts GO, ~1.5 min total orchestration overhead, a complete audit trail, and roughly half the token cost of the dynamic run ($126 vs ~$240–295). Its failures were concentrated in three places:

1. **Pre-flight.** Run 1 died on two pure configuration errors (a script validator enabled with no command; a missing worktree-init script), burned **21 zombie iterations** because the loop fed a deterministic provisioning failure into the circuit breaker as if it were an agent failure, and the eventual "fix" was to *delete* the deterministic gate across all 13 contexts rather than repair it.
2. **Spec authority.** The only validation NO-GO (night-shift `floor` vs `round`) enforced a bug in the acceptance criteria *against the prototype's correct code*; a later context silently reverted it. ACs that restate formulas become a second, divergent source of truth.
3. **Structure rigidity.** The five mode contexts were serialized purely because each touched shared files (`App.tsx`, routing tests, `screens/contract.ts`); the two omnibus contexts overran the context window (288K / 333K vs a 200K limit, i.e. silent-compaction territory); cross-context integration gaps were caught only by the final sweep, not by the 12 per-context GO verdicts.

The dynamic workflow's wins map cleanly to importable mechanisms: **test-locked contracts before fan-out**, **disjoint file ownership**, **schema-forced structured handoffs**, **adversarial verification of findings**, and **an orchestrator that owned global coherence**. Its losses — a hung `parallel()` barrier with no per-agent timeout, reviewing a tree that was mutating underneath it, self-curated reporting, and zero audit trail — are exactly what the graph engine already protects against. So the program is: **import the dynamic workflow's wins without surrendering determinism, auditability, or the policy envelope.**

The post-hoc defect analysis adds a fourth lesson that no current mechanism addresses: all four shipped bugs (flat monitor row, up/down monitor focus bonk, static home-monitor lookup, first-child accordion) were **faithfully inherited from the prototype**, and every validation layer in both workflows was spec-anchored — so the defect class was invisible by construction.

## 1. Current extension points (what we build on)

The system already has most of the durable machinery; the design work is adding typed proposals, contracts, policies, and gates around it.

- `src/lib/workflows/schemas.ts` — graph definitions, context config, task state, validator config, approval-gate config, execution state.
- `src/lib/workflow-graph/runtime-edits.ts` — centralizes safe runtime task edits (`add_task` etc.); the natural home for graph-patch validation and application.
- `src/lib/workflow-graph/tool-server.ts` — agent-facing MCP tools: `complete_task`, `add_task` (gated by `mutability.allowAgentTaskAdd`), `upsert_shared_document`, `request_collaboration`. New tools follow this pattern.
- `src/lib/workflow-graph/iteration-prompt.ts` — where context briefing, required artifacts, validation feedback, and collaboration continuations enter implementer prompts.
- `src/lib/workflow-graph/validator-runner.ts`, `execution-validation.ts`, `codex-agent-schemas.ts` — the context-validator path and its response schema.
- `src/lib/workflow-graph/iteration-orchestrator.ts`, `execution-loop.ts`, `iteration-failure-with-progress.ts` — sequence script validation, context validation, task reopen, circuit-breaker checks, approval parking.
- `src/lib/workflow-graph/approval-gate.ts` — the human approval gate (present in this worktree); the control point that makes dynamic mutation safe.
- `src/lib/workflows/collaboration/` — a working structured negotiation slice: `request_collaboration` → `initial-draft` → `cross-review` → `counter-proposal` → `resolution`. The seed for adversarial review/verify.
- `src/lib/workflow-graph/lane-plan.ts`, `lane-readiness.ts`, `lane-join.ts`, `join-runner.ts`, `lane-committer.ts`, `solo-context-committer.ts` — parallel lanes, fan-in joins, per-context commits, the land-gate (`isContextLanded` in `validation.ts`).
- `src/lib/workflow-graph/shared-documents.ts` — artifact registry surfaced in downstream prompts.
- `src/lib/workflow-graph/{planner.ts,planner-tools.ts}` + the `__planner__` reserved session + planner-draft-registry side channel — programmatic (re)planning.
- `resolve-config.ts` + `workflowDefaults` — the three-tier config cascade (global → workflow → per-context).
- `docs/composable-workflow-primitives.md` — the target vocabulary (AgentCall · Lane · Gate · StatusBus · ArtifactRegistry · Workflow Envelope) every extension should compose, not bypass.

---

## Part 1 — Agent alignment

### 1.1 Workflow Charter: one shared brief injected everywhere

A first-class `charter` artifact — mission, architecture map, module-ownership map, conventions, **source-of-truth hierarchy with explicit precedence**, non-goals, vocabulary, test strategy, known-ambiguity list — produced at planning time (or by an early design context), versioned, and injected verbatim into **every implementer and validator prompt**. Build it on the shared-documents registry with a reserved `kind: "charter"` that `iteration-prompt.ts` auto-includes; keep a concise prompt-digest plus a full artifact available on demand.

*Why:* alignment today lives in 13 independent AC prose blocks that drift (seed prompts grew 8.2KB → 25.3KB as each context re-explained the world). The dynamic run's single biggest success factor was `DESIGN.md` + `CONTRACT.md`: every one of 7 parallel agents coded against the same locked document, and 32 files integrated with one type error. *Token economy:* the charter is one stable, cached prefix instead of N inflating, divergent seeds.

For *high-authority* sections only (charter core, frozen contracts), optionally require the implementer to `acknowledge_artifact({ id, version, summary })` before its first `complete_task` — a read-receipt that raises the cost of ignoring the contract and gives validators something to inspect. Scope this narrow; applied to every note it is pure ceremony.

### 1.2 Source-of-truth hierarchy, declared once

A workflow-level `sourcesOfTruth` list with explicit precedence (e.g. `1. aerospace-game/project/*.jsx code · 2. ~/.aerospace.toml · 3. Handoff HTML narrative · 4. AC prose`), injected into implementer *and* validator prompts, with planning guidance that ACs **cite** their source rather than restate it.

*Why:* the floor/round saga is the proof — implementer followed the prototype (correct), codex enforced the AC's transcription of the handoff doc (wrong), final-verification reverted citing the prototype. Three agents, three implicit authority models. One declared hierarchy makes all of them resolve conflicts identically, and makes "the AC itself is wrong" a recognizable situation instead of a forced iteration.

### 1.3 Contract artifacts with enforced immutability ("interface freeze")

A context may declare `produces: { contracts: [paths] }`. Once it lands, the engine records each contract file's git hash; any later context that modifies a contract file fails a **deterministic** post-iteration check (`git diff --name-only` against the contract set) unless it holds `mayAmendContracts`.

*Why:* the dynamic run hand-built and unit-tested the foundation, then told build agents "the foundation is read-only" — and it held because the orchestrator would have noticed a violation. The graph run had no equivalent: nothing stopped a mode context from "fixing" `engine-core`'s exports to suit itself, and final-verification did quietly patch four earlier contexts' files. This converts the strongest alignment device observed into an engine invariant. *Composition:* extends the land-gate machinery; the check runs with the deterministic script gate (cheaper gate burns first).

### 1.4 Typed deliverables + a test-plan traceability matrix

Each context declares machine-readable `deliverables`: files (globs), exported symbols, runnable commands. Two uses: a **deterministic completion check** (files exist, exports resolve under `tsc`, commands exit 0) *before* any agent validator runs; and **downstream injection** of the *actual extracted signatures* of upstream deliverables (not prose paraphrases) into dependents' prompts.

Pair this with a **test-plan artifact** produced by an early context: a matrix of `behavior → unit target → e2e target → visual evidence → AC covered → source reference`, which downstream validators check for satisfaction. For the project's mandated red-green TDD, rigor-flagged contexts attach structured evidence on `complete_task` (failing test added → failure observed → change → passing rerun) that the validator inspects against the transcript and test files.

*Why:* this is the dynamic build workflow's schema-forced structured output applied to graph edges, plus enforced coverage traceability. Evidence on both sides: the dynamic CONTRACT.md listed literal file paths and import forms per slice and integration "essentially didn't" fail; the graph's night-shift AC paraphrased a formula and the paraphrase was wrong. Injecting code-derived truth instead of prose-derived truth removes the whole "AC drifted from reality" class, and a matrix makes coverage an enforced artifact rather than a prompt-only request.

### 1.5 Structured completion reports + a decision log

Two channels, both injected into dependents' prompts:
- **Completion report** — each context ends with a schema-forced report (deliverables produced, deviations from AC with reasons, warnings for downstream, open questions, structured evidence: `filesChanged`, `testsAdded`, `commandsRun`, `decisionsMade`, `openRisks`). Persisted in the execution log.
- **Decision log** — a `record_decision` MCP tool (sibling of `complete_task`) appending *decision, alternatives rejected, authority cited, affected contracts, downstream contexts bound* to a per-execution structured log. A `propose_decision_change` tool routes a challenge to an established decision through the appropriate gate.

*Why:* the dynamic build agents' `deviations`/`blockers` schema fields demonstrably worked (the UI-shell agent flagged sibling-slice type errors through that channel). The graph has no equivalent — downstream learns about upstream only through git archaeology and AC text — and the floor→round→floor flip-flop happened precisely because final-verification never saw iteration 2's *reasoning*, only its code. Both channels are cheap (a few hundred tokens) and high-leverage; reserve required evidence fields for rigor-flagged contexts so ordinary tasks don't become bureaucratic.

### 1.6 Shared rubric: implementer sees exactly what the validator will check

Generate the validator's checklist from the AC once, at seed time, and show the *same rendered checklist* to the implementer ("you will be validated against:") and to the validator ("validate against:").

*Why:* subtle misalignment between what the implementer optimizes and what the validator later checks produces avoidable NO-GOs and wasted iterations. Validator continuity already exists; this aligns the *other* direction at near-zero cost.

---

## Part 2 — Output quality

### 2.1 Three-valued validator verdicts: GO / NO-GO / ESCALATE

Let the agent validator return `escalate` with a structured reason (`spec_conflict`, `ambiguous_criteria`, `out_of_scope_defect`) instead of forcing every concern into NO-GO-and-iterate. `escalate` routes to the human approval gate with the validator's evidence attached. Pair with a structured **validator-appeal** path for the implementer (`appeal_validation` with evidence + source-hierarchy reference) routed by severity: minor wording → judge agent; source-of-truth conflict → escalate; user-facing trade-off → human gate.

*Why:* codex *saw* that the implementation matched the prototype and the AC didn't — and had no channel to say so. It enforced the AC because that was its only lever, costing an iteration, a wrong TDD test, and a later silent revert. Escalation/appeal converts "validator faithfully enforces a wrong spec" into "human spends 60 seconds adjudicating." *Composition:* extends the validator response schema (`codex-agent-schemas.ts`); the loop treats `escalate` like a gate-pending state.

### 2.2 Adversarial verification of NO-GO findings (built on `collaboration/`)

When the agent validator produces a NO-GO, spawn one cheap skeptic (haiku / low effort) whose only job is to *refute* the finding against the declared sources of truth **before** the engine reopens the task. Refuted → escalate or drop; confirmed → reopen as today. Implement this by extending the existing `cross-review` / `counter-proposal` slice in `src/lib/workflows/collaboration/` rather than greenfield.

*Why:* imported directly from the dynamic review workflow, where per-finding adversarial verification ran 10 verdicts and correctly rejected 1 of 10. With 12/13 contexts passing first-try, NO-GOs are rare, so verifying each is cheap in aggregate — and it guards the graph's most expensive failure mode: a full implementer iteration spent satisfying a wrong finding. This is *engine-initiated and pre-reopen* (catches floor/round before any iteration is spent), complementing the *implementer-initiated, post-reopen* appeal in 2.1.

### 2.3 Validator ensembles and lenses — including a "reality-check" lens

Make validation per-context configurable as an ensemble of lenses: `["acceptance", "integration", "type-safety", "test-quality", "reality-check"]`. Required lenses must pass; optional lenses emit advisory findings for synthesis. The **reality-check** lens is explicitly chartered to judge the product against the *domain* (the real system being simulated/served — e.g. real AeroSpace semantics + the actual `~/.aerospace.toml`), not the spec, and to report **spec smells** (dead capabilities, contradictions, faithful-but-wrong behavior) as advisory findings for the human gate, never as NO-GOs.

*Why:* the dynamic workflow's review dimensions worked because each reviewer had a clear lens; a single broad context validator is too coarse for complex contexts. And reality-check is the *only* mechanism in this proposal that could have caught the four prototype-inherited defects — all of which were invisible to spec-anchored validation by construction. The graph version even unit-tested the focus-capable accordion path that no production code calls (`layoutNode` supports focus; `computeLayout` hard-codes `null`) — a textbook spec smell a "why is this capability dangling?" lens would flag. *Composition:* validator config discriminated union grows a `lenses`/`validators[]` field; `reality-check` defaults onto the integration-sweep context.

### 2.4 Integration sweep as a first-class context type

A built-in `type: "integration-sweep"` context the planner drops in (or the engine appends by default): its prompt is auto-generated from all upstream completion reports + deliverables + decision log; it pins the commit it reviews; its charter is cross-context consistency, end-to-end behavior, and dead-code/wiring checks. Unlike a context validator it is explicitly *global*; its structured output can create remediation contexts (Part 4), not just reopen a local task.

*Why:* final-verification was the second-most valuable context in the run — it caught real gaps 12 GO verdicts missed (App.tsx patches, two screens, `nightshift.ts`, index.html) — but it was hand-authored prose and went into context-window distress (333K tokens). Auto-generating its inputs from structured reports makes it cheaper, repeatable, and harder to forget; pinning the review commit imports the dynamic run's "never review a mutating target" lesson.

### 2.5 Diff-scoped validation

Hand the agent validator the context's exact commit range (the engine already produces per-context commits) and instruct it to review the diff against the AC, exploring the wider tree only as needed.

*Why:* codex averaged 195–290s per context and re-derived project understanding each time despite continuity. Scoping to the diff cuts validator tokens substantially and sharpens findings. The per-context commit discipline already exists (`solo-context-committer.ts`, `lane-committer.ts`) — this is plumbing, not architecture.

### 2.6 Quality profiles

Reusable, named quality bars selected per workflow (`qualityProfile: "interactive-frontend-app"` ⇒ unit + e2e + visual screenshots + console-error check + dev-server smoke + persistence test when localStorage is used + prototype-parity matrix when a prototype exists). The planner uses the profile to generate contexts and validators; the integration sweep uses it to decide whether evidence is complete.

*Why:* the graph product's edge was strong final verification — but it depended on the planner *remembering* the bar. A profile makes the bar a declared, reused artifact. Keep profiles **advisory planner inputs**, not hard runtime gates, to avoid one-size-fits-all rigidity.

### 2.7 Spec lint at planning time

Deterministic checks run by `create_graph_workflow` / `replace_graph_workflow` before a definition is accepted:
- Every file path referenced in an AC exists in the repo.
- `scriptValidator.enabled` ⇒ `preMergeCommand` exists in `CommandCenter.json` (fail at **create** time, not run time).
- Any init script referenced by project config exists and is executable.
- ACs containing literal formulas/numbers alongside a cited source file → warn "cite, don't restate."
- Estimated per-context prompt size (AC + tasks + charter) vs `iterationPolicy.contextLimitTokens` → warn "likely overflow, consider splitting."
- Declared file-ownership overlap between contexts scheduled in parallel → error; between serial contexts → info (predicts contention).
- A downstream context consumes an artifact no upstream context produces; a context is asked to validate work assigned downstream; two contexts name the same concept differently → conflict report.

*Why:* every item maps 1:1 to an observed failure — the `script_validator_missing_command` halt, the missing init script, the floor/round restatement, the 288K/333K overflows, the shared-file serialization, and source contradictions that agents would faithfully amplify. All are statically detectable. Highest leverage-to-effort idea in the whole proposal.

---

## Part 3 — Friction reduction

### 3.1 Pre-flight environment probe with config inference

Before scheduling any context, the engine verifies — in the session worktree or a probe — that the init script runs to completion, `preMergeCommand` executes (even if red), git operations work, reference paths exist, and any required dev server can start. Failures halt with a precise diagnostic **before** any LLM tokens are spent.

When a context needs a browser/dev server but `CommandCenter.json` has no `devServers` entry, **infer a candidate** from `package.json` scripts (`dev`/`preview`/`storybook`) + framework signals + port hints, and propose the config (and any `preMergeCommand`) through an approval gate — don't merely report the gap.

*Why:* run 1 burned ~1.6h of execution + a 3.5h overnight stall + a manual worktree reset on failures a 60-second probe would have caught; and AeroTrainer logged repeated `ensure_dev_server` failures because no dev server was configured, with agents falling back noisily instead of fixing a root cause they have no authority over. The engine performed flawlessly when the environment was sound — so guarantee it is sound first, and turn the common config gaps into one-click remediations.

### 3.2 Failure taxonomy: infrastructure ≠ agent failure

Classify loop errors (`recovery_error`, provisioning, git, merge, dev-server) as **infrastructure** and route them to immediate halt-with-diagnostic; only agent/validation failures consume iterations and feed the circuit breaker.

*Why:* the 21 zombie iterations (each ~40–90s, all `iteration.terminal_error_caught: recovery_error`) plus 22 `parallel.secondary_failure` events until `max_iterations(20)` happened because the circuit breaker assumes failures are agent-shaped. A deterministic provisioning failure will never improve by retrying with an LLM. This also preserves iteration budgets for the failures they were designed for. It is the single highest-impact reliability fix here, and it generalizes what the pre-flight probe (3.1) only prevents for specific known cases. *Composition:* error classification in `execution-loop.ts` / `iteration-failure-with-progress.ts`; new halt reasons.

### 3.3 Mid-flight definition revision + resume (prefix preservation)

Formalize what `runtime-edits.ts` begins: during a halt (or at a gate), allow editing the **pending** subgraph — fix an AC, add/remove/reorder pending contexts, change validator config — while completed contexts stay immutable. Resume continues from the completed prefix (analogous to the Workflow tool's `resumeFromRunId` journal-prefix caching). Every accepted edit bumps the working-definition revision with a recorded diff.

*Why:* run 1's response to two config errors was: abandon the execution, hand-edit the definition (rev 3, then rev 4 just 21 seconds before relaunch), manually reset the worktree, and start over. With prefix-preserving resume, the same incident becomes halt → fix → resume, with all completed work retained. This is the foundation several Part-4 ideas stand on.

### 3.4 Context-window budget management

Three layers: (1) the planning-time size estimate from 2.7; (2) a runtime watch — when an iteration's `contextTokens` crosses ~70% of `iterationPolicy.contextLimitTokens`, the engine warns and offers a `handoff_and_continue` tool (write a structured handoff note, end the iteration cleanly, resume in a fresh iteration seeded with the note); (3) post-hoc, flag any context that exceeded the window so the planner learns to split it.

*Why:* app-orchestration hit 288K and final-verification 333K against a 200K window — silent compaction, where quality degrades invisibly. The fix is making overflow visible and giving the agent a *clean* continuation instead of lossy mid-thought compaction. `contextLimitTokens` already exists as a knob; this gives it teeth.

### 3.5 Script validator: make the failure mode unrepresentable

Default `scriptValidator.command` to the project's `preMergeCommand`; validate it at definition-accept time; and when a remediation edit *disables* a previously-enabled script validator across contexts, require explicit confirmation ("you are removing the deterministic gate — fix the command instead?").

*Why:* the observed remediation to `script_validator_missing_command` was `enabled: false` on all 13 contexts — the run then succeeded with no deterministic gate at the workflow level, which violates CC's own script-before-agent principle and worked only because implementers self-ran `npm run verify`. Guardrails should make the lazy path the correct path.

### 3.6 Retain validator transcripts

Persist full agent-validator transcripts (not just the 0.6–1.8KB final verdict JSON) alongside each context's `validation.jsonl`.

*Why:* during this analysis codex's reasoning was unrecoverable — we know *that* it flagged floor/round, not *how* it weighed the prototype against the AC. For a system whose differentiator is auditability, the validator is currently the least auditable component. Cheap disk, real diagnostic value.

### 3.7 Approval-gate ergonomics (extending the existing gate)

- **Gate digest:** auto-attach the context's diff stat, completion report, validator verdict, and decision-log entries so review takes minutes, not archaeology (CC already computes per-session diffs).
- **Approve-with-comments:** an approval may carry a steering note injected into the next context's prompt (or the same context's next iteration on reject) — reuse the conversation message-queue machinery.
- **Notifications + batch approval:** notify on gate-pending (the push-notification tool exists); allow approving several queued gates at once.
- **Placement guidance** in `graph-workflow-planning`: default gates after charter/contract contexts (where the dynamic orchestrator effectively inserted *itself*), before large fan-outs, and before final merge.

*Why:* the graph's worst calendar losses were human-latency-shaped (the 3.5h overnight halt). Gates intentionally add human latency; the design goal is making each gate cost the human ~2 minutes and never silently stall the run.

### 3.8 Steering channel into pending contexts

Let the human (from the UI, or as an approve-with-comments payload) append a steering note to any pending context; the note is injected into that context's seed prompt. No halt required.

*Why:* mid-run human knowledge currently has no entry point short of halting and editing the definition. The dynamic run had this for free (it was a conversation). Cheap on the existing message-queue + iteration-prompt machinery, and it makes gates more useful: "approve, but: don't restate formulas — cite app.jsx."

---

## Part 4 — Dynamic structure (keeping the graph)

**Design tenet for all of these:** agents never mutate the graph directly. They emit **schema-validated proposals** (`propose_graph_patch`); the deterministic engine checks invariants and applies them under a **policy envelope**, recording every mutation as a working-definition revision. This is the `add_task` model scaled up — and it is what preserves auditability and alignment while importing the dynamic workflow's adaptivity.

**Patch safety rules (enforced by the engine, not the prompt):** no cycles; no editing completed contexts; no removing completed evidence; no moving a running/completed task; no edge that makes an already-ready context depend on unlanded work without parking it; no silent change to the source-of-truth hierarchy; every structural change emits a graph-diff artifact.

**Mutability ladder** (extends `mutability.allowAgentTaskAdd`): `none` → `task-append` (today) → `task-edit` → `context-append` → `edge-append` → `branch` → `validator-append` → `full-proposal`. Each level widens what an agent may propose; **policy decides application** independently — safe append-only changes auto-apply, structural changes pause at a gate with a diff + rationale + new critical path, unsafe changes are rejected.

### 4.0 Liveness policy for every fan-out (cross-cutting)

Any parallel batch — expansion nodes (4.2), review/verify subgraphs (2.2), speculative design lenses — carries `{ timeoutMs, minSuccessfulContexts, onTimeout: synthesize_partial | spawn_replacement | halt | ask_human, requiredDimensions }`. Required dimensions can halt-or-gate on timeout; optional ones synthesize-and-disclose-the-gap.

*Why:* the dynamic workflow's single worst failure was a hung agent stalling a `parallel()` barrier with no per-agent timeout — recoverable only by manual journal salvage. The graph must not import fan-out without importing the liveness guard. *Composition:* the lane/join machinery (`lane-readiness.ts`, `join-runner.ts`) already models fan-in — add batch-policy fields and a per-lane deadline.

### 4.1 `propose_context`: the next rung on the mutability ladder

A new implementer/validator MCP tool, gated by `mutability.allowAgentContextAdd` plus `maxAgentAddedContexts`. The proposal carries the full context shape — id, title, description, AC, dependencies, deliverables — and must be self-contained (same rule as `add_task`: "the executing agent has no access to your conversation context"). Policy decides auto-accept vs. queue-for-approval; either way it lands as a revision.

*Why:* the most direct "more of what `add_task` does" extension. final-verification discovered cross-cutting gaps and fixed them *inside its own overloaded 333K-token context* because it had nowhere to put discovered work; with `propose_context` it could have spawned small, fresh-context fix-and-verify contexts — better token economy, isolation, and audit trail. *Composition:* `tool-server.ts` + `runtime-edits.ts` + scheduler eligibility recompute.

### 4.2 Expansion nodes: declare *where* the graph is unknown

A definition may contain an `expansion` placeholder: a context template + a designated *filler* context whose completion report includes a schema-validated `items: [{id, title, acceptanceCriteria, ...}]`. On the filler's completion, the engine instantiates one context per item from the template (with caps, the 4.0 liveness policy, and an optional gate), wiring declared dependencies.

*Why:* imports the dynamic workflow's scout → fan-out shape declaratively. The AeroTrainer plan hard-coded 5 mode contexts because the planner *happened* to know there were 5; a migration/audit/review workflow often can't know its fan-out until an early context explores. The crucial property: the *shape* of dynamism is declared and human-reviewed at planning time even though the *contents* are discovered at run time. Review-fix pipelines (sweep finds N issues → one fix-verify context per issue) become expressible — that is the dynamic review workflow, with per-finding isolation and audit, inside the graph.

### 4.3 Conditional edges and skippable contexts

Edges (or contexts) carry a `when` guard evaluated **deterministically** by the engine over typed data: fields of upstream completion reports (`report.flags.needsMigration`), script exit codes, file-existence checks, or validator verdict categories. A guard-false context resolves as `skipped` and satisfies its dependents (configurable: satisfy vs. propagate-skip). Start with explicit **router contexts** (produce a structured decision artifact; outgoing edges hold predicates over it); add native conditional edges later.

*Why:* today every planned context always runs, so planners either omit contingency work (and lose it) or include it (and waste tokens when it is unneeded). Guards enable remediation that runs only when the sweep found issues, platform-conditional work, and "polish only if budget remains." Keeping guards deterministic — agent *sets a typed flag*, engine *evaluates* — is the agent-offloading principle applied to control flow, and keeps the graph statically reviewable: a human can still see every branch that *could* run.

### 4.4 Dynamic review subgraphs (templated)

Make review swarms a first-class, templated graph feature on top of `collaboration/`: `parallel_review` (N independent reviewers, distinct dimensions), `review_then_verify` (reviewers produce findings; verifier contexts confirm/reject each), `synthesis` (group confirmed findings into remediation tasks/contexts), `adversarial_pair` (defender vs. attacker vs. judge). Findings are structured (id, severity, evidence, source authority, affected files/contexts, confidence, suggested remediation, verification status); all batches inherit the 4.0 liveness policy.

*Why:* the dynamic workflow's review phase found real issues — its only problem was orchestration reliability, not the pattern. The graph can run the same pattern with durable state, timeouts, partial-result salvage, per-finding verification, and optional approval before large remediation. This generalizes 2.2 from "verify one NO-GO" to "run a whole adversarial review where it pays" (integration sweeps, contract contexts, prototype-parity audits).

### 4.5 Failure routing: remediation subgraphs instead of bare halts

Per-context `onFailure` policy: when iterations exhaust or the circuit breaker trips, instead of halting the engine instantiates a predefined **diagnostic context** (kiro-debug-shaped: root-cause-first, no fixing) whose completion report proposes retry-original (findings injected), split-the-context (via 4.1/4.2), or escalate-to-human (diagnosis attached). Cross-context issues found by the integration sweep likewise spawn scoped remediation contexts (`remediate-night-shift-parity`, `fix-dev-server-config`) rather than overloading the final context.

*Why:* the circuit breaker today is a one-way door to a halt, and halts cost hours of human latency (observed: 3.5h). Diagnosis-then-route converts "stuck, wake the human eventually" into "here is what's wrong and a proposed graph change; approve to continue," and gives the retry loop *fresh-context* debugging instead of the same agent grinding in the same rut.

### 4.6 Read-only exploration contexts

Allow agents to add `readOnly: true` exploration contexts during execution (no write tools, no lane commit, artifact output required): "inspect the reference app's scoring behavior," "compare current CSS with prototype CSS," "find all persistence keys and verify no collisions."

*Why:* dynamic workflows fan out investigation without blocking implementation; the graph can preserve that by running read-only contexts aggressively in parallel — they never contend on worktrees, so there is no merge risk and the scheduler can be liberal with them.

### 4.7 Planner-in-the-loop restructuring

At a halt or gate, invoke the existing `__planner__` session with the live execution state (completed contexts + reports + decision log + remaining definition) to propose a revised pending subgraph via the planner-draft-registry side channel. Human approves the diff; engine resumes via 3.3. A milestone-triggered **parallelization advisor** is a constrained special case: after foundation/contract contexts land, it may propose removing dependency edges among not-yet-started independent contexts, but only after *proving* disjoint ownership (via 5.1) — never on a hunch.

*Why:* closes the loop between mechanical resume (3.3) and real re-planning. The dynamic workflow's deepest advantage was a *mind* that could redesign remaining work when reality diverged from the plan; the graph can have the same thing as a discrete, auditable, human-gated event rather than a continuously-improvising orchestrator. All the machinery exists — this is composition, not new infrastructure.

---

## Part 5 — Parallelism without losing alignment

(Lower priority per the trade-off, but these reduce *tokens and risk*, not just time.)

### 5.1 File-ownership map + spine contexts

The planner declares per-context file-ownership globs; the engine enforces them deterministically (post-iteration `git diff --name-only` vs. ownership — the same check as 1.3 with `mayAmend` semantics). Shared files are assigned to a **spine context** that runs serially while owners of disjoint files run in parallel lanes; spec lint (2.7) flags overlaps at plan time.

*Why:* the five modes serialized — ~2.1h of critical path — *only* because each touched `App.tsx` / routing / contract files. The dynamic run solved this exact problem by having the orchestrator own the shared files while 7 agents wrote disjoint slices (zero conflicts, no worktrees needed). Ownership declarations convert "serialize everything to be safe" into "serialize only the spine."

### 5.2 Registration points: deterministic assembly instead of shared-file edits

For the recurring "every feature edits the central registry" pattern, support a declared **registration point**: each context writes its own fragment file (e.g. `src/modes/<mode>/route.ts`); a deterministic script (not an agent) assembles the registry; the script runs as part of the script-validator step.

*Why:* "push variation to the edges" applied to the merge problem. Mode contexts then never touch shared files at all — full parallelism, zero merge risk, no LLM tokens spent on conflict resolution. It also matches how good plugin architectures already work, so `graph-workflow-planning` can recommend it as a decomposition pattern. This is a stronger answer to the serialization problem than detecting disjoint surfaces after the fact: it *creates* them by construction.

---

## Part 6 — Cross-cutting: budgets, validation economy, and learning

### 6.1 Token budgets with policy

Optional per-workflow and per-context token budgets. The engine tracks SDK cost (already recorded per iteration) and applies policy on breach: warn → require gate approval to continue → skip `optional: true` contexts. Budget state surfaces in the UI and in completion reports, and gives conditional guards (4.3) something principled to condition on ("polish if budget remains").

*Why:* token economy is the stated secondary axis, yet today there is no token-denominated control at all. The data already exists (the $126.21 figure came from recorded SDK results) — this is policy over existing telemetry.

### 6.2 Tiered / risk-gated agent validation

Run the agent validator selectively: always after the deterministic gates, but downgrade to a cheap model (or skip) when risk signals are low — small diff, first-iteration script-validator pass, no new dependencies, low AC complexity — and escalate to codex-xhigh only on failure, large diffs, or `critical`-flagged contexts.

*Why:* ~46 minutes of serial codex was spent mostly *ratifying* 12 first-try passes; the one real catch was AC-precision-dependent anyway. With deterministic gates restored (3.5), typed deliverable checks (1.4), and adversarial verification of findings (2.2), the expensive validator can concentrate where it pays — integration sweeps, contract contexts, failure follow-ups — for significant token savings at negligible quality cost.

### 6.3 Completion retrospectives → planner feedback loop

At terminal, auto-generate a structured retrospective: original graph vs. final graph, dynamically-added contexts, validator failures, human approvals/rejections, friction points, and spec smells found by the reality-check lens. Stored as *recommendations for review* — **never** auto-applied to global templates or planner guidance from a single run.

*Why:* nothing else here closes the learning loop, yet this very AeroTrainer analysis *is* such a retrospective, produced by hand. Make the engine emit it so the planner skill and workflow templates can improve from real executions, with a human deciding what generalizes.

### 6.4 UI legibility for dynamic graphs

Once graphs mutate at runtime, the UI must show original-vs-current graph, highlight agent-added contexts, render skipped conditional branches, surface patches awaiting approval (with diff + rationale + affected contexts + new critical path), show which required artifacts a context has acknowledged, and explain why a context is blocked.

*Why:* dynamism that reduces agent friction while increasing human confusion is a net loss. Legibility is what keeps "audited dynamism" auditable by a *person*, not just by a log — and the audit trail is the graph workflow's standout property.

---

## Prioritization

| Tier | Ideas | Rationale |
|---|---|---|
| **Now (small, kills observed failures outright)** | 2.7 spec lint · 3.1 pre-flight + config inference · 3.2 failure taxonomy · 3.5 script-validator defaults · 1.5 completion reports + decision log · 3.6 validator transcripts · 3.7 gate ergonomics | Each maps 1:1 to a concrete observed failure; all are deterministic code; none changes the execution model. |
| **Next (alignment & quality core)** | 1.1 charter · 1.2 source hierarchy · 1.3 contract freeze · 1.4 typed deliverables + test-plan · 2.1 ESCALATE + appeal · 2.2 adversarial verify (on `collaboration/`) · 2.4 integration sweep · 2.5 diff-scoped validation · 2.6 quality profiles · 3.8 steering channel | Imports the dynamic workflow's proven alignment mechanisms as engine invariants; ESCALATE + skeptic fix the only real validation failure observed. |
| **Then (dynamic structure)** | 3.3 revision + resume → 4.0 liveness policy → 4.1 propose_context → 4.3 conditional edges → 4.2 expansion nodes → 4.4 review subgraphs → 4.5 remediation subgraphs → 4.7 planner-in-the-loop | Strict dependency order: resume semantics + liveness policy underpin everything; propose_context generalizes add_task; expansion/review/conditionals build on the proposal validator; planner-in-the-loop composes all of it. |
| **Opportunistic** | 5.1 ownership map · 5.2 registration points · 2.3 reality-check lens · 4.6 read-only exploration · 3.4 context budgets · 6.1 token budgets · 6.2 tiered validation · 6.3 retrospectives · 6.4 UI legibility · 1.6 shared rubric | High value, mostly independent; schedule by appetite. 6.4 becomes load-bearing the moment any Part-4 dynamism ships. |

**If I had to pick five concrete builds:** (1) **spec lint + pre-flight + failure taxonomy** as one "never lose a run to config again" package; (2) **charter + source hierarchy + contract freeze + typed deliverables** as the alignment core (the verified causal mechanism behind the best result either workflow produced); (3) **ESCALATE/appeal + adversarial verify** on the existing `collaboration/` slice; (4) **revision-and-resume → propose_context**, every fan-out under the 4.0 liveness policy; (5) **integration sweep + reality-check lens** as the first-class home for cross-context and against-reality quality.

---

## Considered and deprioritized

- **Speculative full-implementation branches with convergence.** Running 2+ complete implementation branches to discard all but one is a poor token trade given the stated priorities, and it misreads the precedent: the dynamic workflow's design phase was a *multi-modal sweep of complementary lenses, not a competing judge panel* (its own README says so). The cheap, correct version is multiple *design/exploration* lenses — read-only, gated, already covered by expansion nodes (4.2) and read-only exploration (4.6). Keep speculative *implementation* branches as a rare, explicitly-opted-in tool for genuinely irreversible architecture forks, never a default.

---

## What not to change

- **Fresh context per execution context.** It is why the graph run cost half the dynamic run; ideas 1.1/1.4/1.5 exist precisely to give fresh contexts the alignment a single long-lived conversation gets for free.
- **Determinism of the engine.** Every dynamic feature above is "agents propose typed data, engine applies under policy" — never "agent edits the graph."
- **The audit trail.** It is the graph workflow's standout property (this entire analysis depended on it); every new mutation type must land in the execution log with the same fidelity, and 6.4 keeps it legible to a human.
- **Human-reviewable plans.** Expansion nodes and conditional edges keep dynamism *declared* — a reviewer can still see every shape the run could take, which is the property the dynamic workflow fundamentally lacks.
