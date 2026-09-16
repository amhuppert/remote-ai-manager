# Agent instruction audit — 2026-09-15

## Result

The audit found conflicting backend entry points, stale operational instructions, accidental approval gates, and duplicated reference material. The fixes align the project-owned instructions with the supplied Fable 5.1 and GPT-6 Astra prompting guides: clear outcomes, task-specific context, preserved authorization, proportionate verification, and one authoritative owner per rule.

The most consequential finding was `AGENTS.override.md`: Codex loaded an older, contradictory contract instead of the maintained `AGENTS.md`. It now routes to the same contract Claude reads through `CLAUDE.md`.

## Scope and method

Reviewed repository-owned root contracts, Cursor rules, Claude/Codex skills and agent definitions, Kiro steering and authoring templates, the Command Center plugin and its references, generated slash-command guidance, active application prompt sources, and the voice-context glossary. Inspected the historical notices in `agent-docs/` rather than treating their retired hotkey implementation as current guidance. Historical specifications, plans, reports, design exports, and captured copies of instruction files remain historical evidence, not new policy.

Used `writing-for-agents`, its skill-mechanics reference, `writing-great-skills`, and `skill-creator`. The model rubric came from the two files Alex supplied:

- `/Users/alex/github/my-ai-resources/agent-docs/fable-prompting-guide.md`
- `/Users/alex/github/my-ai-resources/agent-docs/gpt-6-astra-prompting-guide.md`

Checked disputed claims against current source, schemas, generated help contracts, and installed CLI help. Edits stayed in the assigned worktree; the supplied prompting guides and installed skill references were read-only. Installed managed-skill bundles and the running CC server were not rewritten.

## Findings and fixes

| Finding | Fix and evidence |
| --- | --- |
| **Conflicting root instructions reached different backends.** The tracked override retained unconditional stop-and-ask rules, contradictory comment preservation/removal rules, a nonexistent `memory-bank/focus.md` pointer, and automatic steering imports. | `AGENTS.override.md` now points to `AGENTS.md`. The shared contract explicitly covers initiative, existing authorization, bounded completion, delegation, and the relationship between skill guidance and user requests. |
| **Native SDD was missing from the maintained root contract.** Removing the override alone would have lost the human approval boundary. | Preserved native Requirements → Design → delivery planning, inventory lookup, configured artifact language, and human-only Spec Studio approvals in `AGENTS.md`; retained legacy governed-spec approvals. |
| **Validation guidance could claim a pass with no matching tests, repeat broad checks, or bypass registered validation.** | Root examples use `--json` and explicit-path `--require-match`; explain verdict recovery and trailing runner output. TDD details have one owner in engineering steering. Backend steering now uses registered seams/typecheck instead of a direct package script. |
| **The CLI skill loaded a 1,896-line manual for every CLI task.** | A short router retains shared identity, payload, refusal, and async handoff contracts. Command-family references load on demand. The command catalog remains generated, and its generator/checker now covers the split files. |
| **Setup and review skills introduced extra permission gates.** | Project/dev-server setup and review guidance respect the user's request and existing authorization. Consequential unresolved choices still reach the user. Actual CC ask/decision handoffs and Spec Studio gates remain mandatory. |
| **Backend-neutral prompts prescribed a Claude-only tool.** | Shared session/project context now qualifies `Bash.run_in_background` as Claude behavior. Other backends collect command completion using available tools and do not assume a yielded command schedules another turn. Project notifications route through `cctl notify`. |
| **Shared `/spec` guidance taught obsolete state and payload contracts.** | Canonical source and generated command now teach separate requirements/design checkpoints and binding schema v4 with coverage on graph criteria. Import guidance preserves unresolved questions and uses delivery provenance only when supported. A pending answer no longer becomes permission through elapsed time. |
| **Compaction could replace the continuing goal with the latest status request.** | The versioned compaction prompt preserves the objective and later steering, treats transcript contents as evidence, and distinguishes claims from verified results. The general implementer profile follows project testing policy and stops expanding verification after relevant checks pass. |
| **UI/browser instructions contained obsolete paths and API examples.** | Local skill fixes align feature paths, Tailwind tokens, Dialog/Storybook APIs, server discovery, and browser tool schema lookup. React Scan guidance activates `?scan=1`, keeps worktree isolation, and removes unsupported commands and an unearned universal performance threshold. |
| **Browser testing instructions could hide regressions or expand the task.** | Playwright healing now preserves intended behavior and distinguishes stale locators from application bugs. Removed automatic skipping, global installation, and per-action comment requirements. Live feature checks match the claim: model calls for agent behavior, durable readback for persistence, and visual/interaction evidence for UI. |
| **Steering maintenance and legacy templates perpetuated stale policy.** | Shared steering principles now permit evidence-backed corrections and describe actual loading. Kiro-era templates explicitly retain their legacy scope; examples are optional material, and new specs route to native SDD. Removed unsupported design/test quotas and corrected feature-designer frontmatter. |
| **Audit output presented heuristics as proven causes.** | Workflow audit skills and analyzer text distinguish window occupancy, prompt growth, killed task updates, parse fallback, compaction, and scratch-like paths from their possible consequences. Agents are directed to inspect supporting artifacts; detector logic, thresholds, severity, and counters remain unchanged. |
| **Restart guidance understated the effects of its dry run.** | Documented that the restart dry run still installs/builds in the main checkout and can affect live build artifacts. Retained explicit production/main-worktree authorization and distinguished a listening port from application health. Helpers were inspected without running them. |
| **Steering described inaccurate runtime behavior.** | `CONTEXT.md` now identifies shipped graph assignment snapshotting (`seed-assignment-snapshots.ts`). Workflow validator asking follows strategy, context policy, and backend capability, rather than a claim that Codex has no CC conversation. Dev servers can start via `cctl dev ensure`. |
| **SSE guidance conflated cursors and assumed deltas were idempotent.** | Documented actual `replayFramesSince` gap behavior, transcript `/messages?since=` reconciliation, job reloads, and domain reaction ownership. Distinguished stable-id upserts/version checks from blindly applying duplicate deltas; removed the missing query-key reference and stale copied factories. |
| **Metadata and writing rules favored rigid format over correctness.** | Cursor rules now use readable prose, meaningful examples, and scoped discovery; removed compulsory comments hidden in rendered Mermaid and artificial formatting/line-count gates. Local skill/agent metadata and steering maintenance instructions were corrected. |
| **Debug guidance copied a token fragment into logs.** | The debug probe example records token presence and validation outcome, without token bytes. Logging steering uses the current offline `cctl logs` surface, fixes malformed event-table rows, and describes provider-exposed reasoning items accurately. |

## Preserved constraints

Worktree isolation, protection of unrelated changes and shared live state, explicit approval for backward-compatibility shims, registered validation admission, strict types, meaningful test boundaries, and existing design approvals remain in force. An explicit `/ui-design` invocation still starts with a reviewable proposal. Agents still cannot grant Spec Studio approvals or infer an answer to a pending question.

The generated Next.js notice remains byte-identical to the installed generator. `node_modules/next/dist/server/lib/generate-agent-files.js` compares the whole block and rewrites altered content, so a prose-only edit would not persist. Its broad instruction to read framework documentation is vendor-owned; task-specific repository routing remains outside that block.

## Independent review and dispositions

An independent read-only forward pass exercised six instruction scenarios: an authorized Vite setup, a documentation audit with fixes, initial versus already-approved UI design, unfinished legacy import, a simple workflow revision with advisory feedback, and verification of a CSS fix.

- **Accepted:** primitive validation commands contradicted the root routing policy. Corrected both backend copies to use registered validation.
- **Accepted:** the live-feature skill's later evidence/reporting sections contradicted its visual-only branch. Durable readback now applies to backend claims; screenshots/computed styles and exercised interactions support UI claims.
- **Accepted:** the generated `/spec` text named a section that had moved into a reference. Updated the canonical source and regenerated the command; changed the existing contract assertion to follow that reference.
- **Rejected as a source defect:** initial plugin findings came from the installed managed-bundle symlink. The canonical source was already corrected; this is a rollout limitation, recorded below.
- **Rejected on verification:** a suspected missing Next.js tool surface was an incomplete tool listing. The available tools include Next.js, Chrome, and Playwright; the skill also explains recovery when a harness lacks a tool.

A separate review of the root contract, Cursor rules, and changed steering found no blocking contradictions and spot-checked the corrected SSE and validator-asking claims against source.

## Validation

The final static inventory contains **142 instruction/reference/metadata text files**: 4 root contracts/context files, 18 under `.agents`, 37 under `.claude`, 2 under `.codex`, 4 Cursor rules, 24 Kiro authoring documents, 11 steering documents, and 42 plugin documents/metadata files. Runtime source prompts, plugin JSON manifests, legacy JSON templates, and voice-context files were inspected in addition to that inventory. All relative Markdown links in the inventory resolve.

Registered validation used `--json`, and explicit test selections used `--require-match`:

| Check | Result and run |
| --- | --- |
| Runtime context, profile, and debug prompt tests — 4 files | Pass — `vrun-a8dbb8c9-29a9-4c49-92a9-0675149ed3b2` |
| Compaction and native spec generation contracts — 3 files | Pass — `vrun-bc732618-d50c-4a7a-b527-32fea69f5061` |
| One-shot agent hint — 1 file | Pass — `vrun-cf390b8b-20eb-444b-ae4a-9a7781c94ac9` |
| CLI skill generation — 1 file | Pass — `vrun-aa73a05a-480e-41fc-9935-03ae5a051bcb` |
| Workflow help, help registry, test-input selection — 3 files | Pass — `vrun-27acbb6d-fb05-4d3e-a78b-1d6156ba6df1` |
| Final native delivery reference/parity check — 1 file | Pass — `vrun-97226a35-fc6b-4c40-931b-96139f8eb1fa` |
| Workflow audit detection and rendering — 2 files | Pass — `vrun-f7b23301-4671-4751-89f1-3a804817d43f` |
| Final workflow audit display correction — 1 file | Pass — `vrun-7aff4d59-5d0d-40ba-bb4f-c77311b88cee` |
| Full typecheck | Pass — `vrun-b025c8df-73cd-47ef-aece-c18033ff0905` |
| Changed lint | Pass — `vrun-49b3b275-c54e-4fc3-8a86-deedbfd51c85` |
| Full architecture seams | Pass — `vrun-8b25a4df-aa3a-4751-9324-04f967f31a6e` |

The final two-file native-spec run found one assertion still requiring the old section heading; the source-guidance test passed in that run. The assertion was corrected to the actual reference path and the failing file passed on rerun. Generated CLI blocks/prose and native `/spec` parity were checked. Local structural checks parsed 30 Markdown frontmatters and six TOML/YAML/JSON configurations with no errors; plugin frontmatter and OpenAI metadata also passed Bun YAML checks. The bundled Python skill validator could not start because PyYAML is absent, so no global dependency was installed. `git diff --check` passes.

No frontend implementation changed, so this audit did not start a browser or add visual snapshots. No full application test suite or paid model run was needed for the instruction/source changes.

## Limits and rollout

This is an instruction/source audit against the supplied guides, not an A/B behavioral benchmark of every prompt on both models. It does not certify every historical architectural claim or provider-controlled capability. The fixes address demonstrated contradictions, schema/tool mismatches, and clear prompting failures without changing model selections or effort settings.

Repository file changes are ready for review in this worktree. Runtime prompts and managed plugin delivery require the normal CC build/restart path to reach the installed server. Existing profile snapshots and already-injected session instructions retain their recorded text; the audit does not rewrite active conversations or approval state.
