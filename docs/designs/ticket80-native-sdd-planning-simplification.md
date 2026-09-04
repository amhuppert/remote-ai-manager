# Native SDD delivery planning: remove the indirection between specs and graph workflows (command-center#80)

Status: DECIDED, revision 2, 2026-09-03; all six decisions in section 8 settled by Alex on 2026-09-03 with the recommended option. Design only. The one change already shipped under this ticket is the outcomes-only validator rule (section 3.9), which is independent of everything else here.

Revision 2 folds in the fourteen findings of the review against the agentic-engineering-principles skills (same day): a preflight with gate parity and a published rule catalogue (3.3), gate deltas and ledger framing on writes (3.1, 3.5), why-lines in every refusal that enforces a kept constraint (3.1, 3.3, 3.5), a hint chain replacing three prose copies of the launch sequence (3.6), one execution id with no dual acceptance (3.5), server-side verdict attribution (3.3), telemetry for planning-phase friction (3.10), round-trip and remedy-proof tests plus a live scenario list (6), an explicit implementation split (7), and a sixth decision (8).

Scope: `src/lib/specs/{delivery-plan,delivery-plan-seed,delivery-plan-finalization,delivery-plan-service,delivery-plan-binding-lint,execution-claims-document,export}.ts`, `src/lib/workflows/{definition-route-handlers,committed-source-locator-lint,plan-validation}.ts`, `src/lib/workflows/plan-review/schemas.ts`, `src/lib/workflow-graph/{locked-regions,criteria/criterion-records,charter/render,shared-documents,validation,runtime-edits,execution-loop}.ts`, `src/cli/commands/spec/write.ts`, `src/cli/commands/workflow.ts`, `src/cli/commands/workflow-outline.ts`, the `native-sdd-authoring` and `graph-workflow-planning` skills, `.claude/commands/spec.md`, and `.kiro/steering/logs.md`.

Relationship to prior designs: this builds on `docs/design/2026-08-14_direct-authored-delivery-plans.md` (decisions 1 to 6, settled 2026-08-14) and product design §5.13 (approved 2026-08-31). It keeps decision 1 (blocking delivery gate), decision 3 (must-run coverage lock), decision 4 (invariant scoping) and decision 6 (live amend retired). It amends decision 2: claims stop being an authored sidecar and become a derivation from a per-criterion `covers` annotation on the graph definition. Section 8 records the decisions Alex settled.

Evidence: `docs/reports/2026-09-03_graph-workflow-planning-retrospective.md` (sections 2, 5, 7), the memory delivery planning transcript (conversation `d198353e`, messages 32 to 46), and the code at main `c31d7126`. Every issue below names the file that proves it.

## 1. Problem: what a planner meets on the SDD path that an ordinary plan never does

The memory delivery (spec `memory`, execution `24771b4f`) is the reference case. Its planning stretch cost 157 tool calls; roughly 35 to 40 were the inherent work of decomposing, writing criteria and tasks, binding, proposing and starting. Everything else was the SDD apparatus. The largest item, the locked draft charter (#98), is fixed on main. What follows is the verified inventory of what remains, classified as bug, gap, friction, or designed constraint.

| # | Issue | Class | Evidence | Section |
|---|---|---|---|---|
| I-1 | `cctl workflow replace` on a managed draft is refused unless the plan carries `origin`, `approvalRequired` and `lockedRegions` byte-for-byte; the refusal's instruction says "reopen and re-propose", which is wrong for a draft | bug | `definition-route-handlers.ts:557-575` calls `findChangedLockedRegion`; `locked-regions.ts:186-192` deep-compares `lockedRegions` before any locked path; instruction text comes from `delivery-plan-finalization.ts` `provenanceLock` | 3.1 |
| I-2 | No plan.json to edit-ops path; the ops dialect differs (flat fields, `position`, no `order`), so the planner hand-wrote a converter twice | gap | `cctl workflow edit --help`; transcript message 32 ("Op fields are flat, not nested. Rebuilding") | 3.1 |
| I-3 | Validate, create and replace locate issues by array index (`definition.tasks.2.contextId`) in a 700-line file authored by id | friction | live probe; `plan-validation.ts:308,332` (`structuralIssuePath`) | 3.2 |
| I-4 | The committed-tree locator lint warns on the two engine-materialized documents every run | bug | live probe on `.cc/graph-workflow-docs/spec/memory.md`; `committed-source-locator-lint.ts` has no exemption | 3.4 |
| I-5 | Injected sources still carry the retired `accessPolicy` field; `validation.ts:140-150` exempts them with a comment asking for the exemption to be deleted | debt | code | 3.4 |
| I-6 | `spec start` prints two unlabelled ids (`execution`, `workflowExecution`); every `workflow` verb takes the second | friction | `spec/write.ts:3480-3492` | 3.5 |
| I-7 | Three compare-and-swap token names for three write surfaces (`expectedRevision`, `expectedDraftRevision`, `baseLiveRevision`), none of which a receipt names as the next write's token | friction | help texts | 3.5 |
| I-8 | The `/spec` command sends a planner to Workflow Builder after design sign-off; the native-sdd skill never names the planning skill; the planning skill has no native-SDD content | gap | `.claude/commands/spec.md:162-164`; transcript messages 38 and 42 (24 Playwright calls probing the Builder) | 3.6 |
| I-9 | Nothing says how a context's acceptance criteria relate to the spec criteria it claims. The memory planner restated all 31 spec criteria, producing triple specification (spec criteria, context criteria, task prose) and a drift surface | gap | claims are context-level `{ contextId, criterionElementIds }` (`delivery-plan.ts:60-66`); planning retro | 3.3 |
| I-10 | The pinned spec and the claims map are injected as global rank-1 and rank-2 sources, so every context reads the whole 27.6 KB spec and all 31 dispositions when it follows the charter | friction | `delivery-plan-finalization.ts:130-155` (no `appliesTo`); `execution-claims-document.ts` (one global document). The cost is agent-side reading, not prompt injection: `charter/render.ts` renders source entries only | 3.4 |
| I-11 | Pausing a running execution before any lane is provisioned halts the resume with `recovery_error` ("no eligible work and no remaining join"); the halt is not plan-repairable and the session's `live` verbs cannot see it | bug (engine) | transcript message 44; `execution-loop.ts:4134`; no change to the file since 2026-09-01; no ticket | 3.8 |
| I-12 | `requires-pause` refusals state the rule without the reason, so "quiescent" was read as "no started context" | under-explained constraint | `runtime-edits.ts:2551` | 3.5 |
| I-13 | After `spec abandon --execution`, the attempt stays `launched`: only the capture path retires an attempt (`execution-service.ts:2013`); `nextAct` for `launched` says "The immutable launch is running" (`delivery-plan-service.ts:1737-1741`); `spec start` refuses "launched and not signed off" (`:2117`); the working exit, `spec plan open`, is stated nowhere on that path | gap | code | 3.5 |
| I-14 | Edge ids differ after a reopen mints a new definition, so `remove-edge` by id fails; the endpoint-pair form is documented only in `workflow edit --help` | gap | transcript message 36 | 3.1 |
| I-15 | The seed charter is an instruction, not governance: mission "Author the delivery launch for `<slug>`." plus a `delivery-plan-authoring` source (`delivery-plan-service.ts:1884-1895`); nothing at propose checks that the charter was authored, which is how #98 froze a stub into a signed candidate | gap | code | 3.5 |
| I-16 | Plan review is invisible on the SDD path. The review hash covers the whole semantic definition (`plan-review/schemas.ts:96-100`), so a review recorded on the planner's plan.json never matches the managed definition with its injected sources and locks; propose and sign-off surface no verdict | gap | four reviews in `graph_plan_reviews`, all `changes_requested`; the memory plan review's seven findings were applied through ops and never re-recorded | 3.7 |
| I-17 | A selected criterion must be claimed from the conservative must-run set (`binding/selected-criterion-not-must-run`), so a criterion whose natural home is a guarded branch needs an always-run attester claim | designed constraint (decision 3, 2026-08-14), undocumented for planners and unexplained in the refusal | `delivery-plan-binding-lint.ts:200-210`; `route-projection.ts:649` | 3.3, 3.6 |
| I-18 | `spec plan preview --stage draft` returns the whole 52.7 KB envelope; `workflow get` prints prose sizes with no hint that `--charter`, `--context` and `--task` exist | friction | help texts; transcript | 3.5 |
| I-19 | Phase-scoped authoring already works (a plan with contexts, criteria, placement and `"tasks": []` validates clean) and no document says so | gap | live probe | 3.6 |
| I-20 | The launch and recovery sequence is undocumented: when a pause is safe, and the exit after an abandoned launch | gap | transcript message 44 | 3.6 |
| I-21 | Locked draft charter, duplicate injected sources per reopen, silent no-op `update-charter`, lanes-first view dropping contexts | fixed | #98 (`f9353128`), #99, #103 on main | none |
| I-22 | The published lint taxonomy for delivery plans is empty (`cctl spec schema guidance` prints `deliveryPlan: []`), so today's `binding/*` codes can only be learned by tripping them | gap | live output of `cctl spec schema guidance` | 3.3 |
| I-23 | Planning-phase friction leaves no telemetry: refusals by code, merges, and preflight findings are unlogged, so the retrospective could count planning cost only by transcript tally | gap | `docs/reports/2026-09-03_graph-workflow-planning-retrospective.md` section 10 | 3.10 |

Two observations frame the design. First, every item is accidental cost: none of them made the memory plan better, and the plan review's real catches (unowned wiring, an over-broad context) were ordinary planning findings. Second, most items are legibility or duplication rather than missing capability. The SDD path already runs on the ordinary graph engine; what it lacks is a way for the planner to use the ordinary authoring tools, and a way to learn the gate's rules before tripping them.

## 2. Design principles

1. **The planner authors an ordinary `plan.json`.** The only spec-specific concepts a planner meets are the pinned revision and a `covers` annotation on criteria. Dispositions stay a human act in Spec Studio.
2. **Server-owned fields are merged, never demanded.** Provenance, locks, approval policy and injected sources are the server's; a plan that omits them is complete, and a plan that contradicts them is refused by name.
3. **Refusal is never the discovery channel.** Every rule that can refuse propose is readable beforehand through a preflight that runs the identical rule module, every write reports its effect on that gate, and every finding names the transition it blocks.
4. **One id and one labelled token per object.** A receipt that prints an id says which verb takes it; a receipt that prints a revision says which write it guards.
5. **Designed friction states its reason at the point of refusal.** Sign-off, the candidate freeze, human dispositions and the must-run lock stay. Each refusal carries a one-sentence `why:` line; success output carries none.
6. **One owning document, and hints for the flow.** The launch sequence lives in one skill section and is walked by success hints authored beside the commands, never by copies.
7. **Generalize before special-casing.** Anything the SDD path needs that ordinary plans could use (seeded documents, scoped excerpts, id-bearing locators) lands on the shared engine, per the standing rule that graph workflow features stay general.

## 3. Design

### 3.1 One write path for managed definitions (I-1, I-2, I-14)

`cctl workflow replace <definitionId> --file plan.json` becomes the authoring path for a managed draft, exactly as for an ordinary definition.

Semantics, in `definition-route-handlers.ts` replace path, before the locked-region check:

- For each server-owned path (`/origin`, `/approvalRequired`, `/lockedRegions`), an **absent** value in the submitted plan is filled from the existing record. A **present and equal** value passes. A **present and different** value is refused `region_locked` naming the path.
- Server-owned charter sources (`native-sdd-pinned-spec`, `native-sdd-claims`) absent from the submitted plan are fine: `finalizeDeliveryPlanLaunch` re-injects them at propose. Present ones are deduplicated by `authoredDeliveryPlanSources`, which already exists.
- The documented shape is **omit the server-owned fields**. The native-sdd skill and the replace help say so, and the refusal for a present-and-different value says it too, so a planner never learns to round-trip `get --full` just to carry them.
- The refusal is stage-aware and carries its reason. On a draft: `region_locked: /origin is server-owned; omit it from your plan. why: provenance and approval policy are stamped by the server so a signed candidate can prove where it came from.` On a proposed candidate, replace and edit are refused by the read-only guard (`managedMutationRefusal`, which runs before any lock check), whose instruction already names reopening the plan; that refusal gains `why: the signed candidate is immutable so sign-off approves exact bytes.` The charter lock's own "reopen and re-propose" instruction stays for the storage and live-edit paths that still reach it.

The merge lives in `locked-regions.ts` as `mergeServerOwnedRegions(previous, next)` so the live-edit apply path can reuse it later. `findChangedLockedRegion` is unchanged; it simply runs on the merged document.

**Writes report their effect on the gate.** On a managed definition, `replace` and `edit` compute the propose findings before and after the write and print one line, `propose findings: 9 → 2 (blocks_propose)`, carrying `{ blockingBefore, blockingAfter }` in the envelope. This keeps the closed loop that `spec plan edit` provides today, on the surface that replaces it. On a clean write the line reads `propose: nothing refuses` and the hint names `cctl spec plan propose <slug>`.

Edge identity: `seedDeliveryPlanFromLast` copies the launch definition with `structuredClone`, so authored edge ids survive a reopen. The transcript's regenerated ids came from a definition authored through ops that omitted ids, where the server minted them. The design makes `replace` preserve authored ids and adds a test that a reopen keeps them; the endpoint-pair form of `remove-edge` stays as the fallback and is documented in the native-sdd skill.

With this, the plan-to-ops converter is unnecessary. `workflow edit` remains the right tool for a targeted change.

### 3.2 Id-bearing issue locators (I-3)

`structuralIssuePath` in `plan-validation.ts` appends the record id in parentheses after any indexed segment whose record carries an `id`: `definition.tasks.2 (wire-routes).contextId`, `definition.executionContexts.9 (memory-cli).scriptValidator.commands.3`, `definition.charter.sourcesOfTruth.1 (seeded-doc).locator`. The JSON path stays first for machine consumers; the `--json` envelope gains `recordId` beside `path`. Lint warnings and the coverage findings of 3.3 use the same formatter. This is shared-engine work and benefits every plan.

### 3.3 Coverage replaces authored claims (I-9, I-16 in part, I-17, I-22)

The criterion record gains a generic traceability field:

```json
{ "id": "status-line-withheld", "statement": "…", "covers": ["memory-crit-status-withheld"] }
```

`covers` is an optional array of external ids. The graph engine treats it as opaque traceability: it renders `(covers: memory-crit-status-withheld)` beside the record in implementer and validator prompts, and nothing else. The spec layer interprets it.

Claims become a derivation: context C claims spec criterion S when any criterion of C covers S and S is selected. `spec plan propose` computes the claims and freezes them in the candidate manifest, so a frozen candidate remains self-describing and the delivery gate reads the same shape it reads today. The binding document a planner writes shrinks to dispositions, which are human-side already, so on the ordinary path no agent write of the binding remains: `spec plan open` seeds dispositions from the delivery delta, the planner authors the graph with `covers`, and propose does the rest. `spec plan edit` is deleted (decision D-F).

**Verdict attribution stays server-side.** Validators cite `criterionId` in issues exactly as today; the model-facing verdict schema does not gain a `covers` field. After parsing, the delivery gate maps each cited record to the spec criteria it covers. Evidence grain therefore improves without a policy change: today a context's validator GO attributes to every criterion the context claims; with `covers`, it attributes to exactly the spec criteria the cited record covers. Decision 1 of 2026-08-14 (gate blocking) is unchanged; its grain moves from context to criterion.

**Findings, the transition they block, and the catalogue.** Lint moves from the binding to the definition, keyed by criterion id. Every code names the transition it blocks, and every code is published in the delivery-plan section of `cctl spec schema guidance`, which is empty today (I-22); the existing `binding/*` codes are published there in the same change.

| today | after | blocks |
|---|---|---|
| `binding/selected-criterion-unclaimed` | `coverage/selected-criterion-uncovered`: no criterion in a stable authored context covers it | propose |
| `binding/selected-criterion-not-must-run` | `coverage/not-must-run`: the covering contexts can all be skipped by a guard. Message names the covering criteria and the remedy, with `why: a claimed criterion must be covered on every path so a skipped branch can never waive it silently; also cover it from an always-run closeout context that verifies whichever route ran, or re-disposition it.` | propose |
| `binding/claim-criterion-unknown` | `coverage/unknown-id`: `covers` names an id the pinned revision does not carry | propose |
| `binding/claim-criterion-unselected` | `coverage/unselected`: covers a deferred or waived criterion (covering out-of-scope work is a contradiction) | propose |
| `binding/claim-context-unstable` | `coverage/unstable-context`: the covering context is dynamic (loop clone, expansion child); the authored ancestor must cover it | propose |
| none | `launch/charter-unauthored` (3.5) | propose |
| `binding/pending-reaffirmation`, `binding/reaffirmed-without-delivery` | unchanged | propose, human act |

**Preflight with gate parity.** The rules above live in one module that three callers share, so the preflight cannot diverge from the gate:

- `cctl workflow validate --file plan.json --definition <id>` resolves the managed definition to its attempt and pinned revision and runs the coverage and charter rules on the submitted file, alongside the ordinary structural checks. Without `--definition` validate behaves as today, because a session-scoped validate has no pinned revision to check against.
- `cctl spec plan status <slug>` is the state-scoped preflight over the stored draft, callable at any time.
- `cctl spec plan propose <slug>` runs the identical module as the gate.

All three print findings one per line with the record id (3.2), grouped under the transition they block, and when nothing refuses they say so: `propose: nothing refuses`. A finding's severity in `--json` is the transition name, never an abstract level.

**Ledger framing.** Open, status, validate-with-definition and propose all report both sides: `coverage: 12 of 31 selected criteria covered, 19 uncovered (no criterion in a stable authored context covers them)`, then dispositions by kind, then the charter state (`charter: authored, 5 invariants, 10 sources` or `charter: seed stub`). Deficit-only lines ("unresolved dispositions: 31") go away.

Planner guidance, written once in the planning skill (3.6): spec criteria are the contract, context criteria are the validator's checklist written in observable terms, and `covers` is the link. Never paste spec criterion text into a context criterion. A context criterion may cover none (plan-level wiring and cross-context obligations), several may cover one, and one may cover several.

Migration: binding schema version 4 carries `dispositions` only; the candidate manifest carries derived `claims`. Draft and proposed v3 attempts at cutover reopen and re-propose (they are pre-approval by definition, the same policy the v3 cutover used). Launched v3 attempts stay readable; the gate reads claims from the manifest for both versions. A `claims` key on any remaining binding write is refused with a message pointing at `covers`.

### 3.4 Scoped spec excerpts, seeded documents, and the locator lint (I-4, I-5, I-10)

The full pinned spec stays materialized at `.cc/graph-workflow-docs/spec/<slug>.md` as the audit anchor. Launch additionally materializes one excerpt per context at `.cc/graph-workflow-docs/spec/<slug>/<contextId>.md`, containing the requirements and criteria the context covers plus the decisions those requirements cite, rendered by the same revision renderer. The finalizer injects a per-context source entry scoped with `appliesTo: { contextIds: [<contextId>] }` pointing at the excerpt, ranked above the global entry, and rewrites the global entry's description to "when the excerpt is insufficient". No new locator syntax is needed: `covers` already gives the server the mapping.

The claims map is one document, `.cc/graph-workflow-docs/spec-bindings/<candidate>/claims.md`, referenced by the global rank-2 entry as today. Its rendering changes to put the reading context's own claims first and the rest below, so a validator honouring a deferral finds the other claimant without reading everything. There is no second per-context claims document; the per-context entry names the spec excerpt only.

Seeded documents become a definition-level feature for every plan. `definition.seededDocuments[]` entries carry `relativePath` (under `.cc/graph-workflow-docs/`), `contents`, `description` and `readWhen`; validate, create, replace and run accept them; launch materializes them through the existing `seededDocuments` channel (`execution-route-handlers.ts:842`). Caps: 256 KB per document, 1 MB per plan, checked locally by the CLI before any request and again at accept time. This closes the tournament report's "conversation-supplied source material" gap without committing files the planner is not authorized to commit, and it turns the SDD materialization into an ordinary mechanism.

Locator lint: a source locator that names a seeded document path, or any path under `.cc/graph-workflow-docs/`, is resolvable by construction and is skipped by `lintCommittedSourceLocators`. The finalizer stops writing `accessPolicy`, and the `SERVER_SEEDED_SOURCE_IDS` exemption in `validation.ts` is deleted, as its own comment asks. The finalizer change leaves no comment narrating the removal.

### 3.5 Identity, receipts, and state (I-6, I-7, I-12, I-13, I-15, I-18)

- **One execution id, no dual acceptance.** The `spec start` receipt prints `execution: <workflow execution id>` and labels it as the id `workflow status` and `workflow wait` take (`workflow live` acts on the session's active execution and takes no id). The spec-side execution row id stops appearing in agent-facing text. `spec status <slug>` needs no id; `spec abandon <slug> --execution <id>` and `spec capture <slug> --execution <id>` accept the workflow execution id only, and a spec-side id is refused with a typed message naming the id to use. No verb accepts both shapes. The other surfaces that print the spec-side id today move with them: the abandon and capture receipt tokens, the server's post-abandon hint (`seededDeliveryPlanInstruction`), `postLaunchPathsSentence`, and the `spec status` execution rows.
- **Labelled tokens.** Every write receipt on the three surfaces prints the token the next write needs by name (`next write: expectedDraftRevision 4`). The names stay: they guard three different objects, and a rename buys less than a label.
- **Abandon retires the attempt.** The abandon coordinator's finalize phase records the `abandon` transition on a launched attempt, so `nextAct` reads `spec plan open` and the `spec abandon` receipt hints it. `spec start` on an attempt whose execution was abandoned then refuses with that same exit instead of "not signed off".
- **`requires-pause` states its reason:** `requires-pause: structural edits need a paused execution. why: they apply atomically against a quiescent scheduler so no lane reads a half-applied definition; pause, edit, resume.`
- **Seed charter and a propose check.** `spec plan open` seeds the mission from the spec's intent section and no `delivery-plan-authoring` source; the gate refuses `launch/charter-unauthored` (blocks propose) when the mission still equals the seed text or the charter cites no authored source, with `why: the charter is the governance every implementer and validator reads, and a seed stub would freeze into the signed candidate (#98).` The finding appears in the preflight (3.3) before anyone proposes.
- **Draft `nextAct`.** For a draft attempt, `nextAct` names the authoring path of 3.1 and the preflight of 3.3, not `spec plan edit`: `author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition <id>`.
- **Outline hints.** `cctl workflow get` prints the selector beside each size line (`charter: mission 646 chars · 12 sources → --charter`). `spec plan preview` gains `--outline`, delegating to the workflow outline renderer. These are hint-tier lines on read output; they carry no rationale.

### 3.6 Guidance routing and the hint chain (I-8, I-17, I-19, I-20)

The launch sequence has one owning document and is walked by hints, never copied.

**The hint chain**, authored beside each command's registry entry so the vocabulary cannot drift:

| after | success hint |
|---|---|
| `spec plan open` | author `.cc/temp/plan.json` with the graph-workflow-planning skill, then `cctl workflow validate --file .cc/temp/plan.json --definition <id>` |
| `workflow validate --definition` (clean) | `cctl workflow replace <id> --file .cc/temp/plan.json` |
| `workflow replace` on a managed draft (gate clean) | `cctl spec plan propose <slug>` |
| `workflow replace` on a managed draft (findings remain) | `cctl spec plan status <slug>` |
| `spec plan propose` | `cctl spec plan sign-off <slug>` (a human act) |
| `spec plan sign-off` | `cctl spec start <slug>` |
| `spec start` | `cctl workflow status <execution>` |
| `spec abandon --execution` | `cctl spec plan open <slug>` |

**The owning document** is a short section in the planning skill, "Delivering a native spec", limited to what a planner cannot learn from a receipt: the two spec-specific concepts (`covers`, pinned revision) and the restate-versus-reference rule; phase-scoped authoring, since contexts, criteria, placement and edges validate before any task exists; edge ids and the endpoint-pair removal fallback; and one line on the must-run constraint pointing at the refusal's remedy, since the rationale itself renders in the refusal (3.3) and no run has yet tripped it. `.claude/commands/spec.md` and the native-sdd skill each point at that section and name Workflow Builder once, as the human's review surface; neither restates the sequence.

**The interim pause rule** ("pause only after `workflow status` shows a lane active") is earned by transcript message 44 and lives in the native-sdd skill with its retirement condition stated inline: remove when the 3.8 ticket lands.

### 3.7 Plan review on the SDD path (I-16)

`canonicalPlanDefinitionHash` hashes the authored subset: the definition with `origin`, `approvalRequired`, `lockedRegions` and server-owned sources removed through the same `authoredDeliveryPlanSources` helper. Ordinary definitions carry none of those fields, so their hashes are unchanged. A review recorded on the planner's `plan.json` then matches the managed definition; `spec plan propose` prints the advisory review line that `create` and `replace` already print, and the sign-off receipt and Spec Studio's delivery bridge show the verdict with the findings command. The acknowledgement gate keeps its current scope (create and replace) and is not extended to propose.

### 3.8 Engine: pause before provisioning (I-11)

A pause taken while no lane has been provisioned must resume into the scheduler's initial dispatch, not into the completion-invariant guard. On resume, when `startedContexts` is empty and no lane exists, the loop re-runs the initial batch scheduling as if the execution had just started. This is a small change at the resume entry in `execution-loop.ts`, but it is engine work with its own reproduction (start, pause immediately, resume), so it is filed as its own ticket and sequenced first, because every recovery recipe in this design assumes a pause is always safe.

### 3.9 Outcomes only in validator-checked text (shipped)

Shipped separately under this ticket: the blocking validator contract judges what the candidate is and does, never how it was produced, and treats a process-shaped invariant or criterion as satisfied whenever the outcome it protects is present; the validator turn prompt's invariant guidance says the same; the planning, review and native-sdd skills say process rules live in `conventions`; the skill's charter example carries an outcome-shaped invariant. Recorded here because a spec delivery renders spec criteria to validators through `covers`, and spec criteria are contract text that may itself be process-shaped. The contract line covers that case too.

### 3.10 Telemetry for planning-phase friction (I-23)

The retrospective could measure planning cost only by counting tool calls in a transcript. This design adds the events that make the next retrospective mechanical, named `module.event` and catalogued in `.kiro/steering/logs.md` with the implementation that emits them:

| event | level | key fields | meaning |
|---|---|---|---|
| `workflow.validate.refused` | info | `code`, `recordId`, `definitionId?`, `conversationId` | a validate, create or replace refusal, one per issue code |
| `workflow.replace.server_fields_merged` | info | `definitionId`, `fields[]` | replace filled absent server-owned fields |
| `spec.plan.preflight` | info | `slug`, `surface` (`validate`, `status`, `propose`), `blocking`, `codes[]` | a preflight or gate evaluation and its finding counts |
| `spec.plan.propose.accepted` | info | `slug`, `covered`, `selected`, `contexts` | coverage at freeze |
| `spec.plan.attempt.transition` | info | `slug`, `from`, `to`, `actor` | includes the new abandon-retires-attempt transition |

Purpose: refusals by code per conversation, preflight-to-propose ratios, and merge counts answer "how much planning cost was the tooling" without a transcript read. No prompt content is logged.

## 4. What stays, and why

| Constraint | Protects | Where the reason renders |
|---|---|---|
| Human dispositions (deferred, waived, reaffirmed) | nothing leaves scope silently | Studio; the native-sdd skill's designed-friction taxonomy |
| Candidate freeze and sign-off by hash | the human approves exact bytes | the read-only refusal on a proposed candidate (3.1); the sign-off receipt shows the review verdict (3.7) |
| Pinned revision | validators judge the contract the run launched against | the pinned-spec source description |
| Must-run coverage lock | a skipped branch can never waive a claimed criterion | the `coverage/not-must-run` refusal (3.3) |
| `requires-pause` for structural live edits | no lane reads a half-applied definition | the refusal (3.5) |
| `/origin` and `/approvalRequired` locks on a draft | provenance | the draft-stage `region_locked` refusal (3.1); replace merges around them |

The native-sdd skill's existing designed-friction taxonomy gains the last three rows, so an agent that meets them can classify them without a retrospective.

## 5. Migration and compatibility

- Binding v3 to v4: dispositions only, claims derived into the candidate manifest. Draft and proposed attempts reopen and re-propose; launched attempts stay readable through the v3 parser. No table migration: the manifest is stored as JSON with its own `schemaVersion`.
- `covers` is additive on the criterion record schema (`criterionRecordSchema` is a non-strict object; the field is optional). Ordinary plans never set it.
- `seededDocuments` is additive on the definition schema.
- The hash change in 3.7 alters no ordinary definition's hash. Reviews recorded on managed definitions before it lands (none exist today) are not migrated; a planner re-records against the new hash, which the review command prints as "none recorded for this revision".
- The `spec start` receipt change removes a token agents were told to ignore. `spec capture --execution` and the server's post-abandon hint consume the spec-side id today and move to the workflow execution id in the same change.

## 6. Tests

Each area starts from a failing behaviour test in the module's existing test file. Three rules apply across areas.

**Persisted fields extend the round-trip contracts.** `covers` and `seededDocuments` persist in `definition_json`, and derived `claims` persist in the candidate manifest. The maximal round-trip fixtures for the workflow-definitions repository and the delivery-plan snapshot repository grow accordingly, with binding v4 and the derived-claims policy declared in each fixture's policy list.

**Every new blocking finding proves its remedy, not only its rule.** For each finding, a test clears it using only operations an agent has, in the order the sequencing allows:

| finding | remedy an agent can perform | proven by |
|---|---|---|
| `coverage/selected-criterion-uncovered` | add `covers` on a criterion in a stable context, via `replace` | replace, then status reports it cleared |
| `coverage/not-must-run` | add `covers` on an always-run closeout context | same |
| `coverage/unknown-id`, `coverage/unselected`, `coverage/unstable-context` | correct or move the `covers` entry | same |
| `launch/charter-unauthored` | replace with an authored charter | same; this is why the check ships together with 3.1 and never before it |
| `region_locked` on a draft | omit the field | replace succeeds with the field merged |

**Live scenarios gate the steps that only break live.** Every defect in section 1 was found live, not by a suite. Steps 2, 4 and 5 of the sequencing are done only when the following list runs on a scratch instance (`cctl dev ensure`, state created with `cctl fixture`), with evidence from re-read rows, receipts and `workflow-logs`, following the project's `cc-live-feature-test` skill:

- S1, step 2: open; validate with `--definition` shows coverage and charter findings; replace a bare `plan.json`; the receipt shows the gate delta and merged fields; status reports nothing refuses; propose; sign-off; start prints one execution id that `workflow status` accepts.
- S2, step 1: start; pause before any lane is provisioned; resume; the first batch dispatches.
- S3, step 3: abandon the launched execution; the attempt row reads `abandoned`; open reseeds from the launched candidate.
- S4, step 4: a plan with `covers` proposes; the manifest carries derived claims; a validator GO citing one record attributes evidence to exactly the criteria that record covers.
- S5, step 5: per-context excerpts exist in the lane worktree; the locator lint is silent on seeded paths; injected sources carry no `accessPolicy`.

Per area:

- 3.1: `definition-route-handlers` contract tests: a bare `plan.json` replaces a managed draft and the stored record keeps origin, approval policy and locks; a plan with a different `origin` is refused naming `/origin` with the draft why-line; a candidate is refused with the reopen why-line; a reopen preserves authored edge ids; the receipt carries `blockingBefore` and `blockingAfter`.
- 3.2: `plan-validation` tests for id-bearing paths on tasks, contexts, edges and sources; lint and coverage findings use the same formatter.
- 3.3: `criterion-records` accepts `covers`; coverage-lint tests for each code with its blocked transition; the three callers share one module (a test asserts validate-with-definition, status and propose return identical findings for one draft); propose derives and freezes claims; the delivery gate attributes a verdict to covered criteria server-side and the verdict schema has no `covers` field; prompts render `covers` beside the record; `cctl spec schema guidance` lists every code.
- 3.4: finalizer emits per-context excerpts and scoped entries; the claims document orders the reader's claims first; `seededDocuments` accepted, capped locally and at accept time, and materialized; the locator lint skips seeded paths; `accessPolicy` absent and the exemption deleted.
- 3.5: receipt tests for `spec start`, the typed refusal of a spec-side id, the abandon transition on the coordinator, `nextAct` after abandon and for a draft, the `requires-pause` and charter why-lines, outline hints, and the ledger lines.
- 3.6: the help-registry contract test covers the new flags and hints; the planner-docs test pairs `covers` with `criterionRecordSchema` and `seededDocuments` with the definition schema, and asserts the "Delivering a native spec" section exists once and that the spec command and native-sdd skill point at it rather than restating the sequence.
- 3.7: hash equality between a planner's `plan.json` and its managed definition; propose prints the review line.
- 3.8: execution-loop reproduction: start, pause with no lane, resume, first batch dispatches.
- 3.10: each event fires from a pure function testable without a server; the logs catalogue lists every event the code emits (an architecture test enumerates emitters).

## 7. Sequencing and scope

Small, independently landable steps, ordered by leverage and by what the next step assumes:

1. 3.8 pause-before-provisioning fix (own ticket), so recovery recipes hold. Live scenario S2.
2. 3.1 replace merges server-owned fields with gate deltas, plus 3.5 seed charter and the charter check, plus the preflight surfaces of 3.3 running today's `binding/*` rules and the charter rule, plus the published catalogue (I-22). The charter check depends on 3.1 for its remedy and must not ship first. Live scenario S1.
3. 3.2 id-bearing locators; 3.5 one execution id, outline hints, receipts, abandon transition, ledger lines, `requires-pause` reason; 3.6 hint chain and the owning skill section; 3.10 events. Live scenario S3.
4. 3.3 `covers` and derived claims, with the lint rename and severities. Live scenario S4.
5. 3.4 excerpts, seeded documents, locator lint, `accessPolicy` removal. Live scenario S5.
6. 3.7 authored-subset hash and the review line on propose.

**Scope under this ticket:** steps 1 to 3. They need no decision from section 8, and together they remove most of the measured accidental cost: after them a spec delivery is authored as a `plan.json`, preflighted with gate parity, and walked by hints.

**Follow-up ticket:** steps 4 to 6. The decisions they depend on are settled (section 8); they change the binding schema and the review hash and are worth their own design review before implementation.

## 8. Decisions (settled by Alex, 2026-09-03)

Each was asked with its alternative and tradeoff; Alex chose the recommended option in every case.

- **D-A, settled: derive.** Claims derive from `covers` (3.3) and the authored claims sidecar retires, amending decision 2 of 2026-08-14. Rejected: keeping authored claims with `covers` as advisory traceability, because a second write surface is the cost this ticket exists to remove.
- **D-B, settled: one id.** The workflow execution id is the only execution id agents see or pass (3.5); the spec-side row id is internal and refused as input. Rejected: keeping both with labels.
- **D-C, settled: derive excerpts.** Per-context spec excerpts derive from coverage (3.4). Rejected: a planner-authored subset locator syntax, and keeping only the global document.
- **D-D, settled: yes.** Seeded documents become a definition-level feature for every plan (3.4).
- **D-E, settled: yes.** The plan-review hash covers the authored subset (3.7).
- **D-F, settled: delete.** `cctl spec plan edit` is deleted once claims are derived (3.3); dispositions are seeded at open and changed only in Spec Studio. Its help-registry entry, the `plan-edit` schema document and the cc-cli skill's command reference are removed in the same change, and the `spec plan` group index no longer lists it. Rejected: keeping the verb for dispositions only.

## 9. Out of scope

- The delivery gate's post-run behaviour (`spec status` reporting coverage 0/31 until the session branch publishes) is designed and unchanged.
- The four planning-quality recommendations in the retrospective that are not SDD-specific (premise rule and feasibility lens, validator class enumeration, implementer residual rule, grade-aware gates) are tracked there and are not part of this design.
- Renaming the three compare-and-swap tokens; the labelled-receipt change in 3.5 is the cheaper fix and can be revisited if labels prove insufficient.
