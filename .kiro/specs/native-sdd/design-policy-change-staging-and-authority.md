# Design addendum: policy-change staging semantics and action authority

> **Superseded in part (2026-09-24).** Revisions and delivery-plan attempts no longer have a Proposed state: a draft is reviewed while it stays editable, and sign-off is the only freeze. References to `proposed` revisions describe the retired lifecycle; the staging rules otherwise stand. Requirement 27 in `requirements.md` and "Amendment — continuous review" in `design.md` describe the current lifecycle.

**Status:** APPROVED by Alex 2026-07-25 (ticket command-center#24) — both product decisions (§4 PC1 draft pinning with prospective dials; §4 PC5 human-only whole-spec abandon) are accepted, not open — and folded into `requirements.md` (R25 + deltas), `design.md` (amendment section + traceability rows), and `tasks.md` (23.x) the same day; this document remains the decision record. Delivery is staged: 23.1 (the confirmation-bypass hotfix) ships first and independently; 23.2–23.6 are the governed-semantics work. Product-design deltas (§7) are **not yet folded** — this amendment writes only inside `.kiro/specs/native-sdd/`.
**Motivated by:** Ticket command-center#24 — a P0 authority bug found during review (the hard confirmation can be bypassed) plus two under-specified semantics the first authoring run walked into.
**Extends:** `requirements.md` R11 + new R25; `design.md` Transition Ownership (policy change, abandon), PolicyEngine, ReviewService, Security Considerations; `docs/design/native-sdd/01-product-design.md` B8 (rev 6).
**Depends on:** `design-staged-authoring.md` — the authoring stage (SA1) and the stage-scoped dial rule (SA5, R10.11) are the machinery this addendum gives policy-change semantics over.
**Date:** 2026-07-25

## 1. The gap

Three defects, all in the authority half of the feature:

1. **The hard confirmation can be bypassed (P0, found during this review — in no report).** `policyChangeRequiresHardConfirmation` (`policy.ts:75-85`) returns true for **every** preset change plus any dial loosening. But `proposePolicy` (`SpecControls.tsx:261-286`) opens the confirmation dialog only when `policyChoiceLoosens()` is true; otherwise it immediately submits with `hardConfirmed: requiresBackendConfirmation`. A *tightening* preset switch (fast-path → contract-bearing) therefore sends `hardConfirmed: true` with no dialog ever shown. The server check is intact and final (`changePolicy` → `evaluatePolicyChange`, `review-service.ts:1166-1207`), which is precisely the problem: the UI asserts a human confirmation that did not happen, and R11.10's "hard, non-bypassable human confirmation" becomes a claim rather than a fact. The direction of the change does not matter — a mechanism that can be asserted without being shown is not a confirmation.
2. **A policy change has no stated effect on an open draft.** `openDraftAuthoringStage` (`transitions.ts:248-262`) runs only at draft-open, and `changePolicy` (`review-service.ts:1166`) writes the new policy and nothing else. So two specs with identical policy behave differently based on creation history, invisibly: switch a contract-bearing spec to fast-path mid-authoring and its open requirements-stage draft still walks three gates, with nothing telling anyone why; tighten in the other direction and no artifact says what the draft now owes. The behavior is not wrong so much as unstated — and unstated behavior in the gating layer is exactly what R11.10 exists to prevent.
3. **Whole-spec abandonment is agent-invocable while rename is human-only.** `HUMAN_ONLY_ACTIONS` (`route-handlers.ts:2061-2078`) contains `rename` — because renames change the identity references resolve through — but not `abandon-spec` (`:2522-2529`), so an agent can terminate an entire spec. This matches the approved design (R3.10 and the verb map both place abandon on the agent surface); it is a decision to revisit, not drift. It reads backwards on reversibility: a rename is recoverable through aliases, a spec abandonment is terminal (R3.10), and abandon-and-recreate was a live temptation during the observed run when the amendment path could not be found.

## 2. The principle

> A change to gate policy is a human act with **stated, prospective** consequences. It never rewrites history (no admission or approval is ever synthesized for a transition that already happened) and never strands authored content (an open draft's stage is pinned, never moved backward). What it *does* change — which dials govern the draft's remaining transitions, and what the draft still owes — is reported at the moment of the change and every time status is read. And the acts that end things irreversibly belong to the operator; agents propose, the human disposes — the split this feature already uses for waivers, approvals, and assumption dispositions.

## 3. The two accepted product decisions

**Decision 1 — a policy change on an open draft pins the stage and applies prospectively.** Accepted by Alex 2026-07-25 (PC1–PC4 below).

**Decision 2 — whole-spec abandon becomes human-only; `abandon --execution` stays agent-reachable.** Accepted by Alex 2026-07-25 (PC5).

Neither is re-litigated here; §4 records how they are implemented and what they are *not*.

## 4. Design decisions

### PC1 — The open draft's authoring stage is pinned

A confirmed policy change never moves an open draft's `authoring_stage` **backward**. Draft-write admissibility is stage-only (`admitDraftWrite`, SA2): moving a plan-stage draft back to `requirements` would make its already-authored design and plan elements inadmissible — content stranded in a revision that can no longer legally contain it, with no operation to recover them. Forward auto-advance is equally refused: advancing a stage is a recorded transition with a gate admission (SA3), and manufacturing one from a policy edit is precisely the retroactive admission R11.10 forbids.

So: the stage a draft opened at is the stage it keeps until an ordinary, recorded transition moves it — sign-off under Gate, or an explicit `cctl spec advance` under Notify/Off. `openDraftAuthoringStage` keeps its single job (stage assignment **at open**), and a widening policy change simply means the *next* draft opens differently.

### PC2 — The newly confirmed dials govern the draft's remaining transitions

The new policy takes effect immediately for everything ahead of the draft: propose and sign-off resolve their dials at transition time under the existing stage-scoped rule (R10.11 / SA5 — the revision's stage plus any earlier stage whose elements it modified). A just-confirmed tightening governs the very next approval; a just-confirmed loosening lets the next advance be an admission instead of a review. This is the semantics `PolicyEngine` already implements ("dials are resolved at each write/advance/open", SA3) — PC2 states it as contract rather than leaving it as an emergent property, and pairs it with PC1 so "prospective" has one meaning: **future transitions, current stage**.

### PC3 — Nothing is ever synthesized backward, and proposed/approved revisions are never restaged

No policy change writes an approval row, writes a gate admission, or alters a revision's stage for a revision that is `proposed`, `approved`, or `withdrawn`. Approved history is immutable (R2.4, 2.5) and a proposed revision is frozen for review (R3.3); restaging either would silently change what a human is reviewing or has already signed. The only mutable subject of PC1/PC2 is an open **draft**, and even there only its future.

### PC4 — The remaining stage sequence is reported

Because the consequences are prospective, they must be visible at exactly two moments: the `change-policy` response reports the open draft's pinned stage and the stage sequence remaining under the new policy with the gate that concludes each; `cctl spec status` reports the same sequence for the current draft. The policy record carries the acting human, the previous policy, the resulting policy, and the pinned draft stage, so a later reviewer can tell which dials governed which transition — the audit question "why did this revision need a human?" is answerable from durable state.

**Fallback, recorded per the review's condition:** if the staged consequences of a change cannot be specified decision-completely for some policy shape, the spec system refuses that change while a draft at a **wider** authoring stage is open, naming the draft and instructing the operator to resolve it first (propose it, or abandon the draft) before changing policy. Refusing is honest; guessing is not. PC1–PC3 are believed decision-complete for the three presets and every sparse override; the fallback exists so the first shape that is not does not become an invented behavior.

### PC5 — Whole-spec abandon is human-only; execution abandon stays agent-reachable

`abandon-spec` joins `HUMAN_ONLY_ACTIONS` (`route-handlers.ts:2061-2078`), checked at the route gate before any service work (`:2292-2294`) — the same mechanism as `rename`, not a second one. `abandon-execution` (`:2515-2521`) is untouched and stays agent-reachable with its required reason: abandoning a run is the sanctioned recovery path for blocking discovery (R16.9), and the run is not the spec.

An agent that judges a spec should die raises it as an open question (R12.1) — the propose/dispose split already used for waivers (14.3), approvals (10.2), and assumption dispositions. The CLI surfaces the refusal with that instruction rather than a bare 403.

Two implementation constraints follow, both load-bearing:

- **The route guard is the entire enforcement.** `execution-service.abandonSpec` has no actor gate of its own — same posture as `rename`. And human-vs-agent is transport identity (`resolveTransportActor`, `route-handlers.ts:1944-1981`): a token-less call classifies as human. That bound is pre-existing for every human-only action and is not widened here, but it is what the guard actually guarantees.
- **No Spec Studio control calls `abandon-spec` today.** Nothing in `src/features/spec-studio` invokes it (`SpecControls.tsx:2028-2031` wires only abandon-execution; `:1817` merely mentions abandonment in prose). Making the action human-only without adding an operator control would strand the capability behind a hand-made API call. Task 23.4 therefore lands the guard **and** the Studio control together.

### PC6 — The confirmation is shown by the same rule the server enforces

The fix inverts today's coupling: the **backend-equivalent predicate** (`policyChangeRequiresHardConfirmation`) decides *whether* the modal appears; `policyChoiceLoosens` decides only its warning copy; `hardConfirmed: true` is emitted **only** from the modal's explicit accept action, never computed at submit time. The server check stays final authority — the UI can no longer assert a confirmation, only obtain one. Tests cover every preset direction pair (both ways across all three presets) and both override directions.

This is Stage 0: independent of PC1–PC5, shippable immediately, and a prerequisite for trusting anything the later impact preview says. The same modal later hosts the policy-impact preview (current → resulting stage, gates consulted next, draft validity, remaining lifecycle — task 23.6); the hotfix does not wait for that design.

## 5. Deferred design note: the gate satisfaction/supersession lineage model

Recorded here with its evidence because it shares this addendum's question and must not be improvised inside a display fix.

`gateStatuses` (`route-handlers.ts:764-795`) evaluates admissions against the **current** revision only, so a spec whose requirements gate was admitted on revision 2 renders that gate `pending` at revision 3 — indistinguishable from an approval that never happened. The honest near-term fix is presentational and is governed by R24.13: show the historical admission (revision number, basis, actor) on a **separate line** from the current-revision state, wording it as history (`history: admitted on rev N`) and never as satisfaction.

It cannot yet say more. Whether an earlier admission still satisfies a gate depends on whether the governed content changed between revisions — content lineage that is not computed anywhere: `spec_gate_admissions` (`state-db.ts:354-375`) records `(gate, basis, approval_id, revision_id, execution_id, actor_json)` and nothing about what content was admitted. The design target is a satisfaction/supersession lineage model — per-gate, content-scoped, with an explicit supersession rule — designed **together with** restaging (PC1–PC3), because both turn on the same question: *did the admitted content change?* Emitting a "still satisfied" boolean before that model exists would be a false-proof claim in the one direction this feature never permits (13.4, 18.3). Task 23.5.

## 6. Requirement deltas (folded into `requirements.md`)

- **R11 — add criterion 13:** "A confirmed policy change shall pin the authoring stage of any open draft revision and shall govern that draft's remaining transitions prospectively, never restaging a proposed or approved revision and never synthesizing approvals or admissions retroactively (Requirement 25); and any surface requesting a policy change shall obtain the required hard confirmation before asserting it."

### New Requirement 25: Policy-change staging semantics and action authority

Authored in full in `requirements.md` (10 criteria): stage pinning; prospective dials; no retroactive synthesis; no restaging of proposed, approved, or withdrawn revisions; the remaining-sequence report in `change-policy` and `status`; the refuse-while-a-wider-draft-is-open fallback; human-only whole-spec abandon with the propose-not-perform path for agents; agent-reachable execution abandon; confirmation shown by the server's own rule; and the policy record carrying actor, previous policy, resulting policy, and pinned stage.

## 7. Product-design deltas (fold into `01-product-design.md` as rev 7 when implemented — not folded here)

- **§4 / B8:** state what a policy change does to an open draft — stage pinned, dials prospective, nothing synthesized backward — and that the remaining stage sequence is reported at the change and in status.
- **B8:** record that whole-spec abandonment is a human act (an agent raises it as an open question) while execution abandonment stays on the agent surface as the blocking-discovery recovery path.
- Record the decision date 2026-07-25 in the doc's decision log.

## 8. Compatibility and observability

- No schema change, no migration, no new table or column: PC1–PC4 are transition-time semantics over existing state, PC5 is a set membership at the route gate, PC6 is client-side.
- Existing specs are unaffected at rest. The one behavior change an operator will notice is a 403 from `cctl spec abandon <slug>` (the CLI selects the action purely from the absence of `--execution`, `write.ts:1167-1173`) — which is why the CLI refusal copy and the Studio control land with the guard.
- The `change-policy` action is already human-only (`route-handlers.ts:2061-2078`), so PC6 changes only whether the operator was actually asked. The pre-fix window is not silently recoverable: policy events record the change, not whether a dialog was shown.
- Observable effect: policy changes carrying their pinned stage and previous/resulting policy make the §6.1 approval-friction measure attributable to a dial state rather than to a spec's creation history.

## 9. Tasks (appended to `tasks.md` as 23.x)

Now: 23.1 confirmation-bypass hotfix (Stage 0, first and independent). Deferred to the governed-semantics stage: 23.2 pinning and prospective dials with the refusal fallback; 23.3 remaining-sequence surfaces and the enriched policy record; 23.4 human-only whole-spec abandon with its Studio control; 23.5 the lineage model; 23.6 the confirmation impact preview.

## 10. Rejected alternatives

- **Restaging an open draft on policy change (either direction)** — backward strands content under stage-only admissibility (PC1); forward manufactures a gate admission no one made (PC3). Both violate "prospective only, never retroactive" (11.10).
- **Refusing every policy change while any draft is open** — the blunt version of the fallback; it would make policy immovable for the entire authoring period, which is exactly when an operator learns the policy was wrong. Kept only as the narrow, shape-specific fallback of PC4.
- **Leaving the confirmation coupled to loosening** — the bug: it makes "non-bypassable" depend on the change's direction, and a tightening change still asserts a human act that did not occur.
- **Making the server infer confirmation from the UI's dialog state** — unverifiable across the transport; the server's rule stays the rule, and the client's only job is to obtain the answer honestly (PC6).
- **Keeping `abandon-spec` agent-invocable with a `hardConfirmed` flag** — a self-asserted confirmation from an agent is the same defect as N1 in a different surface.
- **Removing whole-spec abandon entirely** — the operator legitimately needs it; the decision is about authority, not capability.
- **Shipping a "still satisfied" gate roll-up now** — a false-proof claim without content lineage (§5).
