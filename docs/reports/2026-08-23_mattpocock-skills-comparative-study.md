# mattpocock-skills comparative study

> **Superseded — retained as a source input.** The canonical report is
> [`2026-08-23_mattpocock-skills-consolidated.md`](./2026-08-23_mattpocock-skills-consolidated.md),
> which uses this document as its **backbone**: its judgments, ownership boundaries, promotion/kill
> gates, evaluation discipline, and skill-by-skill accounting govern the consolidation.
> The consolidated report re-verified this document's recommendation-bearing factual claims against
> current code and **struck or corrected several of them** — most notably the `CONTEXT.md`
> graph-profile "contradiction" (not a contradiction) and the shape of the project-conversation
> reference-document finding (a documented constraint, not an accidental drop). See its §4.4.
> Read this file for the original reasoning; act from the consolidated report.

**Date:** 2026-08-23  
**Scope:** mattpocock-skills compared with Command Center native surfaces, the agentic-engineering-principles plugin, and the ai-resources plugin  
**Outcome:** analysis and proposal sketches only; no product, skill, plugin, config, or steering changes are implemented

## Executive verdict

Do not import mattpocock-skills wholesale. Its philosophy is largely compatible with Command Center, but much of its implementation is prompt-managed, tracker-specific, Claude-specific, or already represented more reliably by CC and the two plugins.

The strongest portable ideas are:

1. Model unresolved work as a dependency graph with a visible **frontier**, not a flat checklist.
2. Make agents responsible for finding environmental facts and humans responsible for consequential decisions.
3. Treat maps and handoffs as indexes of stable source artifacts, not copies of them.
4. Make phase-boundary context choices explicit and purpose-aware.
5. Require evidence that can actually go red and green, especially during diagnosis.
6. Keep Standards and Spec review independent so success on one axis cannot mask failure on the other.
7. Turn staged, rerunnable human walkthroughs into secure, resumable product experiences only when a skill cannot supply the needed persistence and policy.

Most of the engineering doctrine is already incorporated:

- CC owns worktrees, execution graphs, retries, validation, gates, agent jobs, source-grounded compaction, typed artifacts, questions, approvals, and native SDD.
- AEP owns deterministic offloading, structured output, progressive disclosure, guardrails, designed friction, live verification, and evidence-earned guidance.
- AIR owns objective clarification, requirements/planning, tests, standards review, conflict resolution, browser/performance diagnosis, handoffs, and developer utilities.

The plausible CC product opportunities are therefore narrow and conditional:

- prerequisite metadata and a derived decision frontier on existing native-SDD objects, only if a managed pilot proves durable-state demand;
- revision-bound ticket delegability, only if tickets become automated intake/backlog;
- recipient/objective-aware transfer composition, only if managed guidance cannot reliably compose current primitives;
- an experimental staged external-human-procedure primitive with opaque secret references;
- later experiments with one workflow trigger class and interactive-session destructive-Git policy.

Prototype work should begin as a managed convention, not a subsystem. CC already has the cross-domain **Needs You** projection; new human-owned states should extend it rather than create another attention model.

Before any adoption, repair current boundaries exposed by the comparison: malformed agent-run manifests must not complete as “zero documents”; project conversations must not silently ignore registered reference documents; and drifted CC skills/help should be brought back to current `cctl` surfaces.

## Method and coverage

The review covered:

- **MATT:** all 25 promoted skills (18 engineering, 7 productivity), all 4 unpromoted `misc` skills, all 7 `in-progress` skills as lower-confidence evidence, the empty historical `deprecated/` bucket, and operative references/scripts including `.out-of-scope/`, `PHASE-BOUNDARIES.md`, `DESIGN-IT-TWICE.md`, `OUT-OF-SCOPE.md`, prototype guides, and invocation metadata.
- **CC:** `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `.kiro/steering/`, managed/local skills, typed `cctl` help and implementation, tickets, agent runs, compaction/reference docs, validation, graph workflows, Needs You, and native SDD.
- **AEP:** all 13 skill spines.
- **AIR:** all 36 skill spines plus relevant agents, hooks, references, scripts, resources, and MCP configuration.

Every idea was judged twice: philosophically (authority, evidence, autonomy, context) and practically (prompt prose, skill method, hook, schema, deterministic command, durable orchestration, or human gate).

Three focused corpus audits were challenged by an independent one-shot review at `memory-bank/agent-runs/mattpocock-skills-independent-review.md` and reconciled against current source. That challenge narrowed the proposed CC state, reclassified Needs You as incorporated, and surfaced the baseline reliability findings below. This file is this agent's consolidated synthesis. `docs/reports/2026-08-23_mattpocock-skills-comparative-analysis.md` is a separately authored alternative synthesis.

“Promoted” means shipped by the source repository, not empirically validated. AEP is guidance-only: it can rule out a duplicate doctrine/skill, but only current CC code proves mechanical incorporation. AIR likewise supplies procedures and roles unless a host enforces their state.

## Philosophical comparison

| Axis | mattpocock-skills | Command Center | AEP | AIR | Judgment |
|---|---|---|---|---|---|
| Composition | Small skills and artifacts; together an opinionated idea-to-ship path | Deep composable product modules and lifecycle objects | Narrow cross-referenced doctrines | Broad task skills and specialists | Strong compatibility; compose semantics, do not import the lifecycle. |
| State owner | Model/tracker maintains maps, claims, frontiers, labels, and phases | Typed persistent state, CAS, queues, lanes, retries, and recovery | Code owns repeatable facts; model owns judgment | Many workflows still make the model the engine | Matt's semantic vocabulary is useful; CC/AEP ownership is stronger. |
| Human/agent split | Agent finds facts; human decides | Autonomous inside policy; human at consequential gates | Deterministic facts vs. model judgment | Varies | Adopt the heuristic, but agents keep reversible local decisions. |
| Work topology | Decision trees, ticket blockers, ready frontier, fog | Execution DAGs, dynamic expansion, validators, joins | Reliability constraints, not lifecycle | Plans and phases, mainly prompt-run | Execution topology is incorporated; discovery prerequisites are partial. |
| Context | Pointers, maps-as-indexes, loss accounting, tailored handoffs | Source-grounded compaction, typed attachments/docs, bounded reads | Progressive disclosure and file manifests | Save/compress/handoff files | Missing value is recipient/objective-aware composition, not another summary blob. |
| Evidence | Primary sources, red-capable loops, one-question prototypes, two review axes | Registered validation, fixtures, live systems, proof records | Live verification, logs, retrospectives | Strong concrete adapters | Mostly incorporated; general diagnosis packaging is missing in AIR. |
| Guidance | Leading words, positive phrasing, completion demand | Small root plus managed skills/typed help | Earned docs, feedback tiers, disclosure | Mixed age and quality | Consolidate with existing `writing-great-skills`; do not create three owners. |
| Safety | Human control, but prompt-assumed mutations, shell hooks, secret-writing Bash, and no-abort absolutes | Capability/lifecycle policy, worktree isolation, write envelopes, typed refusals | Mechanical guardrails and designed friction | Uneven | Preserve intent; replace source mechanics with typed policy. |
| Scope | Engineering, teaching, writing, personal workflow | Coding-agent control plane | Agent-system doctrine | Developer/productivity toolbox | Teaching/literary methods are not CC product gaps. |

### Alignment and conflict

All four corpora value source discovery before execution, compact maps over copied bodies, fresh independent contexts, public-seam verification, durable artifacts, and mechanical enforcement. Representative evidence: MATT's decision frontier (`MATT/skills/productivity/grilling/SKILL.md:6-28`), map-as-index (`MATT/skills/engineering/wayfinder/SKILL.md:19-25`), and pointer discipline (`MATT/skills/productivity/writing-for-agents/SKILL.md:10-43`); CC composability/offloading (`CC/.kiro/steering/engineering-principles.md:54-99`); AEP offloading/disclosure (`AEP/skills/agent-offloading/SKILL.md:8-73`; `AEP/skills/query-output-disclosure/SKILL.md:21-57`); and AIR behavior-first testing (`AIR/skills/write-tests/SKILL.md:8-68`).

The central conflict is **who owns the loop**. MATT frequently asks the model to maintain dependency state, launch agents, mutate trackers, manage worktrees, count progress, and decide completion. CC and AEP assign those facts to typed orchestration. The portable part is the semantic model—decision, fact, blocker, frontier, evidence, fog—not its prompt-managed runtime.

MATT also criticizes process-owning frameworks for reducing control and making process bugs hard to repair (`MATT/README.md:17`). Applied literally, that conflicts with CC's product category. Applied as a constraint, it is useful: CC processes should remain observable, inspectable, repairable, and available through a lightweight path. Typed enforcement remains preferable for load-bearing bookkeeping.

MATT's default human-interruption posture is also too aggressive. Exhaustive grilling is suitable only as an explicitly selected attended mode. Normal CC work should research facts first, ask only the consequential current frontier, batch independent questions, and retain autonomous-turn restrictions.

## What is already incorporated

| MATT concept | Existing CC mechanism | Existing plugin mechanism | Disposition |
|---|---|---|---|
| Blocking edges, ready frontier, parallel implementation | Graph tasks/contexts/edges, lanes, runtime expansion, joins, validators, merges | AEP offloading; AIR planning roles | **Incorporated for execution.** Do not add a ticket-graph executor. |
| Spec → tasks → implementation → review | Kiro phases; native-SDD revisions, decisions, tasks, evidence, delivery candidates | AIR requirements/plan/design/tests | **Incorporated.** Reject length-maximized specs. |
| Facts from agents, decisions from humans | `cctl ask`, alignment decisions, native questions/assumptions, approval gates | AEP offloading/designed friction; AIR objective clarification | **Authority incorporated; dependency-aware discovery partial.** |
| Context pointers and maps | Reference docs, ticket attachments, workflow docs, compaction, bounded transcript reads | AEP disclosure/structured output; AIR save-current-context | **Strongly incorporated.** Add recipient/objective composition only. |
| Primary-source research | Job-shaped agent runs, registered docs, research tickets, read-only contexts | AIR research/subagent methods | **Mechanics incorporated; managed method/pattern missing.** |
| Red-capable feedback construction | Root TDD, registered validation, fixtures, dev servers, live verification | AIR test/browser/perf tools; AEP live verification | **Partial.** AIR lacks a general minimize/hypothesize/instrument/cleanup router. |
| Deep modules and mechanical boundaries | CC engineering contract, domain context, seam ratchet, architecture tests, write envelopes | AEP mechanical guardrails | **Incorporated through CC/AEP.** Exact MATT terminology is not universal law. |
| Separate Standards and Spec axes | Native-SDD/graph evidence plus specialist validator cohorts | AIR standards reviewers | **Packaging partial.** Extend the existing adversarial-verification pattern. |
| Conflict intent reconstruction | Smart Merge and worktree lifecycle | AIR fix-merge-conflicts | **Incorporated.** Reject “never abort.” |
| Human approvals/checkpoints | Durable workflow user-input and approval gates, SDD signoff | AEP designed friction | **Incorporated for decisions; staged external procedures remain narrower.** |
| Progressive skill/help routing | Managed skills, typed leaf help, related-command graph, profiles/patterns | AEP progressive disclosure | **Strongly incorporated.** Any goal guide must federate existing owners. |
| Purpose-tailored handoff | Fork, compaction, agent run, docs, ticket attachments | AIR save-current-context | **Partial composition gap.** Existing semantics are substantial. |
| Operator attention | Needs You/Active Work adapters across conversations, jobs, specs, and landing | — | **Incorporated.** Extend adapters/ranking for new human-owned state. |

Important implementation evidence:

- CC is a backend-neutral worktree control plane (`CC/.kiro/steering/product.md:3-15`).
- Graph workflows already support human gates, artifacts, profiles, dynamic work, and settlement (`CC/.kiro/steering/workflows.md:108-138,268,319-385,754`).
- Native SDD already persists requirements, questions, decisions, tasks, evidence, and delivery plans (`CC/docs/design/native-sdd/01-product-design.md:19-105,175-220,253-340,399-520`).
- Tickets have typed statuses/attachments but no delegability facet (`CC/src/lib/tickets/schemas.ts:8-46`).
- Compaction preserves provenance, source handles, blockers, freshness, and pre-model/pre-persistence redaction (`CC/docs/design/conversation-compaction/README.md:451-500`).
- Needs You is already assembled from authoritative domain adapters (`CC/src/components/session/sidebar/active-work-adapters.ts:173-176,213-361`; `CC/src/components/Topbar.tsx:110-142`; `CC/src/components/topbar/NeedsYouMenu.tsx:83-129,184-299`).

## Gap and improvement portfolio

| ID | Gap / improvement | Correct home | Priority / condition |
|---|---|---|---|
| BASE-1 | Malformed agent-run structured output currently falls back to `completed` with raw summary and zero docs (`CC/src/lib/agent-runs/service.ts:251-296`). | CC agent-run boundary | **P0** |
| BASE-2 | Project conversations silently receive no registered reference documents (`CC/src/lib/workflows/conversation/actor-implementations.ts:1477-1508`). | CC context behavior/help | **P1** |
| BASE-3 | CC skill/help drift: fixed ports/direct commands, obsolete log paths/interfaces, generic question tooling. | Managed skills + typed `cctl` help | **P0/P1** |
| CC-N1 | Existing native questions/assumptions/decisions lack prerequisites and a derived ready/blocked view. | Managed pilot, then small native-SDD extension | Pilot now; state conditional |
| CC-N2 | Ticket lifecycle status is not revision-bound automated delegability. | Ticket domain + triage workflow | Only if tickets become automated intake/backlog |
| CC-N3 | Durable questions/approvals do not model a staged external human procedure returning public outputs/opaque secret refs. | Workflow primitive/envelope child + graph adapter | Experimental; concrete use case first |
| CC-N4 | No action composes existing purpose/pointers/freshness/redaction for a named recipient and objective. | Managed skill/help first; API conditional | Now / conditional next |
| CC-N6 | No typed cron or authenticated-event trigger invokes saved workflows with dedupe/overlap policy. | Workflow launch domain | Later; one trigger class first |
| CC-N8 | No semantic goal guide across ticket/spec/workflow/job/debug, but owners are intentionally separate. | Managed routing skill; later federated catalog | Later |
| CC-N9 | No project-level, concept-keyed rejection record is surfaced during ticket/spec creation. | AEP/AIR convention first; indexed CC projection conditional | Later |
| CC-N10 | Graph lanes deny `.git`, but interactive-session destructive-Git policy coverage is uneven. | Backend-neutral session policy with override | Later security design |
| PKG-1 | General reproduction-first diagnosis router | AIR | Now |
| PKG-2 | Active scenario/glossary/code/ADR domain modeling | AIR | Now |
| PKG-3 | Purpose-aware handoff contract | AIR enhancement; deterministic redaction stays host-owned | Now |
| PKG-4 | Decision-frontier authority alignment | AEP `agent-offloading` + AIR objective/plan/design alignment | Now |
| PKG-5 | Skill-authoring craft has split ownership despite existing AEP pointers and global `writing-great-skills`. | Consolidate into one AEP/managed owner | Now |
| PKG-6 | Phase-boundary continue/fork/compact/handoff/subagent guidance | CC managed agent-context/`cctl` help | Now |
| PKG-7 | Expand-contract wide-refactor topology is expressible but unnamed in current graph guidance. | CC graph-planning skill | Now |
| PATTERN-1 | Standards + Spec review on one candidate hash | Extend checked-in adversarial-verification pattern | Now |
| PATTERN-2 | Primary-source research citation/source-quality method | Managed skill + checked-in pattern; profile where supported | Now |
| PATTERN-3 | Generate structurally different designs under named constraints before synthesis | Checked-in validated pattern + AIR roles | Now |

BASE-1 is higher priority than any MATT-derived feature. Keep the current manifest schema, allow one format-only repair, validate every referenced path, and otherwise enter a typed failed-structured-output state with forensic raw output. A broken manifest must never be indistinguishable from a valid no-document result.

For BASE-2, either support bounded project-scoped reference consumption or refuse it with the exact supported alternative. Silent acceptance of an unused pointer is the defect.

For BASE-3, repair/promote guidance from authoritative registries: `CC/AGENTS.override.md:75-88`, `CC/.agents/skills/ui-primitive/SKILL.md:19-29,127-182`, `CC/.agents/skills/debug-logs/SKILL.md:14-23`, `CC/.agents/skills/cc-performance-log-analysis/SKILL.md:8-35`, and generic `AskUserQuestion` references should move to `cctl dev ensure`, registered validation, current log queries, and `cctl ask`.

## Designed Command Center improvements

These are deliberately small designs with promotion criteria. They are not authorization to implement them.

### CC-N1: dependency-aware discovery on existing native-SDD objects

Start with a managed method that represents unresolved decisions as existing questions, assumptions, decisions, evidence, and reference handles. The method should:

- research environmental facts before asking the human;
- add prerequisite handles between questions/decisions;
- derive `ready` and `blocked` instead of storing a second lifecycle;
- ask the current independent frontier as a `cctl ask` batch;
- preserve source evidence and record the decision separately;
- route prototypes or manual exploration to existing fixtures, tickets, or workflows.

If repeated use proves that persistence and multi-actor coordination are needed, add only `prerequisiteIds` or typed reference handles to native-SDD questions/assumptions/decisions and reuse existing task-dependency cycle validation. Do not introduce MATT's universal “item” type, issue assignments as leases, cascading invalidation, or a second task runner. Pre-spec discovery remains Kiro's responsibility; native SDD owns durable decisions after a spec exists.

**Promotion test:** users repeatedly lose frontier/blocker state across sessions or cannot safely collaborate with the managed method. **Kill test:** current questions, assumptions, references, and a skill produce reliable outcomes without new durable state.

### CC-N2: revision-bound ticket delegability

Only if CC tickets become an automated intake/backlog, add an orthogonal assessment facet:

```text
assessment: unassessed | blocked | agent_ready
reasons: typed reason codes plus evidence/reference handles
boundTo: ticket updatedAt or content hash
```

Ticket status continues to mean lifecycle; work type continues to mean category; assignment continues to mean ownership; evidence stays in attachments. Any ticket mutation invalidates the assessment. Automated starts require a current `agent_ready` assessment, while a manual override is explicit and audited. Do not overload `open` or labels with this meaning and do not use it to duplicate graph readiness.

### CC-N3: durable external-human procedure

CC already has durable questions and approval gates. The narrower missing case is a multi-stage external procedure—authenticate, inspect, choose, confirm an irreversible action, and return selected public data—whose progress must survive restarts.

Model it first as an experimental workflow primitive or envelope child, not arbitrary state in graph context:

- ordered, stable stages with durable current-stage and completion state;
- typed, non-secret inputs and outputs;
- opaque `secretRef` handles resolved only by the authorized execution boundary;
- an explicit irreversible-action confirmation;
- progress, cancellation, expiry, evidence, and resumability;
- a graph adapter that exposes only the declared output contract.

Secrets must never appear in transcripts, artifacts, schema instances, logs, or generated shell. Begin with one concrete use case. A generic wizard framework without a repeated need would be premature.

### CC-N4: purpose-aware context transfer

CC already has compaction, forks, source handles, registered documents, attachments, freshness, and redaction. Pilot a managed transfer action that declares:

- target and recipient;
- objective and expected next action;
- constraints and required source handles;
- freshness boundary and sensitivity class.

The model chooses semantically relevant handles. Deterministic code validates identity, access, freshness, redaction, size bounds, and referenced-file existence, then produces a small manifest. The host—not an AIR prompt—owns redaction and permission enforcement. Promote this to an API only if the method cannot reliably compose current primitives or atomic policy enforcement is required.

### Extend the existing Needs You projection

There is no missing unified-attention feature. CC already normalizes authoritative conversation, job, and spec state into Active Work and renders it in the ordered Needs You menu. New human-owned states—such as an alignment decision or procedure stage—should gain an adapter and ranking rule. They should not create another inbox, another stored attention state, or another lifecycle aggregate.

### Later, evidence-gated experiments

- **Workflow triggers:** implement one class—cron *or* authenticated event—not an undifferentiated trigger system. Require idempotent launch, deduplication, overlap policy, authorization, durable provenance, and observable failure. Schedule semantics and event semantics should remain distinct.
- **Prototype convention:** capture a question, a fixture/Storybook story or read-only workflow, evidence, a decision, and explicit promotion/disposal. Add `mergeDisabled` or isolated prototype state only after an actual accidental-merge incident or repeated policy failure.
- **Federated capability guide:** begin as a managed router over typed `cctl` leaf help and current skills. A later read-only catalog can federate ticket/spec/workflow/job/debug owners; it must not become a new execution authority.
- **Rejection memory:** begin as an advisory, concept-keyed decision record surfaced during planning. Promote to an indexed projection only after demonstrated repetition. Never silently veto work from fuzzy similarity.
- **Interactive Git policy:** graph write envelopes already deny `.git`. Investigate backend-neutral interactive-session policy and an audited override only after measuring incidents; do not port raw substring regex hooks.

## Skill, pattern, and plugin improvements

### Command Center managed skills and patterns

1. **Primary-source research.** Add a managed method and checked-in pattern that defines source quality, citation requirements, repository artifact promotion, and a synthesis manifest. Use a profile only on surfaces that actually support profiles. `cctl agent run` has no profile option, so the research method belongs in its prompt and validation contract.
2. **Discovery frontier.** Teach native SDD and pre-spec Kiro flows to distinguish facts from decisions, resolve facts first, expose prerequisites, and ask the current independent frontier. Kiro's current interaction is sequential; `cctl ask` supports a batch of independent current questions.
3. **Two-axis review.** Extend the existing adversarial-verification pattern so independent Standards and Spec reviewers assess the same candidate hash. Standards must be selected from project-declared rules; AIR's framework-specific references are not universal. The Spec reviewer comes from CC/native SDD, not AIR. Deterministic code can check hashes, schema/citation presence, and enum mappings; semantic deduplication, severity, and reconciliation remain reviewer judgment.
4. **Phase-boundary transfer.** Add a decision guide for continue, compact, fork, handoff, or subagent based on objective continuity, need for independence, primary-source loss, recipient, and mutation authority.
5. **Conditional triage.** Teach delegability only if the product adopts CC-N2. Until then, keep status, type, blockers, and execution readiness in their current owners.
6. **Graph shapes.** Name context-sized vertical tracer bullets and the expand-contract pattern for wide refactors. Add attended versus autonomous/HITL versus AFK constraints without importing MATT's tracker conventions.
7. **Designed alternatives.** Add a checked-in pattern that asks independent contexts for structurally different designs under named constraints, then validates and synthesizes them. Avoid untyped free-form “brainstorm more” fan-out.

### Agentic Engineering Principles

1. Extend `agent-offloading` with decision-frontier authority: deterministic code owns topology, blocker facts, freshness, attempts, and state; agents investigate facts and synthesize; humans make consequential value decisions.
2. Consolidate skill-writing doctrine with the active global `writing-great-skills` owner. AEP already has pointer-style triggers and progressive-disclosure doctrine; add only missing completion-boundary and caller/frontier ownership rules rather than a duplicate full skill.
3. Document independent-specialist arbitration: separate perspectives, bind them to the same candidate, mechanically validate identity/completeness, and reserve semantic reconciliation for a reviewer.
4. Apply AEP's own mechanical-guardrail doctrine to plugin corpus contracts: unique owners or derived mirrors, valid references, declared inventory, and tests for missing routed skills such as AIR's referenced-but-absent `knowledge-base-ingest`.
5. Add rejection-memory guidance as advisory project memory with evidence, scope, expiry/revisit conditions, and no automatic fuzzy veto.

### AI Resources

1. Add a general reproduction-first diagnosis router over the existing browser, performance, logging, and test adapters: observe, minimize, form ranked falsifiable hypotheses, instrument narrowly, prove the fix, add regression evidence, and remove instrumentation. Read-only investigation may create hypotheses before a repro; mutation should wait for a red-capable signal unless risk policy says otherwise.
2. Add active domain modeling that cross-checks scenarios, glossary, code, and ADRs. Do not demand exact MATT vocabulary or a global glossary when local names are clearer.
3. Align `understand-objective`, plan, requirements, and design around the same fact/decision authority and current-frontier interaction model.
4. Improve `save-current-context` with recipient, objective, pointers, freshness, sensitivity, and explicit secret omission. The host remains responsible for deterministic redaction and access checks.
5. Make AEP the canonical validation doctrine: one O(1) success verdict; all actionable failure detail immediately; `AI_OUTPUT=1` as the neutral switch while accepting compatibility aliases such as `CLAUDECODE`; retained formatter warnings; and current CC registered validation instead of retired `preMergeCommand`.
6. Delete or redesign the unconditional test-edit hook. A reminder must be evidence-earned, state-conditional, deduplicated, and capped; immediate action is an instruction tier, not a reminder.
7. Treat AIR's prompt-managed orchestration as a fallback outside an orchestrator. Under CC, graph/workflow state owns phases, iteration counts, fan-out, retries, and settlement.
8. Give `write-tests` one owner and avoid fixed pyramids or coverage thresholds as universal policy. Select tests by risk, public seam, and project contract.
9. Keep AIR `reflection` as a lightweight qualitative front end and optionally route evidence-bearing retrospectives to AEP when installed. Because AEP and AIR are separately installable, every cross-plugin route needs capability detection, a fallback, or a generated adapter.
10. Remove ownership drift: the byte-identical code-standards reference trees and duplicated design-agent template need one source plus generated/copy-verified consumers.

The ownership rule is simple: AEP owns generic agent-system doctrine; AIR owns executable procedures and ecosystem recipes; CC owns durable orchestration, policy, and product state. A CLI-first principle is a default, not a ban on scoped MCP or live-browser adapters when the interaction requires them.

## Explicit exclusions and adaptations

| Source idea | Decision | Reason / safe adaptation |
|---|---|---|
| Import the full MATT idea-to-ship flow | **Exclude** | It duplicates CC lifecycle ownership and leaves load-bearing state in prompts/trackers. Adopt selected semantics. |
| Exhaustively grill until no questions remain | **Exclude as default** | Use only as an explicitly attended mode. In selected attended mode, completeness—not an arbitrary total cap—ends the exercise, but each UI batch remains bounded and autonomous turns follow their stricter rules. |
| Obtain human approval at every test seam or minor choice | **Exclude** | Agents may make reversible, local choices. Ask only consequential decisions at the current frontier. |
| “Facts = agent, decisions = human” as an absolute | **Adapt** | Strong authority heuristic, not a ban on reversible agent judgment or a license for agents to mutate external state. |
| No hypothesis before a repro exists | **Adapt** | Hypotheses are necessary to construct a repro; implementation waits for a falsifiable red signal where feasible. |
| Narrate all debugging hypotheses continuously | **Exclude** | Persist useful evidence and decisions; do not turn internal exploration into transcript noise. |
| Remove refactoring from red-green-refactor | **Exclude** | Conflicts with CC's TDD contract and MATT's own README. Refactor while green. |
| Never abort conflict resolution | **Exclude** | Unsafe under ambiguous intent, destructive risk, or invalid premises. Preserve both-intent analysis and allow a safe stop. |
| Extensive stories as a quality proxy | **Exclude** | Native specs should be decision- and evidence-complete, not length-complete. |
| Never place paths in agent-facing material | **Adapt** | Stable handles are best for durable interfaces; exact paths are appropriate for local, short-lived execution and clickable evidence. |
| Fixed token heuristics for phase changes | **Exclude** | Choose by objective continuity, source loss, independence, risk, and recipient—not guessed token economics. |
| Model-managed subagents, worktrees, claims, and merger agents | **Exclude** | CC owns topology, concurrency, worktrees, leases, retries, and merges. |
| OS temporary files as durable handoff state | **Exclude** | Use registered documents, attachments, compaction, and typed manifests with provenance. |
| Regex shell hook as Git security boundary | **Exclude** | Raw substring matching is bypassable and backend-specific. Use parsed, typed policy at the execution boundary. |
| Prompt-assumed commits, pushes, tracker edits, or external mutations | **Adapt** | Mutation authority must be explicit, scoped, typed, and audited. |
| Write secrets through generated Bash/environment files | **Exclude** | Use opaque secret references and authorized resolution; secrets never enter artifacts or transcripts. |
| “Push every checkpoint right” | **Adapt** | Move work earlier or automate it when reversibility and evidence support that choice; do not blindly shift irreversible or high-risk actions. |
| Enforce one exact design vocabulary and global `CONTEXT.md` glossary | **Exclude as universal rule** | Prefer domain-local canonical terms and project-declared architecture constraints. |
| Enforce leading words/positive phrasing mechanically | **Adapt** | Useful writing heuristics; only mechanically enforce objectively testable contracts. |
| Generate loose CDN-backed temporary HTML | **Exclude from CC product** | Use repository fixtures, Storybook, or isolated artifacts with known dependencies and provenance. |
| Narrow course/vendor utilities | **Exclude from CC/AEP** | Keep local to their ecosystems unless broader demand and safe generalization appear. |
| Teaching and literary-writing workflows | **Outside CC scope** | Potential AIR/community skills, not control-plane gaps. |

## Skill-by-skill disposition

Every current MATT skill is accounted for exactly once below. “Incorporated” refers to the idea, not necessarily the source implementation.

### Promoted engineering skills (18/18)

| Skill | Disposition |
|---|---|
| `ask-matt` | **Partial.** Federated capability router and phase-boundary guidance are useful; do not create a second lifecycle dispatcher. |
| `code-review` | **Partial/package.** Extend CC's adversarial pattern with independent Standards + Spec review on one candidate hash. |
| `codebase-design` | **Incorporated/adapt.** Deep modules, locality, and mechanical boundaries exist in CC/AEP; do not impose exact vocabulary or every heuristic. |
| `diagnosing-bugs` | **Partial → AIR.** Add the general red-capable diagnosis loop over existing specialized tools. |
| `domain-modeling` | **Partial → AIR.** Package active scenario/glossary/code/ADR reconciliation; CC already has canonical domain context. |
| `grill-with-docs` | **Compose only.** It invokes grilling and domain modeling; it is not the research skill and adds no independent mechanism. |
| `implement` | **Incorporated.** CC/Kiro/graphs already own implementation, tests, checks, review, and mutation authority. |
| `improve-codebase-architecture` | **Optional AIR procedure.** Keep hotspot evidence and deletion/leverage tests; avoid temporary CDN HTML and a CC subsystem. |
| `prototype` | **Convention first.** Link one question to a fixture, evidence, and decision; avoid permanent throwaway-branch state. |
| `research` | **Package.** Add primary-source/citation/artifact-promotion standards around current CC agent runs and docs. |
| `resolving-merge-conflicts` | **Incorporated/adapt.** Smart Merge and AIR own the workflow; reject “never abort.” |
| `setup-matt-pocock-skills` | **Incorporated/exclude mechanics.** CC project setup owns deterministic configuration; do not port tracker-specific label/template bootstrap. |
| `tdd` | **Incorporated/adapt.** Preserve public behavior and boundary mocking; retain refactoring and autonomous seam judgment. |
| `to-spec` | **Incorporated/adapt.** Native SDD/AIR own this; keep outcomes and exclusions, reject mandatory seam interviews and verbosity. |
| `to-tickets` | **Incorporated for execution; guidance addition.** Add vertical slices and expand-contract; persist backlog blockers only if CC owns backlog readiness. |
| `triage` | **Conditional → AIR/CC-N2.** Keep category separate from lifecycle; add delegability state only with automated intake. |
| `wayfinder` | **Highest-value partial.** Pilot dependency-frontier discovery over native state; do not use issue assignment as a lease. |
| `wizard` | **Adapt to CC-N3.** The staged UX is useful evidence; the generated shell/secret implementation is not acceptable. |

### Promoted productivity skills (7/7)

| Skill | Disposition |
|---|---|
| `grill-me` | **Optional attended wrapper.** No independent feature beyond the grilling method. |
| `grilling` | **Pilot.** Adopt decision prerequisites, fact research, and frontier batching; reject exhaustive interruption as a default. |
| `handoff` | **Mostly incorporated; improve composition.** Use recipient/objective/pointer/freshness semantics over CC's durable context primitives. |
| `teach` | **Outside CC/AEP.** A possible AIR/community learning skill, below current priorities. |
| `to-questionnaire` | **Optional AIR.** Useful for external stakeholder collection; no CC feature until there is a collection product. |
| `wait-what` | **AIR micro-pattern or no action.** Good communication behavior, no orchestration mechanism. |
| `writing-for-agents` | **Mostly incorporated.** Consolidate missing pointer/completion rules with AEP and global `writing-great-skills`; reject unearned absolutes. |

### Retained misc skills (4/4, unpromoted)

| Skill | Disposition |
|---|---|
| `git-guardrails-claude-code` | **Principle incorporated; implementation excluded.** AEP owns guardrails; consider typed backend-neutral CC policy only from evidence. |
| `migrate-to-shoehorn` | **Exclude.** Vendor-specific fixture migration with no general CC/AEP role. |
| `scaffold-exercises` | **Exclude.** Course-repository convention, not transferable orchestration. |
| `setup-pre-commit` | **Superseded.** AEP/CC registered validation is the owner; full suites on every commit are not a safe universal cost policy. |

### In-progress skills (7/7, lower-confidence evidence)

| Skill | Disposition |
|---|---|
| `claude-handoff` | **Exclude.** Backend-specific duplicate of CC jobs/collaboration plus durable handoff. |
| `implement-spec` | **Execution incorporated.** Its model-managed agents/worktrees/merger are evidence for offloading, not a new CC feature. |
| `loop-me` | **Later workflow-authoring input.** It is a finite trigger/checkpoint/push-right interview, not evidence for endless loops or fixed token budgets. |
| `setup-ts-deep-modules` | **AEP example/AIR recipe.** Strong red-command guardrail example; one TypeScript topology is not universal architecture. |
| `writing-beats` | **Outside CC; AIR writing candidate.** Wait for beta consolidation. |
| `writing-fragments` | **Outside CC; AIR writing candidate.** Exploration/exploitation is useful but not control-plane state. |
| `writing-shape` | **Outside CC; AIR writing candidate.** Overlaps `writing-beats`; consolidate before adoption. |

## Source and baseline coherence cautions

This comparison should not treat any corpus as internally perfect.

### MATT

- The root README calls red-green-refactor critical, while the operative `tdd` skill explicitly removes refactoring from the loop (`MATT/README.md:142-158`; `MATT/skills/engineering/tdd/SKILL.md:34-38`). CC's red-green-refactor contract wins.
- Setup documentation says GitHub/Linear/local, while the implementation branches across GitHub/GitLab/local/other. The routing registry is not a reliable single source.
- `to-spec` says it is not an interview, then requires confirmation of the test seam. Treat this as a consequential-gate heuristic, not a mandatory interaction.
- `triage` requires category and state roles, but setup maps only five state labels. This is a concrete example of prompt-managed taxonomy drift.
- `writing-for-agents` advocates a single source, yet inventory/routing is manually duplicated across READMEs, plugin metadata, root instructions, and `ask-matt`.

### Command Center

- Root/project guidance contains stale paths and commands: an `AGENTS.md` reference to `./VISION` where the document is under `docs/`, old hard-coded dev ports/direct validation, and obsolete logging instructions. Repair managed skills/help rather than adding another explanation layer.
- `CONTEXT.md` says graph profiles are not resolved, while current workflow behavior/documentation supports profiles. Keep capability facts derived from current implementation.
- Some UI-design/question guidance still names generic `AskUserQuestion` rather than CC's asynchronous `cctl ask` contract.
- Needs You must be described as an existing derived projection, not a new feature. Its possible work is adapter/ranking coverage.

### AEP and AIR

- AIR's `ai-validation-output` conflicts with the newer AEP owner: it suppresses the success verdict, hides formatter warnings, keys on a backend-specific variable, and emits retired CC configuration. AEP's O(1)-success/full-failure contract should be canonical.
- AIR's unconditional test-edit hook violates AEP's evidence-earned feedback tiers and should be removed or made conditional, deduplicated, and capped.
- AIR has byte-identical duplicate code-standards references and a duplicate design-agent template. Select one owner and derive or verify consumers.
- AIR `reflection`/`steer` agent self-reports are claims; AEP retrospectives require deterministic extraction and spot checks before durable guidance.
- AIR references a missing `knowledge-base-ingest` skill. Corpus contract tests should catch missing routes, references, and duplicated owners.
- AEP and AIR are separately installable. Cross-plugin composition cannot assume both exist; it needs detection and a useful standalone fallback.

## Prioritized roadmap

| Sequence | Deliverable | Success evidence |
|---:|---|---|
| 1 | BASE-1 strict agent-run output boundary | Malformed manifests cannot settle as successful zero-document runs; bounded repair and forensic failure are tested. |
| 2 | Reconcile AIR validation with AEP; remove/fix test hook; repair AIR ownership drift | One canonical doctrine, current CC config, corpus checks, no unconditional reminder. |
| 3 | Repair CC managed skill/help drift and BASE-2 reference-doc behavior | Skills use current `cctl` surfaces; project reference behavior is supported or explicitly refused. |
| 4 | Pilot primary-source research and dependency-frontier discovery | Artifacts cite primary sources; frontier method reduces repeated questions and records unresolved blockers. |
| 5 | Package phase-boundary transfer, graph slice/expand-contract guidance, and two-axis review | Same candidate hash, independent verdicts, bounded evidence, clear context transitions. |
| 6 | Add AIR general diagnosis/domain modeling and authority alignment; consolidate AEP skill-writing ownership | Repro-to-fix evidence, glossary/scenario/code reconciliation, no duplicate owner. |
| 7 | Consider CC-N2, CC-N4, CC-N1 durable state, then CC-N3—in that evidence order | Each feature passes its promotion test and demonstrates value a skill cannot provide. |
| 8 | Explore one trigger class, prototype isolation, federated routing, rejection memory, and interactive Git policy | A concrete use case, incident evidence, and typed invariants precede product state. |
| 9 | Leave teaching/literary and narrow vendor/course skills to AIR/community/local owners | No CC complexity added without control-plane value. |

## Evaluation plan

| Candidate | What to measure | Failure/kill signal |
|---|---|---|
| Discovery frontier pilot | repeated questions, time to decision, facts resolved without interruption, lost blockers across sessions | No measurable gain or existing native objects persist enough context. |
| Ticket delegability | stale-assessment rate, unsafe auto-starts prevented, human override rate | Status/graph readiness already answers the question or assessments churn on every edit. |
| Human procedure | completion/resume rate, secret leakage tests, irreversible confirmations, downstream output validity | One-off use, secrets enter model-visible state, or ordinary approval gates suffice. |
| Purpose-aware transfer | recipient task success, missing/stale source rate, package size, secret/access violations | Current compaction/fork/docs composition performs equally well. |
| Needs You extension | time-to-human-action, duplicate/stale alerts, adapter coverage | New stored inbox or conflicting authority is required. |
| Primary-source research | citation validity, primary-source ratio, referenced-file validation, downstream reuse | Generic prompts perform equally or source quality is not enforceable. |
| Two-axis review | independent finding yield, candidate-hash mismatches, semantic arbitration quality | Reviewers duplicate one another or aggregation hides dissent. |
| Diagnosis router | time to minimal repro, falsified hypotheses, regression evidence, cleanup completeness | Added ceremony without better causal confidence. |
| Workflow trigger | duplicate/overlapping runs, auth failures, provenance, retry behavior | Trigger class cannot guarantee idempotency or has no repeated use case. |
| Prototype convention | decisions resolved, accidental merges, promotion/disposal clarity | Artifacts outlive their question or isolation adds overhead without incidents. |
| Interactive Git policy | prevented destructive incidents, false positives, audited overrides | Regex-like brittleness or no demonstrated risk beyond existing instructions. |

## Final recommendation

Preserve MATT's best **ideas**, not its runtime. The durable contribution is a vocabulary for uncertainty: prerequisites, frontier, fog, facts, decisions, evidence, and purpose-aware context. CC should continue to own lifecycle truth in typed state and deterministic orchestration; AEP should own the generic engineering doctrine; AIR should own reusable procedures.

The immediate work is reliability and packaging, not a broad new subsystem: fix malformed agent-run settlement, reference-document ambiguity, and stale validation/help; then pilot dependency-aware discovery, primary-source research, transfer guidance, diagnosis, and two-axis review. Promote only the pilots that demonstrate a need for persistence, policy, concurrency, provenance, or secure inputs that a skill cannot provide.

That direction keeps CC composable and inspectable while incorporating the strongest insights from mattpocock-skills without importing its tracker coupling, model-managed bookkeeping, unsafe shell mechanics, or contradictory absolutes.
