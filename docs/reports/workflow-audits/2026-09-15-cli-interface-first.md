# Workflow audit — interface-first cli-for-agents

Execution: `117f1dc7-1032-4aa3-a838-93ea24cb3ed7` · definition revision 6 · completed September 15, 2026.

## Verdict

**Interface-first demonstrably helped expose design and type-safety problems before runtime implementation. The reviewed core contracts then provided useful, largely stable implementation boundaries.** However, the scaffold did not establish that every promised behavior was implementable: missing host capabilities and runtime identity semantics required later changes, and several public contract defects survived delivery.

I recommend keeping the approach for this API-focused library, with a small executable path through its modules before freezing contracts for parallel work. This run supports that quality judgment; it cannot establish whether interface-first saved money or time overall. Recorded workflow spend is **at least approximately $200.71**, with **35h 49m elapsed**, heavily affected by pauses and infrastructure incidents unrelated to interface design.

## What this run actually evaluated

The process was:

1. Write compiling interfaces, type fixtures, and throwing stubs.
2. Independently review the design and real consumer needs; repair compiler defects.
3. Plan a graph that explicitly revises the interfaces.
4. Complete the serial `input-family-contracts` and `runner-response-contracts` contexts, including review corrections.
5. Implement runtime owners, integrate them, and exercise real local and remote pilots.

The launch baseline, `71e8331`, explicitly describes the scaffold as provisional. Significant accepted design changes still awaited implementation when the workflow began. The repaired contract checkpoint is `551ad98`; the delivered session commit is `9f6d22f`. Thus, this is evidence about **provisional interfaces plus review and refinement**, rather than about the sufficiency of the original interfaces. [P; G]

The workflow completed **19 contexts and 51 tasks**. Ten contexts received a NO-GO before passing, accounting for 17 blocking findings. Nine passed their first recorded review; eight completed in one iteration. The difference is the baseline context, whose extra iterations involved launch preparation rather than a rejected implementation. [E]

## What worked — preserve these

### 1. The scaffold made design claims testable early

The initial compiler fixtures exposed secret metadata lost through type widening and flag maps that could not prove reserved names were absent. These were actual compiler failures followed by repairs, not retrospective claims about testing. [P, seq 79–95]

Independent review also found a valid `Result` consumer expression that failed with TypeScript's excessive-recursion error, TS2589. An existing negative fixture had hidden that error alongside the intended rejection. Isolated positive compiler controls were then added. This is a concrete benefit of having executable types available before implementation, and a reminder that negative type tests alone are insufficient. [R, seq 4174–4175 and 4480–4481; P, seq 171–177]

Review could also identify behavioral shortcomings before runtime code depended on them: optional payload decoding, forcing every write through prepare/commit, no per-command text renderer, mandatory application context, and competing guidance arbitration owners. The workflow deliberately revised these decisions. [G, design review and implementation contract]

### 2. The repaired core stayed stable

The foundation changed `defineCommand<App>()` into `commandsFor<Contexts>()`, separated caller inputs from resolved handler inputs, made lazy payload decoding mandatory, supported direct scalar writes, and gave response assembly sole ownership of guidance arbitration.

After those changes and their review repairs:

- `src/input.ts` is byte-identical between `551ad98` and `9f6d22f`.
- The public command and runner declaration signatures survived implementation; `commandsFor` gained an implementation overload.
- The central `execute`, `assembleResponse`, and `deliver` call signatures survived.

This supports the usefulness of explicit boundaries for distributing work. It does not isolate their contribution from the graph's dependencies, ownership documents, tests, and reviewers. Host, help, testkit, and private intermediate contracts continued to change. [G]

### 3. Types caught an actual integration mistake

During runtime composition, TypeScript rejected an object with independently optional `instruction` and `hint` properties as `HandlerGuidance`. The implementer repaired it to select the mutually exclusive variants. The declared contract enforced an intended invariant while separate implementations were being connected. [C, seq 37–39]

### 4. Validation extended beyond compilation

The delivered library contains executable local and loopback-HTTP pilots, real filesystem persistence checks, process output tests, package export checks, and Node/Bun evidence. The final-verifier transcript contains a successful full-test result. Final publication includes no remaining `return notImplemented()` sites in `src`.

These are useful outcome checks to retain. Passing them does not mean every public composition works, as the postworkflow review demonstrates. [F, seq 76, 86, 88; G; P, seq 739–773]

## Friction, ranked by relevance to interface-first

### 1. A declared feature lacked the capabilities needed to implement it

Both the original scaffold and the repaired foundation exposed `ArtifactPolicy.retention.maxAgeMs`. Their `Host` contract lacked operations for enumerating, aging, and deleting artifacts.

The artifact implementer reached this gap, left the task open, and asked Alex whether to expand the host or defer retention. Alex chose **“Add opt-in host cleanup.”** The implementation then extended `Host` and both real and test adapters. The observable question-to-resumed-prompt interval was about **1h 45m**. [A, seq 121, 125, 135, 139; G, `src/runtime/index.ts` and `src/internal/artifact-retention.ts`]

This is the clearest evidence of an incomplete interface forcing a late design decision and work across module owners. It does not prove that interface-first caused the omission; it shows that declaration review failed to uncover it before the freeze.

Related gaps appeared elsewhere:

- Reference generation needed to replace existing content, while the host's artifact-oriented `writeAtomic` correctly refused overwriting different bytes. `ReferenceHost` gained a separate replacement capability.
- Help examples initially promised runnable `Invocation` values, but secret-bearing examples required a redacted template variant.
- The local pilot discovered `runForTest` accepted only `TestHost`, excluding the real `nodeHost(): Host`. The public option was widened to `Host`.

[H, reference-writing and help-example changes; L, seq 83–117; G]

### 2. Static shapes did not settle identity and lifecycle semantics

Runtime integration initially JSON-cloned a resolved artifact policy, destroying the private identity that made it trusted. The repair preserved the policy object while detaching ordinary guidance and issue data. A deliberate reintroduction reproduced the failure. [C, seq 40–60]

Other integration repairs had to carry canonical JSON-output selection through parser refusals and distinguish offline help metadata from handler output. These required changes across parser, registry, execution, response, and runtime modules. [C, seq 168–237]

The missing complement to type checking was a behavioral contract for how values move between modules: which values may be copied, which retain identity, and which source-specific rules apply.

### 3. The original API required substantive revision

The two contract-revision contexts consumed **$17.96 in recorded implementer spend and approximately 54 minutes of recorded agent time**, excluding their validators. Both received a NO-GO:

- Input contracts retained union/widening holes around secret flags and selected application types.
- Runner/response documentation assigned host and delivery responsibilities to the wrong owners and omitted an explicit assembled-response handoff.

Their repairs happened before downstream runtime implementation, which is valuable. This expenditure is **design/refinement work, not a measured waste estimate**: a different development order would still need to solve these problems. [E; I; B]

### 4. Interfaces did not eliminate merge work

The execution records two joins with conflicts resolved by agent sub-turns: runtime composition and final publication. Resolution reports include both overlapping implementation edits and earlier scaffold snapshots meeting later implementations. The core API's stability therefore cannot support a claim of conflict-free parallel delivery. These records alone do not establish whether interface design or the merge strategy caused particular conflicts. [J]

### 5. Most runtime review failures do not establish harm from interface-first

Proxy-safe JSON validation, positional argument rebinding, path containment, finalizer capture, output overflow, secondary-error preservation, and shell quoting all required corrections. Their intended behavior was already specified. They are implementation defects, not evidence by themselves that writing interfaces first was a bad choice. [E, blocking validation issues]

## Work-product quality after delivery

The design is substantially implemented, but the subsequent review found three remaining P2 gaps:

1. **A public composition typechecks but fails:** `renderInvocation(hint(ref, "Inspect").invocation, "tool")` loses invocation identity. Detachment also permits a same-path foreign reference to acquire local meaning.
2. **Optional context keys evade compile-time provider completeness:** a command requiring `remote` can compile with an empty provider map when the context-map property is optional, then fail at registration.
3. **Envelope decoding brands contradictory artifact metadata as validated:** it accepts a binary artifact described as containing data and accepts an invalid media type.

The first and third have direct reproduction output in the planning transcript. Source inspection confirms the copying, mapped-type optionality, and independent field checks involved. These are existing reviewed defects, not fresh test executions performed for this audit. [P, seq 739, 759, 773; G, `src/guidance/index.ts`, `src/runtime/index.ts`, `src/results.ts`]

The hint defect particularly matters to this question: an existing test explicitly expects the public composition to fail and recovers through a private API. Local tests can preserve a contradiction in the interface promise. A test written as an ordinary package consumer would expose it. This is evidence for checking public composition, not proof that predeclaring `Hint` caused the defect. [G, `tests/registry.test.mjs:398–407`]

## Cost

| Recorded work | USD | Interpretation |
| --- | ---: | --- |
| Original scaffold turn | $4.75 | Primary turn telemetry; 20m 23s recorded duration |
| Independent interface review and consumer census | $23.46 | Corrected cumulative lineage accounting |
| Review response and compiler fixes | $4.40 | Primary turn telemetry |
| Those preparation stages combined | **$32.61** | Excludes earlier research, graph planning, and graph-plan review |
| Workflow implementer conversations | **$162.57** | Transcript-corrected, across 23 reachable conversations |
| Workflow validator usage | **$38.14** | Extractor estimate from 31 usage-bearing verdict events |
| Recorded workflow total | **at least ~$200.71** | Incomplete spend coverage |

The raw implementer DB total is $222.63; it overcounts relative to transcript accounting and is unsuitable for conclusions. Some response-assembly activity has no recorded cost: two reachable transcripts contain tool calls without priced results, although the confidence detector flags only one active gap. Failed validator attempts and merge-resolution work are not established as fully priced by the displayed rollups. Treat $200.71 as the known floor, not the complete invoice. [E]

Selected corrected implementer costs: execution lifecycle $16.19; registry/parser $15.51; runtime composition $13.13; artifact delivery $12.96. These are whole-conversation costs. I cannot split them reliably into useful implementation versus interface-driven rework, or price individual NO-GO iterations. [E]

Preparation accounting is independently traceable: P seq 136 and 207; R cumulative results at seq 7791, 9270, 10182, and 11542. The review total sums the final values of two lineages, rather than summing intermediate cumulative results. The supplied planning-conversation total also includes later troubleshooting and review, so it is not a scaffold cost.

## Time — corrected interpretation

| Measurement | Duration | Meaning |
| --- | --- | --- |
| Workflow elapsed | 35h 49m | September 14 05:14 UTC → September 15 17:03 UTC |
| Recorded agent-turn total | 7h 20m | Summed implementer turns; excludes the extractor's hung-turn interval |
| Operator pause | 8h 30m | Explicit pause/resume lifecycle events |
| Halt-to-resume recovery | 10h 50m | Four infrastructure-related interruptions |
| Question pending → resumed prompts | About 2h 56m | Three Node-20 preparation questions and the retention decision |

These are different measures, not a complete additive partition. Summed agent time is not serial wall time. The extractor's 1h 41m “hung turn” overlaps the SDK-error recovery interval; adding it again would double-count waiting. Validator work and merging also consume elapsed time.

Three corrections to the automatic report matter:

- Its **8h 30m unexplained gap** is an explicit operator pause in `lifecycle.jsonl` lines 8–10.
- Its **zero human wait** is incomplete. Pending-question events have no matching resolved events in this archived stream, but resumed prompts contain the answers.
- Its two other long “unexplained” gaps correspond to Node preparation and the retention question, not unexplained orchestration inactivity.

The halts include validator inactivity timeouts and the Codex SDK JSONL parsing failure. These cannot be charged to interface-first. The retention decision is relevant to contract completeness, but its calendar wait measures when the workflow could resume, not engineering effort spent fixing the interface. [E; J; Q; A]

## What can and cannot be concluded

| Question | Evidence-based answer |
| --- | --- |
| Did the approach produce benefits? | **Yes.** Early compiler/design defects were found; retained types caught integration errors; the repaired core stayed stable. |
| Did it eliminate design decisions during implementation? | **No.** Host capabilities, public help/testkit shapes, and internal semantic contracts still changed. |
| Did it cause observable rework? | Revising written interfaces and consumers incurred work. Some was explicitly planned refinement; some came from late capability gaps. Attribution to avoidable waste remains uncertain. |
| Was it harmful overall? | **Not established.** The omissions show limits, but there is no evidence that a different ordering would have produced fewer defects or less work. |
| Did it save money or finish sooner? | **Not determinable from this run.** There is no matched implementation without the scaffold, and elapsed time is heavily confounded. |

## Recommendations for the next run

1. **[template/definition] Keep the provisional typed scaffold and independent positive/negative compiler review.** They found concrete errors at useful boundaries.
2. **[template/definition] Add a small executable path before contract freeze:** declaration → parsing → selected handler → guidance → response → delivery. Exercise one real host, a refusal, a value whose identity must survive, and every advertised filesystem capability. This would target the retention and copying gaps directly.
3. **[planning-skill] Freeze proven core boundaries and document semantic obligations.** Specify ownership, whether values may be copied, acquisition/release order, and failure behavior. Retain an explicit amendment path for facts discovered during implementation.
4. **[template/definition] Require tests through public imports for cross-module compositions.** In particular, test `hint` → `renderInvocation`, real-host use of the testkit, and writer → decoder agreement. A private repair helper should not substitute for a working public contract.
5. **[planning-skill] Measure interface revisions separately from infrastructure waits.** For a future comparison, retain initial/frozen/final contract snapshots, reasons for amendments, and implementation/review costs. Compare similar scope and model settings before claiming savings.

These recommendations refine the existing improvement report's contract-freeze, integration-sweep, and ownership proposals (§1.3, §2.4, §5.1–5.2), especially its “test-locked contracts before fan-out” principle. This audit supports adding executable evidence before freezing; it does not establish a need for another orchestration mechanism. See [graph-workflow-improvement-report.md](../graph-workflow-improvement-report.md).

## Evidence and reproduction

Audit performed read-only against execution state, transcripts, and the named project worktree; only audit artifacts were written in the audit session. No implementation changes or fresh target-project validation runs were made.

- **E — deterministic extractor:** `bun run workflow:audit -- --execution 117f1dc7-1032-4aa3-a838-93ea24cb3ed7 --json`. Captured locally in `.cc/temp/interface-audit/extraction.json`; markdown alongside it. Figures use its corrected costs, with the explicit timing corrections above. Codex cumulative token counters do not measure context occupancy.
- **J — archived execution and lifecycle:** read-only `graph_workflow_archived_executions.execution_json` and `graph_workflow_events` for the execution; `~/Library/Application Support/cc/workflow-logs/117f1dc7-1032-4aa3-a838-93ea24cb3ed7/`. Snapshot captured in `.cc/temp/interface-audit/execution.json`. Context validation timestamps and issues are retained in the extractor.
- **G — git evidence:** `/Users/alex/github/cli-for-agents/.worktrees/initial-design-implementation-08a934`, revisions `71e8331`, `42accbf`, `551ad98`, and `9f6d22f`. The complete baseline-to-delivery diff is 196 files, +19,989/−749 lines. The extractor's 11-file publish diff describes only the last publication commit, not the whole implementation. Signature comparison artifacts are under `.cc/temp/interface-audit/`.
- **Transcripts:** `~/Library/Application Support/cc/transcripts/<UUID>.jsonl`. Seq references are zero-based physical JSONL coordinates; use `cctl conversation read <UUID> --seq-range A:B` for bounded retrieval.

| Key | Conversation UUID | Role |
| --- | --- | --- |
| P | `8fb1e2e6-d258-4cbd-8cea-a3bd2c5d39c6` | Scaffold, planning, troubleshooting, final review |
| R | `eb9d2da9-4523-40f3-9bf9-2dc917b073a2` | Independent interface review and census |
| I | `73c2cbdc-610b-4d99-a119-d99ba661e16d` | Input/family contracts |
| B | `7a0aaf2f-34de-4b98-8914-32a612854720` | Runner/response contracts |
| Q | `5f1fde08-bbfe-44b5-af74-8b26f37ebe98` | Baseline preparation questions |
| H | `ef2a1cf4-577a-4bc0-a0ab-2f381a3d5db7` | Help/reference implementation |
| A | `f225a233-e3b9-4758-9ba4-830350fd60bb` | Artifact delivery and retention decision |
| C | `ca36b33e-4c7e-4f2e-817c-370ffc94141b` | Runtime composition |
| L | `736d2110-bc4f-441b-9212-d99fc77728b8` | Local pilot |
| F | `84eb1ab3-52b1-4c4b-b752-3aa9d3dab8ce` | Final verification |
