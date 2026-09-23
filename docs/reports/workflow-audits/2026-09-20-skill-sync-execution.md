# Workflow audit — Implement skill-sync in ReScript

Execution `beac065a-6731-42eb-96ab-57a5e169c1ac` · skill-sync · 2026-09-20

## Verdict

This run produced a substantial, reviewed partial implementation, but has not delivered the requested CLI. It recorded **$297.35 across 14 lane conversations** over **9h 1m 53s before the operator pause**: six contexts completed, instructions remained under repair, and ten contexts had not started. The cost is a floor because automatic plan repair and the interrupted final turn are not priced in that total.

The main problem was expensive convergence on a broad contract, especially filesystem identity and publication accounting. Review caught real data-loss and compatibility defects; removing it would have made the result worse. The highest-leverage change is to settle a smaller first delivery and its safety guarantees before execution, proving those guarantees through a working CLI journey before expanding them into general infrastructure and many sequential gates.

This is an audit of a paused run, not a release assessment. The companion [complexity-origins report](2026-09-20-skill-sync-complexity-origins.md) traces the earlier specification and planning decisions. This report independently checks execution telemetry and sampled work-product evidence; it does not adopt that companion's numerical claims without verification.

## What worked — preserve these

- **Independent review prevented destructive behavior.** Skill-spine's first rejection caught an edited `Review` directory being replaced through the case-equivalent target `review` without override. Instructions review caught existing counterparts hidden by destination ignore rules being overwritten as supposedly missing files. These are ordinary conflict-protection failures, not optional hardening. Later verdicts confirmed the respective repairs. [V:skill-spine, V:instructions]
- **Review distinguished local obligations from downstream work.** Store's production composition and process-kill evidence were explicitly deferred to their named owners. The production fault-injection environment variable was repeatedly reported as a nonblocking downstream concern rather than forcing premature packaging work. This preserved useful context boundaries, although the repeated advisory exposed a missing concrete removal task. [V:bounded-store; S:planRepairRounds/1]
- **Implementers produced real behavioral evidence.** The instructions transcript shows four isolated reversions making the relevant regression tests fail, restoration of the implementation, a passing 22-file suite, and subsequent production-bin probes. The claim that those tests detect the repaired defects is supported by tool results, not only by the handoff. [T:instructions L7407–7414, L7431–7437, L7549 onward]
- **Implementers could challenge individual findings.** The agents implementer used native-loader probes to reject the claim that Codex refuses an explicit `type = "stdio"`, while fixing the valid parts of the same MCP issue. Preserve this evidence-based partial rejection. [T:agents L6283, L6335, L6951, L7280]
- **Recovery was fast and preserved completed work.** Both circuit-breaker episodes were followed by automatic plan repair and successful continuation in the same implementation lane. Their combined halt-to-resume interval was only 5m 42s. There is no evidence that these episodes waited meaningfully for a human. [L L18–25, L54–61; S:planRepairRounds]
- **The basic orchestration stayed healthy.** All 27 validator invocations produced structured-output verdicts; the reached contexts used one implementer prompt cycle per iteration, with no unfinished-task re-prompt spiral. The extractor counted only 10 errored tool results among 1,213 implementer tool calls. No merge conflict, infrastructure halt, hung turn, or compaction was detected in this run. [E; V]

## Friction, ranked by quality impact

### 1. The reviewed contract became more elaborate while implementation chased its edge cases

`bounded-store` and `sync-policies` each needed six iterations and five NO-GOs. Together they account for **$110.18**, including their reviewers, and ten of the eighteen rejections. That is hotspot spend, not an estimate of wasted dollars. [E]

Store's initial defects included real boundary escapes, unsafe replacement shapes, and missed collision preflight. Later rounds increasingly concerned the exact distinction between `NotPublished`, `Partial`, `Complete`, and `Unknown`: spent empty batches, errors after the final rename, directory creation before a failed publication, and failed metadata probes. Automatic repair expanded the short “truthful publication state” criterion into detailed accounting rules and prescribed a centralized model. The next rejection then enforced the new blanket rule that failed metadata probes produce `Unknown`. [V:bounded-store rounds 1–5; S:launchDocument versus workingDefinition, criterion `effect-outcome`]

Sync-policy review similarly moved from a genuine case-folded nested-boundary bug through Unicode normalization, absent-path uncertainty, and disagreement between Native's identity model and Store's claim comparison. Repair added a task to unify that authority across modules. Some churn was plainly introduced by implementation: unconditional NFC normalization broke mirror and drift on filesystems that distinguish the spellings, and the later shared-identity repair introduced an asymmetric containment check. The implementer acknowledged both errors. [V:sync-policies; S:planRepairRounds/2; T:sync-policies L7758, L11412]

**Assessment:** many findings were correct against the approved contract. The defect is not “validators were too strict.” The workflow made agents discover and reconcile foundational semantics through repeated rejection, and repair consistently chose to strengthen the contract. The stated envelope is one local operator, one writer, and regenerable selected output; unrelated settings and overwrite protection still matter. That envelope deserved an explicit proportionality decision about the additional identity and accounting machinery before execution.

The repair diagnosis calls the four-failure breaker and twenty-iteration ceiling contradictory. They are different controls and need not be equal. Their configuration did trigger diagnosis early in this run; raising the breaker enabled completion but did not reduce the underlying work.

**Change:** [planning-skill] specify concrete failure examples and one owner for destination identity and publication outcomes at the first working skill journey. Use the existing plan review to challenge guarantees that exceed the operating envelope. Any reduction to the approved behavior needs a revised, approved contract; it is not permission for implementers to ignore findings.

### 2. There was no deterministic completion gate

All seventeen contexts have `scriptValidator.commands: []`, and telemetry records no script-gate runs. The instructions validator prompt explicitly says it must not fail the context for test, type, lint, build, or compile failures and must not run those checks itself. [S:workingDefinition; V:instructions `context-validator.md` L475–480]

Implementers did run builds and tests, so this is **not evidence of untested code**. It means a GO was not mechanically bound to successful deterministic checks on the candidate. The green instructions suite also did not catch the next discovery regression: the directory-symlink repair excluded ordinary directories named `CLAUDE.md` or `AGENTS.md`. The next reviewer caught that defect by reading the code. [V:instructions round 2; T:instructions L7437]

**Change:** [template/definition] after toolchain setup creates runnable wrappers, register and select a cheap build plus relevant behavioral tests before agent review. Keep judgment about semantics with the reviewer. This directly reinforces improvement-report §3.5; adding another reviewer is unnecessary.

### 3. The shared implementation concentrated unrelated journeys into the same editing surface

The recorded code shows Native containing skill and agent conversion, destination identity, instruction discovery, ignore-rule evaluation, inventory, comparison, and rendering. Instructions then changed Store's traversal predicate, added occupancy probing, and rewired Sync despite those owners already having passed earlier gates. Its second repair broadened a symlink exclusion into an ordinary-directory exclusion; the third attempt changed the traversal contract again to distinguish candidate kinds. [T:instructions L3556–4001, L6875–7308, L8430–8478; V:instructions recorded code]

The four-owner design gives useful public responsibilities, but public owners do not require all their private behavior to live in one large source file. The serial graph and shared editing surface reinforce each other. A local GO cannot certify downstream extensions to these common modules.

**Change:** [template/definition] keep the public owners while separating private content-specific implementations where that makes dependencies explicit. Review shared-interface changes against their existing callers. Enable parallel content work only after there are disjoint implementation surfaces; deleting dependency edges now would introduce contention. This aligns with improvement-report §§5.1–5.2.

### 4. Agents conversion mixed real semantic defects with a faulty review claim and contract ambiguity

Agents was the largest cost center: **$70.26**, four implementer iterations, and three rejections. Missing MCP shape/duplicate handling, Codex identity normalization, and restriction-specific diagnostics were substantive implementation defects. But the first MCP issue also claimed Codex rejects `type = "stdio"`; recorded loader probes contradicted that subclaim, and the implementer declined it. [E; V:agents round 1; T:agents L6283, L6335, L6951]

The same review asked inspection to compare loader-effective descriptions, despite the pinned design's direct-description mapping. The implementer generalized normalization to descriptions, Claude names, and literal MCP IDs. The next review rejected that overreach; the following iteration restored direct mapping and recorded that the earlier probes had not established description equivalence. Finally, review caught padded source names that generated successfully but failed repeat pairing under Codex's normalized identity. The final repair refused those cases before writes, and the transcript shows ordinary sync, repeat-sync, and inspection succeeding with description whitespace preserved. [S:pinned spec “Agents”; V:agents rounds 1–3; T:agents L7280, L7636, L8713, L9038]

**Assessment:** the final scoped GO has credible runtime support. The churn has mixed ownership: incorrect or conflicting review guidance, an overly broad implementer repair, and a missing decision about source identities that the destination normalizes. It should not all be attributed to either agent.

**Change:** [planning-skill] agree on a small table of source-specific normalization, equality, repeat pairing, and unsupported-setting examples before implementing a mapping. Reuse it across conversion, inspection, and lint. Reviewers should separate loader facts from interpretations of the approved behavior, and implementers should challenge only the disputed part of a bundled finding. This applies improvement-report §§1.6 and 2.1 without adding another review gate.

### 5. Ownership context dominated prompts, including follow-ups

The 25 saved implementer prompts contain **1,969,193 UTF-8 bytes**; **1,633,528 bytes (82.95%)** are the repeated spec-ownership prefix, including the full cross-context claims table and context index. Even follow-ups in the same conversation repeat it. The instructions seed names its own claims link near the top, then includes all contexts' claims before reaching its work. [P; telemetry `promptFiles`]

This is prompt volume, not token count or a dollar-savings estimate. Caching affects its price, and these logs do not isolate the attention or billing cost of that section. The measured Claude implementer peak was 652,768 of a 1,000,000-token window (65.3%); no compaction was observed. Codex validator occupancy remains unmeasurable. There is no evidence here that a context overflow caused the defects.

**Change:** [engine] inject the active context's claims, its shared contracts, and relevant downstream deferrals, with a stable link to the full immutable table. Follow-ups should carry changed findings and tasks rather than the entire table. Preserve authority and traceability while reducing repeated payload.

### 6. The pause interrupted verification of the final repair

At 16:04:54 UTC the instructions reviewer rejected pruning ordinary directories named like instruction files. The implementer acknowledged the defect, changed the candidate-kind interface, compiled successfully, added a regression, and launched the full suite. The operator pause at 16:08:01 terminated that test task. There is no terminal test result or GO for this repair. [T:instructions L8430–8481; L L79–80]

The extractor reports zero background-task kills because this termination appears as a `notice`, not the system-event shape it counts. It also reports the instructions conversation's last completed billing result, which precedes this interrupted turn.

**Change:** [engine] include notice-form terminations and unfinished billed-work intervals in audit confidence reporting. On resumption, verify the current candidate and rerun the interrupted check before accepting instructions. This is a closeout obligation, not evidence that the paused repair is wrong.

## Work-product assessment

The recorded implementation follows several valuable design choices: explicit direction, source-specific conversion, byte-preserved instruction content, one expected-output comparison path, and a separate Store publication boundary. Review evidence supports usable project/user skill and agent paths within their scoped criteria. It also demonstrates why a passing local suite alone was insufficient: source discovery, physical destination occupancy, and filesystem identity interact in ways that individual tests initially missed.

The completed contexts have commit snapshots through agents at `5bd90c1`; instructions has no completed context snapshot. There is **no final-publish result**. Hooks, plugin delivery, failure-recovery closeout, remaining automation/result work, package distribution, and final journey evidence are pending. Linux execution and package-install completion therefore must not be inferred from the local passes.

The future hook contract also deserves a product-value check before paying for its remaining contexts: the pinned design supports a deliberately narrow payload-independent command grammar, including neutral commands and a fixed plugin marker. A faithful implementation could pass while omitting many hooks a user actually wants to transfer. That is a scope/value decision, not an observed implementation defect in this run; hook work has not started. [S:pinned spec, “safe command subset”]

This assessment uses recorded diffs, source listings, tool results, and validator findings. It does not claim a fresh checkout review or a live execution of the product. No other worktree was entered during the audit.

## Cost

| Context | Implementer | Validator | Recorded total | Iterations | NO-GOs |
|---|---:|---:|---:|---:|---:|
| Toolchain/contracts | $13.99 | $1.73 | $15.71 | 1 | 0 |
| Bounded Store | $50.13 | $8.44 | $58.57 | 6 | 5 |
| Skill spine | $25.18 | $4.25 | $29.43 | 2 | 1 |
| Skill compatibility | $33.90 | $3.02 | $36.92 | 3 | 2 |
| Sync policies | $43.41 | $8.20 | $51.61 | 6 | 5 |
| Agents | $59.07 | $11.19 | $70.26 | 4 | 3 |
| Instructions, paused | $31.50 | $3.34 | $34.84 | 3 started | 2 |
| **Total** | **$257.19** | **$40.17** | **$297.35** | **25 started** | **18** |

Totals use unrounded values; displayed cells can differ by a cent when added. These are seven implementer and seven validator conversations. Implementer lineage totals match the stored costs; validator costs come from the conversation rows because the ordinary validator conversation transcripts do not carry billing result records. Detailed review activity is in the separate validator transcripts.

The total excludes earlier specification/planning work, this audit, unpriced automatic repair calls, and any unreported cost from the interrupted final turn. Both repair IDs have diagnostic transcripts but no conversation billing row. Do not quote $297.35 as the complete project bill.

The clearest avoidable work is repeated repair of inconsistent identity/accounting rules, full-ownership reinjection, and repairing mistakes introduced by a prior fix. There is no defensible exact waste subtotal: those conversations also delivered required functionality. No per-iteration dollar allocation is inferred from conversation totals.

There were 27 review rounds: eighteen NO-GOs and nine GOs. Three GOs were recertifications after advisory-response edits changed the candidate tree, in toolchain, skill-spine, and agents. These are not nine completed contexts and not duplicate verdict events. Rechecking a changed candidate is sound; any optimization must preserve that guarantee. [V:advisory_response.recertification_required]

## Time

| Measurement | Duration | Meaning |
|---|---:|---|
| Start to operator pause | **9h 1m 53s** | 07:06:07.799–16:08:01.223 UTC |
| Implementer prompt intervals | 6h 47m 53s | Includes the interrupted final turn and about two seconds of pause drain |
| Validator invocation intervals | 2h 1m 47s | All 27 invocations |
| Automatic plan repair | 5m 42s | Both recorded repair calls; overlaps the reported halt-recovery windows |
| Remaining interval | 6m 34s | Setup, transitions, advisory-response work and other time outside the above intervals |
| Configured approval/question wait | 0 | No such waits recorded for this execution |

The residual is computed from a clipped union of intervals, not by treating parallel duration sums as elapsed time. It is not established scheduler dead time. The extractor's ten longest event gaps are covered by agent work; there is no evidence of a long unexplained stall. The open-ended calendar pause after 16:08 is excluded.

All seventeen contexts form one dependency chain in one lane. Although telemetry reports concurrency capacity eight, every ready set contains one context. The engine ran the graph it was given. A reviewed skill spine arrived at 10:30, more than three hours after launch; the initial foundation and Store came first. Independent compatibility research or fixture preparation could have overlapped implementation, but the current common-module edits do not support a credible parallel speedup estimate. [L:scheduler.ready_set; S:workingDefinition.edges]

## Recommendations

1. **[planning-skill / template] Make the first delivery and its safety bar explicit.** Keep conflict protection, containment, inert inputs, and unrelated-setting preservation. Price the extra publication/identity guarantees against the local operating envelope before making them blockers. Prove the chosen contract through a working skill journey. Reuse the existing plan review rather than adding another gate. Related: improvement-report §§1.6, 2.3, 2.7.
2. **[template/definition] Add deterministic gates once wrappers exist.** Bind build and relevant tests to the candidate before agent review. Related: §3.5.
3. **[planning-skill] Repair causes with both ownership and scope in view.** The shared identity repair was useful; “stronger criteria plus a larger breaker” should not be the only repair outcome considered. A broader product obligation should return to its approval boundary. Related: §§2.1, 4.5, 4.7.
4. **[engine] Scope ownership injection to the active work.** Retain immutable full claims by reference and send only relevant claims and changes inline. This run supplies a measured repeat of the existing prompt-volume problem.
5. **[template/definition] Separate content internals before increasing concurrency.** Preserve the four public owners and assign explicit shared-interface responsibility. Related: §§5.1–5.2.
6. **[engine] Correct audit coverage.** Attribute automatic repair separately from human recovery; include unfinished billing and notice-form task termination; report Claude occupancy independently of unmeasurable Codex lanes. These corrections are reporting improvements, not reasons to rerun the implementation.

These refer to [the existing improvement report](../graph-workflow-improvement-report.md) as proposal alignments, not claims about whether those proposals are currently implemented. No workflow, product code, specification, or global guidance was changed by this audit.

## Evidence and reproducibility

The adjacent [telemetry snapshot](2026-09-20-skill-sync-execution.telemetry.json) records the derived counts, costs, timing intervals, prompt byte measurements, source paths, and measurement limits.

- **E:** `bun run workflow:audit -- --execution beac065a-6731-42eb-96ab-57a5e169c1ac --json`, extracted before transcript reading.
- **S:** the execution returned by `cctl workflow status <id> --full --json` using the skill-sync project/session reference. It includes the original launch document, current definition, pinned seeded spec, repairs, and commit snapshots. Initial/current task counts are 52/54; both definitions have 17 contexts and 135 context criteria.
- **L:** `~/Library/Application Support/cc/workflow-logs/beac065a-6731-42eb-96ab-57a5e169c1ac/lifecycle.jsonl`.
- **V:context:** that log directory's `contexts/<context>/validation.jsonl` and `validators/general/validation-transcript.jsonl`; verdict text is also in E. Round numbers mean successive `validation_round.opened` records.
- **P:** `contexts/*/prompts/iteration-*.md`, including follow-up files. Ownership-prefix measurement ends before `# Workflow Charter` for seeds and `You still have` for follow-ups.
- **T:instructions:** `~/Library/Application Support/cc/transcripts/4ac0142c-1544-4b89-8177-83cd50af984c.jsonl`. `L` references on transcripts mean physical newline-delimited records, not rendered message numbers.
- **T:sync-policies:** `~/Library/Application Support/cc/transcripts/f7ea3eba-1d0b-4666-92e9-8685efc8c4ed.jsonl`.
- **T:agents:** `~/Library/Application Support/cc/transcripts/f74d294a-608e-4262-a725-c2f65b98b828.jsonl`.

Two independent bounded deep-reads covered Store/sync-policy and agents hotspots. Their interpretations were treated as hypotheses; the figures above come from the extractor, execution state, or primary logs. SQLite checks used read-only connections. Scratch extraction and calculations are under `.cc/temp/skill-sync-audit/` in this audit worktree.
