# Evaluation of command-center#153

Evaluated on 2026-09-22 against worktree commit `fa2de91e7`, the ticket and its attachment, and selected original conversation entries. The evaluation below records that original proposal and its evidence. The implementation follow-up records the subsequent authorized work.

## Implementation follow-up — 2026-09-23

Alex deferred section 1 to a separate session and authorized the other fixes. Sections 2–5 are implemented in this worktree:

- Conversation identity uses ASCII-safe JSON. Local request-construction failures report that nothing was sent; actual transport loss retains its unknown-effect semantics. Invalid-header diagnostics omit header values, and log failures retain a bounded root cause.
- Upstream tickets `cli-for-agents#1` and `cli-for-agents#2` are complete. The deliberate library refresh consumes commit `7fd35c1215de1163e0d3acd30f628865063bff42`, including artifact-delivery and local-input diagnostics. No separate CC fallback or vendored-source patch was added.
- Status exposes current authoring revision, delivery pin, editable object guards, next actor, and review links. Plan read/write receipts agree on `payload.data.plan`. Human sign-off points to Builder. Structural validation, criteria mapping, and semantic review are labeled separately; portable references explain artifact contents with a parsing example.
- Approved Design amendments open in Design. Unchanged Requirements and delivery pins remain intact. Imported specs use their approved baseline when returning to Requirements without a separate checkpoint; unapproved Design edits are excluded. Integration testing also exposed a section-role conversion that could omit the Requirements gate; the existing diff owner now consults both the original and replacement roles.
- Delegation prompts disclose their lack of CC session credentials and the host's document-registration responsibility. Validation prompts and refusals explain frozen command selections and the existing live-edit recovery path. Portable setup guidance explains registration before launch.

Live verification found one adjacent receipt defect: fixture session names containing spaces produced invalid recovery identifiers after a successful write. Create/delete receipts now encode the identifier components while preserving displayed names.

Behavioral fixes have observed failing regressions followed by passing runs. Wording-only changes use existing contract checks. All final checks passed: combined changed-code tests with `--require-match` (`vrun-9a58336c-8f04-4d04-aeb5-ae917bce7db7`), full-project typecheck (`vrun-7c081b8c-1ce4-45f3-b499-eb9ae767d1f0`), changed-file lint (`vrun-e956b550-f6f7-435d-8d60-fe48aa348ee4`), architecture seams (`vrun-d9ddeec4-c7b2-4eb4-8d4a-2e283f75cbd9`), and formatting (`vrun-6665b930-1488-42b5-81ea-78474958caac`). The broad run also verified corrected legacy amendment setups and UI status fixtures; the latter now validate their base payload against the canonical response schema.

Live checks used the source CLI against the session server at `http://localhost:3002`, whose resolved database is this worktree's `.config/command-center.db`. With a Unicode-named fixture conversation, a disposable schema-example spec was imported, a delivery plan opened and exported, and Design amended, edited, proposed, and re-read. The read-back confirmed only human Design approval was outstanding, Requirements content was unchanged, the plan retained the original approved pin, and explicit JSON output declared `contains: data` with the same plan identity as the write receipt. This verifies real CLI/API identity and persistence; it does not claim a live workflow pause/resume or notification-delivery test.

A second live scenario reproduced the missing imported Requirements checkpoint refusal before its repair, then successfully returned to Requirements, changed the contract, proposed it, and re-read the human Requirements approval requirement. Its author withdrew the disposable proposal afterward.

All three fixture sessions were deleted and the unlaunched plan retired. The two disposable specs remain only in the isolated dev database as evidence. `plc-test-lab/retro153-live` still has its proposal: after deleting its authoring conversation, the server correctly refused withdrawal by a successor conversation. `retro153-import-return` has an editable draft. Local receipts are under `.cc/temp/retro153/`. No production workflow, human approval, or deployed build was changed.

Section 1 and the original evidence-dependent deferrals (export-to-edit convenience and new notification machinery) remain outside this implementation.

Consumer follow-up for `command-center#158`: the pinned refresh above already includes the requested upstream repairs. Expanded `src/cli/framework/local-input.test.ts` to cover invalid UTF-8, JSON line/column diagnostics, and preserved schema issue paths/messages in both formats; the focused run passed (`vrun-cfd67d0d-16be-4970-8b03-eba70be1b37e`, one matched file). Rebuilt the Node-targeted CLI with `bun run build:cli` and exercised all five acceptance cases in text and JSON against real local files: missing input, invalid UTF-8, malformed JSON, schema-invalid JSON, and a misplaced relative `--out`. All ten checks passed. Receipts are under `.cc/temp/retro153/ticket158-live/`; `summary.json` indexes the cases. No additional production parsing, retry, or envelope changes were needed.

The retrospective is credible and usefully distinguishes failures from protected lifecycle behavior. Its recommendations should be narrowed. Command Center already has bounded output fallback, schema examples, revision checks, approval carry-forward, and most of the state needed for a clearer interface. Improve those owners instead of adding a new control layer.

The linked complexity audit adds a more consequential lesson: making an expanding contract easier to administer does not make that contract worth building. Address proportionality when authoring Requirements, as well as operational friction in the CLI.

## Recommended changes

### 1. Question expensive obligations before they become requirements

**Accept a small guidance change.** In the existing Intent/Requirements handoff, make consequential additions visible: the present use case they serve, the cheaper supported behavior, and what remains unsupported. Recommend a smaller first version when warranted, while preserving explicit user scope until the user changes it. Apply the same comparison when a review introduces new behavior or proof obligations.

Suggested Requirements guidance:

> Before proposing, identify consequential guarantees added beyond the intent or explicit user decisions. Explain the current case each serves and the simpler alternative. Prefer a clearly bounded supported case over generalized handling when it meets the user's need. Keep optional additions separate from the proposed contract; do not silently narrow an explicit requirement.

Use a short paragraph for material additions, not a ledger for every criterion. Do not add a complexity score, mandatory new document, approval gate, or automated criterion-count budget. In delivery review and repair, distinguish a violated approved obligation from a proposal to strengthen it. The latter needs an explicit scope decision, not another implementer retry.

**Why:** the original operating envelope excluded hosted systems and concurrent writers but still allowed costly filesystem and evidence obligations. The original Requirements review response added interrupted-write integrity and separate platform evidence; the Design response added result semantics, contracts, and edge cases while rejecting flag removal. These are primary records of accumulating obligations, not proof that every addition was wrong. The linked audit's proportionality concern is supported, but blanket removal of integrity or compatibility checks is not.

**Owners:** portable `sdd-intent` and `sdd-requirements` skills, with the existing review process applying the rule. Preserve and reference current `sdd-design/references/design-outline.md` and `design-review.md`: they already require a simpler alternative and prefer narrowing/removing before adding. The current graph review and repository `review-response` skill also already weigh complexity. Avoid duplicating those instructions across more files.

**Verification:** on the next real proposal, check whether material additions are visible before approval and whether review can remove or narrow scope. Do not use pass rate or document size as a proxy for product fit.

### 2. Repair failures in the owners that already exist

**Accept these bounded fixes:**

| Failure | Smallest proposed repair | Owner and useful verification |
| --- | --- | --- |
| Unicode session name makes workflow controls fail before reaching the server | Serialize the existing conversation identity as ASCII-safe JSON, escaping non-ASCII code units. The existing JSON decoder already reconstructs the original name. | `src/lib/agent-gateway/conversation-identity.ts`; exercise real `Headers`, decoding, and principal verification with a non-ASCII session name. |
| Input errors can say only `KERNEL_INPUT`, with no issue | Preserve the file/input stage and a bounded parse/read error in the existing diagnostic. Keep ordinary schema issue paths. | Upstream `cli-for-agents` local-input module; missing file, malformed JSON, and valid JSON with an invalid draft shape. |
| Artifact failure loses its cause | Retain a bounded delivery-stage/cause diagnostic while preserving the primary error, mutation effect, and recovery identity. | Upstream `cli-for-agents` artifact delivery; a controlled artifact-write failure through its public runtime. |
| Log failure becomes uninformative when optional detail cannot be exported | Put a bounded root cause in the primary log error instead of storing it only in optional detail. | `src/cli/commands/logs/handlers.ts`; verify the root diagnostic survives failed detail delivery. |

The Unicode fix needs no new session identifiers, lookup registry, percent-decoding protocol, or migration. The current encoder produces raw JSON in an HTTP header. A read-only diagnostic using the current encoder rejected `skill-sync – planning`; ASCII-escaped JSON passed native `Headers` and the unchanged server decoder returned the original name. This establishes the local defect, not a live pause/resume success.

Also stop describing a known local request-construction failure as an unreachable server. Distinguish it before submission; retain unknown-effect treatment for actual transport loss. Do not attempt a general network-error taxonomy.

The historical artifact root causes remain unresolved. The attached log receipt already demonstrates a bounded fallback preserving the original classification. Adding another fallback or spill writer would duplicate functioning machinery. The reported spec-export failures and log `Invalid string length` may have different causes; reproduce each before selecting further behavioral changes.

Upstream library repairs should be made in that library and consumed through the repository's deliberate refresh procedure, not patched into a second CC implementation or directly maintained in generated vendored JavaScript.

Follow-up tracking (2026-09-23): `cli-for-agents#2` owns local input diagnostics; existing `cli-for-agents#1` owns artifact-delivery diagnostics. Both are linked to `command-center#153`.

### 3. Make existing status and receipts answer the next operational question

**Accept, reduced to presentation and projection changes.** Extend `cctl spec status` and align plan receipts around existing state. Lead with:

- The authoring phase and whether a draft is editable, proposed, or approved.
- The current delivery attempt and the approved revision it pins.
- The editable object and its own expected revision token.
- The next actor, the exact available action, and the relevant review link.

Disclose candidate hashes, historical snapshots, element versions, and other details when needed. Preserve the separate concurrency tokens; do not replace them with a universal token or another stored state model. Existing plan views already contain the attempt, pin, workflow revision, candidate, approval, Builder URL, and next act.

Fix these concrete inconsistencies together:

- After approved Requirements, say that `amend` opens the Design draft. Current status falls through to “Nothing is outstanding”; the stale-stage refusal says to amend and then advance, although the resulting Design draft cannot advance further. Keep `advance` for transitions it actually admits.
- Change `plan sign-off` help from “Request sign-off” to language describing its actual approval effect. Under human-required policy, the agent's handoff should name the human and Builder review URL. Do not direct an agent to a command it cannot use as if it merely files a request.
- Use one stable plan location, such as `payload.data.plan`, for reads and mutation receipts. Keep mutation-specific information alongside it and update first-party consumers together. Do not add dual-shape compatibility parsing or a new SDK.
- Explain artifact contents accurately in the existing read-envelope reference and one executable example: automatic JSON spill contains a response envelope; `--json --out` exports domain data when the original payload is inline; binary exports contain document bytes. Treat the existing `artifact.contains` discriminator as authoritative.
- Say “structurally valid” and describe coverage as criteria mapping. Show recorded semantic review separately; mechanical coverage does not establish complete wiring or sufficient evidence.

**Owners:** existing spec CLI projections and definitions, `authoring-review-projection.ts`, `delivery-plan-next-act.ts`, portable native authoring/CLI references. Reuse domain state owners; add no orchestration service or new approval request lifecycle.

**Verification:** walk the existing public command contracts through Requirements approval → Design draft and plan draft → proposal → human review. Check next actions, actor, token, and plan extraction in inline and artifact delivery. Proposal notification visibility remains an unverified historical question; a published change event alone does not prove a UI notification was delivered. Do not add notification machinery based on this incident alone.

### 4. Let an approved Design amend directly into Design

**Recommend as a deliberate policy simplification.** `amend` on approved Design should open a Design draft by default. Contract changes use the existing `return-to-requirements` action. This avoids a new command, stage selector, amendment mode, or separate unchanged-Requirements proof artifact.

Current code intentionally maps approved Design to Requirements, and its test expects that behavior. Related ticket #106 is closed but has no recorded disposition explaining why. Closure therefore establishes neither resolution nor a regression. This recommendation changes current lifecycle policy.

Reuse the existing baseline clone, stage restrictions, revision diff, and approval carry-forward. Unchanged Requirements should owe no new Requirements sign-off; changed Design decisions and the Design revision still pass their applicable approval gate. Existing delivery attempts remain pinned to their original approved revision: a corrected Design does not silently retarget them.

**Owner:** `src/lib/specs/transitions.ts` with the existing authoring/gate services.

**Verification:** amend an approved Design, change one decision, and prove that Requirements are unchanged and only the applicable Design approval is outstanding. Exercise attempts to edit/remove Requirements, convert section roles, and change citations. The write whitelist alone is insufficient evidence because upserts classify incoming payloads and citations have separate paths. Reuse the existing diff/gate check; add a narrow assertion only if these cases expose a gap. This deserves integration coverage, not a claimed one-line fix.

### 5. Explain delegation and validation boundaries at their point of use

**Accept documentation/disclosure changes; defer new runtime machinery.**

For `cctl agent`, document the actual current launch contract: the generic one-shot path does not receive an explicit CC session scope. Backend adapters clear ambient CC identity and restore scoped access only when the trusted caller provides it. Tell these delegates to return report files through `referenceDocuments`; successful structured output is already registered by the server. Avoid instructions that imply they should register their own report. Do not solve the historical incident by blindly inheriting parent credentials or assuming every delegation path has the same capability.

The reported successful and unsuccessful historical delegates need their launch paths/builds identified before calling the difference an environment regression. This generic scope-less path is also distinct from the stronger `isolated-one-shot` execution profile.

For validation, disclose that `all` means all registered commands when the execution role was resolved. An empty launch registry produces an empty frozen allowlist; later registrations must not silently broaden a running execution. The existing live-edit path can update it. Explain this in the validation prompt/refusal that exposes the disabled command, and link the existing project-setup bootstrap guidance. Where practical, establish canonical registrations before launching delivery. Local wrappers remain local evidence until registered and selected as CC gates.

**Owners:** `cc-cli/references/agents.md` and the `agent-runs/service.ts` prompt; `validation-prompt-section.ts` and existing portable `project-setup` guidance. Canonical-checkout wrapper behavior and its narrow development exception are already documented, so link and clarify rather than add another bootstrap system.

**Verification:** existing scoped/unscoped task and frozen-command tests retain their semantics; prompt/help examples accurately describe those paths. No automatic permission refresh, new capability framework, or blanket launch gate is warranted.

Start with the diagnostic and receipt repairs, alongside the short guidance changes. Make the Design amendment change separately so its approval semantics receive focused review. Export-to-edit and any deeper artifact redesign can wait for evidence that these repairs leave a material problem.

## What worked — preserve these

| Mechanism | Evidence and implication |
| --- | --- |
| Immutable approval provenance and delivery pins | The historical plan read/proposal receipts retain the same approved pin while recording the frozen candidate separately. The retrospective reports retiring the disproved attempt. Keep that distinction when improving status. |
| Unchanged-subject approval carry-forward | The original retrospective reports a focused Design reapproval after the BOM correction. Current gate logic compares with the nearest approved ancestor. Preserve reuse of unchanged approvals rather than flattening revision history. |
| Stale-write and stage protection | Both attached `advance` refusals report `not_applied` and an immutable/no-draft explanation. Repair the continuation guidance, not the refusal. |
| Structural checks plus substantive review | The ticket records gaps discovered after full criterion mapping. These answer different questions. Keep independent review and explicit wiring ownership, while assessing whether added proof obligations fit the scope. |
| Bounded output and schema examples | The failure receipt preserved its primary error; current schema examples derive from canonical schemas and have parsing tests. Improve cause retention and discovery instead of replacing these mechanisms. |

## Disposition of the remaining observations

| Observation | Classification | Disposition |
| --- | --- | --- |
| Missing outer draft `kind` | Agent input error | Preserve schema validation and existing examples. The empty-issues receipt does not prove ordinary missing-`kind` errors lose their path. |
| Incorrect native BOM premise | Research error | Keep evidence-based premise checks and approval correction. Do not add another generic review gate. |
| Searching huge single-line JSON | Agent read-method error | Use bounded projections and parse selected fields. No new search restriction is justified. |
| Re-proposal requested by the user | Insufficient evidence of notification failure | Check the actual UI handoff in future verification; do not infer a missed notification. |
| Desire for export-to-edit | Potential convenience, not the first repair | Existing schema examples and reads already help. Defer an exact write-payload projection until status/envelope fixes leave demonstrated reconstruction friction. Never silently treat verification exports as importable drafts. |

## Evidence, measurement, and limits

The attachment was mechanically inventoried: **six receipts**, comprising **four failed operations** and **two successful plan projections**. The failures comprise a log/artifact failure, an input-check failure, and two stage refusals. These are selected receipts, not a failure rate or a complete run inventory. The source input for the failed draft check and the artifact-writer exception causes are absent from that attachment.

**Quality:** evidence supports diagnostic, navigation, and transport defects; protected approval boundaries should remain. The linked audit supports evaluating the value of obligations before improving compliance with them.

**Cost:** no new dollar/token total or savings estimate is asserted. The linked audit's reported totals were not re-derived here and are not republished. The selected records show plausible sources of avoidable work, but cannot attribute their cost.

**Speed:** the Design amendment path adds an extra human handoff; clearer next actions should reduce recovery work. This evaluation does not measure agent time, human waiting, tooling waits, or dead air, and does not treat elapsed time as overhead. A full execution-cost audit is outside this proposal.

Historical conversation summaries were treated as claims. Selected original records were inspected to check the operating envelope and what reviewers actually recommended. Current behavior was assessed from source, with a read-only native-header diagnostic for the Unicode finding. Existing tests were inspected, not run. No product behavior, ticket state, live workflow, or approval was changed; this document is the only repository change. Test-first does not apply to this report-only task.

### Primary retrieval handles

- Ticket and later runtime finding: `cctl ticket get command-center#153`; `cctl ticket status-update get command-center#153 93f2dbab-63a7-490f-a620-796da9b6bc69`.
- Receipt attachment: `.cc/tickets/153/files/be4eee8d-9c15-446c-9160-b4c372413dc1-cctl-native-sdd-retrospective-evidence.json`.
- Related lifecycle ticket: `cctl ticket get command-center#106`.
- Linked audit: `cctl conversation entry get c1f07062-5a6b-4c58-883f-7fd57145009a 1`, `2`, and `2157` (each number is a separate invocation). Its quantified execution conclusions are not independently endorsed here.
- Original planning conversation: `cctl conversation entry get 693b8fc0-1a1b-4b2a-a0d9-39df959b5549 <seq>`: `1176` operating envelope; `2993` Requirements review response; `6650` Design review response; `13286` original retrospective.

### Source anchors at evaluation

- CLI input/artifact ownership: `.kiro/steering/cli.md:62`; `.yalc/cli-for-agents/dist/internal/local-input.js:94` and `:122`; `.yalc/cli-for-agents/dist/internal/artifacts.js:89`, `:108`, `:116`; `src/cli/commands/logs/handlers.ts:155`.
- Identity encoding and transport: `src/lib/agent-gateway/conversation-identity.ts:14`; `src/cli/transport.ts:48`, `:439`, `:553`; `src/lib/workflow-graph/request-principal.ts:73`.
- Plan shape and existing examples: `src/cli/commands/spec/native-plan.ts:209`; `native-write-delivery.ts:73`; `schema-documents.ts:401`; `schema.test.ts:385` (last three in the same directory).
- Lifecycle and continuation: `src/lib/specs/transitions.ts:308`; `transitions.test.ts:480`; `authoring-service.ts:2371`, `:2451`, `:3015`, `:3058`; `authoring-gates.ts:63`; `authoring-sequence.ts:107`; `authoring-review-projection.ts:933`; `route-handlers.ts:4180` (same specs directory).
- Sign-off and plan presentation: `src/cli/commands/spec/native-write-definitions.ts:906`; `src/lib/specs/route-handlers.ts:4885`; `delivery-plan-service.ts:1204`, `:1238`, `:1578`; `delivery-plan-next-act.ts:43`; `delivery-plan-views.ts:37`, `:115` (last three in the specs directory).
- Delegation: `src/lib/agent-runs/service.ts:208`, `:243`, `:374`; `src/lib/agent-backends/task.ts:23`; `src/lib/agent-backends/claude/task-runner.test.ts:231`.
- Validation snapshot: `src/lib/workflow-graph/execution-repository.ts:450`; `src/lib/validation/singleton.ts:329`; `singleton.test.ts:167`; `src/lib/workflows/edit-schemas.ts:423`; portable `project-setup/SKILL.md:133`.
- Proportionality guidance: `plugins/command-center/command-center/skills/sdd-requirements/SKILL.md:26`; `sdd-intent/SKILL.md:45`; `sdd-design/references/design-outline.md:22`; `sdd-design/references/design-review.md:36`; `graph-workflow-review/SKILL.md:37` (same portable skills root); `.agents/skills/review-response/SKILL.md:12`.
