# Cursor graph workflows and native managed delivery — #118

Implemented against Alex’s governing 2026-09-12 policy on tickets #110 and #118. Dependencies #113, #114, #115 and #117 were Done. Existing native specification approvals were preserved; no competing specification or live human approval was created.

## Implementation

- Cursor task-validator continuity receives the lane directory, complete model selection and task identity. Its backend adapter creates and resumes task references without requiring a persisted conversation. Ephemeral validators retain their unscoped CC access contract.
- Planner MCP submission advertises the complete canonical workflow schema. The previous four-field tool schema stripped the required charter and omitted workflow staffing, preventing valid submissions. A real MCP client/server round trip now retains both.
- Owned/read-only implementer instructions describe Cursor’s instruction-only limits accurately, preserve allowed paths and scratch instructions, and retain stronger enforcement disclosures for other backends.
- Workflow transcript panels and message authors use the persisted backend, including Cursor and Codex. Loading metadata never defaults to a Claude label.
- The compact configuration controls used by builder and live panels show the existing informational Cursor limitation notice for implementers, validator seats and plan repair. Cursor stays selectable without an acknowledgment.
- Cursor cumulative input tokens remain token usage; they are no longer reported as context occupancy. Unknown context size, occupancy and cost remain unknown.
- Native managed-definition freeze/reload/reopen and common graph launch tests retain Cursor staffing and complete model selections. No alternate orchestrator or persistence migration was introduced.

## Authenticated live evidence

The session’s `cctl dev ensure` server was `http://localhost:3001`, serving this worktree and its isolated `.config` database. All fixture repositories and Git worktrees were beneath `.cc/temp/118-live/` in this session worktree. Bearer-authenticated requests launched real Cursor `composer-2.5`, `fast=false` turns. Workflow launch/abandon actions were executed by an ordinary Cursor conversation with its genuine server-issued capability; no principal or approval was fabricated.

### Ownership, publication and restart

Execution `5cc53ab0-4129-4ecd-9a7e-0760b2982ccb` completed three Cursor contexts: full, owned (`owned/`), and read-only. The full and owned lane published to the scratch session through the engine’s normal join. Files read back from the session worktree were exactly `CC118_FULL=42\n` and `CC118_OWNED=84\n`; the read-only captured result was `{ "marker": "CC118_READ", "value": 126 }`.

The run was paused, confirmed paused through fresh durable reads, the dev server was stopped/restarted, and the same execution resumed and completed. Cursor implementer and conversation-validator identities survived. The first run exposed the task-validator setup defect and fabricated occupancy; it is not counted as passing task-validator evidence. Those defects were reproduced and corrected before the later runs.

### Planner

The final authenticated planner request returned one context, one task, no validation errors, and the submitted charter plus Cursor implementer, conversation/task validators and repair configuration. The actual `submit_workflow_draft` tool accepted the document. An earlier cold route exceeded the MCP startup timeout; a warmed retry exposed the incomplete tool schema. Neither empty fallback response was counted as success.

### Repair, advisory response and retry

Execution `51cf5776-e126-49ad-848d-fe55166f47db` completed with `{ "heading": "# Cursor workflow acceptance" }` after exercising:

1. A blocking Cursor conversation validator returned a planning defect for an obsolete README criterion; the Cursor task validator returned a real advisory verdict.
2. Cursor plan repair returned one structured operation, corrected the criterion, and recorded `outcome=repaired`, `planningDefect=true`, `resumed=true` in the durable repair ledger.
3. A subsequent output capture returned an incorrect status string. The blocking validator rejected it and reopened the task. The retry produced the exact heading and passed.
4. Cursor advisory response/disposition records and both validator strategies were read from durable workflow state. Task references retained their provider identity and lane directory; costs and context metrics remained unknown.

The initial repair fixture `08ece144-9b04-4a88-8b53-af3c241def26` returned a valid repair diagnosis but could not edit an already completed context. It was explicitly abandoned with an audit reason and replaced by the planning-defect fixture above; it is not counted as successful repair application.

The final smoke execution `6e4226e0-126c-4aab-9e09-4eb6c119b4a4`, after restarting with the final task-scope fix, completed and archived on its first iteration. Its Cursor implementer captured the exact README heading; both conversation and task validators recorded `verdict_pass` with no infrastructure failure. The task lane retained actual token usage and an unscoped provider task reference, without fabricated cost or context occupancy.

### UI and limits

Cursor transcript identity was inspected in the authenticated workflow and in desktop/390px Storybook screenshots. The shared compact configuration notice was inspected in the authenticated builder and at desktop and phone widths in Storybook. Cursor was enabled, with one informational note and no acknowledgment checkbox. It explicitly says read-only/ownership limits rely on instructions, that Cursor may edit outside assigned paths, and that network/native approval limits are not enforced. The final builder browser console and Next.js runtime diagnostics reported no errors. Story sizing changes are visual-only and were verified through screenshots rather than test-first assertions.

Native managed delivery was verified through production storage and common graph-launch tests. A live human Spec Studio sign-off was not performed. Generic question/gate/pause/recovery behavior remains covered by the workflow-manager suite; the live probes did not manufacture human decisions. Cursor occupancy-triggered rotation remains unsupported when the SDK supplies no occupancy, with focused durable tests proving unknown values and no fabricated threshold crossing. Collaboration Mode remains outside #118.

## Validation

All tests used registered `cctl validate run test --queue-if-busy --require-match --json -- <explicit test files>` commands. Behavioral fixes were first reproduced failing: envelope disclosure, transcript/backend loading identity, context occupancy, task continuity, planner MCP schema and compact configuration disclosure. Added persistence/launch coverage exercises existing supported behavior.

| Check | Passing run |
| --- | --- |
| Implementer envelope | `vrun-503deba0-fedf-43c0-8c77-901266336880` |
| Workflow manager / managed launch | `vrun-55a5c0d3-5fdd-4b66-aab3-a700d4afbb1b` |
| Planner / managed storage / transcript | `vrun-b49f234a-25b6-4788-a132-8e8348335ecd` |
| Cursor runtime and validator regressions | `vrun-f33dfc74-f2f9-4565-9752-d7db74f0e667` |
| Unscoped task continuity | `vrun-d817c899-624a-4ba2-b495-938095aa898d` |
| Validator task scope | `vrun-a8ea6ca4-4274-4cdb-9bba-c06d90b433c7` |
| Compact configuration screens | `vrun-20d2f0cf-d0c6-4a8a-9138-144abb8a6582` |
| Lane durability | `vrun-35c2fb23-42c6-464f-8cee-8a0c7dc4cd71` |
| Plan-repair decoder | `vrun-2d518927-66a3-4c5f-8e10-6420916b2c73` |
| Definition / capture / advisory / envelope regression | `vrun-745dddbe-70cf-48ad-ae9d-7142ef1b47fe` |
| Cursor runtime unknown occupancy | `vrun-8818eb51-e28c-400b-b9da-25706a8c7625` |
| Typecheck | `vrun-e1956414-3f15-4aed-be5a-bf0adf15ee68` |
| Lint | `vrun-40233dfa-59a8-4d11-a56a-1d02f0599428` |
| Seams | `vrun-cedb32eb-0b80-4f82-a602-d10c94fffce4` |
| Format | `vrun-ef841f57-461b-4b77-97db-a680408cab01` |

## Evidence retention and cleanup

The ticket includes this report, bounded JSON extracted from the final durable execution snapshots and accepted planner definition, and screenshots of the authenticated UI and mobile disclosure. The JSON retains outputs, validator verdicts, repair ledger entries and lane metrics without credentials or opaque provider session references. Detailed local run receipts remain under the ignored `.cc/temp/118-*` paths.

The scratch `fx-118` and reserved `__planner__` sessions and the saved disclosure definition were deleted through supported APIs after evidence capture. No active workflow was left running. The session dev servers were stopped and the two fixture-specific local configuration fields (`baseDir`, `defaultAgentBackend`) were restored. The ignored scratch repository and evidence files remain available for inspection; no fixture files entered the product source tree.
