# mattpocock-skills: comparative analysis against Command Center, agentic-engineering-principles, and ai-resources

> **Superseded — retained as a source input.** The canonical report is
> [`2026-08-23_mattpocock-skills-consolidated.md`](./2026-08-23_mattpocock-skills-consolidated.md),
> which uses this document as its **donor**: its framing, orientation material, concept-ledger
> format, charter mapping, named examples, and gated brainstorms are folded in, each traceable
> through the `analysis:` alias column in its §3 and the disposition table in its §9.3.
> The consolidated report **corrected** this document's loose corpus counts (verified: 18/7/4/7 =
> 36 total, 25 promoted) and re-worded its absence claims — reproduction-first debugging, research,
> and two-axis review are packaging gaps around existing capabilities, not absent capabilities.
> See its §4.4. Read this file for the original reasoning; act from the consolidated report.

**Date:** 2026-08-23
**Session:** review-mattpopcock-skills (charter: mattpocock-skills comparative study)
**Corpora read:** `/Users/alex/github/mattpocock-skills` (all five buckets, including `deprecated/` and `in-progress/` as direction signal, plus ADRs, `.out-of-scope/`, changesets); `agentic-engineering-principles` plugin (13 skills); `ai-resources` plugin (~36 skills + agents/hooks/resources); CC native surfaces (AGENTS.md/CLAUDE.md, 11 steering docs, 29 repo skills, `docs/VISION.md`, `CONTEXT.md`, the full `cctl` surface).
**Depth:** proposal-level sketches, not implementable specs. Recommended home stated per accepted idea; items needing Alex's call are collected in §11.

---

## 1. Executive summary

- **The corpora agree on far more than they disagree.** All four name the same enemies — misalignment, context waste, unverified claims, entropy — and all four believe in fresh-context work units, dependency-ordered decomposition, human approval at phase boundaries, and domain vocabulary as a compression tool. mattpocock-skills reads like a *prose-and-human-loop* implementation of the same worldview CC implements as *typed server machinery*.
- **The one real philosophical conflict is process ownership.** mattpocock positions explicitly against process-owning frameworks ("they take away your control and make bugs in the process hard to resolve") — and CC's kiro + native SDD + graph workflows are exactly that. The conflict mostly dissolves on inspection: mattpocock's underlying objection is *opacity and unrepairability*, and CC answers it with observability (Spec Studio, workflow UI, audit skills) and repair (plan repair, live edit) — plus Alex owns the process code, which is the same hackability mattpocock sells. But the objection survives as a standing design constraint: keep CC processes inspectable, repairable, and keep the lightweight path (which `docs/VISION.md` already commits to).
- **By the plugins' own doctrine, CC's position is the stronger one.** mattpocock's skills make the model execute process bookkeeping (labels, states, gates) in prose; agent-offloading says the model is the least reliable component for exactly that. CC mechanizes the bookkeeping and reserves agents for judgment. mattpocock wins on iteration speed and hackability; CC wins on reliability at scale. This is a genuine trade-off, not a verdict — and it is the reason "wholesale importing" (a charter non-goal) would be wrong even if allowed.
- **A surprising amount is already incorporated.** Of ~30 distinct concepts in mattpocock-skills: ~11 are already present or superseded (often mechanized more strongly in CC — `implement-spec` vs the graph engine is the clearest case), ~6 are partial, ~9 are genuine gaps worth adopting, and ~7 should be explicitly excluded. Two mattpocock skills are *already installed at Alex's user level* (`improve-codebase-architecture`, plus `request-refactor-plan`, which upstream has since deprecated in favor of `to-spec` + `improve-codebase-architecture` — the local copy is stale).
- **The strongest adoption candidates:** the **grilling** discipline (round-based frontier elicitation over `cctl ask`), **diagnosing-bugs** (feedback-loop-first debugging — a gap in all three baselines), **writing-craft for agent docs** (leading words, negation, no-op hunting — complements earned-guidance-docs), the **phase-boundary decision procedure** (CC has all the context-hygiene machinery and no when-to guidance), **`.out-of-scope/` rejection memory**, and the **wizard → human-action-runbook** concept, which generalizes CC's existing `human_act_required` contract into a first-class feature opportunity.
- **The clearest exclusions:** tracker-agnostic indirection (CC owns its tracker), the local `.scratch/` tracker (a competing path by CC's own adoption-matrix rule), the personal/teaching/prose-writing skills (out of CC's product scope), `claude-handoff` (superseded by CC sessions), and unconditional no-question-caps (incompatible with CC's autonomous-turn model; resolved as a mode split, not adopted wholesale).

---

## 2. The four corpora at a glance

**mattpocock-skills** — ~25 small, composable, deliberately hackable skills for engineers using coding agents. Four named failure modes drive everything: misalignment (cured by relentless "grilling" interviews), verbosity (cured by a ubiquitous-language CONTEXT.md glossary), broken code (cured by feedback loops / TDD at pre-agreed seams), entropy (cured by Ousterhout-style deep modules). One main pipeline — grill → spec → tracer-bullet tickets → implement — with on-ramps (triage, wayfinder, diagnosing-bugs). Distinctive machinery: user-invoked vs model-invoked skill taxonomy with a hard "no skill calls a user-invoked skill" invariant; near-empty orchestrator skills composing model-invoked primitives via the Skill tool; `.out-of-scope/` rejection memory; institutional decision records in changesets; a first-class prose theory of writing for agents.

**Command Center** — a control plane where process is *product*: server-enforced staged spec authoring, typed human-only acts, hash-bound approvals, graph workflow execution with validators/circuit breakers/plan repair, worktree isolation, registered validation, structured question batches (`cctl ask`), compaction artifacts, reference documents, tickets, evidence-based verification skills. Guidance ships as steering (repo-specific), a managed cross-backend skill bundle (portable), and a registry-derived CLI help graph.

**agentic-engineering-principles** — 13 doctrine skills distilled (visibly from CC itself) into portable principles: context economics, evidence-earned guidance, mechanical enforcement over prose, feedback tiers in tool output, progressive disclosure for tooling and data, live-system verification, retrospectives, structured output, logging for agents. It is the *theory layer* CC's cli.md explicitly delegates to.

**ai-resources** — ~36 pragmatic workflow/utility skills plus subagents and one hook: understand-objective → create-plan / multi-agent design workflow, code-standards review fan-out, write-tests doctrine, reflection/steer retrospectives, perf tooling, document generators. File-coupled multi-agent phases, conservative human gates, `memory-bank/` + `agent-docs/` artifact conventions. Notable declared absences: no ticket decomposition, no TDD loop, no bug-diagnosis skill, minimal handoff.

---

## 3. Philosophical alignment and conflict

### 3.1 Shared ground

1. **Fresh context per work unit.** mattpocock: tickets "sized to fit in a single fresh context window", `/clear` between tickets. CC: execution contexts as independent agent sessions; kiro-impl's one-sub-task-per-iteration with re-read-from-disk. Identical doctrine.
2. **The frontier.** mattpocock reuses one concept — the set of items whose prerequisites are settled — across grilling rounds, ticket graphs, and wayfinder maps. CC's graph engine ready-set is the same concept mechanized. (Vocabulary adoption is a cheap alignment win; see §10.)
3. **Decompose into dependency-ordered vertical slices.** Tracer-bullet tickets with blocking edges ≈ CC execution contexts with deliberate edges. Both warn against horizontal slicing.
4. **Human judgment at phase boundaries, autonomy inside them.** mattpocock's grilling stop-gate and to-tickets quiz ≈ kiro approval gates and native-spec human-only acts. mattpocock's `loop-me` "push right" (defer the checkpoint maximally; the human reads a brief, never raw output) is precisely CC's autonomy direction. The apparent grilling-vs-autonomy tension inside mattpocock resolves the same way CC resolves it: front-load alignment, then run AFK.
5. **Primary sources over derivatives.** mattpocock: research targets primary sources; conversations are primary sources; "every compaction is lossy"; resolve merge conflicts by tracing intent to primary sources. CC: "every published number must trace to primary telemetry"; kiro-verify demands fresh evidence; graph planning requires materializing external sources into the worktree. Same epistemology, CC's is mechanized.
6. **The environment is the source of truth; docs restating it are caches.** mattpocock says it in prose; CC derives help/SKILL.md/flag allowlists from a typed registry so the cache cannot drift.
7. **Domain vocabulary as compression.** mattpocock's CONTEXT.md glossary with `_Avoid_` lists; CC's CONTEXT.md deep-module vocabulary and the design system's enforced glossary tone. Same belief, different flavor (see ledger row 2).
8. **Deep modules.** mattpocock's codebase-design (depth = leverage at the interface, deletion test) ≈ CC structure.md ("depth over line count", deletion test) ≈ the session-available software-design-philosophy skill. Ousterhout is the shared ancestor.
9. **Institutional memory for decisions and rejections.** mattpocock: minimal ADRs, `.out-of-scope/`, narrative changesets. CC: steering, memory, adoption-matrix deletion conditions, Alignment decisions, spec assumptions/waivers. AEP: earned-guidance lessons files. Everyone agrees; the *rejection-record* slice is under-served everywhere but mattpocock (§6.5).

### 3.2 Real conflicts, and how each should resolve

1. **Process ownership (the big one).** Anti-framework stance vs CC-as-framework. Resolution above (§1): treat mattpocock's objection as a design constraint CC already honors (observable, repairable, lightweight path), not as a reason to change course. Do not adopt "process as editable prose" for anything load-bearing — that contradicts agent-offloading, which CC's own steering enshrines.
2. **Question economics.** mattpocock rejects question caps outright (`.out-of-scope/question-limits.md`: a cap conflates under-specified plans with low-value questions; prompt quality is the fix). CC says "ask only at real forks", denies asking on autonomous turns; ai-resources caps at 1–4 per call. Resolution: **mode split**. In an *attended, user-initiated* elicitation session (the user ran the grilling skill), relentless is correct and caps are a prompt-quality dodge — mattpocock's reasoning is sound and worth importing into any CC grilling skill. In *ambient/autonomous* work, CC's conservatism is correct. No surface should hard-cap total questions; per-round batch sizing is a UX matter, not a philosophy.
3. **Artifact durability vs. resolvable precision.** mattpocock: specs/tickets never contain file paths or line numbers ("they go stale"). CC: kiro-design mandates a File Structure Plan; graph plans cite source locators that must *resolve at authoring time*. Resolution: both are right for their artifact lifetimes. mattpocock tickets can sit in a tracker for months; CC plans and tasks are near-term execution artifacts consumed within a session or an execution. No change needed — but the distinction is worth one line in graph-workflow-planning guidance so nobody imports the "no paths" rule into short-lived plans, and so long-lived artifacts (native specs, tickets) keep leaning behavioral, which they already do.
4. **Refactor placement.** mattpocock: TDD is red→green only; refactoring belongs to code-review. CC: red-green-refactor with tests green. Minor; CC keeps its loop. mattpocock's underlying point — don't let refactor ambition contaminate the green step — is already served by CC's proportionality review in kiro-review.
5. **Human cognitive load.** mattpocock: the human's reading burden is "the price of human agency," not to be minimized. CC's push toward autonomy and briefs seems opposed but isn't: mattpocock spends human attention at alignment time and defers it during execution (`loop-me`'s push-right). CC does the same. Genuine residual difference: mattpocock's flows assume an attended operator far more often; CC must state per-flow whether it is HITL or AFK — which is exactly mattpocock's wayfinder HITL/AFK classification, worth adopting (§9.8).
6. **Merge-conflict doctrine.** mattpocock: "always resolve; never `--abort`." ai-resources: plan + human approval before resolving. CC: merge machinery owns most conflicts. Low stakes; no adoption. CC's worktree-safety conservatism wins inside CC sessions.

### 3.3 Reverse flow (what mattpocock lacks that the baselines have)

Not a charter deliverable, but useful context for judging maturity: mattpocock-skills has **no evidence-verification discipline** (nothing like kiro-verify-completion's fresh-evidence gate or live-system-verification), **no retrospective/audit machinery** (AEP agent-retrospectives, CC graph-workflow-audit), **no proportionality/over-engineering check** in review, and **no mechanical enforcement** beyond one git-hook installer — its guardrails are prose and human attention. Its verification story is "feedback loops while working," not "evidence before claiming done." This asymmetry is why the adoption flow runs mostly mattpocock → CC for *elicitation and framing* ideas, and would run the other way for *verification and enforcement*.

---

## 4. Concept ledger

Verdicts: **INC** = incorporated (where), **SUP** = superseded (baseline version is a mechanized superset), **PART** = partially covered, **GAP** = compatible but not incorporated anywhere, **EXCL** = exclude from adoption.

| # | mattpocock concept | CC | AEP plugin | ai-resources | Verdict |
|---|---|---|---|---|---|
| 1 | Grilling: rounds over the question frontier of a design tree; facts→background subagents, decisions→human; no caps | `cctl ask` batch surface exists (recommended badges, tradeoffs, one pending batch ≈ one round); no discipline anywhere | — | understand-objective: batched 1–4, iterate to zero; no rounds/tree/fact-split | **GAP** (skill) |
| 2 | CONTEXT.md as pure glossary + `_Avoid_` lists; active domain-modeling (challenge, sharpen, cross-reference with code, lazy inline updates) | CONTEXT.md exists but is architecture vocabulary; no glossary discipline | — | document-map (navigation, unused) | **GAP** (discipline) / PART (artifact) |
| 3 | Minimal ADRs + triple gate (hard to reverse ∧ surprising ∧ real trade-off) | decisions in steering/specs/Alignment decisions; no ADR convention | earned-guidance lessons (different slice) | — | **PART** |
| 4 | `.out-of-scope/` rejection memory, checked before re-proposing | memory files; adoption-matrix deletion conditions (code paths only) | earned-guidance covers positive rules only | — | **GAP** |
| 5 | to-spec: pure synthesis, no re-interview; seams confirmed as the one interaction | kiro requirements/design + native spec staged authoring (server-enforced) | — | create-requirements (PRD, no elicitation) | **SUP** (CC) |
| 6 | to-tickets: tracer-bullet vertical slices, blocking edges, sized to one fresh context | graph execution contexts + DAG; kiro tasks 1–3h with `_Depends:_` | — | absent (declared) | **SUP** (CC) |
| 7 | Expand–contract sequencing for wide refactors (blast-radius batches) | not named in graph-workflow-planning | — | — | **GAP** (guidance) |
| 8 | implement: thin orchestrator, `/clear` between tickets, typecheck cadence | kiro-impl: bounded loops, strict handoff parsing, divergence detector | — | — | **SUP** (CC) |
| 9 | implement-spec (beta): worktree-isolated implementer subagents + merger + frontier concurrency | the graph workflow engine, lanes, merge machinery | — | — | **SUP** (CC) |
| 10 | Wayfinder: shared map of decision tickets, fog of war, HITL/AFK typing, claim-by-assignment | kiro-discovery roadmap.md; tickets; Alignment decisions — no decision *graph*, no fog, no HITL/AFK | — | — | **GAP** (feature) |
| 11 | Prototype: logic prototypes as self-contained HTML for non-developers; N structurally-different UI variants; prototype branches as kept primary sources | ui-design/Storybook covers UI-variant prototyping partially | — | — | **GAP** (partial) |
| 12 | Diagnosing-bugs: feedback-loop-first; 10-technique loop ladder; hard gate (named red command before hypothesizing); `[DEBUG-xxxx]` tags; regression test at a correct seam | kiro-debug (impl-failure triage, different scope); AGENTS.md repro-test-first (one line of same doctrine) | — | perf-investigator only | **GAP** (all three) |
| 13 | Research: primary sources only, background agent, cited notes saved to repo convention | kiro research.md; `cctl agent run`; materialization rule | — | knowledge-base-ingester | **INC** (spirit) |
| 14 | TDD reference: pre-agreed seams; tautological-test anti-pattern; red→green | engineering-principles TDD (no seam-agreement step, no tautology naming) | — | write-tests (confidence test ≈ adjacent) | **PART** (2 nuggets) |
| 15 | Code review: two axes (Standards/Spec) never merged or cross-ranked; parallel word-capped subagents; Fowler baseline; skip tooling-enforced | kiro-review (spec-anchored, mechanical+judgment, proportionality — stronger overall) | — | code-reviewer, code-standards fan-out | **INC**; no-cross-axis nugget PART |
| 16 | Merge-conflict resolution by intent traced to primary sources | merge machinery + memory traps | — | fix-merge-conflicts | **INC** (AIR) |
| 17 | Wizard: generated interactive walkthrough for human-only steps; "work an agent can do, an agent should do" | `human_act_required` typed contract (spec gates only); `cctl ask` | — | — | **GAP** (feature idea) |
| 18 | PHASE-BOUNDARIES: continue / clear / handoff / subagent / compact — worked *in order*, at boundaries only; compaction is lossy; pointer-not-copy handoffs | all the machinery (compaction artifacts, docs, tickets, agents), none of the decision procedure | — | save-current-context (minimal) | machinery **SUP** / procedure **GAP** |
| 19 | claude-handoff: seed a background agent with the handoff | CC sessions, ticket `start`, `cctl agent` | — | — | **SUP** (CC) |
| 20 | writing-for-agents: leading words, negation as failure mode, no-op hunting, two budgets, completion criteria w/ clarity+demand | — | earned-guidance + progressive-disclosure cover *admission* and *architecture*, not prose craft | compress (style, not theory) | **GAP** (AEP) |
| 21 | Invocation taxonomy: user- vs model-invoked; no skill calls a user-invoked skill; router skills; Skill-tool-explicit cross-references | `disable-model-invocation` used ad hoc; no stated rules | — | heavy `disable-model-invocation` use, no stated rules | **GAP** (authoring guidance) |
| 22 | Triage state machine + AGENT-BRIEF doctrine | tickets exist, no triage states; graph AC discipline ⊃ brief doctrine | — | — | brief **SUP**; triage **EXCL**-for-now (no inbound-issue surface) |
| 23 | Tracker-agnostic indirection (`docs/agents/issue-tracker.md`) | CC owns its tracker (`cctl ticket`) | — | — | **EXCL** |
| 24 | teach (missions, learning records, desirable difficulty) | — | — | explainer-document (adjacent) | **EXCL** (scope) |
| 25 | to-questionnaire ("grill the send, not the subject") | `cctl ask` targets the operator only | — | — | **EXCL** (single-operator) |
| 26 | wait-what (one-shot re-pitch in Simplified Technical English) | — | — | — | **EXCL** for CC; optional AIR micro-skill |
| 27 | writing-beats / -fragments / -shape (explore/exploit prose workflows) | — | — | explainer/cheat-sheet (different niche) | **EXCL** for CC; optional AIR |
| 28 | loop-me: loop lens, mandate nothing structural, push right, brief-not-raw-output | workflow templates + harness schedules exist; no authoring flow | — | — | **GAP** (feature brainstorm) |
| 29 | Setup skill pattern (explore → sectioned Q&A → draft → write; seed templates) | project-setup / dev-server-setup skills | — | init-design-config etc. | **INC** |
| 30 | setup-ts-deep-modules: dependency-cruiser boundary install; prove-the-rules-bite | seams ratchet (stronger, CC-specific) | mechanical-guardrails = the doctrine, no installer | — | **SUP** (CC) / **GAP** (AIR installer) |
| 31 | git-guardrails hook (block dangerous git in the harness) | AGENTS.md prose rules only | mechanical-guardrails says prose is rung 1 | one hook exists (write-tests nudge) | **GAP** (mechanize in CC) |
| 32 | Design-it-twice: 3+ parallel subagents with *different design constraints*, then opinionated synthesis | VISION wants Generate-And-Filter/Tournament; no shipped template | — | design workflow reviews one draft in parallel; never generates alternatives | **GAP** (CC template + AIR phase) |

Counts: 11 INC/SUP, 6 PART, 9 GAP (rows 1, 4, 7, 10, 11, 12, 17, 20, 21, 28, 31, 32 — some double-homed), 7 EXCL.

---

## 5. Already incorporated — notes beyond the table

- **CC steering already cites AEP by name.** `cli.md` delegates principle ownership to cli-tools-for-agents, query-output-disclosure, progressive-disclosure-tooling, and agent-feedback-tiers; `engineering-principles.md` embeds the Agent-Offloading Principle. The AEP plugin is effectively CC's extracted theory, so "incorporated into a plugin" is often literally true by construction.
- **`implement-spec` is the flagship supersession.** mattpocock's newest beta (worktree-isolated implementers, merger subagent, frontier concurrency, pointer-only communication) is a prose description of CC's graph engine. Everything it wants — plus validators, circuit breakers, plan repair, live edit, audit — already exists as product. No action; useful as external validation of CC's direction.
- **`cctl ask` already implements grilling's UX substrate.** Numbered questions, recommended-answer badges, structured tradeoffs, one pending batch at a time (= one round). What's missing is purely the discipline layer (row 1).
- **User-level installs observed.** This session's environment includes user-level skills matching mattpocock's `improve-codebase-architecture` (references CONTEXT.md + `docs/adr/`) and the *deprecated* `request-refactor-plan` (upstream replaced it with `to-spec` + `improve-codebase-architecture`). Also present: `software-design-philosophy` (same Ousterhout lineage). **Actionable side-finding:** the local `request-refactor-plan` copy is stale relative to upstream's retirement; worth refreshing or removing when convenient.
- **AGENT-BRIEF doctrine vs CC acceptance criteria.** mattpocock's brief rules (behavioral, independently verifiable, explicit out-of-scope, durable) are a subset of graph-workflow-planning's AC discipline (independently-failable obligations, stable ids, banned patterns, capability ownership). CC's version is stronger because it was audited against a real 21-context failure.

---

## 6. The CC gap list (compatible, not yet incorporated anywhere)

1. **Grilling discipline** (row 1). Round-based frontier elicitation with the facts/decisions split. CC-compatible because `cctl ask` is already round-shaped and background agents can run fact-finding while a batch pends (spawn agents, then ask, then end turn — both survive turn end).
2. **Rejection memory** (row 4). Durable "we considered X and rejected it because Y" records, checked before re-proposing. CC has the belief (this very charter mandates explicit rejections) but no first-class surface.
3. **Feedback-loop-first debugging** (row 12). The loop-construction ladder and the hard gate (no hypothesizing before a named, already-run, red-capable command) is missing from CC, AEP, and ai-resources alike. The `[DEBUG-xxxx]` tag convention and "state the winning hypothesis in the commit message" are cheap riders.
4. **Phase-boundary decision procedure** (row 18). CC owns compaction, reference docs, agents, and tickets, but nothing teaches *when* to continue vs clear vs hand off vs subagent vs compact. mattpocock's ordered five-option procedure maps 1:1 onto CC surfaces. (CC memory: 65% of turns trip the 150k default — this guidance has a measured audience.)
5. **Wayfinder decision mapping** (row 10). Cross-session efforts need "decisions, not deliverables" maps with deliberate fog. CC's roadmap.md is dependency-ordered specs (deliverables); Alignment decisions are per-session. The HITL/AFK typing is independently valuable (§9.8).
6. **Prototype discipline** (row 11). Logic prototypes as shareable single-file HTML in domain language; "structurally different or it's wallpaper" for UI variants; prototype branches kept as primary sources with context pointers from the implementing issue.
7. **Writing craft for agent-facing prose** (row 20). Leading words, negation avoidance, no-op hunting ("delete the whole sentence"; settled by running the document), the two-budgets frame. Complements — does not overlap — earned-guidance-docs.
8. **Invocation taxonomy for skill authoring** (row 21). Both CC's bundle and ai-resources use `disable-model-invocation` by instinct; nobody states the rules (model-invocation test, the no-calling-user-invoked invariant, router skills, "name the Skill tool explicitly for higher hit rate").
9. **Expand–contract for wide refactors** (row 7), **design-it-twice** (row 32), **human-action runbooks** (row 17), **routine authoring via loop-me's push-right** (row 28), **mechanized worktree git-safety** (row 31) — each detailed as a design or brainstorm below.

---

## 7. Explicit exclusions (with reasons)

1. **The anti-framework stance, applied to CC itself.** Adopting "small hackable prose skills only" would delete CC's core value (observable, enforceable, resumable process) and contradict agent-offloading. Retained only as a design constraint: every CC process must stay inspectable and repairable, and the lightweight path must exist (VISION already commits to both).
2. **Tracker-agnostic indirection layer** (row 23). CC owns its ticket store; maintaining canonical-role→label mappings for external trackers is the permanent-maintenance-surface mattpocock's own `.out-of-scope/mainstream-issue-trackers-only.md` warns about. Revisit only if CC ever integrates external trackers.
3. **`.scratch/` local markdown tracker.** CC has native tickets and specs; a parallel file tracker is a competing path, which CC's adoption-matrix philosophy explicitly forbids creating.
4. **teach, to-questionnaire, wait-what, writing-beats/-fragments/-shape** (rows 24–27). Outside CC's product scope (coding control plane; single operator). to-questionnaire's cross-stakeholder elicitation is a real concept but CC has no second-party surface to aim it at. Optionally ai-resources material if Alex wants personal-productivity coverage — flagged in §11, no recommendation to adopt.
5. **claude-handoff** (row 19). Harness-bound (`claude --bg`); CC sessions, `cctl ticket start`, and `cctl agent run` are the native superset.
6. **"Always resolve; never `--abort`" and handoffs-to-OS-temp.** Both conflict with CC's conservatism and durable-artifact model respectively. CC compaction artifacts are first-class and durable; temp-dir handoffs would be a regression.
7. **Unconditional no-question-caps.** Adopted only inside an attended grilling mode (§3.2.2); CC's autonomous-turn ask-denial stands.
8. **House style items** (em-dash ban, AI-comment disclaimers on public trackers). Taste and non-applicable context respectively. (The disclaimer idea becomes relevant only if CC ever posts agent output to public trackers.)

---

## 8. Deliverable 1 — designed improvements to the plugins

Proposal-level sketches. CC-directed designs are in §9 (features) and §10 (skills/instructions).

### 8.1 agentic-engineering-principles

**D1. New skill: `writing-craft-for-agents`** *(from writing-for-agents + SKILL-MECHANICS)*
The prose-mechanics layer AEP lacks: leading words (recruit pretrained priors: *tight*, *red*, *frontier*, *tracer bullet*); negation as a failure mode (prompt the positive); no-op hunting (sentence-level deletion test, settled by running the document, model-relative); the two budgets (context load vs human cognitive load, the latter "the price of human agency"); completion criteria with clarity + demand against premature completion; information hierarchy (in-file step → in-file reference → disclosed reference). Position it as the sibling of earned-guidance-docs: that skill decides *whether a line ships*, this one decides *how the line is written*. AEP's cross-reference mesh makes the pairing natural.

**D2. New skill: `feedback-loop-first-debugging`** *(from diagnosing-bugs)*
Generic doctrine: Phase 1 *is* the skill — construct a red-capable loop before any hypothesis; the 10-technique ladder (failing test → curl → CLI+fixture → headless browser → trace replay → throwaway harness → property/fuzz → bisection harness → differential → HITL script); the hard gate checklist (one named command, already run once, shown redacted, deterministic, fast, agent-runnable); tighten-the-loop as a product; ranked falsifiable hypotheses; one-variable probes; regression test at a correct seam *before* the fix, or the seam gap is itself the finding; `[DEBUG-xxxx]` tags; winning hypothesis in the commit message. This fills a declared hole in all three baselines and fits AEP's evidence-first identity perfectly (it is live-system-verification's diagnostic twin).

**D3. New skill (or major section in a skill): `skill-invocation-design`** *(from .agents/invocation.md + router-skill theory)*
The taxonomy: user-invoked (orchestrates, human-facing description, `disable-model-invocation`) vs model-invoked (holds discipline, trigger-rich description); the invariant that no skill calls a user-invoked skill (preconditions phrase as "tell the user to run /X"); the model-invocation test ("could the model usefully reach for this autonomously?" — reuse alone is not the test); explicit `Call the Skill tool with "name"` cross-references (higher hit rate, harness-neutral); router skills as the cure for user-side cognitive load ("it can only hint, never fire them"); shared reference between two user-invoked skills lives in neither. Both Alex's plugins and CC's bundle already follow parts of this by instinct; writing it down makes it reviewable.

**D4. Extend `earned-guidance-docs` with a rejection-memory section** *(from .out-of-scope/)*
A fourth admission surface alongside reminders/gotchas/lessons: the rejection record — one file per rejected *concept* (not per request), containing the ask, the reasoning, and the escape hatches; checked during triage/proposal flows to prevent re-litigation; explicitly excluding already-implemented closes (they poison dedup). The lessons-file format already has the right shape; this adds the negative-space counterpart ("what we deliberately don't do") that earned guidance currently lacks.

### 8.2 ai-resources

**D5. Upgrade `understand-objective` with the round/frontier protocol** *(from grilling)*
Keep the existing scratchpad and batching; replace "iterate until zero open questions" with the explicit design-tree model: map the tree, ask the full frontier each round (questions whose prerequisites are settled), defer dependent questions to later rounds, recompute after answers. Add the facts/decisions split: facts dispatched to the client's agent-delegation mechanism without blocking the round; decisions always to the human. Drop any implication that 1–4 questions is a *total* budget (per-call batch sizing stays). Expected effect: same coverage in fewer round trips — mattpocock measured "13 questions in ~3 rounds instead of 13."

**D6. Add an alternatives phase to the `design` workflow** *(from DESIGN-IT-TWICE)*
Before the current draft-then-review pipeline, an optional Phase 2.5: spawn 3 design agents with *different assigned constraints* (minimize interface / maximize flexibility / optimize the common caller — ports-and-adapters as a fourth when integration-heavy), each emitting interface + usage + hidden implementation + trade-offs to `{DESIGN_DIR}/alternative-*.md`; synthesis compares on depth/locality/seam placement and produces an opinionated pick or hybrid ("the user wants a strong read, not a menu") that becomes the design-draft input. The existing review phases then attack the winner. This converts the workflow's parallelism from *critique-only* to *generate-and-filter*.

**D7. Sharpen `code-reviewer` with the two-axis rule** *(from code-review)*
Where a spec/requirements source exists, report Standards findings and Spec-faithfulness findings under separate headings, never merged or cross-ranked, with a per-axis worst-issue line ("stops one axis from masking the other"). Add the spec-discovery ladder (commit-message refs → user-passed path → branch-matched spec file → ask; absent ⇒ note the axis was skipped).

**D8. New skill: `setup-boundary-enforcement`** *(from setup-ts-deep-modules)*
The turnkey installer counterpart to AEP's mechanical-guardrails doctrine: dependency-cruiser config with the four error-level rules (entry-point boundary, intra-package freedom, tests-through-entry-points, no cycles), an exemplar package that is "visibly deep, not a pass-through," and — the completion criterion — **prove the rules bite** (pass → introduce a violation → observe the fail → revert), plus the one-line context pointer from CLAUDE.md/AGENTS.md. Fits ai-resources' installer genre (setup-perf-stack, ai-validation-output).

**D9. Minor: `save-current-context` adopts pointer-not-copy** *(from handoff)*
Add two rules: never duplicate content that lives in durable artifacts (specs, plans, ADRs, issues, commits) — reference by path/URL; and include a "suggested skills" section naming what the next session should invoke. Cheap, directly improves the plugin's weakest area (handoff was a declared absence).

---

## 9. Deliverable 2 — first-class CC feature brainstorms

Ordered roughly by (value × fit); all are sketches, none scoped.

**F1. Human Action Runbooks** *(from wizard + human_act_required)*
Generalize the native-spec typed human-only act into an operational surface: an agent registers a step-by-step runbook for work only a human can do (provision a service, set CI secrets, click through a third-party dashboard), CC renders it as an interactive checklist panel — step text, `open URL` buttons, captured values (secret-masked) written to agreed destinations, confirm-before-irreversible steps — and completion resumes the agent with the captured facts. mattpocock solved this with a generated bash script and a fixed helper library because he has no UI; CC has the UI and the ask/notify/turn machinery already. The philosophy line carries over verbatim: "work an agent can do, an agent should do" — the runbook is only for the human-only residue, and the agent should reach for it the moment it hits that wall rather than dumping numbered instructions into chat.

**F2. Grilling sessions over `cctl ask`** *(from grilling)*
A thin session-object layer above ask batches: a named elicitation session holding the design tree; each `ask` batch is a round; answered/pending/deferred questions visible in the UI with the frontier highlighted; background fact-finding agents attachable to a round (their results annotate the questions they unblock); the stop-gate ("shared understanding reached") as an explicit terminal act. Most of the value ships as the skill (S1 below) with zero server work; the feature version adds continuity across turns and a UI the operator can scan instead of scrolling chat.

**F3. Decision maps** *(from wayfinder)*
A navigable graph of *decisions to make* for cross-session efforts: nodes are decision tickets (question-only bodies), edges are blocking relations, the frontier is computed, deliberate fog is first-class ("not yet specified" nodes that graduate into tickets when they can be stated precisely), claim-by-assignment across sessions, each node typed research/prototype/grilling/task and badged HITL or AFK. CC has every ingredient (tickets, Alignment decisions, sessions, agents) but no surface where the *decision structure* of a big effort is visible. Fits VISION's owning-agent direction: the map is what an orchestrating agent would maintain.

**F4. Rejection records** *(from .out-of-scope/)*
A first-class record type at project scope: concept-keyed, reason-bearing, with escape hatches noted; surfaced automatically during charter authoring, spec search-before-create, and ticket creation ("a matching rejection exists: …"); never auto-blocking, always visible. Distinct from Alignment decisions (session-scoped, affirmative) and from memory (agent-private). Cheap to build on the docs/tickets substrate and directly serves the anti-re-litigation behavior this session's own charter demands.

**F5. Design-it-twice workflow template** *(from DESIGN-IT-TWICE + VISION patterns)*
A shipped graph-workflow template: N parallel design contexts, each charged with the same problem under a *different named constraint*, one synthesis context comparing on depth/locality/seam placement and emitting an opinionated recommendation, optional human gate on the pick. This is the smallest concrete instance of VISION's Generate-And-Filter/Tournament ambition, exercises `{{inputs.*}}` templating, and gives the pattern a name agents can reach for.

**F6. Prototype artifacts** *(from prototype)*
Two halves: (a) a document type for self-contained HTML logic prototypes — rendered live in the CC document viewer, so "email a double-clickable file to a non-developer" becomes "send a CC link"; guided walkthrough tabs and state panels per the mattpocock format; (b) prototype-branch registry: `prototype/<name>` branches recorded as primary sources with context pointers from the implementing ticket/spec, so folded-in winners keep their provenance. (b) is mostly convention + one `cctl` affordance; (a) rides existing docs machinery.

**F7. Mechanized worktree git-safety** *(from git-guardrails, argued by mechanical-guardrails)*
AGENTS.md's worktree-safety rules (`no git stash/checkout/reset` etc.) are prose — rung 1 on AEP's own enforcement ladder, and a real incident class (the stash is shared across worktrees). CC provisions sessions; it can provision a PreToolUse hook or backend command policy that blocks the dangerous forms structurally, with the one-line `why:` at the point of refusal per designed-friction. Candidate for the managed bundle's settings surface so every backend gets it.

**F8. HITL/AFK classification on workflow contexts** *(from wayfinder)*
A planning-time flag per execution context: AFK contexts are linted against containing `askUserQuestions` gates; HITL contexts warn when launched into an unattended run. mattpocock added the classification after real users watched "a grilling agent answer its own questions" — the same failure shape as a CC context stalling on `awaiting_user_input` nobody will answer. Small schema addition, real planning-quality payoff, and it gives plan reviewers a vocabulary for a defect class they currently describe ad hoc.

**F9. Routine authoring ("loop grilling")** *(from loop-me)*
A guided flow that turns a recurring loop in the operator's life into CC machinery: grill the loop (trigger, inputs, outputs, failure handling), mandate nothing structural the interview didn't surface, place the human checkpoint as late as possible ("push right"), and emit a workflow template + schedule whose checkpoint delivers a *brief*, never raw output. Definition of done carries over verbatim: "an implementer agent could build it without asking a single question."

---

## 10. Deliverable 3 — CC skill/instruction-level changes

Per the standing placement rule: portable guidance → managed skill bundle or plugins; CC-repo-specific → steering. Homes stated per item.

**S1. `grilling` skill in the managed bundle.** The discipline of row 1 implemented on CC surfaces: map the design tree; each round = one `cctl ask` batch (numbered, recommendations via the `recommended` flag, tradeoffs structured); dispatch fact-finding to background agents *before* ending the turn so facts land with the answers; recompute the frontier; terminal stop-gate. Import the no-caps reasoning for attended sessions; defer to the ambient ask rules otherwise. (If F2 ships later, the skill drives it; the skill is valuable alone.)

**S2. `diagnosing-bugs` skill — CC-flavored.** The generic doctrine (D2) wired to CC machinery: loop candidates include `cctl validate run test -- <file>`, `cctl fixture prompt` against the worktree dev server, playwright-cli, `logs:duckdb` trace replay; the two-instance model as a named trap in loop construction; `[DEBUG-xxxx]` tagging composes with structured logging (a debug event grep-key, honoring logs.md). Home: managed bundle (portable across CC projects). If D2 lands in AEP, the CC skill shrinks to the wiring layer.

**S3. Phase-boundary guidance.** Add the five-options-in-order procedure to the `agent-context` (or `cc-cli`) managed skill, mapped to CC surfaces: continue (primary source; rule out first) → clear/fresh conversation → compaction artifact with an instruction argument (the default, not the first reach) → reference-document handoff (portability cases only) → background agent (AFK-scoped). Plus the pointer-not-copy rule for anything artifact-backed. One paragraph, big audience (65% of turns trip the context default).

**S4. graph-workflow-planning additions (steering-adjacent skill, CC-specific — allowed).**
   - Name the **expand–contract** pattern for wide mechanical refactors: expand context → migration batch contexts sized by blast radius, each edged on expand → contract context edged on all batches.
   - Adopt **frontier** as the term for the ready-set in prose (leading word; already the concept).
   - One line on artifact lifetimes (§3.2.3) so the "no file paths" durability rule is applied to durable artifacts only.
   - If F8 is rejected as a feature, add HITL/AFK as a planning *vocabulary* item instead (costs one paragraph).

**S5. engineering-principles.md (steering, repo-specific): two lines.** Name the **tautological test** anti-pattern (assertion recomputes the expected value the code's way; expected values come from an independent source) alongside the existing mock-echo smell; add **seam agreement** to the ad-hoc TDD loop ("confirm which seams get tests before writing them" — kiro flows already do this via design approval; the line covers non-kiro work).

**S6. ui-design skill: variant discipline.** Adopt "structurally different or it's wallpaper": N=3 (cap 5) genuinely different structures, prefer embedding in an existing page over an empty canvas ("an empty route hides design problems" — same claim as ui-design's page-coherence philosophy, now with a variant-count rule). Storybook already provides the switcher mattpocock had to build.

**S7. Skill-authoring conventions.** Wherever CC documents how bundle skills are written (or in D3's AEP skill, referenced from CC): the invocation taxonomy, the no-calling-user-invoked invariant, explicit Skill-tool cross-references, router-skill pattern. CC's bundle currently encodes these choices implicitly; one reviewable statement prevents drift as the bundle grows.

**S8. Domain-modeling discipline — needs Alex's call on home (§11).** The active moves (challenge terms, sharpen overloaded words, cross-reference with code, update the glossary inline and lazily; ADR triple gate). CC's CONTEXT.md is architecture vocabulary and should stay so; the glossary discipline is most valuable as a *portable* skill (AEP or ai-resources) that CC projects can also use, possibly with CC's CONTEXT.md exempted as an already-owned surface.

---

## 11. Items needing Alex's call

1. **Grilling home:** managed bundle skill only (S1), or bundle skill + session feature (F2)? Recommendation: S1 now, F2 if the skill proves out.
2. **Diagnosing-bugs home:** AEP generic (D2) + thin CC wiring (S2), or CC-only? Recommendation: both layers; the doctrine is the portable part.
3. **Domain-modeling home** (S8): AEP, ai-resources, or CC bundle. Recommendation: AEP (it is doctrine, and AEP is where CC steering already points for doctrine).
4. **Wayfinder:** feature (F3) vs. a planning-skill section teaching decision-mapping over existing tickets. The feature is the biggest build proposed here; the skill-only version captures maybe half the value.
5. **Rejection records:** feature (F4) vs. convention (a `docs/out-of-scope/` directory + one steering line). Convention is nearly free; the feature adds surfacing at proposal time, which is where re-litigation actually happens.
6. **Personal-productivity ports to ai-resources** (wait-what, writing pair, wizard-as-skill): only if wanted; none are engineering-critical. Not recommended by default.
7. **Stale user-level skill:** `request-refactor-plan` is deprecated upstream; refresh or remove.

---

## 12. Method appendix

Four parallel digest subagents (one per corpus) produced structured philosophy+mechanics inventories; synthesis, ledger judgments, conflict analysis, and all designs/brainstorms were done in the main session against those digests plus the session's own environment evidence (available-skills list, AGENTS.md/CLAUDE.md, memory index). Charter ambiguities resolved as: deprecated/in-progress included as direction signal; single consolidated report in `docs/reports/` (matching prior comparable work); proposal-level depth; per-item home recommendations with contested ones escalated (§11). External repos were read-only throughout; nothing outside this worktree was modified.
