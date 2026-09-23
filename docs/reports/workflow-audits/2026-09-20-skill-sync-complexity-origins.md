# Complexity origins: skill-sync (execution beac065a-6731-42eb-96ab-57a5e169c1ac)

Companion to the workflow audit of the same execution. This report traces every layer of complexity in the skill-sync build back to the phase and actor that introduced it, and separates what Alex asked for from what was added on top.

Sources: ticket skill-sync#1; SDD conversation 693b8fc0 (intent seq 60 to 651, envelope 1099 to 1306, requirements 1663 to 2269, reviews 2275 and 5580, design 3792 to 5514, simplification 8041, delivery 9406 to 12247); spec revision 8 rendered; workflow definition 3454f6ea revision 2; execution workflow-logs and plan-repair events; two implementer transcript deep-reads.

## How it grew

| Stage | Author | Size | Obligations |
|---|---|---|---|
| Ticket skill-sync#1 | Alex | 1,949 words | 8 requirement groups, 11 acceptance criteria, 7 open items |
| Interview answers | Alex | 8 answers | 5 envelope rows, 3 requirement choices |
| Intent (spec sections) | agent | about 830 words | Same scope as the ticket; appetite stated as the whole ticket |
| Requirements rev 1 to 7 | agent, one review | 9,333 words | 16 requirements, 91 then 96 criteria, each with a validation strategy |
| Design rev 3 to 8 | agent, one review | 13,878 words | 7 decisions, 4 owners, 11 internal contracts, closed hook matrix, verification table |
| Workflow definition rev 2 | agent, one review | 7,841 words | 17 serial contexts, 52 tasks, 135 criteria, 5 invariants, 6 conventions, 25 seeded documents |
| Execution, 7 of 17 contexts | implementers, validators, repair | 23,732 lines | 9,596 source, 11,235 test, 2,474 evidence prose; 27 validation rounds, 18 NO-GO |

Total spec text at revision 8 is 24,078 words against a 1,949-word ticket.

## Complexity caused by Alex's direct instructions and decisions

**Breadth, from the ticket.** Four content types, both directions, project, user and explicit-plugin scope, sync plus inspect plus lint, destination plugin packaging, a version-aware compatibility matrix, documentation, tests, and unattended use with documented exit statuses. Every later phase multiplied its work by this matrix. This is the root of the total size, and it was requested.

**Semantics in the ticket that require real machinery.**
- Inspection compares against expected converted output, not a raw diff (ticket section 6). A full conversion must therefore run for inspect and lint, which is why Native ended up shared by all three actions.
- Whole-directory skill replacement plus a separate exact-mirror mode (section 7).
- Whole hook-collection replacement that preserves unrelated settings (sections 5 and 7). This is the origin of shared-document editing.
- Omit-and-warn for every unsupported feature, symmetric lint, and the rule to distinguish executable directives from shell examples (section 4).
- "Establish a documented, version-aware compatibility matrix against official product behavior. Do not assume that similarly named features have identical semantics." This sentence is the seed of the verified-equivalents-only discipline that later produced the closed hook matrix and the native-loader proofs.

**Interview choices.** macOS and Linux (led to separate per-platform evidence and case-sensitivity concerns); standalone inspect and lint for agents and hooks (the agent marked this option recommended); per-agent override with optional mirror (also marked recommended); exact byte copy for instructions.

**ReScript** (seq 3732, repeated at 5535). Added the toolchain context, the binding modules (NodeFs, NodeToml, NodeIgnore), a ReScript test harness, and a feasibility spike. The toolchain context alone is 1,840 source lines.

**"Use the software-design-philosophy skill" for design** (seq 3539). This produced the four-deep-owner architecture, the eleven canonical contracts, and a self-assessed 7.5 of 10 score on deep-module diagnostics. Nothing in that rubric scores proportionality.

**Ratified reviews.** "update the spec" (seq 2999) accepted the requirements review, adding R14.7 to R14.10. "update the design" (seq 6656) accepted design-review findings F1 to F8. Each gate was signed off in Spec Studio.

**The one subtraction.** Byte-preserved skill bodies with warnings only (seq 8041) removed the directive-rewriting subsystem. It was the only reduction in the whole flow.

## Complexity added beyond what those instructions required

| Mechanism | Entered at | What Alex asked | Assessment |
|---|---|---|---|
| Filesystem hardening tier: safe-link materialization, hard-link identity, special-file rejection, EACCES distinct from ENOENT, case-aware and Unicode-aware path identity, single-use prepared batch | Envelope "hostile data" row; R14.4 and R14.5; design "Path and file safety"; bounded-store and sync-policies criteria | Nothing. The ticket never mentions symlinks, case, Unicode or error classes | Overbuilt for one user on a local disk. Ten of eighteen NO-GO verdicts |
| Four-state publication outcome with "truthful" accounting | Design ApplyOutcome; bounded-store effect-outcome; plan repair | "Documented exit statuses and clear diagnostics" | Overbuilt. Temp-plus-rename needs no ledger |
| Per-document atomic writes with interruption and kill proofs | Requirements review finding 1, ratified; R14.9 and R14.10; failure-recovery context | Preserve unrelated settings | The write pattern is cheap and sensible. The interruption proofs, fault seam and kill evidence are not |
| Token-preserving JSON and TOML range edits, including large integers and date precision | Design D7 | Preserve unrelated settings | Partly needed; the precision guarantees are beyond the ask |
| Agent-local stdio MCP server mapping | Design "Agents" section; agents context criterion | "Translate settings when an equivalent exists"; MCP never named | Scope creep. Part of three agents NO-GO rounds |
| Hook static command grammar accepting only no-op scripts, canonical matcher spellings, logical script path, quoting rules, machine-specific absolute paths | Design hooks section; review F1 | "Native equivalents only; report unverified" | Overbuilt: proves compatibility only for scripts that do nothing |
| Status precedence law, six-value comparison JSON, schema version | R15.6; design result semantics via review F3 | "Documented exit statuses" | Overbuilt |
| Explicit-root precedence over config-home variables; hook-index flags | Design CLI section | Not asked | Scope creep. Removing the hook-index flags was the one design-review finding rejected |
| Native-loader verification for every discovery claim; separate macOS and Linux evidence with NO-GO if unexercised; packed-tarball install in an unrelated repository | Validation-strategy boilerplate on 91 of 96 criteria; design verification table; plan review item 2 | "Tests exercise the behavioral contracts" | Proof obligations well beyond the ask |
| Fault-injection seam and process-kill proofs | Design verification table; bounded-store task text | Not asked | Overbuilt. The seam violated a downstream criterion and drew five advisories |
| 17 serial contexts, 135 criteria (22 with no spec mapping), 25 seeded documents, per-context evidence documents, red-green single-file conventions, heap-pinned harness | Planning | Not asked | Proof machinery; 2,474 lines of evidence prose and 11,235 test lines for 9,596 source lines |
| Unicode NFC normalization, three-valued identity model, shared path-identity authority | Implementer iteration 2; plan repair | Not asked | Scope creep at execution time; about $18 of repair-segment spend |

## Phase by phase

### Alex's instructions to intent

Carried forward: the whole ticket. Added: the appetite sentence "No calendar, staffing, or cost budget was supplied; this brief does not invent one or reduce the ticket to skills alone", a general "developers" audience written before the envelope existed, and an open-choices list. The envelope correctly excluded services, locks, transactions, backups, network destinations and large batches. It also added the trust row "imported repositories and plugin files can contain malformed or hostile data", meant as do-not-execute, and the caveat that regenerable output "does not relax conflict protection, explicit replacement/deletion boundaries, or preservation of unrelated settings". The interview asked five envelope questions and none about a version-one cut or a hardening level. No mechanism was added in this phase. The one thing it could have done, propose a smaller first version, it explicitly declined.

### Intent to Requirements

Carried: ticket sections 1 to 8 map almost one to one onto R1 to R13. Added by the requirements agent: config-home overrides (R2.4); ancestor and descendant collection isolation (R2.6); identity collision errors before writes (R4.6); whole-run preflight before any write (R8.4); per-path units for support files outside a skill (R8.5); input and boundary hardening including symlink and alias rejection (R14.1 to R14.6); six status-class criteria with a precedence order (R15); four documentation criteria (R16); and a validation-strategy sentence on 91 of 96 criteria requiring real CLI fixtures and a native-loader check for any discovery claim. Added by the review and ratified: partial-progress reporting, override recovery and per-document atomicity (R14.7 to R14.10), separate per-platform evidence, and the nested-collection clarification. Criteria went 91 to 96; words went 1,949 to 9,333. Six of seven review findings were accepted; all were additive.

### Requirements to Design

Carried: all 96 criteria unchanged. Added: D1 ReScript (Alex's); D2 four owners and eleven contracts (the software-design-philosophy framing); D3 stateless invocation (a good exclusion); D4 one conversion behind sync, inspect and lint (follows from the ticket); D5 verified native mappings, which brought the closed hook matrix, the no-op script grammar, MCP stdio mapping, underscore-name rejection, BOM handling, description defaults and the reserved openai.yaml policy; D6 whole-selection preflight; D7 span-editing of shared documents with temp-plus-rename. The "Path and file safety" section added canonical roots, nearest-ancestor resolution, safe-link materialization, hard-link identity, special-file rejection, "comparisons are case-aware for the actual destination filesystem", and the only-ENOENT-means-absence rule. ApplyOutcome gained four publication states. The verification table added loader checks, separate OS evidence, fault injection with process termination, and a packed install. The design review accepted eight of nine findings, all of which pinned more behavior; the one rejected finding was the one simplification. Alex's body-preservation change is the only reduction. Design text is 13,878 words on top of the requirements.

### Design to graph workflow definition

Carried: 96 criteria mapped to 13 contexts through the claims table. Added: four contexts owning no spec criterion at all (toolchain-contracts, bounded-store, hook-conversion, journey-closeout; 22 plan-authored criteria), plus 39 further plan criteria restating spec ones in production-path and evidence terms, for 135 in total. Task instructions added the fault seam, a docs/evidence file per context, red-green loops on single test files, a heap-pinned harness, a publication allow-list and nearest-ancestor resolution. The charter added five invariants (including bounded-local-operation and honest-runtime-evidence) and six conventions. Twenty-five documents were seeded. The graph is strictly serial with Store placed before the first working journey, has no script gate, and pairs a breaker threshold of four with a twenty-iteration budget. The plan review's six findings were all accepted: cli-automation split into three contexts, separate OS records that fail when unexercised, six hook direction and scope cases, a separate R7.7 record, and a seeded fixture matrix. This phase added 7,841 words and turned 96 criteria into 17 sequential validation gates over 135 criteria.

### Definition to execution

Implementers added: unconditional Unicode NFC normalization in sync-policies iteration 2, which nothing had asked for and which cost three further rounds; a fault seam read from the production module through an environment variable, which contradicted a downstream criterion and drew five advisories; a three-valued identity model and a shared path-identity authority with Store rewired to it (repair-directed); a per-effect tally model for publication state (repair-directed); one Native.res of more than 3,600 lines; 2,474 lines of evidence prose rewritten every iteration; and 11,235 test lines against 9,596 source lines. Validators added, as readings of open-ended criteria under the pinned design: Unknown on any failed metadata probe, spent-batch semantics, directory-creation accounting, loader-effective trimming and literal MCP ids, reference-style link forms, and restriction-specific consequences for every Codex key. Plan repair added a 150-word effect-outcome rule, a Unicode-aware selection-preflight rule, a new unify-identity task, a breaker raised to eight, and a fault-seam removal task appended to failure-recovery. The result: 18 NO-GO verdicts, $297.35, and 23,732 lines for 7 of 17 contexts.

## Reading the trace

Alex's decisions set the multiplier: breadth, both platforms, ReScript, agents and hooks in inspect and lint, and a deep-module design philosophy. Almost every concrete mechanism that later failed validation was agent-originated: the hardening tier, the publication ledger, the hook grammar, the MCP mapping, the precedence law, the loader and platform proofs, the fault seam, and the plan's four spec-free contexts. Alex ratified most of these by accepting review dispositions and signing gates, and reduced scope exactly once. The largest single additions happened at two points: the requirements review plus design (hardening and proof obligations) and planning (proof machinery).
