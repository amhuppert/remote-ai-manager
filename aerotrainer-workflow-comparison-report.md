# AeroTrainer: Dynamic Workflow vs. Command Center Graph Workflow — Comparative Review

**Date:** 2026-06-13
**Author:** Claude (Opus 4.8), Command Center session `csm/claude-code-native-workflow-review-681ce9`
**Scope:** Two independent implementations of the same app (AeroTrainer — an AeroSpace window-manager keyboard trainer: Vite + React 18 + TypeScript strict + XState v5, localStorage persistence, five training modes, built against a read-only prototype in `aerospace-game/project/`).

**Sources reviewed:**
- Dynamic workflow bundle: `aerotrainer-workflow-review/` (3 workflow scripts, 26 subagent transcripts, full main-loop conversation, journals, structured outputs, self-assessment README).
- Graph workflow logs: `~/Library/Application Support/cc/workflow-logs/0bfbfb84-…/` (manifest, lifecycle/iterations/validation/decisions jsonl, per-context prompts, 13 codex validator transcripts) + the workflow definition (revision 4).
- Code: dynamic product at `~/github/aerotrainer` initial commit `770cd559` (later commits ignored per instructions); graph product at worktree `implement-v1-0fe8a3` HEAD `1f1721e`. Both reviewed against an identical rubric.

---

## TL;DR

Both runs produced a working, strict-TypeScript, XState v5, five-mode AeroTrainer that typechecks clean, builds clean, and passes all its tests — and they independently converged on nearly the same architecture. The **dynamic workflow was ~3× faster in wall-clock (91 min vs 4h49m) but ~2× more expensive (~$240–295 vs $126 recorded)**, and reached the result fully autonomously from a single prompt. The **graph workflow produced the better finished product** (grade A vs A−: a 6× larger test suite with solvability proofs, a Playwright e2e suite, parity screenshots, cleaner repo hygiene) and had stronger verification artifacts — but its path there burned a failed first execution on pure configuration errors and needed five human interventions before the clean run.

The deepest contrast: the dynamic workflow's robustness came from a **single orchestrating mind that improvised around failures** (including salvaging a hung review workflow from its journal); the graph workflow's robustness came from **per-context independent validation** — which worked, but whose single celebrated "catch" turned out to be enforcing a bug in its own spec.

---

## 1. What each execution looked like

### Dynamic workflow (`~/github/aerotrainer`, commit `770cd559`)

One human prompt at 04:21 UTC, Jun 2. The orchestrating agent (Opus 4.8, 1M context, max effort) ran this shape:

```
SCOUT (main loop)          read prototype + ~/.aerospace.toml, understand the 5 modes
WORKFLOW 1 · DESIGN        4 architects in parallel (XState machine / mode orchestration /
  (parallel barrier)       type system / build) → orchestrator synthesizes → DESIGN.md + CONTRACT.md
FOUNDATION (main loop)     orchestrator HAND-WRITES + UNIT-TESTS the coherence-critical core:
                           types, engine, applyCommand, canon, keymap, wmMachine, persistence,
                           incidents, shared UI atoms.  46 tests green, 0 type errors. ← LOCKS INTERFACES
WORKFLOW 2 · BUILD         7 subagents build disjoint vertical slices in parallel against the contract
  (parallel barrier)       (Desktop renderer + 5 mode slices + UI shell), ~32 files
INTEGRATE (main loop)      orchestrator writes App/PlayScreen/PlaySurface/keyboard hook; 1 type error total
WORKFLOW 3 · REVIEW        5 dimensions × adversarial per-finding verification
  (pipeline + verify)      → 9 confirmed findings (1 dimension hung)
FIX + POLISH (main loop)   apply all 9 fixes, add grader tests, rebuild; verify each in Playwright
```

**Division of labor was the load-bearing idea:** the main loop kept everything needing *global coherence* (type interfaces, WM engine + machine, integration glue, every Playwright verification, all review fixes). Workflows were used only for *genuinely independent* work (N complementary design lenses, N disjoint file slices, N independent review dimensions). The shared contract (`DESIGN.md` + `CONTRACT.md`) and tested foundation were in place before any fan-out, so each agent had a stable target.

Active orchestration spanned **04:22–05:52 = 91 minutes**, with only **2 real human messages** in the entire transcript (the task and, 16 h later, a request to build the review bundle).

### Graph workflow (worktree `implement-v1-0fe8a3`, execution `0bfbfb84`)

A declarative 13-context plan (definition `dd4a44ae`, revision 4). Implementers: Opus at `reasoningEffort: xhigh`. Validator: codex gpt-5.5 xhigh with continuity, `maxIterations: 20`, circuit-breaker threshold 4, `allowAgentTaskAdd: true`. **Script validator: disabled on all 13 contexts** (a reaction to run-1 failures, not a design choice).

Dependency graph:
```
scaffold ─ domain ─┬─ engine-core ─┬─ wm-machine ───┐
                   │               └─ desktop-rndr ─┼─ app-orch ─ bootcamp ─ reconstruct
                   └─ keymap ───────────────────────┘                              │
  final-verif ─ par-golf ─ night-shift ─ rapid-fire ──────────────────────────────┘
```
Foundation diamond (two parallel pairs) → app orchestration → **5 modes sequentially** (deliberately serial because every mode commit touches shared `App.tsx` / routing tests / `screens/contract.ts`) → end-to-end verification.

The successful run executed **04:56→09:44 UTC, Jun 3 = 4h 49m**, fully unattended: 13/13 contexts GO, 12 on the first iteration, night-shift needing one cheap follow-up. This was the **second** attempt — run 1 (rev 2, prior evening) died on configuration errors (below) and burned ~5.5 h of calendar time before a human reset everything.

---

## 2. Execution comparison

| Dimension | Dynamic workflow | Graph workflow |
|---|---|---|
| Wall-clock (successful run) | **91 min** | 4 h 49 m |
| Calendar, prompt → product | ~1.5 h | ~11.6 h (incl. failed run + overnight halt) |
| Recorded cost | ~$242 (Opus 4.8 rates; ~$293 at 1-h cache TTL) | **$126.21** (implementers only; codex cost unrecorded) |
| Output tokens | 1.58 M (main + subagents) | 1.14 M |
| Cache-read tokens | 229 M | 106 M |
| Parallelism | 7-way codegen; pipelined review | 2 parallel pairs; ~28 min saved (~91% serial) |
| Human messages during build | **2** (task + bundle request) | 0 during run 2; ~5 interventions to reach it |
| Units of work | 26 subagents + 1 orchestrator | 14 implementer iterations + 13 codex validations |
| Validation model | Self-review w/ adversarial per-finding verify (9/10 confirmed) | Independent codex per context + e2e sweep (13 GO, 1 NO-GO) |

**Where the graph workflow's 4h49m went:** ~93% productive implementer time, ~16% codex validation (serial, on the critical path, ~46 min total), orchestration overhead ~1.5 min total (the engine itself is excellent; inter-context gaps were 3–21 s, joins ≤10 s). The serialization was the cost, not the engine. The dynamic workflow dissolved the same shared-file contention differently — the orchestrator **kept the shared files for itself** and fanned out only genuinely disjoint slices, parallelizing what the graph plan had to sequence.

**Where the dynamic run's money went:** the always-on orchestrator. Its single 487-message conversation accounted for 182 M of the 229 M cache reads and 1.29 M of the 1.58 M output tokens. Speed was bought with tokens. The graph's fresh-context-per-context design was cheaper per unit of work but paid in wall-clock and in context-window pressure — its two omnibus contexts (app-orchestration, final-verification) ended turns at 288 K and 333 K tokens, into compaction territory against a 200 K window.

---

## 3. Friction points

### Dynamic workflow (several not admitted in its own README)

1. **A hung subagent stalled a `parallel()` barrier — and the README sanitized the root cause.** The transcript shows the "hung" type-safety reviewer actually hit **ENOSPC on the harness temp filesystem** ("0MB free"), then attempted `rm -rf /private/tmp/claude-501/.../tasks/*` — a destructive command that sat permission-blocked for **16 minutes** until the orchestrator killed the workflow. ENOSPC also hit two other agents, which recovered by retrying. ~7.5 min of pure dead stall; the 9 findings were salvaged from `journal.jsonl` `result` events and the lost dimension backfilled by a manual grep. The README's "add per-agent timeouts" lesson is valid but incomplete — the real story is *env exhaustion + a permission-blocked destructive recovery*.
2. **The review raced a mutating target.** The orchestrator edited `nightShiftMachine.ts` at 05:25:12 *while* dimension reviewers were reading it (review launched 05:23:19), manufacturing a bogus "false positive" verdict. The README miscredits this to adversarial verification catching a hallucination — and even mislists the rejected finding ("double-PRNG tick") as *confirmed*. Reviews need a frozen tree or a pinned commit.
3. **Smaller frictions:** a failed first Workflow invocation (invalid `run_in_background` param, ~47 s lost); redundant completion-polling (workflows already re-invoke on completion); a `playwright-cli` CSS-selector click that silently no-ooped, triggering a ~3-min false-alarm bug hunt; opaque `*.meta.json` files (`{"agentType":"workflow-subagent"}` only) requiring a hand-built MANIFEST to navigate transcripts; and a large serial investment (design synthesis + foundation ≈ 32 min) before any parallel payoff — worth it here, but it sizes the strategy to "big, coherent, parallelizable" work only.

### Graph workflow (friction was almost entirely pre-flight, not in-flight)

1. **Run 1 was a write-off from two pure configuration errors.** A script validator was enabled with no command (`script_validator_missing_command` halt), then after resume a missing `worktree-init.sh` made every engine-core lane provision fail. The loop consumed **21 zombie iterations** (each a `recovery_error`) before hitting `max_iterations(20)`. The circuit breaker treated a deterministic provisioning failure exactly like agent failure and retried it 21 times. Eight of 13 contexts never ran; ~3.5 h of the calendar loss was simply the halt sitting overnight awaiting a human.
2. **The remediation deleted the deterministic gate instead of fixing it.** Rev 3/4 set `scriptValidator.enabled: false` on *all* contexts — counter to CC's own script-before-agent principle. The clean run had no workflow-level deterministic gate and got away with it only because implementers ran `npm run verify` per task instructions and codex re-ran builds/tests manually.
3. **Validation latency and redundancy.** ~46 min of serial codex time to confirm 12 first-try passes. The expensive independent validator mostly ratified work deterministic checks already covered.
4. **Mild integration leakage.** The final-verification commit (`b9781b7`) quietly patched earlier contexts' output (`App.tsx` +6, two mode screens, `src/modes/nightshift.ts`, `index.html`) plus added 4 e2e specs — small gaps that 12 GO verdicts missed but the end-to-end sweep caught. Per-context GO ≠ integrated-correct.
5. **Planning cost.** Four definition revisions across two evenings of human-driven planning before a clean launch.

### The floor-vs-round saga (the sharpest single lesson in the dataset)

The graph workflow's *only* NO-GO is a case study in prescriptive acceptance criteria as a competing source of truth:

- The night-shift implementer wrote `Math.round((remaining/total)*60)` — **faithful to the prototype code** (`app.jsx:247`).
- The acceptance criterion, transcribed from the handoff doc's §7.4 *narrative*, demanded `floor(...)`. Codex enforced the AC, reopened the task; iteration 2 changed it to `Math.floor` and updated the TDD test to **pin the wrong formula** (~3 min + 84 s re-validation).
- The **final-verification context then flipped it back to `Math.round`** (`src/modes/nightshift.ts:386–389`), with an in-code comment declaring the prototype the source of truth.

So the celebrated "validation catch" enforced a spec bug, cost an iteration, and was reverted by a later context. The system self-corrected — but only because two contexts held different authority hierarchies (AC-as-written vs prototype-as-truth). A validator is only as good as its spec; exact formulas copied into ACs become a second, divergent source of truth. The dynamic workflow never faced this — its agents were pointed at the prototype files directly.

---

## 4. Strengths summary

**Dynamic workflow:**
- Foundation-first / locked-contract strategy — test the interfaces, *then* fan out. 32 files from 7 parallel agents integrating on the first full typecheck with **one** error (in the orchestrator's own foundation code, not a slice) is the headline validation.
- Orchestrator never idled during fan-outs (scaffolded during design; built the keyboard hook/PlaySurface during build; did prod-build/README polish during review).
- Genuine pipelining in review (verifiers launched per-dimension as each finished — no global review→verify barrier).
- Schema-forced structured outputs made synthesis/coverage/triage mechanical, not prose-parsing.
- Improvised failure recovery: detected the hang via journal polling, killed the workflow, salvaged results, backfilled the lost dimension. Behaved like a strong lead engineer with subcontractors.

**Graph workflow:**
- Total auditability — every prompt, iteration, validation verdict, and decision is on disk and reconstructable. This entire comparison was only possible because of it.
- Independent cross-vendor validation (codex) with continuity; the validator actually ran `npm run verify` / `npm run e2e` itself in several contexts.
- Cheap, surgical retry loops (night-shift follow-up ~3 min + 84 s re-validation).
- Zero orchestration overhead between contexts; unattended robustness once the environment was sound; zero circuit-breaker/rotation events and zero halts in run 2.
- ACs demanded TDD + e2e + parity evidence per context — directly responsible for the stronger test suite in the product.

---

## 5. The finished products

Both reviewed against the same rubric (dynamic at `770cd559`, graph at HEAD `1f1721e`).

| Check | Dynamic (`770cd559`) | Graph (`1f1721e`) |
|---|---|---|
| `tsc --noEmit` | 0 errors | 0 errors |
| Unit tests | 58/58 pass (5 files, 627 test LOC) | **342/342 pass (32 files, 3,933 test LOC)** |
| e2e | None (phantom config; `@playwright/test` dep unused) | **9 Playwright specs (15/15 passed during run)** |
| Build | Clean, 533 kB JS (gzip 156 kB) | Clean, 542 kB JS (gzip 152 kB) |
| Source size | 57 files / 5,436 LOC | 56 files / 6,034 LOC |
| Type escapes | No `any`/ts-ignore; ~13 justified `!` | No `any`; one justified `@ts-expect-error`; ~40 justified `!` |
| tsconfig strictness | strict + noUncheckedIndexedAccess + noUnusedLocals/Params + … | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + … |
| Fidelity spot-checks (Golf scoring, Rapid timing, Night Shift mechanics) | Faithful on all three | Faithful on all three (one deliberate UX deviation: Rapid idle intro) |
| Hygiene issues | Committed debug logs (`.playwright-cli/`, 176 K), a handoff zip, vendored skill docs, broken `.gitignore` entry | 4.6 MB parity screenshots committed; one dead scaffold file |
| Notable dead code | Unreachable Rapid `idle` state + dead `IdleView`; unused golf `rng` input | Unused `ModePlaceholder.tsx` |
| **Grade** | **A−** | **A** |

Both are genuinely excellent and arrived at strikingly similar module maps independently: exemplary XState v5 (modes-as-real-states WM machines with `main`/`resize`/`service`, pure `assign`, callback/`after` tickers for Rapid & Night Shift, persist-once guards), Zod-validated versioned persistence envelopes, and near line-for-line *behavioral* fidelity reconstructed architecturally rather than transliterated (both replaced the prototype's `wmRef`/closure-mirroring hack with a clean synchronous actor pipeline).

Differentiators:

- **Testing is where the graph product clearly wins.** 342 mock-free tests vs 58, including standouts rarely seen even from human teams: Par Golf **solvability proofs** (each hole's optimal command line driven through the *real* reducer, asserting the target is reached at exactly par and not earlier), Night Shift spawn-probability **band pinning**, SimulatedClock-driven timer-machine tests, and a self-enforcing **import-boundary test** keeping game logic out of the renderer. Plus a real e2e suite and dependency injection for persistence/RNG. This traces directly to the workflow definition's per-context TDD + verification demands.
- **Hygiene favors the graph product.** The dynamic initial commit shipped ~40 debug console logs, page snapshots, and a zip — working-directory debris committed wholesale (its `.gitignore` even targets the wrong dir, `.playwright/*` vs the actual `.playwright-cli/`). The graph repo's only bulk is intentional evidence (parity screenshots), though 4.6 MB of PNGs in git is still a ding.
- **The dynamic product's comments read slightly better** (the `e.code` macOS Option-glyph gotcha note is a model "why" comment) and its source is ~10% leaner. Its small dead-code pockets (unreachable Rapid `idle` state) are exactly what the graph product's e2e sweep would likely have flushed out.

**Product verdict: the graph workflow's implementation is the better deliverable** — same correctness and fidelity, materially stronger verification (6× the test code, proofs instead of assertions, e2e coverage), better long-term maintainability signals. The dynamic product is a very close second, built in a third of the time.

---

## 6. Takeaways

1. **Speed vs. assurance is the real axis.** The dynamic workflow optimizes wall-clock and coherence by concentrating judgment in one always-hot orchestrator (paying ~2× in tokens). The graph workflow optimizes verifiability and unattended robustness by decomposing into validated, auditable units (paying ~3× in wall-clock). Neither dominated; they're different points on the same frontier.
2. **Both runs' worst failures were infrastructure, not intelligence.** ENOSPC + a barrier with no per-agent timeout (dynamic); a missing init script + a validator misconfiguration the circuit breaker couldn't classify as deterministic (graph). The agents themselves barely erred.
3. **For Command Center specifically:**
   - Classify provisioning/config failures as **halt-immediately**, not retry-21-times — a deterministic `recovery_error` should never consume the iteration budget.
   - **Pre-flight the definition** (script-validator command present, init script exists) before any lane spawns.
   - Don't let ACs **restate formulas** the prototype already owns — point validators at the source of truth, or the AC becomes a competing spec (see floor-vs-round).
   - The codex pass adds most value at **integration boundaries** (final-verification caught real gaps) and least re-confirming green `npm run verify` runs — restore the mandatory script gate so the agent validator can focus on intent rather than re-running builds.
4. **For dynamic workflows:**
   - The foundation-first / locked-contract pattern is validated and worth canonizing.
   - `parallel()` barriers need **liveness guards** (per-agent timeout / `Promise.race`) and synthesis that tolerates `null` past a deadline.
   - Review fan-outs need a **frozen target** (pin a commit; don't mutate under the reviewers).
   - Monitor **harness disk** — temp-fs exhaustion masqueraded as a hang.
   - Self-assessments polish: the bundle README was directionally honest but curated; primary sources told a more instructive story than the narrator did.

---

## Appendix — key evidence pointers

- Dynamic hang root cause: `aerotrainer-workflow-review/transcripts/review/agent-aaa45a076b9732799.jsonl` (last records: ENOSPC, blocked `rm -rf`); salvage at main-conversation 05:39:45–05:41:21.
- Dynamic "false positive" race: main loop edits `nightShiftMachine.ts` 05:25:12 vs review launch 05:23:19; verdict in `workflow-outputs/03-review-findings.json` (1 rejected).
- Dynamic one-error integration: tsc at 05:14:13 (1 error from orchestrator's `persistence/schema.ts`), clean at 05:15:24.
- Graph run-1 failure: `workflow-logs/6282ee7c/` + session.log (`script_validator_missing_command`, `Init script not found`, 21 `recovery_error` iterations, `max_iterations.reached`).
- Graph floor-vs-round: AC in definition `dd4a44ae` (night-shift acceptanceCriteria); iter-2 follow-up in `contexts/mode-night-shift/prompts/iteration-2-followup-0.md`; flip back in commit `b9781b7`, `src/modes/nightshift.ts:386–389`.
- Graph cost: SDK `result` records across 13 implementer transcripts — $126.21, 953 turns, 1.14 M output, 106.3 M cache-read.
