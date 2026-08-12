# SDD ↔ graph-workflow alignment — design

Source findings: `docs/reports/workflow-audits/2026-08-11-spec-import-delivery.md`
(execution `2560164c`, spec-import delivery). Three issues; three designs. D-numbers are
decision records with rejected alternatives, ready to be lifted into a native spec.

---

## 1. Planner-decidable parallelism strategy (lightweight vs worktree)

### Problem

`deliveryPlanContextSchema` is `.strict()` with no placement vocabulary, and
`delivery-plan-materializer.ts:400` hardcodes `{ lane: contextId, mode: "full" }` for
every context. D5 lightweight parallelism (shared lanes, ownership envelopes, session
read-only placement) is unreachable from native-SDD plans. The spec-import planner
compensated by spending dependency edges to serialize hot files — rational, but it put
6 of 9 contexts on the critical path and still paid a 55-minute final publish merging 7
single-member lanes.

### Design

**D1 — Context-level `placement` on the delivery-plan document, mirroring the graph
vocabulary.** Add an optional `placement` field to `deliveryPlanContextSchema`:

```
placement?: { lane, mode: "full" }
           | { lane, mode: "owned", ownedPaths: [path, …] }
           | { lane, mode: "readOnly" }
```

Same discriminated-union shape as `contextPlacementSchema`
(`src/lib/workflow-graph/definition-schemas.ts:206`), so materialization is a **copy,
not a translation** — the exact precedent `deliveryPlanGovernanceSchema` already sets
("the shape is the workflow charter's own, field for field"). The shape is **mirrored
locally** in `delivery-plan.ts` with blob-column bounds (lane ≤ 120 chars via the
`executionLaneSchema` grammar already mirrored in `specs/schemas.ts`; `ownedPaths` ≤ 64
entries × ≤ 500 chars, `ownedPathSchema` grammar), and a drift-pin test asserts the
mirror parses exactly what `contextPlacementSchema` parses — the same
mirror-plus-pinning pattern `executionLaneSchema` uses to stay dependency-free.

Rejected: **task-level `executionLane` revival** — in the attempt model contexts are
first-class, so deriving context placement from member-task agreement re-imports the
legacy contraction indirection for nothing. Rejected: **a `parallelism:
"lightweight" | "worktree"` enum** — it hides the load-bearing part; owned mode is
meaningless without declared write surfaces, and a boolean cannot supply `ownedPaths`.

**D2 — Absent placement keeps the solo default.** `placement` omitted ⇒ materializer
emits today's `{ lane: contextId, mode: "full" }`. The graph tier made placement
*required* to kill silent seed-time defaults ("an optional field would silently
resurrect it"), but that reasoning binds the tier where placement IS the contract; at
the plan tier the materializer is the single deliberate owner of the default, the
default is the safest grade, and requiring it would force 9 boilerplate placements onto
every plan that doesn't care. The default is *documented* rather than silent via D5
below. Existing attempts and their plan hashes are byte-identical (absent field ⇒
unchanged canonical serialization).

**D3 — Lane-name collision handling reuses the one existing owner.** Authored lanes and
generated solo lanes draw from one namespace (a context named `core` with no placement
generates lane `core`; another context may author `executionLane`-style lane `core`).
The legacy compiler already solved this — reserve authored names first, rename contested
generated ones with a numeric suffix (`contextPlacements`,
`src/lib/specs/compiler.ts:1077`). Extract that algorithm into a shared helper (natural
home: alongside `laneNameFromId` in `@/lib/workflow-graph/lane-identity`) and call it
from the materializer; the legacy compiler keeps delegating to it until that path is
deleted.

**D4 — Propose-time placement lint, mirroring graph-layer refusals as located
findings.** New `plan/placement-*` rules in `delivery-plan-lint.ts`, `blocks_propose`:

- `plan/placement-lane-grammar` — lane fails the branch-name grammar, or names the
  reserved session lane with a mode other than `readOnly`.
- `plan/placement-owned-overlap` — two same-lane `owned` contexts that no edge orders
  declare overlapping `ownedPaths` (prefix overlap, matching the graph layer's rule).
- `plan/placement-full-shared` — a `full`-mode context shares its lane with any other
  context that no edge orders (mirror of `placement-full-access-concurrency`).
- `plan/placement-closeout-shared` — **advisory**: a `closeout`/`integration`-typed
  context shares a lane with unordered writers (self-verifying contexts want quiet
  lanes; matches the planning skill's guidance).

Deep validation stays owned by the graph layer: the candidate compile at
propose/preview already runs the definition through placement validation, so anything
the lint misses still refuses before launch — the lint's job is a located finding with
the owning context's id and a remedy, hours earlier.

**D5 — Teach it everywhere the compile contract is taught, in the same change.**

- `MATERIALIZER_FIELDS` gains a `placement` entry (`source: "contexts[].placement"`,
  `target: "executionContexts[].placement"`, `transformation: "copy when authored; solo
  lane (context id, full access) when absent"`) so `cctl spec schema guidance` finally
  documents the rule the audit found undocumented.
- `native-sdd-authoring/SKILL.md` gains a short placement section — decision rules, not
  schema prose: chain-shaped context groups (ordered by edges anyway) share one lane
  and cost one worktree + one join instead of N + N; unordered same-lane members need
  disjoint `ownedPaths`; pure readers go `readOnly` on the session lane; when unsure,
  omit placement and take a solo lane. Cross-link the `graph-workflow-planning` skill's
  "Lane Placement and File Ownership" for the full model.
- `cctl spec plan edit --help` (spec.help.ts) names the field and the default.
- Drift protection follows the audited lesson (agent-guidance NO-GO): the
  instruction-docs tests pin the *section's* mandatory statements, not a phrase list
  over the whole document.

**Compatibility note.** The attempt document is strict and stored whole in a TEXT
column; an older build (shared DB across branches) reading a placement-bearing attempt
will fail parse and quarantine the row — same exposure class as any additive plan-schema
field, acceptable for short-lived draft rows, worth a line in the migration/floor notes
rather than a schema-version fence.

Applied to the audited plan, the expressible win: `schema-foundation →
import-service-core → delivered-marking → validation-loop` (a pure chain) share one
`owned`/`full` lane — 3 fewer worktrees and 3 fewer final-publish merges — while the
genuinely parallel tracks (`carry-forward`, `cli-verb → agent-guidance`, `studio-ui`)
keep isolation, and their known file overlap becomes a *refused overlap or a declared
edge at propose time* instead of six LLM conflict sub-turns at publish.

---

## 2. Charter access: make the pinned spec readable (must-fix)

### Problem

`accessPolicySchema` is two-valued (`worktree-relative` | `external-readonly`,
`src/lib/workflows/charter-schemas.ts:23`). A native spec is DB-resident, so the
spec-import plan had to rank its own spec `external-readonly`, and the charter's
blanket rule ("never read … automatically — explicit human permission is required")
forbade every validator in all 9 contexts from reading the plan's #1-ranked source of
truth.

### Design

**D6 — Materialize the pinned revision into every lane as a reserved shared document;
the source of truth becomes `worktree-relative`.** At SDD launch, the spec layer writes
the pinned revision export (the `cctl spec export` payload, rendered once as
`spec.md` + raw `spec.json`) into the execution's shared-document store under a reserved
path — `.cc/graph-workflow-docs/spec/<slug>.md` — and registers it as a
`sharedDocuments` entry with a new `kind: "spec"`. Everything downstream already
exists: the charter itself rides this exact channel (`kind: "charter"`, reserved id,
enum extended with default-parse `"shared"` for old rows —
`definition-schemas.ts:944`), the central store re-materializes into every lane
worktree on fork, and lane-drift accounting already excludes `.cc/graph-workflow-docs`.

Why a file and not live reads: the execution **pins** a revision; validators must judge
the pinned contract, and a live `cctl spec show` reads current state that mid-run
amendments legitimately move. The injected file is deterministic, needs no permission
model, adds zero prompt bloat (read on demand, like `charter.md` today), and works
identically for Claude and Codex validator runners.

Rejected: **a third `accessPolicy` grade** (`cc-readonly`: "readable via read-only cctl
verbs without permission") — it reintroduces live-vs-pinned drift, and its enforcement
is guidance-only unless the sandbox/proxy layer learns to distinguish read verbs;
revisit only if a future need for *live* spec state in lanes appears. Rejected:
**embedding the full spec into every brief** — tens of KB × every prompt for content
the packs already excerpt.

**D7 — Governance stays authored; `spec plan open` seeds the correct entry and lint
refuses the unreadable spelling.** Consistent with the document's philosophy ("deriving
those at materialization would be exactly the synthesis this document exists to
remove"), the engine does not rewrite authored sources. Instead:

- `emptyDeliveryPlanDocument()` / `spec plan open` pre-seed `governance.sourcesOfTruth`
  with the pinned-spec entry: rank 1, locator `.cc/graph-workflow-docs/spec/<slug>.md`,
  `accessPolicy: "worktree-relative"`, description naming the pinned revision id.
- New lint `plan/spec-source-unreadable` (`blocks_propose`): the plan's own spec ranked
  with `external-readonly` access, or located via `cctl spec` verbs, refuses with the
  exact replacement entry in the finding — a located lesson instead of nine silent
  "was not queried" verdicts.

The charter renderer needs no change: a worktree-relative source renders as readable
today; the permission-gated sentence stays, now scoped to genuinely external sources
(other repos, URLs), which is what `external-readonly` was for.

---

## 3. Silent SDK dead turn — verification and the two remaining gaps

### What is already fixed (verified, predates the audited run)

- Per-turn inactivity watchdog: `src/lib/agent-backends/stall-watchdog.ts`, wired into
  the conversation pre-turn path (`workflows/conversation/pre-turn/abort-wiring.ts:99`)
  and both task runners — landed July 19 (`b4828c54`, `daf6da34`), from the 9h37m codex
  incident. Activity-based: any backend event re-arms it, so long thinking/tool turns
  never trip it — only dead air.
- One automatic recovery, no operator: a stall-aborted turn
  (`AgentTurnFailedError cause "stall"`) or a transport-class error (`stream closed`,
  `querysession died`, …) resets the context and retries once on a fresh conversation
  (`execution-loop.ts:2515-2553`); the halt path is the second strike.

### Why the Aug 10 run halted anyway — two gaps, two changes

**Gap A: the watchdog is disabled for Claude turns.**
`claude/descriptor.ts:56` sets `defaultStallTimeoutMs: null` (codex:
`20 * 60 * 1000`); no builtin profile overrides it, and workflow agent assignments
don't carry one. The 55 silent minutes had no watchdog — the halt fired only when the
SDK finally surfaced its own error.

**D8 — give Claude the same default:** `defaultStallTimeoutMs: 20 * 60 * 1000` in the
Claude descriptor (one line + descriptor metadata test). Calibration is safe for opus
xhigh: extended thinking streams deltas continuously, so 20 minutes of *zero* events is
pathological, same as codex. Profiles can still override per-agent.

**Gap B: the SDK's own terminal failure is not classified retryable.** The halt cause
was `sdk_error` with message `[ede_diagnostic] result_type=user … stop_reason=tool_use`
— a turn that terminated on a non-result message. That string exists nowhere in this
repo or the SDK package here (it is an SDK/CLI-side diagnostic), so
`isRetryableIterationError`'s message regex can never be a reliable net for the class.

**D9 — first sdk_error strike is retryable, by cause, not by message.** Extend the
recovery predicate: a context's **first** `agent_turn_failed` with cause `sdk_error`
takes the same single automatic recovery as stall (fresh conversation, context reset,
`recoveryAttempts < 1` already bounds it); the second consecutive strike halts exactly
as today. Deterministic failures (auth, config) fail twice and still halt — the cost of
one wasted retry is minutes; the cost of the current behavior was a 3h 22m operator
wait for a failure a fresh conversation fixed on resume. Rejected: growing the message
regex per incident — the strings are not ours and change under our feet.

With D8 + D9 together, the audited incident replays as: watchdog aborts at 20m (not
55m), automatic recovery relaunches the iteration on a fresh conversation, no halt, no
operator, ~35 minutes lost instead of ~4.3 hours.

---

## Test plan (red-green, per AGENTS.md)

1. Delivery-plan schema: placement round-trips through the attempt persistence contract
   fixture; mirror-pin test vs `contextPlacementSchema`; hash-stability test for
   placement-less documents.
2. Materializer: copy-through for each grade; solo default when absent; collision
   rename (authored lane vs generated solo name) via the extracted helper's unit tests.
3. Lint: one red fixture per new `plan/placement-*` and `plan/spec-source-unreadable`
   rule; guidance registry snapshot includes the placement mapping line.
4. Launch injection: integration test proving `spec/<slug>.md` exists in a lane
   worktree at first iteration and matches the pinned revision (persistence fixture +
   real store, not a JS fake).
5. Descriptor: claude metadata default test; execution-loop test for
   first-strike-sdk_error recovery and second-strike halt.
6. Instruction docs: section-scoped drift tests for the new skill/help sections.

## Suggested sequencing

Design 3 (D8, D9) is two small, independent changes — ship first. Design 2 (D6, D7) is
self-contained in the launch path + lint. Design 1 (D1–D5) is the largest and touches
the plan schema, materializer, lint, and three instruction surfaces; it wants its own
native spec with these decisions as the seed.
