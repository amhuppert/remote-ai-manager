# mattpocock-skills: consolidated comparative report

**Date:** 2026-08-23
**Scope:** mattpocock-skills (MATT) compared with Command Center native surfaces (CC), the agentic-engineering-principles plugin (AEP), and the ai-resources plugin (AIR).
**Outcome:** analysis and proposal sketches only. **No product, skill, plugin, config, or steering change is authorized by this document.** Feature sections are brainstorms with gates, not a build queue.

**Provenance.** This report consolidates two independently authored syntheses, both retained on disk as superseded inputs:

- `2026-08-23_mattpocock-skills-comparative-study.md` — the **backbone**. Its judgments, ownership boundaries, promotion/kill gates, evaluation discipline, and completeness accounting govern this document.
- `2026-08-23_mattpocock-skills-comparative-analysis.md` — the **donor**. Its framing, orientation material, concept-ledger format, charter mapping, named examples, and brainstorm hypotheses are folded in where they survive the backbone's gates.

A third input, `memory-bank/agent-runs/mattpocock-skills-independent-review.md`, is cited as provenance only: the baseline findings in §4 originate there (as `M-05`/`M-06`, `P0-1`/`P1-5`), were adopted by the study, and are **independently re-verified against current code here**.

**The two source reports are not independent evidence trails.** The study cites the analysis by filename and postdates it on disk. The `Source` column in §3 therefore records **coverage**, never corroboration or confidence.

**The backbone is not presumed true.** Every recommendation-bearing factual claim retained below was checked against current code and current corpora before entering this report. §4.4 lists what was struck or corrected.

---

## 1. Executive verdict

Do not import mattpocock-skills wholesale, and do not treat the overlap as coincidence. All four corpora name the same enemies — misalignment, context waste, unverified claims, entropy — and all four believe in fresh-context work units, dependency-ordered decomposition, human judgment at phase boundaries, and domain vocabulary as compression. **MATT is a prose-and-human-loop implementation of the worldview CC implements as typed server machinery.**

The strongest portable ideas are semantic, not mechanical:

1. Model unresolved work as a dependency graph with a visible **frontier**, not a flat checklist.
2. Agents find environmental **facts**; humans make consequential **decisions**.
3. Maps and handoffs are **indexes of stable source artifacts**, not copies of them.
4. Phase-boundary context choices should be explicit and purpose-aware.
5. Require evidence that can actually go red and green — especially during diagnosis.
6. Keep Standards and Spec review independent so success on one axis cannot mask failure on the other.
7. Turn staged human walkthroughs into secure, resumable product experiences **only** when a skill cannot supply the needed persistence and policy.

Most engineering doctrine is already incorporated. **The ownership rule that settles every placement question in this report:**

> **CC** owns durable orchestration, policy, and product state. **AEP** owns generic agent-system doctrine. **AIR** owns executable procedures and ecosystem recipes.

CC already owns worktrees, execution graphs, retries, validation, gates, agent jobs, source-grounded compaction, typed artifacts, questions, approvals, native SDD, and the cross-domain **Needs You** projection. AEP owns deterministic offloading, structured output, progressive disclosure, mechanical guardrails, designed friction, live verification, and evidence-earned guidance. AIR owns objective clarification, requirements and planning, tests, standards review, conflict resolution, browser and performance diagnosis, handoffs, and developer utilities.

**By the plugins' own doctrine, CC's position is the stronger one.** MATT asks the model to execute process bookkeeping — labels, states, gates, claims, merges — in prose; `agent-offloading` says the model is the least reliable component for exactly that. MATT wins on iteration speed and hackability; CC wins on reliability at scale. That is a real trade-off, and it is why wholesale import would be wrong even if it were permitted.

**The immediate work is reliability and packaging, not a new subsystem.** Three verified CC baseline defects (§4) outrank every MATT-derived idea. After those: package the method-level gaps (§5). Product state is the last resort, reached only through a promotion test (§7).

---

## 2. Philosophy: alignment, conflict, and reverse flow

### 2.1 Axis comparison

| Axis | MATT | CC | AEP | AIR | Judgment |
|---|---|---|---|---|---|
| Composition | Small hackable skills forming an opinionated idea-to-ship path | Deep composable product modules and lifecycle objects | Narrow cross-referenced doctrines | Broad task skills and specialists | Compose the semantics; do not import the lifecycle |
| State owner | Model/tracker maintains maps, claims, frontiers, labels, phases | Typed persistent state, queues, lanes, retries, recovery | Code owns repeatable facts; model owns judgment | Many workflows still make the model the engine | MATT's vocabulary is useful; CC/AEP ownership is stronger |
| Human/agent split | Agent finds facts; human decides | Autonomous inside policy; human at consequential gates | Deterministic facts vs. model judgment | Varies | Adopt the heuristic; agents keep reversible local decisions |
| Work topology | Decision trees, blockers, ready frontier, fog | Execution DAGs, dynamic expansion, validators, joins | Reliability constraints, not lifecycle | Plans and phases, mainly prompt-run | Execution topology incorporated; **discovery** prerequisites partial |
| Context | Pointers, maps-as-indexes, loss accounting, tailored handoffs | Source-grounded compaction, typed docs, bounded reads | Progressive disclosure, file manifests | Save/compress/handoff files | Missing value is recipient/objective-aware composition, not another summary blob |
| Evidence | Primary sources, red-capable loops, two review axes | Registered validation, fixtures, live systems, proof records | Live verification, logs, retrospectives | Strong concrete adapters | Mostly incorporated; general diagnosis **packaging** is missing |
| Guidance | Leading words, positive phrasing, completion demand | Small root plus managed skills and typed help | Earned docs, feedback tiers, disclosure | Mixed age and quality | Consolidate with the existing `writing-great-skills` owner; do not create a third |
| Safety | Human control, but prompt-assumed mutations, shell hooks, secret-writing Bash, no-abort absolutes | Capability/lifecycle policy, worktree isolation, write envelopes, typed refusals | Mechanical guardrails, designed friction | Uneven | Preserve intent; replace source mechanics with typed policy |
| Scope | Engineering, teaching, writing, personal workflow | Coding-agent control plane | Agent-system doctrine | Developer/productivity toolbox | Teaching and literary methods are not CC product gaps |

### 2.2 Shared ground

Fresh context per work unit; the frontier as a reusable concept; dependency-ordered vertical slices; human judgment at phase boundaries with autonomy inside them; primary sources over derivatives; the environment as source of truth with docs as caches; domain vocabulary as compression; Ousterhout-style deep modules; institutional memory for decisions.

Representative evidence: MATT's decision frontier (`skills/productivity/grilling/SKILL.md:6-28`), map-as-index (`skills/engineering/wayfinder/SKILL.md:19-25`), pointer discipline (`skills/productivity/writing-for-agents/SKILL.md:10-43`); CC composability and offloading (`.kiro/steering/engineering-principles.md:54-99`); AEP offloading and disclosure (`agent-offloading/SKILL.md:8-73`, `query-output-disclosure/SKILL.md:21-57`); AIR behavior-first testing (`write-tests/SKILL.md:8-68`).

CC's steering already cites AEP by name — `cli.md` delegates principle ownership to `cli-tools-for-agents`, `query-output-disclosure`, `progressive-disclosure-tooling`, and `agent-feedback-tiers`, and `engineering-principles.md` embeds the Agent-Offloading Principle. **AEP is effectively CC's extracted theory, so "already incorporated into a plugin" is often literally true by construction.**

### 2.3 Conflicts and how each resolves

1. **Process ownership — the central one.** MATT positions against process-owning frameworks ("they take away your control and make bugs in the process hard to resolve", `README.md:17`); CC's Kiro, native SDD, and graph workflows are exactly that. The objection mostly dissolves: MATT's real target is *opacity and unrepairability*, and CC answers with observability (Spec Studio, workflow UI, audit skills) and repair (plan repair, live edit). **It survives as a standing design constraint:** CC processes must stay inspectable, repairable, and reachable through a lightweight path. It is *not* a reason to move load-bearing bookkeeping into editable prose — that contradicts `agent-offloading`, which CC's own steering enshrines.
2. **Who owns the loop.** MATT asks the model to maintain dependency state, launch agents, mutate trackers, manage worktrees, count progress, and decide completion. The portable part is the semantic model — decision, fact, blocker, frontier, evidence, fog — never its prompt-managed runtime.
3. **Question economics.** MATT rejects question caps outright (`.out-of-scope/question-limits.md`: a cap conflates under-specified plans with low-value questions). Resolution is a **mode split**: in an attended, user-initiated elicitation session, relentlessness is correct and a total cap is a prompt-quality dodge; in ambient or autonomous work CC's conservatism holds and the autonomous-turn ask-denial stands. No surface hard-caps *total* questions; per-round batch sizing is a UX matter, not a philosophy.
4. **Artifact durability vs. resolvable precision.** MATT: specs and tickets never contain file paths ("they go stale"). CC: Kiro designs mandate a File Structure Plan and graph plans cite locators that must resolve at authoring time. **Both are right for their artifact lifetimes** — MATT's tickets sit in a tracker for months; CC plans are consumed within a session or execution. Long-lived artifacts lean behavioral; short-lived execution artifacts use exact paths and clickable evidence.
5. **Refactor placement.** MATT's `tdd` removes refactoring from the loop (`skills/engineering/tdd/SKILL.md:34-38`) while its own README calls red-green-refactor critical (`README.md:142-158`). CC keeps red-green-refactor; the underlying point (don't let refactor ambition contaminate the green step) is already served by proportionality review.
6. **Human cognitive load.** MATT treats the human's reading burden as "the price of human agency"; CC pushes toward briefs and autonomy. Less opposed than it looks — MATT spends attention at alignment time and defers it during execution (`loop-me`'s push-right), which is CC's direction too. The residual difference is that MATT assumes an attended operator far more often, which is why per-flow HITL/AFK vocabulary is worth adopting.
7. **Merge-conflict doctrine.** MATT: "always resolve, never `--abort`." CC's worktree-safety conservatism wins inside CC sessions.

### 2.4 Reverse flow — what MATT lacks

Useful for calibrating how much authority to grant the source. MATT has **no evidence-verification discipline** (nothing like fresh-evidence completion gates or live-system verification), **no retrospective or audit machinery**, **no proportionality check** in review, and **no mechanical enforcement** beyond one git-hook installer. Its verification story is "feedback loops while working," not "evidence before claiming done."

This asymmetry explains the direction of flow: MATT → CC for **elicitation and framing**, and CC/AEP → MATT for **verification and enforcement**.

---

## 3. Master decision ledger

**Verdicts.** `INC` incorporated · `SUP` superseded (baseline is a mechanized superset) · `PART` partially covered, packaging gap · `GAP` compatible, not incorporated anywhere · `COND` conditional product state behind a gate · `EXCL` excluded.

**Source** records coverage only: `study` / `analysis` / `both`. It is not a confidence score (see Provenance).

**IDs.** One canonical ID per proposal. `BF-*` baseline finding, `P-*` proposal, `X-*` exclusion. Aliases map back to each source report.

### 3.1 Incorporated and superseded — no action

| ID | Concept | Verdict | Where it already lives | Source | Aliases |
|---|---|---|---|---|---|
| — | Spec → tasks → implementation → review | SUP (CC) | Kiro phases; native-SDD revisions, decisions, tasks, evidence, delivery candidates | both | analysis:5 |
| — | Tracer-bullet vertical slices with blocking edges | SUP (CC) | Graph execution contexts + DAG; Kiro tasks with `_Depends:_` | both | analysis:6 |
| — | Thin implement orchestrator, fresh context per ticket | SUP (CC) | `kiro-impl` bounded loops, strict handoff parsing, divergence detector | analysis | analysis:8 |
| — | `implement-spec`: worktree-isolated implementers + merger + frontier concurrency | SUP (CC) | The graph engine, lanes, merge machinery, validators, circuit breakers, plan repair, live edit, audit | both | analysis:9 |
| — | `claude-handoff` | SUP (CC) | CC sessions, `cctl ticket start`, `cctl agent run` | both | analysis:19 |
| — | Merge-conflict resolution by intent traced to primary sources | INC | Smart Merge + worktree lifecycle; AIR `fix-merge-conflicts` | both | analysis:16 |
| — | AGENT-BRIEF doctrine | SUP (CC) | Graph AC discipline is a strict superset (independently-failable obligations, stable ids, banned patterns, capability ownership) | analysis | analysis:22a |
| — | Setup-skill pattern (explore → sectioned Q&A → draft → write) | INC | `project-setup`, `dev-server-setup`; AIR installers | analysis | analysis:29 |
| — | Deep modules, mechanical boundaries | INC | CC engineering contract, domain context, seam ratchet, architecture tests, write envelopes; AEP `mechanical-guardrails` | both | analysis:8 |
| — | Boundary-enforcement installer | SUP (CC) | Seams ratchet is stronger and CC-specific | both | analysis:30 |
| — | Context pointers and maps | INC | Reference docs, ticket attachments, workflow docs, compaction, bounded transcript reads | study | — |
| — | Progressive skill/help routing | INC | Managed skills, typed leaf help, related-command graph | study | — |
| — | Operator attention | INC | **Needs You / Active Work adapters** across conversations, jobs, specs, landing. New human-owned state gets an adapter and a ranking rule — never another inbox, stored attention state, or lifecycle aggregate | study | — |
| — | Primary-source research mechanics | INC (spirit) | Job-shaped agent runs, registered docs, research tickets, read-only contexts, materialization rule | both | analysis:13 |
| — | Code review, overall | INC | `kiro-review` is spec-anchored with mechanical + judgment + proportionality — stronger than the source | both | analysis:15 |

### 3.2 Packaging and method gaps — adopt as guidance

| ID | Concept | Verdict | Owner | Gate / next step | Source | Aliases |
|---|---|---|---|---|---|---|
| **P-01** | Grilling: rounds over a design-tree frontier; facts to background agents, decisions to the human | GAP | CC managed bundle | Ship as an attended method over `cctl ask`. Session object is `P-21`, promotion-gated | both | study:CC-N1(part), analysis:1/S1 |
| **P-02** | Reproduction-first diagnosis router | PART | **AIR** procedure; AEP `live-system-verification` as doctrine reference; thin CC wiring | Ship the AIR router. A separate AEP debugging skill is conditional on proving a contract that duplicates neither | both | study:PKG-1, analysis:12/D2/S2 |
| **P-03** | Phase-boundary procedure: continue / clear / compact / handoff / subagent, worked in order | machinery SUP, procedure GAP | CC managed `agent-context` / `cctl` help | Ship now. Measured audience: ~65% of turns trip the context default | both | study:PKG-6, analysis:18/S3 |
| **P-04** | Two-axis review — Standards and Spec never merged or cross-ranked, bound to one candidate hash | PART | CC adversarial-verification pattern | Extend the existing pattern. Standards come from project-declared rules; the Spec reviewer comes from CC/native SDD, not AIR | both | study:PATTERN-1, analysis:15/D7 |
| **P-05** | Primary-source research method: source quality, citation requirements, artifact promotion, synthesis manifest | PART | CC managed skill + checked-in pattern | Ship in the prompt and validation contract — **`cctl agent run` has no profile option** (verified) | both | study:PATTERN-2 |
| **P-06** | Purpose-aware context transfer: recipient, objective, constraints, freshness, sensitivity | PART | CC managed skill first; AIR `save-current-context` enhancement | Host owns deterministic redaction and access checks, never a prompt. API is `P-24` | both | study:PKG-3/CC-N4, analysis:D9 |
| **P-07** | Active domain modeling: challenge terms, sharpen overloaded words, cross-reference code, lazy inline glossary updates | GAP (discipline) / PART (artifact) | **AEP** doctrine (portable), usable by CC projects | CC's `CONTEXT.md` stays architecture vocabulary and is exempt | both | study:PKG-2, analysis:2/S8 |
| **P-08** | Writing craft for agent prose: leading words, negation as failure mode, no-op hunting, two budgets, completion criteria | GAP | Extend the existing `writing-great-skills` owner (**verified present**), linked from AEP | A new skill requires a non-overlapping contract. Do not create a third owner | both | study:PKG-5, analysis:20/D1 |
| **P-09** | Invocation taxonomy: user- vs model-invoked, no skill calls a user-invoked skill, router skills, explicit Skill-tool cross-references | GAP (baseline adoption) | AEP skill-authoring owner; referenced from CC | MATT states this in `.agents/invocation.md`; the gap is that CC and AIR follow it by instinct without stating it | analysis | analysis:21/D3/S7 |
| **P-10** | Expand–contract sequencing for wide refactors | GAP (guidance) | CC `graph-workflow-planning` | Name the pattern: expand context → blast-radius batches edged on expand → contract edged on all batches | both | study:PKG-7, analysis:7/S4 |
| **P-11** | Design-it-twice: N designs under *different named constraints*, then opinionated synthesis | GAP | CC checked-in pattern + AIR `design` phase | Avoid untyped "brainstorm more" fan-out. Workflow template is `P-22` | both | study:PATTERN-3, analysis:32/D6 |
| **P-12** | Decision-frontier authority alignment | PART | AEP `agent-offloading` + AIR objective/plan/design | Code owns topology, blocker facts, freshness, attempts, state; agents investigate; humans decide value | both | study:PKG-4, analysis:D5 |
| **P-13** | TDD nuggets: tautological-test anti-pattern, seam agreement | PART | CC steering `engineering-principles.md` | Two lines. Keep red-green-**refactor** | both | analysis:14/S5 |
| **P-14** | UI variant discipline: "structurally different or it's wallpaper", N=3 (cap 5), prefer an existing page over an empty canvas | GAP (partial) | CC `ui-design` skill | Storybook already provides the switcher MATT had to build | analysis | analysis:11/S6 |
| **P-15** | Rejection memory: concept-keyed "we considered X and rejected it because Y", checked before re-proposing | GAP | AEP `earned-guidance-docs` section → `docs/out-of-scope/` convention | Escalation ladder in `P-23`. **Never a fuzzy veto** | both | study:CC-N9, analysis:4/D4/F4 |
| **P-16** | HITL/AFK typing per flow or context | GAP | CC `graph-workflow-planning` **vocabulary** | Schema field only after evidence of stalled unattended runs that guidance cannot prevent | both | study:CC-N1(part), analysis:10/F8/S4 |
| **P-17** | Minimal ADRs with a triple gate (hard to reverse ∧ surprising ∧ real trade-off) | PART | AEP, alongside `P-07` | Low priority; CC has steering, specs, and Alignment decisions | analysis | analysis:3 |
| **P-18** | AIR ownership hygiene: reconcile `ai-validation-output` with AEP; remove/condition the unconditional test-edit hook; de-duplicate reference trees and the design-agent template; add corpus contract tests | — | AIR + AEP | **Highest-priority plugin work.** Includes the verified missing `knowledge-base-ingest` route (§4.3). AEP's O(1)-success / full-failure contract is canonical | study | study:AIR-5/6/10, AEP-4 |
| **P-19** | Cross-plugin composition safety | — | AEP + AIR | AEP and AIR are separately installable. Every cross-plugin route needs capability detection, a fallback, or a generated adapter | study | study:AIR-9 |
| **P-20** | Conditional triage guidance | COND | AIR / CC | Teach delegability only if `P-25` is adopted. Until then keep status, type, blockers, and execution readiness in their current owners | both | study:triage, analysis:22b |

### 3.3 Conditional CC product state — gated

Each carries a promotion test (what would justify building it) and a kill test (what would prove a skill suffices). Evaluation signals in §7.2.

| ID | Concept | Verdict | Gate | Source | Aliases |
|---|---|---|---|---|---|
| **P-21** | Grilling session object over `cctl ask` | COND | Only if the `P-01` method repeatedly loses frontier or blocker continuity across turns | analysis | analysis:F2 |
| **P-22** | Design-it-twice graph-workflow template | COND | Ship after `P-11` proves the pattern is reached for. Smallest concrete instance of VISION's Generate-And-Filter ambition | analysis | analysis:F5 |
| **P-23** | Rejection records as a first-class project record | COND | Only after **observed** re-litigation that the `P-15` convention failed to prevent | both | study:CC-N9, analysis:F4 |
| **P-24** | Purpose-aware transfer as an API | COND | Only if the `P-06` method cannot reliably compose current primitives, or atomic policy enforcement is required | study | study:CC-N4 |
| **P-25** | Revision-bound ticket delegability | COND | Only if CC tickets become an automated intake/backlog. Orthogonal assessment facet, bound to a content hash, invalidated by any mutation | study | study:CC-N2 |
| **P-26** | Dependency-aware discovery on native-SDD objects | COND | Pilot the `P-01` method first. Then add only `prerequisiteIds` or typed reference handles, reusing existing cycle validation. **No** universal "item" type, **no** issue-assignment-as-lease, **no** second task runner | both | study:CC-N1, analysis:10/F3 |
| **P-27** | Durable external human procedure ("Human Action Runbooks") | COND | Experimental, one concrete use case first. Ordered stable stages, typed non-secret I/O, opaque `secretRef` resolved only at the authorized boundary, explicit irreversible-action confirmation, expiry/cancellation/resumability. Needs You supplies attention; a panel is only execution UI | both | study:CC-N3, analysis:17/F1 |
| **P-28** | Typed backend-neutral destructive-Git policy | COND | **Gate unmet.** Mechanism agreed: parsed, typed policy at the execution boundary with an audited override — never substring regex. Shared-stash is the candidate hazard class to measure, not observed incident evidence | both | study:CC-N10, analysis:31/F7 |
| **P-29** | Prototype artifacts: self-contained HTML logic-prototype document type; prototype-branch registry | COND (deferred brainstorm) | Convention first — one question, a fixture or Storybook story, evidence, a decision, explicit promotion/disposal. Any rendered artifact needs pinned dependencies and provenance; no loose CDN-backed HTML | both | study:prototype, analysis:11/F6 |
| **P-30** | Workflow triggers | COND | Later. Implement **one** class — cron *or* authenticated event. Requires idempotent launch, dedupe, overlap policy, authorization, durable provenance, observable failure | study | study:CC-N6 |
| **P-31** | Federated capability guide | COND | Later. Begin as a managed router over typed `cctl` leaf help. A later read-only catalog must never become an execution authority | study | study:CC-N8 |
| **P-32** | Routine authoring ("loop grilling") | COND | Later workflow-authoring input. Grill the loop, mandate nothing structural the interview did not surface, push the checkpoint right, deliver a brief and never raw output | analysis | analysis:28/F9 |

---

## 4. Verified CC baseline side findings

**These did not come from mattpocock-skills.** They surfaced during the comparison, originate in the independent challenge review, and are recorded here as CC defects in their own right. They are excluded from the gap counts in §3 and from the charter crosswalk in §6.

All three were re-verified against current code for this report.

### BF-1 — Malformed agent-run structured output settles as `completed` with zero documents · **P0 · CONFIRMED**

`src/lib/agent-runs/service.ts:251-296`. When `validateStructuredOutput` fails but `result.response` is non-empty, execution falls to the unstructured-text fallback at `:290-296` and terminates with `status: "completed"`, `summary: result.response`, `referenceDocuments: []`.

A broken manifest is therefore **indistinguishable from a valid no-document run**. This undercuts the manifest boundary AEP prescribes and CC's own agent-run contract.

*Direction:* keep the current manifest schema; allow one format-only repair; validate every referenced path; otherwise enter a typed failed-structured-output state preserving the raw forensic response. Never "completed, zero docs."

### BF-2 — Project conversations silently receive no registered reference documents · **P1 · CONFIRMED, refined**

`src/lib/workflows/conversation/actor-implementations.ts:1477-1508`. Reference-document loading is skipped for project conversations: `const referenceDocs = isProjectConversation ? [] : await deps.getReferenceDocuments(...)`.

**Refinement the study did not carry:** this is a *deliberate, code-commented* constraint, not an accidental drop. The comment at `:1477-1482` explains it — focus-memory registration and reference-document loading are session-scoped through the session aggregate, which the `__project__` sentinel cannot address.

That changes the defect's shape. The problem is not the skip; it is that **nothing surfaces the constraint to the agent or the user**, so a registered pointer is silently inert.

*Direction:* either support bounded project-scoped reference consumption, or refuse it with the exact supported alternative and teach the limitation in `cctl docs --help`. Silent acceptance of an unused pointer is the defect.

### BF-3 — CC skill and help drift · **P0/P1 · CONFIRMED**

Verified instances:

- `AGENTS.md:7` points at `./VISION.md`; the document is at `docs/VISION.md` and no root `VISION.md` exists. **A broken pointer in the root contract.**
- `AGENTS.override.md` hard-codes a Storybook port (`bun run storybook` on 6006) and direct `bun run dev`, where the current surface is `cctl dev ensure` with session-scoped ports.
- `.agents/skills/debug-logs/SKILL.md:14-23` hard-codes raw log-file paths and teaches direct file access rather than current log-query surfaces.
- UI-design and question guidance still names generic `AskUserQuestion` rather than CC's asynchronous `cctl ask` contract.

*Direction:* repair and promote guidance from authoritative registries rather than adding another explanation layer.

### 4.4 Claims struck or corrected during verification

| Claim | Source | Disposition |
|---|---|---|
| "`CONTEXT.md` says graph profiles are not resolved, while current workflow behavior supports profiles" — a CC self-contradiction | study | **STRUCK.** `CONTEXT.md:295-298` says workflow assignments "belong to the workflow-validator-cohorts spec; no graph-workflow path resolves a profile **yet**" — a scoped, dated statement about runtime resolution. `.kiro/steering/workflows.md` documents the assignment *schema* and library surface. Design surface vs. current runtime resolution; the "yet" is doing the work. Not a contradiction |
| "The empty historical `deprecated/` bucket" | study | **CORRECTED (substantially right).** `skills/deprecated/` exists but contains only `README.md` — no skills |
| "All five buckets, including `deprecated/`" as read corpora | analysis | **CORRECTED.** Technically a directory, but there was nothing to read |
| "~25 skills", "~36 skills across five buckets", "~30 distinct concepts" | analysis | **CORRECTED to exact counts.** 18 engineering + 7 productivity + 4 misc + 7 in-progress = **36 total, 25 promoted**. The study's counts are exact |
| Reproduction-first debugging is "a gap in all three baselines" / "GAP (all three)" | analysis | **RE-WORDED.** `AGENTS.md` already carries repro-test-first; AIR has `perf-investigator`; CC has `kiro-debug` for a different scope. It is a **packaging gap around existing capabilities**, not an absent capability. Same correction applies to research and two-axis review |
| A missing global `writing-great-skills` owner | — | **NOT A GAP.** Verified present. `P-08` extends it rather than creating a skill |
| "No hypothesis before a repro exists" as a hard gate | analysis (D2) | **ADAPTED.** Gate the *fix*, not the *thinking*: no mutation before a named, already-run, red-capable command. Hypotheses are required to construct the repro |
| Wayfinder claim-by-assignment as a lease | analysis (F3) | **DROPPED.** CC has real sessions and leases; issue assignment is not a lease |
| Shared-stash satisfies the git-safety promotion gate | — | **REJECTED.** A documented hazard class is not observed incident evidence. `P-28` gate stays unmet |

---

## 5. Owner-grouped adoption portfolio

Escalation is always **convention → pilot → feature**. Nothing below is authorized; each item names its owner and its gate.

### 5.1 Command Center — managed skills and patterns *(ship now)*

1. **Phase-boundary transfer (`P-03`).** Five options worked in order, mapped to CC surfaces: continue (rule out first — the conversation is a primary source) → fresh conversation → compaction artifact with an instruction argument (the default, not the first reach) → reference-document handoff (portability cases only) → background agent (AFK-scoped). Plus pointer-not-copy for anything artifact-backed.
2. **Primary-source research (`P-05`).** Source quality, citation requirements, repository artifact promotion, synthesis manifest — in the prompt and validation contract, since `cctl agent run` takes no profile.
3. **Grilling (`P-01`).** Map the design tree; each round is one `cctl ask` batch with recommendations and structured tradeoffs; dispatch fact-finding to background agents *before* ending the turn so facts land with the answers; recompute the frontier; terminal stop-gate. Attended mode imports the no-caps reasoning; ambient work defers to the standing ask rules.
4. **Diagnosis wiring (`P-02`).** Over the AIR router: loop candidates include scoped `cctl validate run test`, `cctl fixture prompt` against the worktree dev server, `playwright-cli`, and log trace replay. The two-instance model is a named trap in loop construction. `[DEBUG-xxxx]` tagging composes with structured logging.
5. **Graph shapes (`P-10`, `P-16`).** Name expand–contract; adopt **frontier** as the prose term for the ready-set; add HITL/AFK as planning vocabulary; one line on artifact lifetimes so the "no file paths" rule is applied only to durable artifacts.
6. **Two-axis review (`P-04`) and designed alternatives (`P-11`).** Extend the checked-in adversarial-verification pattern; both reviewers bound to the same candidate hash. Deterministic code checks hashes, schema and citation presence, and enum mappings; semantic dedup, severity, and reconciliation stay reviewer judgment.
7. **UI variant discipline (`P-14`)** and **skill-authoring conventions (`P-09`)**.
8. **Steering, two lines (`P-13`).** Tautological-test anti-pattern; seam agreement in the ad-hoc TDD loop.

### 5.2 agentic-engineering-principles

1. Extend `agent-offloading` with **decision-frontier authority** (`P-12`).
2. Consolidate skill-writing craft into the existing `writing-great-skills` owner (`P-08`); add only the missing completion-boundary and caller/frontier rules.
3. State the **invocation taxonomy** (`P-09`) — the model-invocation test, the no-calling-user-invoked invariant, router skills, explicit Skill-tool cross-references.
4. Document **independent-specialist arbitration**: separate perspectives, bound to one candidate, mechanically validated for identity and completeness, semantic reconciliation reserved for a reviewer.
5. Add **rejection-memory** guidance (`P-15`) as advisory project memory with evidence, scope, and revisit conditions.
6. Apply AEP's own mechanical-guardrail doctrine to **plugin corpus contracts** (`P-18`): unique owners or derived mirrors, valid references, declared inventory, tests for missing routed skills.
7. Own **domain-modeling discipline** (`P-07`) — it is doctrine, and CC steering already points at AEP for doctrine.

### 5.3 ai-resources

1. **Reproduction-first diagnosis router (`P-02`)** over the existing browser, performance, logging, and test adapters: observe → minimize → ranked falsifiable hypotheses → narrow instrumentation → prove the fix → regression evidence at a correct seam → remove instrumentation. Read-only investigation may hypothesize before a repro; **mutation waits for a red-capable signal.**
2. **Ownership hygiene (`P-18`)** — the highest-priority plugin work: make AEP the canonical validation doctrine (one O(1) success verdict, full failure detail, a neutral `AI_OUTPUT=1` switch accepting compatibility aliases, retained formatter warnings, current CC registered validation instead of retired config); delete or redesign the unconditional test-edit hook; collapse the byte-identical code-standards reference trees and the duplicated design-agent template to one source with generated or copy-verified consumers; add corpus contract tests that would have caught the missing `knowledge-base-ingest` route.
3. **Frontier protocol in `understand-objective` (`P-12`)** — replace "iterate until zero open questions" with the design-tree model and the facts/decisions split.
4. **`save-current-context` pointer-not-copy (`P-06`)** — recipient, objective, pointers, freshness, sensitivity, explicit secret omission. The host stays responsible for deterministic redaction and access checks.
5. **Two-axis rule in `code-reviewer` (`P-04`)**, with a spec-discovery ladder and an explicit note when the axis was skipped.
6. **Boundary-enforcement installer** — the turnkey counterpart to AEP's doctrine, whose completion criterion is *prove the rules bite* (pass → introduce a violation → observe the fail → revert).
7. Treat AIR's prompt-managed orchestration as a **fallback outside an orchestrator**; under CC, graph state owns phases, iteration counts, fan-out, retries, and settlement.
8. Give `write-tests` one owner; select tests by risk, public seam, and project contract — not fixed pyramids or coverage thresholds.
9. Keep `reflection` as a lightweight qualitative front end, routing evidence-bearing retrospectives to AEP **only with capability detection** (`P-19`).

---

## 6. Charter crosswalk

| Charter outcome | Where it is answered |
|---|---|
| Where the corpora align and conflict; compatibilities and incompatibilities | §2.1–2.3 |
| How MATT concepts relate to existing CC features | §3.1, §3.2 (`Where it already lives` / `Owner`) |
| What is **already incorporated** into CC or either plugin | §3.1 (15 concepts), plus §2.2 on AEP-as-extracted-CC-theory |
| What is **philosophically compatible but not yet incorporated** — the CC gap list | §3.2 (`P-01`…`P-20`), §3.3 (`P-21`…`P-32`) |
| What is **not aligned** and should be excluded, with reasons | §8 |
| **Deliverable 1** — designed improvements to CC, AEP, or AIR | §5.1 (CC), §5.2 (AEP), §5.3 (AIR) |
| **Deliverable 2** — brainstormed first-class CC feature ideas | §3.3 (`P-21`…`P-32`), all gated, none authorized |
| **Deliverable 3** — brainstormed skill/instruction ideas | §5.1, §5.2, §5.3; ledger rows `P-01`…`P-17` |
| *(Not a charter outcome)* CC baseline defects surfaced by the comparison | §4 — attributed away from MATT |

---

## 7. Sequencing and evaluation

### 7.1 Roadmap

| # | Deliverable | Success evidence |
|---:|---|---|
| 1 | **BF-1** strict agent-run output boundary | Malformed manifests cannot settle as successful zero-document runs; bounded repair and forensic failure are tested |
| 2 | **P-18** AIR ownership hygiene; reconcile validation with AEP; remove or condition the test hook | One canonical doctrine, current CC config, corpus contract checks, no unconditional reminder |
| 3 | **BF-3** skill/help drift and **BF-2** reference-doc behavior | Skills use current `cctl` surfaces; the root VISION pointer resolves; project reference behavior is supported or explicitly refused |
| 4 | Pilot **P-05** research and **P-01** grilling | Artifacts cite primary sources; the frontier method reduces repeated questions and records unresolved blockers |
| 5 | Package **P-03**, **P-10**, **P-16**, **P-04** | Same candidate hash, independent verdicts, bounded evidence, clear context transitions |
| 6 | **P-02** diagnosis router, **P-07** domain modeling, **P-12** authority alignment, **P-08** writing craft | Repro-to-fix evidence; glossary/scenario/code reconciliation; no duplicate owner |
| 7 | Consider **P-25**, **P-24**, **P-26**, then **P-27** — in that evidence order | Each passes its promotion test and demonstrates value a skill cannot provide |
| 8 | Explore **P-30**, **P-29**, **P-31**, **P-23**, **P-28** | A concrete use case, incident evidence, and typed invariants precede product state |
| 9 | Leave teaching, literary, and narrow vendor/course skills to AIR, community, or local owners | No CC complexity added without control-plane value |

### 7.2 Evaluation and kill signals

| Candidate | Measure | Kill signal |
|---|---|---|
| `P-01` / `P-26` discovery frontier | repeated questions, time to decision, facts resolved without interruption, blockers lost across sessions | No measurable gain, or existing native objects already persist enough context |
| `P-05` research | citation validity, primary-source ratio, referenced-file validation, downstream reuse | Generic prompts perform equally, or source quality is not enforceable |
| `P-04` two-axis review | independent finding yield, candidate-hash mismatches, arbitration quality | Reviewers duplicate one another, or aggregation hides dissent |
| `P-02` diagnosis router | time to minimal repro, falsified hypotheses, regression evidence, cleanup completeness | Added ceremony without better causal confidence |
| `P-06` / `P-24` transfer | recipient task success, missing or stale source rate, package size, secret/access violations | Current compaction/fork/docs composition performs equally well |
| `P-25` ticket delegability | stale-assessment rate, unsafe auto-starts prevented, override rate | Status or graph readiness already answers it, or assessments churn on every edit |
| `P-27` human procedure | completion and resume rate, secret-leakage tests, irreversible confirmations, downstream output validity | One-off use, secrets reach model-visible state, or ordinary approval gates suffice |
| `P-30` workflow trigger | duplicate or overlapping runs, auth failures, provenance, retry behavior | Cannot guarantee idempotency, or has no repeated use case |
| `P-29` prototype convention | decisions resolved, accidental merges, promotion/disposal clarity | Artifacts outlive their question, or isolation adds overhead without incidents |
| `P-28` Git policy | prevented destructive incidents, false positives, audited overrides | Regex-like brittleness, or no demonstrated risk beyond existing instructions |
| Needs You extension | time-to-human-action, duplicate or stale alerts, adapter coverage | A new stored inbox or conflicting authority becomes necessary |

---

## 8. Exclusions and adaptations

| ID | Source idea | Decision | Reason / safe adaptation |
|---|---|---|---|
| X-01 | Import the full MATT idea-to-ship flow | **Exclude** | Duplicates CC lifecycle ownership and leaves load-bearing state in prompts and trackers |
| X-02 | The anti-framework stance applied to CC | **Adapt** | Retained only as a design constraint: processes stay inspectable and repairable, and the lightweight path exists |
| X-03 | Tracker-agnostic indirection layer | **Exclude** | CC owns its ticket store. Maintaining role→label mappings is the permanent-maintenance surface MATT's own out-of-scope notes warn about |
| X-04 | `.scratch/` local markdown tracker | **Exclude** | A competing path; CC's adoption-matrix philosophy forbids creating one |
| X-05 | Exhaustively grill until no questions remain | **Exclude as default** | Attended mode only. Completeness ends the exercise, not an arbitrary cap; each UI batch stays bounded; autonomous turns keep stricter rules |
| X-06 | Human approval at every test seam or minor choice | **Exclude** | Agents may make reversible local choices. Ask only consequential decisions at the current frontier |
| X-07 | "Facts = agent, decisions = human" as an absolute | **Adapt** | A strong authority heuristic, not a ban on reversible agent judgment nor a license to mutate external state |
| X-08 | No hypothesis before a repro exists | **Adapt** | Gate the fix, not the thinking — see §4.4 |
| X-09 | Narrate all debugging hypotheses continuously | **Exclude** | Persist useful evidence and decisions; do not turn exploration into transcript noise |
| X-10 | Remove refactoring from red-green-refactor | **Exclude** | Conflicts with CC's TDD contract *and* MATT's own README. Refactor while green |
| X-11 | Never abort conflict resolution | **Exclude** | Unsafe under ambiguous intent, destructive risk, or invalid premises. Keep both-intent analysis; allow a safe stop |
| X-12 | Extensive stories as a quality proxy | **Exclude** | Specs should be decision- and evidence-complete, not length-complete |
| X-13 | Never place paths in agent-facing material | **Adapt** | Stable handles for durable interfaces; exact paths for short-lived execution and clickable evidence |
| X-14 | Fixed token heuristics for phase changes | **Exclude** | Choose by objective continuity, source loss, independence, risk, and recipient |
| X-15 | Model-managed subagents, worktrees, claims, merger agents | **Exclude** | CC owns topology, concurrency, worktrees, leases, retries, merges |
| X-16 | OS temporary files as durable handoff state | **Exclude** | Use registered documents, attachments, compaction, and typed manifests with provenance |
| X-17 | Regex shell hook as a Git security boundary | **Exclude** | Substring matching is bypassable and backend-specific. Use parsed, typed policy at the execution boundary (`P-28`) |
| X-18 | Prompt-assumed commits, pushes, tracker edits, external mutations | **Adapt** | Mutation authority must be explicit, scoped, typed, and audited |
| X-19 | Write secrets through generated Bash or environment files | **Exclude** | Opaque secret references, resolved only at the authorized boundary. Secrets never enter artifacts or transcripts |
| X-20 | "Push every checkpoint right" | **Adapt** | Move work earlier or automate it where reversibility and evidence support it; never blindly shift irreversible actions |
| X-21 | One exact design vocabulary and a mandatory global glossary | **Exclude as a universal rule** | Prefer domain-local canonical terms and project-declared constraints |
| X-22 | Mechanically enforce leading words and positive phrasing | **Adapt** | Useful heuristics; mechanically enforce only objectively testable contracts |
| X-23 | Loose CDN-backed temporary HTML | **Exclude from CC product** | Repository fixtures, Storybook, or artifacts with pinned dependencies and provenance |
| X-24 | Unconditional no-question-caps | **Adapt** | Attended grilling only; the autonomous-turn ask-denial stands |
| X-25 | `teach`, `to-questionnaire`, `wait-what`, `writing-beats`/`-fragments`/`-shape` | **Exclude from CC** | Outside a single-operator coding control plane. Optional AIR or community material; not recommended by default |
| X-26 | `migrate-to-shoehorn`, `scaffold-exercises` | **Exclude** | Vendor- and course-specific; no general CC/AEP role |
| X-27 | `setup-pre-commit` running full suites | **Superseded** | AEP/CC registered validation owns this. Full suites on every commit are not a safe universal cost policy |
| X-28 | House style items (em-dash ban, AI-comment disclaimers on public trackers) | **Exclude** | Taste, and a context CC does not have |

---

## 9. Appendices

### 9.1 Skill-by-skill completeness index

Every MATT skill is accounted for exactly once. Counts verified: **18 engineering + 7 productivity + 4 misc + 7 in-progress = 36 total, 25 promoted.** `skills/deprecated/` contains only a README. "Incorporated" refers to the idea, not the source implementation.

**Promoted engineering (18/18)**

| Skill | Disposition | Ledger |
|---|---|---|
| `ask-matt` | Partial — federated router and phase-boundary guidance useful; no second lifecycle dispatcher | `P-03`, `P-31` |
| `code-review` | Partial/package — two independent axes on one candidate hash | `P-04` |
| `codebase-design` | Incorporated/adapt — deep modules exist in CC/AEP; do not impose exact vocabulary | §3.1 |
| `diagnosing-bugs` | Partial → AIR — the general red-capable loop over existing tools | `P-02` |
| `domain-modeling` | Partial → AEP — scenario/glossary/code/ADR reconciliation | `P-07`, `P-17` |
| `grill-with-docs` | Compose only — invokes grilling and domain modeling; no independent mechanism | — |
| `implement` | Incorporated — CC/Kiro/graphs own implementation and mutation authority | §3.1 |
| `improve-codebase-architecture` | Optional AIR procedure — keep hotspot evidence and deletion/leverage tests; avoid CDN HTML | — |
| `prototype` | Convention first — one question, a fixture, evidence, a decision | `P-29` |
| `research` | Package — primary-source, citation, artifact-promotion standards | `P-05` |
| `resolving-merge-conflicts` | Incorporated/adapt — reject "never abort" | §3.1, `X-11` |
| `setup-matt-pocock-skills` | Incorporated/exclude mechanics — no tracker-specific label bootstrap | `X-03` |
| `tdd` | Incorporated/adapt — retain refactoring and autonomous seam judgment | `P-13`, `X-10` |
| `to-spec` | Incorporated/adapt — keep outcomes and exclusions; reject mandatory seam interviews and verbosity | §3.1, `X-12` |
| `to-tickets` | Incorporated for execution; guidance addition | `P-10` |
| `triage` | Conditional — category stays separate from lifecycle | `P-20`, `P-25` |
| `wayfinder` | Highest-value partial — pilot discovery over native state; no issue-assignment lease | `P-26`, `P-16` |
| `wizard` | Adapt — staged UX is useful evidence; generated shell and secret handling are not | `P-27`, `X-19` |

**Promoted productivity (7/7)**

| Skill | Disposition | Ledger |
|---|---|---|
| `grill-me` | Optional attended wrapper — no independent mechanism | `P-01` |
| `grilling` | Pilot — prerequisites, fact research, frontier batching; reject exhaustive interruption as default | `P-01`, `X-05` |
| `handoff` | Mostly incorporated; improve composition | `P-06` |
| `teach` | Outside CC/AEP | `X-25` |
| `to-questionnaire` | Optional AIR — CC has no second-party surface | `X-25` |
| `wait-what` | AIR micro-pattern or no action | `X-25` |
| `writing-for-agents` | Mostly incorporated — consolidate the missing pointer/completion rules with the existing owner | `P-08` |

**Misc, unpromoted (4/4)**

| Skill | Disposition | Ledger |
|---|---|---|
| `git-guardrails-claude-code` | Principle incorporated; implementation excluded | `P-28`, `X-17` |
| `migrate-to-shoehorn` | Exclude | `X-26` |
| `scaffold-exercises` | Exclude | `X-26` |
| `setup-pre-commit` | Superseded | `X-27` |

**In-progress (7/7, lower-confidence evidence)**

| Skill | Disposition | Ledger |
|---|---|---|
| `claude-handoff` | Exclude — backend-specific duplicate of CC sessions and durable handoff | §3.1 |
| `implement-spec` | Execution incorporated — external validation of CC's graph direction, not a new feature | §3.1 |
| `loop-me` | Later workflow-authoring input | `P-32` |
| `setup-ts-deep-modules` | AEP example / AIR recipe — strong prove-the-rules-bite guardrail; one TS topology is not universal | §3.1, §5.3 |
| `writing-beats` | Outside CC; AIR writing candidate | `X-25` |
| `writing-fragments` | Outside CC; AIR writing candidate | `X-25` |
| `writing-shape` | Outside CC; overlaps `writing-beats` | `X-25` |

### 9.2 Corpus coherence cautions

No corpus is internally perfect.

**MATT.** The README calls red-green-refactor critical while `tdd` removes refactoring (`README.md:142-158`; `skills/engineering/tdd/SKILL.md:34-38`). Setup docs name GitHub/Linear/local while the implementation branches across GitHub/GitLab/local/other. `to-spec` says it is not an interview, then requires seam confirmation. `triage` requires category and state roles, but setup maps only five state labels. `writing-for-agents` advocates a single source while inventory and routing are duplicated across READMEs, plugin metadata, root instructions, and `ask-matt`.

**Command Center.** See §4 — `BF-3` is the operative finding. The `CONTEXT.md` graph-profile "contradiction" was struck on verification (§4.4). Needs You must be described as an existing derived projection, not a new feature; its available work is adapter and ranking coverage.

**AEP and AIR.** AIR's `ai-validation-output` conflicts with the newer AEP owner. AIR's unconditional test-edit hook violates AEP's evidence-earned feedback tiers. AIR has byte-identical duplicate code-standards reference trees and a duplicate design-agent template. AIR `reflection`/`steer` self-reports are claims, where AEP retrospectives require deterministic extraction and spot checks. **Verified:** the `knowledge-base-ingester` agent routes to a `knowledge-base-ingest` skill five times, and that skill does not exist in the installed plugin. AEP and AIR are separately installable, so no cross-plugin route may assume both are present.

### 9.3 Donor-material disposition

Analysis-only content, with an explicit fate so nothing vanished by attrition:

| Item | Fate |
|---|---|
| Four-corpora orientation | **Folded** — §1, §2 |
| Reverse flow (what MATT lacks) | **Kept** — §2.4 |
| "CC steering already cites AEP by name" | **Kept** — §2.2 |
| `implement-spec` as external validation of CC's direction | **Kept** — §3.1 |
| Artifact-lifetime framing | **Kept** — §2.3(4), `X-13` |
| Concept-ledger format | **Kept** — §3 structure |
| Charter crosswalk | **Kept** — §6 |
| Stale user-level `request-refactor-plan` (deprecated upstream; local copy stale) | **Kept** — §10 |
| "~65% of turns trip the context default" | **Kept** — `P-03` rationale |
| `D1`–`D9`, `F1`–`F9`, `S1`–`S8` | **Folded** into §3 and §5 with aliases; each traceable |
| Absence claims for debugging, research, two-axis review | **Corrected** — §4.4 |
| Concept counts | **Replaced** by verified counts — §4.4, §9.1 |
| Decision-map UI, fog state, claim-by-assignment as predetermined shapes | **Deferred / dropped** — `P-26`, §4.4 |

### 9.4 Method

Two independently authored syntheses (see Provenance) were reconciled in a single authoring pass. The study's judgments, gates, and completeness accounting govern; the analysis donates framing, examples, structure, and gated brainstorms. Before any prose, six verification checks ran against current code and corpora, covering the three baseline claims, the corpus counts and `deprecated/` bucket, the AIR route, and two placement-determining capability facts. §4.4 records every struck or corrected claim. The independent challenge review was excerpt-read for provenance only, not re-synthesized. External repositories were read-only throughout.

---

## 10. Decisions that still need Alex

Only choices the evidence does not settle. Everything else in this document is resolved.

1. **Grilling depth (`P-01` → `P-21`).** Managed skill now, session object only if the skill proves out — or skip the skill and treat the elicitation UI as the product? *Recommendation: skill now; `P-21` stays gated.*
2. **Domain-modeling home (`P-07`).** AEP (doctrine, and CC steering already points there), AIR (procedure), or the CC bundle? *Recommendation: AEP.*
3. **Rejection memory depth (`P-15` → `P-23`).** The `docs/out-of-scope/` convention is nearly free; the feature adds surfacing at proposal time, which is where re-litigation actually happens. *Recommendation: convention first; promote only on observed re-litigation.*
4. **Wayfinder ambition (`P-26`).** Prerequisite-aware discovery over existing native-SDD objects, or a decision-map surface? The feature is the largest build proposed here; the method captures roughly half the value at a fraction of the cost. *Recommendation: method first.*
5. **Whether `BF-2` is a defect or a documented constraint.** Verification showed the skip is deliberate and commented. The remaining question is whether to build bounded project-scoped reference consumption or simply surface a typed refusal. *Recommendation: refuse loudly first; build only on demand.*
6. **Personal-productivity ports to AIR** (`wait-what`, the writing trio, wizard-as-skill). *Not recommended by default.*
7. **Stale user-level `request-refactor-plan`** — deprecated upstream in favor of `to-spec` + `improve-codebase-architecture`; the local copy is stale. Refresh or remove.

**Informational, not for approval:** eight claims were struck or corrected during verification (§4.4). The most consequential are that the `CONTEXT.md` graph-profile contradiction does not exist, that `BF-2` is a documented constraint rather than an accidental drop, and that reproduction-first debugging is a packaging gap rather than an absent capability in all three baselines.

---

## 11. Final recommendation

Preserve MATT's best **ideas**, not its runtime. The durable contribution is a vocabulary for uncertainty — prerequisites, frontier, fog, facts, decisions, evidence, purpose-aware context — and a handful of well-shaped methods: red-capable diagnosis loops, two independent review axes, structurally different designs before synthesis, and explicit phase-boundary choices.

CC keeps lifecycle truth in typed state and deterministic orchestration. AEP keeps generic doctrine. AIR keeps reusable procedures.

Do the reliability work first (`BF-1`, `P-18`, `BF-3`, `BF-2`), then the packaging (`P-01`…`P-17`), and promote a pilot to product state only when it demonstrates a need for persistence, policy, concurrency, provenance, or secure inputs that a skill cannot supply. That keeps Command Center composable and inspectable — the one thing mattpocock-skills is right to insist on — while incorporating its strongest insights without importing its tracker coupling, model-managed bookkeeping, unsafe shell mechanics, or contradictory absolutes.
