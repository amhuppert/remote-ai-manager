# Collaboration Report: Native Spec-Driven Development in Command Center

| Field | Value |
|---|---|
| Conversation | Command Center-Native SDD 2 |
| Conversation ID | e13b46c3-c213-40a4-9a61-6e3c72dec5e8 |
| Collaboration workflow ID | ae7e14f0-0c71-4450-82ed-a01bd89e1958 |
| Participants | Claude as agent one; Codex as agent two |
| Negotiation | One completed round |
| Agreement | Full convergence; no user arbitration required |
| Workflow failure | Temporary Claude API 529 overload after convergence |
| Recovered | July 16, 2026 |

## Executive conclusion

Native spec-driven development is worth pursuing if Command Center builds the strong version: not a document-generation wizard, but a living product object that the system can understand, review, execute, observe, and learn from.

The resulting product is an **intent-to-evidence control plane**:

**intent → review → enforced approval → reviewed execution plan → isolated execution → criterion-level evidence → controlled delivery**

The key differentiator is not generating requirements, design, and tasks. Kiro skills already do that. The differentiator is making identity, revisions, approvals, relationships, execution scope, and evidence durable product state that every Command Center subsystem can act on.

## 1. The native spec model

A spec becomes a versioned, addressable package: a typed envelope of stable IDs, relationships, revisions, approvals, and evidence around flexible Markdown narrative.

The package contains:

- **Intent:** problem, outcomes, non-goals, success measures, and constraints.
- **Requirements:** stable IDs, scenarios, acceptance criteria, priority, risk, status, citations, and open questions. EARS is optional where useful, not mandatory.
- **Design:** components, contracts, decisions, rejected alternatives, risks, migrations, and validation strategy.
- **Plan:** tasks, dependency edges, criteria coverage, affected areas, suggested execution settings, and gates.
- **Evidence:** diffs, commits, tests, validator verdicts, screenshots, approvals, and exceptions.
- **History:** revisions, comments, approvals, and reasons for material changes.

Three structural commitments are essential:

1. **Approved revisions are immutable.** Every execution pins an exact revision and scope, preventing later edits from silently changing running work.
2. **Authoring and execution have separate lifecycles.** Spec revisions move through authoring phases; implementation and delivery runs pin a revision and own separate states. One revision can have multiple runs.
3. **Related domains stay distinct.** Tickets, specs, execution runs, and merge jobs have different identities and lifecycles. They should be linked with provenance and presented as one navigable lifecycle graph, not forced into a shallow mega-entity.

Execution scope is a core concept even for a single operator because partial implementations, deferred criteria, retries, and staged delivery are routine.

## 2. Enforced, policy-aware gates

The clearest native advantage is changing gates from prompt etiquette into a server-enforced mechanism. Approval becomes durable state. An agent attempting an invalid transition receives a machine-readable refusal and cannot falsely advance the lifecycle.

Enforcement should recognize three policies:

- **Contract-bearing execution** cannot claim implementation or verification until required gates pass.
- **Exploratory execution** may run spikes, gap analysis, and prototypes before approval but cannot mark the spec complete.
- **Fast-path execution** deliberately reduces gates for small work without becoming a separate workflow system.

Approval should also become granular:

- Approve individual requirements and decisions.
- Track approved-with-conditions as explicit obligations.
- Invalidate only approvals affected by an amendment.
- Review semantic changes such as removed criteria or changed contracts instead of raw line diffs.
- Attach specialist agent reviews for security, UX, architecture, and testability while keeping the human as sole approver.
- Route approvals through existing jobs, notifications, Active Work, and Needs You surfaces, deep-linked to the exact decision.

## 3. Spec Studio from existing Command Center primitives

Spec Studio should largely compose existing capabilities:

- AnnotatedMarkdown and document feedback for inline requirements and design review.
- Message-reference chips for requirements, tasks, and decisions in any conversation.
- Status chips and typed SSE events for live phase, gate, validation, and evidence updates.
- A traceability graph from goal to requirement to decision to task to diff to evidence.
- Focused views for decisions, risks, coverage gaps, and approvals.

This should be a new domain surface, not a fourth orchestration engine.

## 4. Guided elicitation and spec linting

Before generation, Command Center can use repository context, steering documents, validation commands, and prior decisions to find missing actors, unmeasurable outcomes, absent failure behavior, and conflicting constraints.

Useful native mechanisms include:

- Small, targeted question batches.
- An assumption ledger with confirm, reject, and defer actions.
- An autonomy dial by concern.
- Risk-selected project checklists for areas such as migrations, recovery, accessibility, and UI states.
- A hard complexity budget: fast-path skippability, visible and removable prompts, and data-pruning when portfolio evidence shows a prompt no longer pays for itself.

Structured relationships also enable deterministic linting:

- Every criterion has a task and validation strategy.
- Every task traces to a requirement, or is flagged as possible scope creep.
- The task graph is acyclic and executable.
- Non-goals do not leak into the plan.
- Terms remain consistent across requirements, design, tasks, tickets, and steering.
- Declared sources of truth do not contradict one another.

Deterministic checks should run first, with agent judgment reserved for semantic questions.

## 5. The reviewed bridge to graph workflows

Approved product tasks should not be treated as automatically executable workflow plans. Execution additionally requires isolation, lane ownership, fan-in, validation scope, retries, concurrency, continuity, and merge behavior.

Native SDD should therefore generate and validate a **reviewable execution-plan projection**:

- Task groups become execution contexts.
- Dependencies become graph edges.
- Lanes and worktrees are chosen from ownership and affected code.
- Each lane receives a narrow context pack containing only its task, relevant requirements, decisions, and steering.
- Acceptance criteria seed validator briefs.
- CommandCenter.json supplies deterministic validation commands.
- Human gates are added at risky migrations and design boundaries.
- Budgets, retries, and circuit breakers reflect feature risk.
- Newly discovered work becomes a proposed scope amendment rather than silent expansion.

Direct compile-and-run is appropriate only when the spec already contains complete execution metadata.

## 6. Criterion-level evidence and controlled delivery

Task completion is not sufficient proof. Each acceptance criterion should accumulate an evidence bundle:

- Relevant diff hunks and commits.
- Passing tests and deterministic validator results.
- Agent verdicts with citations.
- Dev-server screenshots or recordings.
- Accessibility and performance results.
- Human approval and explicit exceptions.

This evidence powers:

- A completion view answering “what proves this?” for every criterion.
- Diff annotations showing which requirement or task motivated a change.
- Filters by requirement, lane, and risk.
- Detection of unrelated changes before merge.
- Intent-aware conflict review.
- Smart Merge gates based on the pinned revision’s selected scope, critical criteria, valid approvals, and waivers.
- Spec-derived pull-request descriptions, squash narratives, and release notes.

Merge policy must be scoped. Deferred, waived, superseded, or separately delivered criteria must not create false blocks.

## 7. Change impact, drift, and authority

Stable identities make change impact a practical first fast-follow:

- A changed requirement identifies dependent decisions, tasks to reopen, stale running contexts, invalidated evidence, and approvals to renew.
- Reverse traceability flags implementation drift, unrequested behavior, and deleted proof.
- Every drift finding resolves through one of three explicit actions: fix the implementation, revise the spec, or record an approved exception.

Cost should remain disciplined: deterministic invalidation first, change-triggered analysis second, agent judgment last. Scheduled semantic review should be reserved for high-risk specs.

Conversations and external sources should feed the spec without becoming competing sources of truth:

- Convert selected conversation text into proposed requirements, decisions, risks, or structured spec patches.
- Show a spec lens beside each conversation with relevant requirements, current decisions, open questions, and revision warnings.
- Let tickets graduate into specs and approved tasks materialize as linked tickets.
- Declare authority and precedence among product policy, charters, ADRs, existing behavior, and other reference documents.
- Flag specifications when a cited source changes.

## 8. Multi-agent authoring

Collaboration Mode can become a native specification technique:

- Parallel independent drafts.
- Cross-provider critique, such as Claude drafting and Codex refuting.
- Red-team review and pre-mortems.
- Specialist security, UX, architecture, and testability lenses.
- Persona and dependency simulations.
- Judge panels comparing design alternatives.

Because outputs are typed proposals, comments, and verdicts, Command Center can merge compatible findings, preserve dissent, and route only unresolved choices to the human.

## 9. Agent ergonomics and Kiro migration

A typed **cctl spec** command family should become the agent mutation boundary. It should support status queries, requirement lookup, evidence-backed task completion, approval submission, stable JSON envelopes, typed exit codes, and machine-readable gate failures.

This removes the failure class where an LLM edits spec.json directly and corrupts workflow state.

It also provides the migration path:

- Kiro skills become thin clients over the native API.
- An importer brings existing .kiro/specs into the native model.
- Kiro may continue generating prose, while all authoritative mutations and transitions go through native validation.

The product must maintain one SDD system, not parallel native and skill-owned systems.

## 10. Living memory and longer-term opportunities

Once completed specs are durable and queryable, Command Center can add:

- A steering feedback loop that proposes recurring constraints or decisions as steering updates with source citations.
- Portfolio analytics for missed requirement types, estimate accuracy, validation value, failure-prone task shapes, and risk forecasts.
- Reusable requirement packs and design-pattern cards tied to project decisions.
- Executable contracts generated from selected criteria.
- Counterfactual planning across minimal, robust, and platform variants.
- Spec simulation with users, dependent services, operators, and attackers.
- Semantic blame linking behavior to the requirement and decision that authorized it.
- Change budgets that require approval when blast radius exceeds a threshold.
- Confidence maps for weak, stale, or disputed intent and evidence.
- Decision-expiry triggers.
- Spec-derived regression evaluations.
- Architecture radar derived from recurring design dependencies.

## 11. Existing capability leverage

| Existing Command Center capability | Native SDD value |
|---|---|
| Graph workflows | Execute reviewed plans with parallelism, gates, validators, retries, and circuit breakers |
| Worktree-isolated sessions and lanes | Safe parallel implementation with task-level provenance |
| Human gates, Needs You, and parked states | Resumable, enforceable checkpoints |
| Typed SSE and Active Work | Live state and precise attention requests |
| Jobs and notifications | Durable approvals, gap analysis, and targeted drift checks |
| AnnotatedMarkdown and document feedback | Granular requirements and design review |
| Message references and chips | Addressable requirements, tasks, and decisions |
| Deterministic and agent validators | Spec linting and criterion verification |
| Diff viewer and Smart Merge | Intent-aware review, scoped gates, and generated delivery narratives |
| Dev-server automation | Durable visual and behavioral evidence from the correct worktree |
| Tickets | Graduation, task materialization, and progress roll-up |
| Collaboration Mode and backend neutrality | Independent drafts and adversarial cross-provider review |
| cctl | A safe, typed agent mutation boundary |
| State store and contract tests | Durable repositories with round-trip guarantees |
| Compaction and context discipline | Narrow per-lane context packs instead of whole-spec dumps |

## 12. Recommended staged sequence

### Stage 1: Make review and state first-class

Import Kiro specs; add stable identities for requirements, decisions, tasks, approvals, and revisions; build semantic review, inline comments, enforced gates, notifications, and a portable projection.

### Stage 2: Connect specification to execution

Generate a reviewed execution-plan projection; run it through graph workflows; add requirement-to-task-to-diff-to-evidence traceability, narrow context packs, criterion-level completion, and spec-aware diff review.

### Stage 3: Close the delivery loop

Integrate tickets, visual acceptance evidence, scoped Smart Merge gates, generated delivery narratives, impact analysis, targeted drift detection, and source-revision tracking.

### Stage 4: Learn across features

Add steering proposals, reusable packs, portfolio views, confidence maps, and spec-derived evaluations.

## 13. Foundational open decision and constraints

The collaboration intentionally did not choose whether canonical authored content should live in SQLite, the repository, or a hybrid. That choice needs explicit design work against these agreed invariants:

1. Spec and revision identity is stable and worktree-neutral.
2. Approved revisions are immutable and tamper-evident.
3. Every execution pins an exact revision and scope.
4. Approval, review, evidence, and run state are worktree-neutral.
5. Each concern has one authoritative representation; there is no silent bidirectional synchronization.
6. A portable, reviewable, and recoverable repository representation or export always exists.

A DB-first control plane removes file conflicts and improves shared access but weakens Git-native history, clone portability, disaster recovery, and external tooling. A repository-first model reverses those tradeoffs. The recovered answer leaned toward DB-first operational state with a Git-projected authored layer, but explicitly recorded that as a leaning rather than a decision.

Other constraints to preserve:

- Keep authoring prose-first and avoid forms-first over-structuring.
- Migrate through thin-client Kiro skills and an importer so two divergent systems never coexist.
- Preserve a fast path and continuously prune elicitation overhead.
- Treat the five-step wedge as a falsifiable product experiment.
