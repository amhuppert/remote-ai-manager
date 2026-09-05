# Graph workflow planning retrospective: consolidated findings and recommendations

Ticket: command-center#80 · Written 2026-09-03, revised the same day to add FM-11 and R13; implementation status appended 2026-09-04 (section 11) · Tree at writing: main `c31d7126`

This report consolidates the six attachments on #80 (a tournament-pattern authoring field report, the five-run execution retrospective, two planning retrospectives and the workflow audit from the memory delivery, and the memory-delivery planning conversation), cross-checks them against two earlier workflow audits (`docs/reports/workflow-audits/2026-08-28-notepad-slice2-review-loop.md`, `docs/reports/workflow-audits/2026-07-19-native-sdd-execution-audit.md`), re-derives every load-bearing number from the event ledger and workflow logs, and verifies each reported friction against the code and guidance on main today. Section 8 is the independent analysis: what to change, who owns it, and which of the agents' own remedies not to adopt.

Method follows the `agent-retrospectives` discipline: mechanical extraction first, agent self-reports treated as claims, friction taken as reliable data but proposed fixes derived independently, every finding routed to an owner, and a preserve list alongside the problems.

## 1. Verdict

1. **Planning-model errors, not engine behaviour, drove the expensive runs.** Across the five audited runs plus the memory delivery, the ledger records 130 context validations, 76 of which failed. Failures concentrate in a few contexts per run, and in every case the concentrated context carried an acceptance criterion asserting something about the system the planner had inferred rather than read: data the product does not retain, a lifecycle the product does not implement, or state the embedder does not control. One failure class explains the spirals.
2. **Record count did not predict failure.** The contexts that failed most had the *fewest* criteria records in their runs (5 of 13 in the UI run, 2 and 1 of 12 in the memory run). No failing-heavy context ever exceeded the 12-record `lint/criteria-density` dial. The dial measures blob-shaped criteria, which is a real defect class, but it cannot see proof-surface breadth or unverified premises, which is where the money went.
3. **The costliest tooling friction is already fixed.** The locked-charter defect (#98) and its launch consequence account for 88 of the 157 tool calls in the memory delivery's planning stretch, and both landed on main on 2026-09-01. What remains on the native-SDD path is a short, verified list: a replace path that still refuses managed drafts unless the plan carries server-owned fields, no plan-to-ops converter, index-based error locators, a locator lint that warns on engine-materialized documents every run, two execution ids and three compare-and-swap token names, an entry point that routes planners to the Builder instead of the planning skill, and an unfixed, untracked pause-before-provisioning halt.
4. **Several remedies the agents proposed should not be adopted as written.** Two of the retros' proposed lints (surface-by-verb, spec-subset locators) would not have fired on, or are not needed for, the failures that occurred. The remedy for the biggest class belongs in the review protocol and the validator contract, not in more warning-tier prose. One proposal the first revision of this report declined, a rule against process language in validator-checked text, is adopted after Alex's notes supplied the incidents the attachments lacked (FM-11, R13).

## 2. Evidence and what was re-derived

Primary sources: `graph_workflow_events` (read-only), `workflow-logs/<execution>/` (`decisions.jsonl`, `lifecycle.jsonl`, per-context `iterations.jsonl`), the stored execution definitions, the planning conversation transcript (`cctl conversation read d198353e… --message N`), two live `cctl workflow validate` probes, and the source tree at main.

| Published claim | Source | Re-derived | Status |
|---|---|---|---|
| 60 of 102 agent validations failed across five runs; `81d48065` 39 of 52; its history context 18 of 19 | five-run retro | 60/102, 39/52, 18/19 from `graph-workflow-validation-result` events | confirmed |
| `e39cc5c0` has 249 durable events | five-run retro | 249 | confirmed |
| Memory delivery: validators rejected 10 of 12 contexts; 39 iterations | audit, planning retro | 28 rounds, 16 failed, 10 contexts with ≥1 failure; 39 distinct `iterationNumber`s across `iterations.jsonl` | confirmed |
| Rotation peak 391,298 tokens; three operator pauses | audit | 29 `rotation.scheduled` decisions, max `contextTokens` 391,298; 3 `execution.paused` / 3 `execution.resumed` | confirmed |
| Planning stretch cost "~85 tool calls, ~82% accidental" | planning retro | 157 tool calls in messages 32–46 (21, 1, 41, 29, 9, 25, 25, 6); 26 of them Playwright; 88 in the four messages that only exist because of #98 | count under-reported; the accidental share holds |
| "The whole 27.6 KB pinned spec is injected into every context on every iteration" | planning retro | prompts carry a charter digest whose source entries are rank, label, locator and a truncated description; the spec is a seeded shared document at `.cc/graph-workflow-docs/spec/<slug>.md` read on demand (`charter/render.ts`, `iteration-prompt.ts`) | wrong model of the prompt; the agent-side read cost is real but discretionary |
| "`workflow get` hides charter content; verifying a charter change needs the 200 KB `--full` payload" | planning retro | `cctl workflow get <id> --charter` has existed since 2026-07-07 (`0ad3bf4f`); the outline prints sizes without naming the selector | wrong model, taught by the outline |
| `workflow replace` refused on a managed definition | planning retro | true at the time (`/charter` locked); after #98 a draft locks `/origin` and `/approvalRequired`, and `findChangedLockedRegion` still refuses any plan that omits `origin`, `approvalRequired` or `lockedRegions` (deep-equality on `lockedRegions`) | still a defect, narrower |
| Source-locator lint warns on the two server-materialized documents every run | planning retro | live probe: a `.cc/graph-workflow-docs/spec/memory.md` locator warns `lint/source-locator-unresolvable`; no exemption in `committed-source-locator-lint.ts` | confirmed defect |
| Upstream captured output is not delivered to downstream contexts on ordinary edges | tournament report (guess #1) | `buildUpstreamInputsSection` renders every direct predecessor's validated output verbatim as JSON under "Inputs from upstream"; values over 64 KB become a `cctl workflow result` reference; skipped predecessors are named | wrong model; the skill never states the contract |
| `prerequisites: { kind: "skill" }` may not resolve project-local skills | tournament report (guess #4) | `prerequisite-probes.ts` reuses the runtime skill-discovery service; a project skill the agent can load satisfies it | wrong model; undocumented |
| Validate error locators are array indices | planning retro | probe prints `definition.tasks.0.contextId: Task "t1" references missing context` | confirmed |
| A context with no tasks cannot be validated on its own | planning retro (asks for `--phase contexts`) | probe: a plan with one context, criteria, placement and `"tasks": []` prints `plan is valid` | phase-scoped validation already exists, undocumented |

Not measurable from telemetry, stated as gaps rather than numbers: the "real versus spurious" split of validator findings (the audits' deep reads say overwhelmingly real; the ledger cannot confirm it), planning-phase cost in dollars (no telemetry outside transcripts), and per-run validator dollars (estimated in the audit from usage fields). One incident class is sourced from the operator rather than the ledger: the process-evidence failures behind FM-11 come from Alex's notes on the Workflow planning improvements notepad (revision 81), and the ledger does not tag a verdict by whether it demanded process or outcome.

Run facts used below (wall clock from the stored `started_at`/`completed_at`):

| Execution | Session | Started | Wall | Validations | Failed | Plan-defect halts | Repairs | Breakers |
|---|---|---|---|---|---|---|---|---|
| `37d48541` | Notepad verification | 08-27 | 21m | 1 | 0 | 0 | 0 | 0 |
| `29e46e86` | Notepad delivery | 08-27 | 11h 02m | 21 | 12 | 1 | 4 | 1 |
| `6068bd10` | Native SDD operability | 08-24 | 15h 56m | 17 | 6 | 1 | 1 | 0 |
| `e39cc5c0` | Planning DX | 08-22 | 4h 11m | 11 | 3 | 0 | 0 | 0 |
| `81d48065` | Graph workflow UI | 08-20 | 42h 27m | 52 | 39 | 7 | 10 | 3 |
| `24771b4f` | Memory delivery | 09-01 | 22h 10m | 28 | 16 | 0 | 0 | 0 |

## 3. What worked (preserve these)

| Mechanism | Evidence |
|---|---|
| Validators as the primary defect finder | 76 of 130 rounds failed and the deep reads in three audits attribute the overwhelming majority to real production defects (CAS bypass, silent archival drop, unresolved active spec, watermark ordering). Nobody who audited these runs recommends weakening validators. |
| Producer/consumer closure (planning steps 4 and 5) | The memory plan review found three unowned handoffs; closing them is why the audit reports "deferral integrity held". The July run, which predates the rule, shipped three release blockers past green per-context validation. |
| Scoped charter invariants | `inv-slug-only-text-output` and `inv-events-via-publication` cited by id in verdicts; five of five invariants scoped in the memory plan, five of seven in the UI plan. |
| Single ordered lane for a shared-surface feature | Memory delivery: one worktree, one clean 178-file merge, no scratch debris. The audit found no context pair that could have run in parallel without same-file competition. |
| Final live-verification context with `allowAgentTaskAdd` | Produced the strongest evidence of the memory run (live two-backend propagation, byte-identical preview) and two live-only defects that became criterion-bearing remediation tasks. |
| Committed evaluation fixtures | A review finding turned a home-directory corpus into `docs/fixtures/`; the evaluation reproduced at 15 and 121 notes. |
| Plan review before launch | Seven findings on the memory plan, all accepted; the split of one write context into three produced three of the cheapest, cleanest contexts in the run. |
| Structural validation with located errors | The tournament plan validated clean on the second attempt; both errors carried a JSON path and fixed in one round trip. `validate` persisting nothing made iteration cheap. |
| Loop-group and handoff-field conventions | The tournament author called the worker-plus-judge guidance "genuinely load-bearing" and wrote it straight into the assessor's criteria. |
| Typed `plan_defect` halts routed at first detection | Nine plan-defect halts across the runs went to repair without charging failures; the five-run retro explicitly asks to keep them. |
| The `askUserQuestions` gate at a real fork | The backend-neutralization implementer stopped rather than guess how to build a provider-native control; the operator answered in under eight minutes. |

## 4. Failure-mode catalog

Each entry names the mode, the signal, the incidents that earned it, where the guidance stands on main today, and the owner of the fix. Classes follow the retrospective triage: **wrong model** (the friction dissolves on checking the system), **under-explained constraint** (real, protects something, needs rationale), **genuine defect**.

### FM-1 Unverified-premise criterion (genuine, the dominant cost)

A criterion binds the implementer to a fact about the system that the planner inferred rather than read. Three faces:

- **Data the product does not retain.** `81d48065`: UI criteria demanded rotation provenance, frozen rosters and script logs; the execution record keeps only the latest round and some records are filesystem-only. The history context failed 18 of 19 rounds. The first repair preserved the false premise (monotonic round sequence numbers), so it could not converge.
- **A lifecycle the product does not implement.** `6068bd10`: the Request Changes criterion assumed an attention request keeps its identity across revisions; the product withdraws the revision and mints new asks.
- **State the embedder does not control.** `24771b4f`: "native memory disabled in every CC-launched environment, proven by a contract test" over an SDK settings cascade with remote-mutable layers; three NO-GOs each naming one deeper layer, and a fail-closed launch guard nobody asked for shipped as the only way to satisfy the wording.

The notepad slice-2 audit's "unspecified representation-mapping contract" (four serial NO-GOs) is the same mode from the other side: the premise was that a DOM selection maps to canonical offsets, and nobody had checked how.

Guidance today: nothing in `graph-workflow-planning` asks the planner to verify a premise; the review skill's two lenses are completeness and executability, with no feasibility lens. Each retro proposed a differently named rule ("observable-data contract", "strongest control plus enumerated residual", "mapping contract"). They are one rule.

Owner: planning skill (Acceptance Criteria) and review skill (a third lens). See R2.

### FM-2 Proof-surface breadth hidden by record count (genuine)

A criterion that reads as one obligation ranges over many cells: fourteen verbs by three output surfaces (`memory-cli`, six records, the most expensive context of its run); pagination, restoration, shell-hostile names and mobile states (`29e46e86`, `notepad-panel`, eight records, six of seven rounds failed); possessives and curly quotes against a quantifier lint (`e39cc5c0`). Validators then discover the surface one cell per round.

The ledger makes the point mechanically. Per run, the contexts that failed most and their record counts:

| Run | Worst context | Records | Failed / rounds | Highest-record context | Records | Failed / rounds |
|---|---|---|---|---|---|---|
| `81d48065` | `execution-history-log` | 5 | 18 / 19 | `config-panel-core` | 10 | 0 / 0 |
| `24771b4f` | `memory-backend-neutralization` | 2 | 3 / 4 | `memory-cli` | 6 | 2 / 3 |
| `29e46e86` | `notepad-panel` | 8 | 6 / 7 | `notepad-domain-core` | 10 | 1 / 2 |
| `6068bd10` | `prose-lint` | 5 | 3 / 4 | `section-reads` | 6 | 0 / 1 |

No context in any run exceeded the 12-record dial. Three of the five runs executed after the density and open-quantifier lints landed (`8452dcb1`, 2026-08-22) and the lints had nothing to say about the contexts that spiralled.

Guidance today: "count the independently-failable obligations, not the paragraphs" and the open-quantifier lint. Nothing about enumerating a surface-by-verb matrix, and no requirement that a criterion over several surfaces name its cells.

Owner: planning skill authoring convention plus review lens. Not a lexical lint (see section 8, "do not adopt").

### FM-3 Obligation falls between contexts (genuine, partly mitigated)

`29e46e86`: a CLI retrievability clause sat in an injection-owned context; the final-verification task mentioned CLI behaviour generally but no criterion carried the nested-read obligation, and plan repair could add a task but could not prove a receiving criterion. The July run's three release blockers are the earlier form.

Guidance today: steps 4 and 5, the deferral-integrity rules, and the validator-alignment checklist all state the rule in prose. Nothing mechanical checks that a deferral names a context that exists or that the receiving context carries a matching record.

Owner: planning skill (keep the prose) plus an optional structured deferral field so the check can be mechanical. See R6.

### FM-4 Several validation theses in one context (genuine, guidance exists)

`81d48065` history combined event projection, rotations, rounds, transcripts, logs, caches and reset behaviour; `29e46e86` panel combined layout, CRUD, autosave, SSE, pagination, diffs, restoration and responsive shell. Splitting the memory plan's write context into three (a review finding) produced three of its cheapest contexts.

Guidance today: step 6 and the density lint. The lint counts records; the review skill's "overloaded context" finding is the working detector. Keep it there and sharpen the wording: one authoritative data model and one proof strategy per context.

### FM-5 Validators report the nearest gap, not the class (genuine)

Failed verdicts carried one or two issues in 24 of 39 rounds (`81d48065`) and 10 of 16 (`24771b4f`); the memory audit's deep reads show round two finding a sibling of a round-one finding (a not-found refusal echoing a UUID). The blocking validator contract in `role-instructions.ts` says an issue reopens the task that owns it and never asks the seat to enumerate sibling instances of a finding before returning.

Owner: engine prompt (`blockingContract`). See R3.

### FM-6 Task grain is the rotation lever, stated as a style preference (under-explained constraint)

The engine schedules rotation when a lane's tokens cross `contextLimitTokens` but only acts on it between tasks: the follow-up loop breaks on `rotateBeforeNextTurn`, and `task complete` prints the stop instruction. The memory run recorded 29 rotation schedules with peaks of 391k, 382k and 347k tokens, and rotation ceremonies of about $4–5 each. The skill says "roughly 10–30 minutes per task" with no reason; a planner writing coherent multi-hour tasks has no way to know the number is the context-budget control.

Owner: planning skill (rationale sentence) and engine (mid-iteration enforcement, already recommended by the audit). See R4 and R10.

### FM-7 Deterministic gates deferred to the end (genuine)

The memory plan gated only the final context; a sibling seam-ratchet red surfaced there after 2.7 hours of changed-scope waits that were each effectively full-suite runs (1119 s and 1058 s changed-scope versus 1087 s full), because a lane branch's diff against its target is the whole feature. `e39cc5c0`'s final gate absorbed an unrelated import-boundary cleanup because it demanded a green whole-repository build with no baseline rule. The notepad verify context finalized while a background gate it launched had not settled.

Guidance today: "select commands only for a context expected to leave those checks green", with an exception clause that nudges toward gating only the final context. Nothing says cheap gates (`typecheck`, `seams`) belong on every `full`-grade context that should leave the tree valid, nothing explains changed-scope on a lane branch, and the final-verification section has no baseline or escalation policy.

Owner: planning skill (defaults, final verification), validation tooling (lane-aware changed scope), engine (no finalize with an unsettled launched gate). See R5.

### FM-8 Implementer self-report outruns evidence (genuine)

`memory-policy-cascade` found a scope leak against its own criteria, wrote it into the handoff as a "residual", completed both tasks and took the NO-GO it deserved; `memory-cli` completed on characterization tests that passed first time; the July run ticked checklists while its own remediation findings were open. The implementer prompt tells the agent to verify invariants before `task complete` and to address reopened issues; it says nothing about a self-discovered gap.

Owner: engine prompt (implementer contract), not a charter convention. See R3.

### FM-9 Wrong models taught by the tooling (wrong model, route to the surface that formed the belief)

| Belief | Reality | Where the belief formed |
|---|---|---|
| Downstream contexts do not receive upstream captured output on ordinary edges | "Inputs from upstream" section, verbatim JSON, 64 KB per value | the planning skill documents only the loop channel; the placement reference has one sentence |
| Charter content is only readable through `--full` | `--charter` selector | the outline prints "mission 38 chars · sources 5" with no selector hint |
| `kind: "skill"` prerequisites may not see project-local skills | resolved through runtime skill discovery | the skill's one-line description of prerequisites |
| `nonGoals`/`vocabulary` are prose | string arrays | fixed in the skill since the tournament report |
| Pausing right after `spec start` is harmless | halts on resume with `recovery_error` (untracked engine defect) | nothing states when a pause is safe |
| "Quiescent" means no started context | `requires-pause` for every structural op on a running execution | the refusal states the rule without its reason |
| The `execution` id printed by `spec start` is what `workflow status`/`live` take | they take `workflowExecution`, printed beside it unlabelled | the `spec start` receipt |
| The `--json` `--full` payload is the only way to answer "what is the mission" | outline plus selectors | same as above |

### FM-10 Native-SDD-only apparatus (mixed; see section 7)

The attempt lifecycle, the binding document, locked regions, injected sources, the candidate hash, spec execution ids and the claims table exist only on the SDD path. The memory planner met all of them and reports that none made the plan better; the plan review's real catches were ordinary planning findings. Which of these protect a human judgment or an audit property, and which are duplicate surfaces, is worked through in section 7.

### FM-11 Process evidence demanded by validators (genuine; incident supplied by the operator)

A validator fails a context for lacking evidence of how the work was produced rather than what it does: a failing test observed before the implementation, a red-green sequence, a step order. Alex reports this as recurring across runs: a correct implementation, produced by the right process, could not pass because the process was unprovable after the fact. The six attachments do not record it as an incident, which is why the first revision of this report declined a lint; the operator's observation is the incident.

The mechanism is where process rules are placed. `charter.invariants` render into validator prompts and validators actively check each one, while `conventions` render for implementers and are not judged. The planning skill's own compact charter example carries `{ "id": "tests-first", "statement": "Behavior changes start with a failing test." }` as an invariant, which is exactly the trap. The one legitimate test-shaped outcome is "a regression test exists and fails when the behaviour is reverted"; the order in which it was written is not an outcome.

Guidance today: the skill says not to ask the validator to enforce deterministic checks, and nothing about process. Owner: validator contract (R3), planning skill and lint (R13).

## 5. Friction triage from the six attachments

| Reported friction | Source | Class | Verified | Owner and fix |
|---|---|---|---|---|
| Upstream-output contract for ordinary edges undocumented | tournament #1 | wrong model | channel exists (`iteration-prompt.ts`) | planning skill: document the section, its verbatim-JSON contract, the 64 KB reference threshold, and skipped-predecessor rendering |
| Tournament guidance forces lane-per-candidate | tournament, friction 1 | genuine guidance defect | both references still say candidates "write the same paths by construction" | placement and dynamic-control-flow references: artifact tournaments with disjoint output directories share one lane; lane-per-candidate only for same-file rewrites |
| No decision rule for adversarial review (validator cohort vs read-only judges) | tournament | genuine gap | not in validation-and-staffing | validation reference: cohort judges one context's criteria; read-only judge contexts compare candidates; aggregation across judges is authored by hand, state the shape |
| Worker-first loop has no verdict on pass 1 | tournament | genuine gap | not in dynamic-control-flow | dynamic-control-flow: a worker-first body needs a seeded agenda from the context upstream of the entry |
| Conversation-supplied source material has nowhere to live but the charter | tournament #5 | genuine gap | no seed-time shared documents in the definition schema; the SDD path materializes documents into `.cc/graph-workflow-docs/` but ordinary plans cannot | engine/schema: definition-level seeded shared documents (R8); skill: name the interim pattern |
| `kind: "skill"` resolution unclear | tournament #4 | wrong model | resolves via runtime discovery | skill: one sentence |
| Script-gate default assumes registered commands fit every change | tournament | under-explained | escape hatch exists in the text | skill: make the default grade-aware (R5) |
| Locked `/charter` on managed drafts, silent no-op `update-charter`, duplicated injected sources on reopen | planning retro #1, conversation | genuine defect | fixed on main (`f9353128`, #98 done) | none; retire the interim recipe from memory notes and skills |
| `replace` refused on managed definitions | planning retro #1 | genuine defect | still refused unless the plan carries `origin`, `approvalRequired`, `lockedRegions` verbatim; refusal instruction says "reopen and re-propose", which is wrong for a draft | `definition-route-handlers.ts` replace path: merge server-owned fields when absent (R1) |
| Four dialects for one graph; hand-written plan-to-ops converter twice | planning retro | genuine defect | no converter exists | R1 makes the converter unnecessary |
| Three CAS token names, two execution ids | planning retro #2 | under-explained constraint | `expectedRevision` / `expectedDraftRevision` / `baseLiveRevision`; `execution` and `workflowExecution` printed unlabelled | receipts label which token the next write takes; `spec start` prints one workflow execution id (R7) |
| Edge ids regenerate on reopen; remove by endpoint pair works | planning retro #3 | under-explained | help documents the endpoint-pair form | native-sdd skill: one sentence |
| `amend-charter` refused `requires-pause` on a run with no started context | planning retro #4 | under-explained constraint | message states the rule, not why | `runtime-edits.ts`: add the reason (atomic edit against a quiescent scheduler); with #98 fixed the pre-launch need is gone |
| Pausing before the lane is active halts on resume with `recovery_error`; halt invisible to `live` verbs | planning retro #4 | genuine engine defect | no fix on `execution-loop.ts` since 09-01; no ticket found | file a ticket (R10) |
| Post-abandon recovery undocumented; only `spec plan open` works | planning retro #5 | under-explained | `nextAct` for an abandoned attempt already says `spec plan open`; the abandon receipt and skill do not | `spec abandon` receipt and native-sdd skill: state the exit |
| Outline hides charter content | planning retro #6 | wrong model | `--charter` exists | outline: print the selector beside the size line |
| Injected sources carry `accessPolicy`; seeded ids refused by plan edit, duplicated by workflow edit | planning retro #7 | genuine defect | duplication fixed by #98; `accessPolicy` still written by the finalizer and exempted by `validation.ts` | finalizer stops writing the retired field and the exemption is deleted (the code comment already says so) |
| Locator lint warns on the two materialized documents every run | planning retro #8 | genuine defect | probe reproduces it | `committed-source-locator-lint.ts`: skip engine-materialized `.cc/graph-workflow-docs/` locators |
| Lanes-first view dropped two contexts | planning retro #9 | genuine defect | #99 done, #103 done | none |
| Restate or reference spec criteria? Triple specification | planning retro, instruction gaps | genuine gap | neither skill answers it; claims are context-level `{contextId, criterionElementIds}` | R9 |
| Cross-lane dependency content visibility undocumented; over-serialized | planning retro | partly wrong model | placement reference has a "Lane visibility and fork points" section | planning skill core: one paragraph pointing at it; the audit found the serialization was right anyway |
| Launch sequence for spec deliveries undocumented | planning retro | genuine gap | mostly moot after #98 except the pause defect | native-sdd skill: "start, then pause only after `workflow status` shows a lane active" until R10 lands |
| Process language could reach criteria; lint it | planning retro #7 (rec); Alex's notepad (recurring: correct work, correct process, unprovable to the validator) | genuine | the attachments record no incident, the operator does; the charter example itself carries a `tests-first` invariant, which validators check | validator contract judges outcomes only (R3); process rules live in conventions, fix the example, add the lint (R13) |
| Observable-data contract for every UI criterion | five-run rec 1 | genuine, over-scoped | FM-1 | adopt as the premise rule scoped to three shapes (R2) |
| Review semantic feasibility | five-run rec 2 | genuine gap | no feasibility lens in the review skill | R2 |
| Obligation ledger, mechanically checked | five-run rec 3 | genuine | prose only | R6 |
| State-space inventories for parsers, pagination, persistence, responsive UI | five-run rec 4 | genuine | open-quantifier lint only | R2 (matrix/inventory convention) |
| Split by validation thesis | five-run rec 5 | exists | FM-4 | sharpen review wording |
| Repair agent needs source-backed inputs and verified/inferred labels | five-run rec 6 | genuine | engine track | R10 |
| Baseline and causality policy for final gates | five-run rec 7 | genuine gap | not in the final-verification section | R5 |
| Archived-history read path | five-run rec 8 | product observability | out of scope for #80 | note only |
| Criteria over provider-controlled state | audit 1, planning retro D1 | genuine | FM-1 face 3 | R2 |
| Surface-by-verb matrices; caller-echo semantics | audit 5, retro D2 | genuine | FM-2 | R2, authoring convention |
| Rotation only at task completion | audit 3, retro D3 | genuine engine defect; guidance under-explained | FM-6 | R4, R10 |
| Full-scope once at context end; residual blocks completion | audit 7 and 10, retro D4 | genuine | FM-7, FM-8 | R3, R5 |
| Under-reduced review remedy (fold-in vs predecessor) | retro D5 | genuine judgment lesson | the review skill says "prefer move/delete/defer/split before add" | review skill: when the reduction lands in the widest context, prefer the predecessor |
| Per-context deterministic gates | retro D6 | genuine | FM-7 | R5 |
| Pause/resume reset started contexts; shared-document re-materialization clobbers edits; killed background validation | audit 4, 6, 9 | engine defects | not planning | R10 |
| Extractor gaps (rotated conversations, continuation blocks, human wait, hung-turn heuristic) | audit 8, notepad audit 7, July audit 7 | tooling defects | recurring across three audits | R11 |

## 6. Planning cost accounting, memory delivery

Tool calls per message in the planning stretch of conversation `d198353e`, counted from `⚙` tool-use lines in the transcript:

| Message | What it did | Tool calls |
|---|---|---|
| 32 | open attempt, read seed and schemas, author plan, validate, replace refused, convert to ops twice, binding, propose | 21 |
| 34 | verify the review's central finding | 1 |
| 36 | review repair: reopen, fixture, split ops, edge-id retry, charter attempts, code reading of the lock | 41 |
| 38 | Builder probe 1 (13 Playwright calls), draft the bug | 29 |
| 40 | file #98, stage the live-amend workaround | 9 |
| 42 | Builder probe 2 on the rebuilt server (11 Playwright calls) | 25 |
| 44 | launch 1, pause, amend, halt, abandon, recovery probing | 25 |
| 46 | launch 2 with the amendment | 6 |
| | **Total** | **157** |

Messages 38, 40, 42 and 44 exist only because of #98 and the pause defect: 88 calls, 56 percent. Add the lock discovery inside message 36 and the replace refusal and double ops conversion inside message 32 and the accidental share is in the region the retro estimated. Inherent planning (decompose, criteria, tasks, binding, propose, start) plus legitimate review repair is roughly 35–40 calls. That is the target once R1 and R9 land.

## 7. Native SDD versus ordinary planning: surface inventory

Ticket goal four asks for every SDD-only indirection that ordinary plans do not have. The test for each surface is the one the native-sdd skill itself states: does it protect a human judgment or an audit property? If yes it stays and needs rationale; if it is a read path, a message, a missing verb or a duplicate write surface, it goes.

| SDD-only surface | Ordinary equivalent | Protects | Verdict |
|---|---|---|---|
| Criterion dispositions (selected, deferred, waived, delivered_elsewhere, reaffirmed, pending_reaffirmation) | none | "nothing leaves scope silently"; human-decided | keep; already spec-side and Studio-owned |
| Frozen candidate hash + human sign-off | `approvalRequired` parks the execution for approval at launch | the human approves exact bytes | keep the freeze; it is the definition revision hash the ordinary path already computes |
| Pinned revision and materialized spec document | `sourcesOfTruth` | lane agents can read the contract they implement | keep the materialization; make it scoped per context (R9) and generalize the mechanism to all plans (R8) |
| Claims table `{contextId, criterionElementIds}` in a separate binding document written through `spec plan edit` | none | the delivery gate needs an accountability map | duplicate write surface; derive from a generic per-criterion `covers` annotation on the graph definition (R9) |
| Locked regions on a draft (`/origin`, `/approvalRequired`) | none | provenance | keep the lock; make `replace` merge around it (R1) |
| Server-injected sources at ranks 1–2, global, still stamped `accessPolicy` | none | agents find the spec | keep, scoped and without the retired field |
| Spec execution id beside the workflow execution id | one id | nothing agent-facing | hide; print the workflow execution id only (R7) |
| `spec plan open/edit/propose/sign-off/reopen/abandon/get/status/preview` (nine verbs) | `validate/create/start` | the attempt lifecycle | after R9 the agent-facing set reduces to open, propose, sign-off, start; dispositions stay a human act |
| `/spec` and `native-sdd-authoring` route planners to Workflow Builder after design sign-off; neither names the planning skill | `cctl workflow --help` names the planning skill | nothing | route to the planning skill (R9) |

## 8. Recommendations

Ranked by leverage, except R13, which was added after Alex's notes supplied an incident and would rank beside R3. Each names its owner and the incident that earned it.

### R1. One write path for managed definitions [CLI + `definition-route-handlers.ts`]

`cctl workflow replace` on a managed draft treats absent `origin`, `approvalRequired` and `lockedRegions` as "unchanged" and refuses only a submitted value that differs from the locked one; the refusal for a draft names the field and never says "reopen and re-propose". With that, a planner authors `plan.json` per the skill, validates, and replaces, exactly as for an ordinary definition, and the plan-to-ops converter the memory planner wrote twice is unnecessary. Until it lands, document the working recipe in the native-sdd skill: `get --full`, merge, keep the three server fields and the two injected sources, `replace`. Earned by the memory planning stretch (messages 32 and 36).

Also in this item: validate and edit issue locators carry the record id beside the index (`definition.tasks.2 (wire-routes).contextId`), since planners address a 700-line file by id, not position.

### R2. One named rule for the dominant failure class, enforced in review [planning skill, review skill]

Add to the Acceptance Criteria section a rule with three faces and their incidents: a criterion may bind an implementer only to (a) data whose authoritative record and field the planner has opened (`81d48065`), (b) a lifecycle transition the planner has read in the state machine (`6068bd10`), and (c) state the embedder controls; for provider-owned or remote-mutable state the template is "sets the strongest control the SDK exposes, enumerates higher-precedence sources once, discloses the residual" (`24771b4f`). The planner labels each such premise verified (with a `file:symbol`) or inferred, and an inferred premise is not execution-ready.

Add to the review skill a third lens, **feasibility**: for every criterion that displays, reconstructs, audits or asserts runtime state, the reviewer opens the cited source and confirms the premise; an inferred premise is a blocking finding. Pair it with the breadth check from FM-2: a criterion naming several surfaces or verbs is either an enumerated matrix with named tests or a split, and a context with two authoritative data models or two proof strategies is two contexts. This is where the "observable-data contract", "mapping contract" and "strongest control" proposals converge, at a cost of one rule and one lens instead of three.

### R3. Three prompt-contract changes [engine, `role-instructions.ts`, `iteration-prompt.ts`]

Validator: after finding a defect, enumerate every sibling instance of the same kind in the candidate before returning, and report one issue per class listing its instances. Earned by FM-5 (24 of 39 and 10 of 16 failed rounds carried one or two issues; round-two siblings in the memory audit).

Implementer: a gap you discover against this context's own acceptance criteria is an open task, not a handoff note; fix it or leave the task open and say why. Earned by `memory-policy-cascade`, `memory-cli` iteration 2, and the July checklist churn. This belongs in the role contract because it is a property of every context, not a convention a planner should have to remember.

Validator, outcomes only: judge what the candidate is and does, never how it was produced. The order in which tests and code were written, which commands ran first, and every other process step are outside the verdict. When a rendered invariant or criterion describes a process rather than an outcome, treat it as satisfied whenever the outcome it protects is present, and say so in the summary. Earned by the recurring failures Alex reports (FM-11). The contract line protects every existing plan, including those already carrying a `tests-first` invariant.

### R4. State why the task grain matters [planning skill, Workflow Model]

One sentence beside "10–30 minutes": the engine rotates a lane only at task boundaries, so task count is the context-budget control; a multi-hour task runs past the limit until it completes. Earned by the 391k-token peak and 29 rotation schedules in `24771b4f`. Under-explained constraints get worked around; this one was.

### R5. Grade-aware gate defaults and a baseline policy [planning skill Defaults and Final Verification, validation reference, `cctl validate`]

Replace the "select commands for the final context" exception with: every `full`-grade context expected to leave the tree valid carries the cheap deterministic gates (`typecheck`, `seams`); `test` goes where the diff is bounded, and once at the end. Explain that `--scope changed` in a lane worktree diffs the whole feature and so costs the full suite; tooling should make changed scope lane-aware (diff against the previous landing commit). The final-verification section gains a baseline rule: state whether the context owns pre-existing failures, proves non-regression against a captured baseline, or escalates them. Earned by the 2.7 hours of changed-scope waits and the late seam red in `24771b4f`, and the absorbed cleanup in `e39cc5c0`. The existing caution against gating intentionally invalid intermediate states stays.

### R6. Make deferral checkable [planning skill, definition schema]

Keep the prose rules and add an optional structured field on a criterion record, for example `deferredTo: { contextId, criterionId }`, so validate can refuse a deferral naming a context or criterion that does not exist. Earned by the `29e46e86` CLI-retrievability leak, where a topologically correct graph still dropped an obligation. Prose deferrals remain legal; the field is what makes the check mechanical.

### R7. Legibility fixes at the surfaces that taught wrong models [CLI receipts, outline, messages]

- `cctl workflow get` outline: print `→ --charter` beside the mission/sources size line, and the other selectors beside their sections.
- `spec start` receipt: print one execution id and label it as the id `workflow status`/`live` take; hide the spec-side id.
- Every write receipt names the token the next write needs (`expectedRevision`, `expectedDraftRevision`, `baseLiveRevision`) instead of assuming the reader knows which object they hold.
- `requires-pause` refusal: add the reason (structural edits apply atomically against a quiescent scheduler so no lane reads a half-applied definition).
- `spec abandon` receipt and native-sdd skill: the exit after abandoning a launched attempt is `spec plan open`, which reseeds from the launched candidate.
- Locator lint: skip `.cc/graph-workflow-docs/` locators materialized by the engine, and stop writing `accessPolicy` on injected sources.
- Planning skill: document the "Inputs from upstream" contract, skill-prerequisite resolution, the lane-visibility section pointer, and that a plan with contexts and no tasks validates (phase-scoped validation exists today).

### R8. Generalize the SDD document materialization to every plan [definition schema, `shared-documents.ts`]

A definition may declare seeded shared documents (`path`, `content`, `description`, `readWhen`) that the engine writes into `.cc/graph-workflow-docs/` at launch, exactly as it already does for the pinned spec and claims. This closes the tournament report's "conversation-supplied source material" gap without committing files the planner is not authorized to commit, and it removes one SDD-only mechanism by making it ordinary.

### R9. Make spec planning ordinary planning plus one annotation [specs, planning skill, native-sdd skill, `/spec` command]

- Add a generic `covers: string[]` (external requirement or criterion ids) to the acceptance-criterion record. Derive claims: context C claims spec criterion S when any criterion of C covers S. The coverage lint replaces the claim-existence finding ("every selected criterion is covered by at least one criterion in a stable authored context"), errors are criterion-addressed, and the delivery gate follows `covers` from validator verdicts that already cite `criterionId`, which is finer evidence than today's per-context claim. Dispositions stay spec-side and human.
- Render the pinned spec per context from coverage: a context's materialized spec excerpt is the requirements and decisions its criteria cover. No new locator syntax is needed; the engine already knows the mapping.
- Answer the "restate or reference" question in both skills: spec criteria are the contract, context criteria are the validator's checklist written in observable terms, and `covers` is the link; never paste spec criteria verbatim.
- Route planners: `/spec` and `native-sdd-authoring` send the planner to `graph-workflow-planning` for the graph and mention Workflow Builder only as the human's review surface; the planning skill gains a short "Delivering a native spec" section that says the only spec-specific concepts are `covers` and the pinned revision.

With R1, the agent-facing SDD surface becomes open, author `plan.json` with `covers`, validate, replace, propose, human sign-off, start.

### R10. Engine items the planner can only mitigate [engine; file tickets]

- Pause-before-provisioning: a pause on a running execution with no started context must not halt on resume with `recovery_error`. No ticket tracks it; file one with the `execution-loop.ts` completion-invariant guard as the site.
- Rotation enforced mid-iteration at a forced turn boundary (audit rec 3).
- Pause/resume preserving a started context's in-flight iteration, and priced reset conversations (audit rec 5).
- Shared-document materialization that does not clobber post-upsert edits; relaunch of a killed background validation surfacing the surviving verdict (audit rec 6).
- No context finalizes while a validation it launched is unsettled (notepad audit rec 5).
- Repair agent inputs: full criterion, all candidate receiving criteria, contradicting runtime evidence, and verified-versus-inferred labelling (five-run rec 6).

### R11. Audit tooling [`scripts/workflow-audit/`]

Include rotated-out and reset conversations in cost rollups, count continuation blocks, treat progress heartbeats as activity in the hung-turn heuristic, classify answered questions and operator pauses as human wait, and derive `completed_clean` from lifecycle halts. Three audits in a row report the same gaps; every published cost figure is currently a floor for the same reasons.

### R12. Bounded re-review [CLI `workflow review`]

Four plan reviews exist in the database, all `changes_requested`, none re-approved; planners launch on unreviewed revisions because any repair invalidates the verdict and a fresh full review is expensive. Let `cctl workflow review --file new.json --since <reviewed hash>` print a structural diff against the reviewed revision so the reviewer's second pass is bounded to what changed. Hash binding stays; the cost of honouring it drops.

### R13. Outcomes, never process, in validator-checked text [planning skill, `plan-lints.ts`]

Added after Alex's notes supplied the incidents the attachments lacked; by leverage it sits beside R3. Three changes:

- Planning skill: a validator-checked statement, whether a criterion or a charter invariant, describes what the work is or does, never the steps that produced it. Process guidance such as red-green TDD belongs in `charter.conventions` and task instructions, which render for implementers and are not judged. Name the one legitimate test-shaped outcome, a regression test that exists and fails when the behaviour is reverted, so planners have a correct spelling to reach for.
- Fix the skill's compact charter example by moving its `tests-first` invariant to `conventions`.
- A warning-tier `lint/process-language` over invariant and criterion statements for process vocabulary such as "failing test", "test-first", "red-green", "TDD" and "before implementing", consistent with the four existing lints. This class is lexical in a way FM-1 and FM-2 are not, which is why a lint can work here where a breadth lint cannot.

### Do not adopt

- **A lexical surface-by-verb lint.** The failing contexts had two to eight records with ordinary statement lengths; the shape is semantic. Put it in the authoring convention and the review lens (R2).
- **Spec-subset locator syntax** (`spec:memory@5#R2,R8`). Coverage already gives the engine the mapping (R9).
- **Retiring dispositions, sign-off or the candidate freeze.** They protect the human's approval of exact bytes and the "nothing leaves scope silently" property. The retro's frustration with them is route-around risk, which argues for rationale, not removal.
- **A mandatory observable-data table on every UI criterion.** Scope the rule to the three premise shapes (R2); an unconditional table inflates plans, the incentive the review skill warns about.
- **Larger circuit-breaker or iteration budgets.** `81d48065` shows they lengthen discovery; the five-run retro says the same.
- **Weakening validators or removing the final gate.** See section 3.

## 9. What should not change

Validators as the primary defect finder; typed `plan_defect` halts routed at first detection; producer/consumer closure and deferral integrity as planning rules; scoped invariants; the single-ordered-lane shape for shared-surface features; the final live-verification context with task-add authority; hash-bound reviews; human-only dispositions and sign-off; `validate` persisting nothing; the record-shaped criteria model and its density lint (it catches blobs, which are real, and simply cannot see FM-1 and FM-2).

## 10. Telemetry gaps

- Planning-phase cost has no telemetry outside conversation transcripts; the 157-call figure here is a transcript tally, and dollars are unknown. A per-conversation count of `cctl workflow validate` runs, refusals by code and edit batches would make planning cost auditable.
- `graph_plan_reviews` binds to a plan hash with no link to the definition or execution it became; review-to-outcome correlation is manual.
- Validator findings carry no "real versus spurious" mark; the audits' deep reads are the only evidence, and they are claims.
- Per-run validator dollars are estimated from usage fields, not recorded.

## Appendix A: criteria density versus validation failures, all contexts

Records, total statement characters, tasks, validation rounds, failed rounds, and distinct iterations per context, from the stored definitions, the event ledger, and `iterations.jsonl` where retained.

`81d48065` (Graph workflow UI): `execution-history-log` 5 / 986 / 4 / 19 / 18 / 18 · `mobile-responsive` 7 / 1148 / 5 / 4 / 3 / 6 · `lane-canvas-kit` 9 / 1948 / 5 / 5 / 3 / 9 · `execution-live-edit` 8 / 1332 / 4 / 4 / 3 / 7 · `execution-page-shell` 8 / 1416 / 5 / 3 / 2 / 6 · `execution-inspector-core` 7 / 1440 / 5 / 3 / 2 / 4 · `execution-gates-recovery` 6 / 1153 / 4 / 3 / 2 / 7 · `config-panel-context-screens` 8 / 1514 / 5 / 3 / 2 / 3 · `builder-page-shell` 9 / 1511 / 5 / 3 / 2 / 5 · `final-verification` 5 / 1304 / 4 / 2 / 1 / 4 · `builder-lane-drag` 9 / 1751 / 4 / 2 / 1 / 3 · `config-panel-core` 10 / 1874 / 5 / 0 / 0 / 3 · `config-panel-cascade-screens` 9 / 1588 / 5 / 1 / 0 / 3.

`24771b4f` (Memory delivery): `memory-backend-neutralization` 2 / 483 / 2 / 4 / 3 / 4 · `memory-telemetry` 2 / 340 / 2 / 3 / 2 / 3 · `memory-session-lifecycle` 1 / 321 / 1 / 3 / 2 / 4 · `memory-library-ui` 5 / 1044 / 2 / 3 / 2 / 5 · `memory-cli` 6 / 1570 / 5 / 3 / 2 / 5 · `memory-recall-ranking` 4 / 683 / 2 / 2 / 1 / 3 · `memory-policy-cascade` 4 / 876 / 2 / 2 / 1 / 4 · `memory-index-delivery` 5 / 1238 / 3 / 2 / 1 / 3 · `memory-freshness-engine` 4 / 942 / 1 / 2 / 1 / 2 · `memory-capture-writes` 3 / 576 / 1 / 2 / 1 / 3 · `memory-final-verification` 4 / 1426 / 4 / 1 / 0 / 1 · `memory-domain-foundation` 5 / 1139 / 3 / 1 / 0 / 2.

`29e46e86` (Notepad delivery): `notepad-panel` 8 / 1354 / 4 / 7 / 6 · `notepad-cli` 5 / 762 / 2 / 4 / 3 · `notepad-mobile` 4 / 749 / 2 / 3 / 2 · `notepad-domain-core` 10 / 2084 / 4 / 2 / 1 · five further contexts with 0 failures.

`6068bd10` (Native SDD operability): `prose-lint` 5 / 1371 / 2 / 4 / 3 · `read-current-only` 5 / 1128 / 2 / 2 / 1 · `parent-immutability` 5 / 892 / 1 / 2 / 1 · `approval-ledger` 5 / 1448 / 2 / 2 / 1 · six further contexts with 0 failures.

## Appendix B: issues per failed validation round

`81d48065`: 1 issue × 12, 2 × 12, 3 × 5, 4 × 4, 5 × 3, 7 × 2, 8 × 1 (39 rounds). `24771b4f`: 1 × 7, 2 × 3, 3 × 3, 4 × 2, 10 × 1 (16). `29e46e86`: 1 × 7, 2 × 1, 3 × 3, 7 × 1 (12). `6068bd10`: 1 × 4, 2 × 2 (6). `e39cc5c0`: 1 × 2, 2 × 1 (3).

## Appendix C: charter shape per run

Mission characters, sources (scoped), invariants (scoped): `81d48065` 798, 8 (6), 7 (5) · `6068bd10` 672, 5 (2), 5 (3) · `29e46e86` 537, 14 (12), 7 (4) · `e39cc5c0` 350, 12 (11), 6 (5) · `37d48541` 673, 4 (0), 2 (0) · `24771b4f` 646, 12 (9), 5 (5). Scoping is being used; the "keep the charter small" advice is being followed.

## 11. Implementation status (2026-09-04)

Recorded after the native-SDD design (`docs/designs/ticket80-native-sdd-planning-simplification.md`) shipped its steps 1 to 3 through execution `773a058c`, merged to main in `3142bcbf`.

| Recommendation | Status | Where |
|---|---|---|
| R1 one write path for managed definitions; id-bearing locators | done | #80, execution `773a058c` (design 3.1, 3.2) |
| R2 premise rule in the planning skill; feasibility lens in the review skill | not started | remains under #80 |
| R3 validator enumerates the class; implementer residual blocks completion; outcomes-only | outcomes-only done; the other two not started | remains under #80 (engine prompts) |
| R4 task-grain rationale in the skill | not started | remains under #80 |
| R5 grade-aware gate defaults; final-verification baseline policy; lane-aware changed scope | not started | remains under #80 (skill); changed-scope tooling unticketed |
| R6 structured deferral field | not started; needs a decision | remains under #80 |
| R7 legibility fixes | outline hints, one execution id, labelled tokens, `requires-pause` reason, abandon exit, published catalogue, phase-scoped authoring documented: done. Locator-lint exemption and `accessPolicy` removal: #109. Upstream-inputs contract, skill-prerequisite resolution and lane-visibility pointer in the planning skill: not started | #80 done part; #109; remains under #80 (docs) |
| R8 seeded documents for every plan | pending | #109 (design 3.4) |
| R9 spec planning as ordinary planning | routing and the `native-spec-delivery` reference done; `covers`, derived claims and per-context excerpts pending | #80 done part; #109 (design 3.3, 3.4) |
| R10 engine items | pause-before-provisioning done; rotation mid-iteration, pause/resume preserving an in-flight iteration, shared-document clobbering, no finalize with an unsettled gate, repair-agent inputs: not started | #80 done part; the rest unticketed |
| R11 audit extractor gaps | not started | unticketed |
| R12 bounded re-review | not started | unticketed |
| R13 no process language in validator-checked text | contract, prompts, skills and example done; the warning-tier lint not built | #80 done part; lint remains optional |

Two facts worth carrying forward: the spec-graph boundary architecture test that command-center#107 lists as red passes on the merged tree, and no workflow audit of execution `773a058c` exists yet.

