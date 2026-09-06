# command-center#111 implementation validation

Date: 2026-09-05. Status: implementation validated in the session worktree, ready for review. Ticket: command-center#111, first implementation child of command-center#110. Base revision: `06159859ac88c34706cc19943c9c5cfb3020606a`; Cursor SDK: `1.0.28`.

The implementation checks declared execution class, launch profile, instruction fidelity and filesystem enforcement before dispatch. Actor results and stream errors retain the structured refusal code, and a task refusal precedes transcript-adapter resolution. Cursor remains usable for ordinary conversations. Unsupported task work and history forks receive structured refusals; optional ticket enrichment and git message generation retain their valid deterministic outcomes.

Alex authorized this work with “Implement the design.” The implementation follows [design.md](design.md), with one source correction: there is no repository naming override or repository-config write API. Global settings are validated before saving; manually edited repository compaction overrides are checked before creating a pending artifact and again at dispatch.

## Delivered behavior

- Required execution intent flows through conversation creation, task callers, AgentCall and structured-output repair. Descriptor registration rejects inconsistent grants. A task facet alone does not admit governed work or an undeclared profile. A raw-dispatch syntax ratchet covers conventional runner bindings in neutral consumers.
- Commands share reserved-name availability with prompt and service admission. Unavailable commands remain visible and cannot activate. Git commands disclose unavailable assistance and directly use default messages when necessary. Message generation preflights its possible isolated repair profile.
- Quick Ticket captures an admitted backend and atomic model selection before commit. When enrichment is unavailable, valid attachments persist, a structured warning is returned, and no enrichment task is scheduled.
- Settings and workflow assignment controls use the fetched catalog. A hydration seed does not authorize gated work. Invalid existing auxiliary settings stay readable; disabling naming and unrelated edits remain possible.
- Derived fork admission uses the backend of the effective source reference. Unsupported forks fail before target IDs, transcript copies or provisional records. User message zero retains start-over. Unexpected adapter refusal cleans up the provisional fork; a transcript deletion failure does not prevent the separate row cleanup attempt.
- Cursor rejects every defined filesystem policy before transport construction on fresh and resumed creation, including empty policies. It never drops the request or replaces enforcement with instructions.
- Pane and peek actions share fork availability. Refusal text is visible, associated with its control, and uses unique accessibility IDs when several surfaces are mounted.

## Automated evidence

Bug reproductions were run red before their corresponding fixes. The implementation added tests for execution grants/profiles and repair, command availability, Quick Ticket degradation, config admission, fork refusal and Cursor policy creation. Test fixtures were mechanically migrated to supply the required execution intent; catalog-dependent UI fixtures now supply fetched data. Mechanical wiring, copy-only changes and documentation did not require new behavior tests.

| Acceptance | Evidence |
| --- | --- |
| A1–A3 | `execution-admission.test.ts`, `task-execution.test.ts`, `agent-call-admission.test.ts`, `agent-call-facade.test.ts`, descriptor/conformance and workflow validation suites cover limited grants, absent facets/profiles, pre-dispatch refusal, preserved repair requirements and backend agreement. |
| A4–A5 | Command availability and command-service tests cover all seven names, reserved-name shadowing, missing live entries, unavailable isolated message repair, default-message dispatch and refusal before ticket work. Existing commit/merge/rebase and validation/conflict suites remain in the regression selection. |
| A6 | Attachment planner tests cover preserved report/screenshot attachments, no scheduling after commit when unavailable, and the selection captured before commit despite a later config change. |
| A7 | Config route tests cover attempted invalid auxiliary saves, unchanged invalid values, disabling naming and ordinary Cursor defaults. Naming, compaction, assignment and backend-toggle tests cover live-catalog eligibility and hydration refusal. |
| A8 | Conversation service tests assert unchanged source/session state, no copied transcript or adapter call on Cursor history forks, preserved start-over and provisional cleanup on unexpected adapter refusal. Message actions tests cover activation prevention and accessible explanations. |
| A9 | Cursor runtime creation tests cover fresh/resumed defined policies and the unrestricted ordinary path. |
| A10 | Existing adapter, continuation, conversation, task, workflow and ticket regression suites are included in validation. |

| Registered check | Result | Run |
| --- | --- | --- |
| `format --scope changed` | Passed | `vrun-7c6cdda6-78a3-4fe2-8dbf-5db7e62c43d6` |
| `lint --scope changed` | Passed | `vrun-2fbc8183-e121-4454-8a9f-93ba8e5770a8` |
| `typecheck --scope changed` (full project) | Passed | `vrun-9e986aee-bdd3-4435-90ce-c6be702f2796` |
| `seams --scope changed` (full project) | Passed | `vrun-13c22c86-a8ee-4949-888b-cb9008b5448b` |
| `test --scope changed` | Passed | `vrun-fdff340e-eff4-4db3-ac3c-742fafffe7e8` |

`git diff --check` also passed. Local red/green logs and live probe material are under `.cc/temp/capability-admission/`; these are ignored session evidence, not delivery source.

## Live application evidence

`cctl dev ensure nextjs` selected `http://localhost:3001`; `cctl dev ensure storybook` selected `http://localhost:6006`. The Next.js server used this worktree’s `.config` datastore. A disposable git project was created entirely inside `.cc/temp/capability-admission/live-projects/cc111-live`, keeping real project state and source worktrees out of the probes.

| Probe | Observed result |
| --- | --- |
| Catalog/settings | Live catalog returned truthful conversation/task policies. Naming=Cursor (including a new selection with naming disabled) and compaction=Cursor writes returned HTTP 400 with admission codes and left the raw config unchanged. Setting Cursor as the ordinary conversation default succeeded. |
| Task request | Token-authenticated agent-run request with Cursor returned HTTP 400 `backend-facet-unsupported`. |
| Commands | Session `/ticket` and `/collab`, plus project `/ticket`, returned HTTP 400 with the shared refusal and no added conversation records. The composer displayed `/ticket` as disabled; pressing Enter left the text in the editor. `/commit` remained selectable with its unavailable stages disclosed. |
| Quick Ticket | Ticket creation returned HTTP 201, retained its diagnostic note attachment and returned `enrichment_unavailable` with the Cursor refusal. Ordinary ticket deletion later succeeded. |
| Real Cursor turn | Conversation `545e8be3-6641-4208-bf4e-0744c0e61872` returned exactly `CC111_CURSOR_OK` through the actual provider and persisted a Cursor backend reference. The prompt prohibited tools and file edits. |
| History fork | Forking assistant index 1 returned HTTP 422 `backend-fork-unsupported`. Conversation rows and the SHA-256 map of local transcript files were unchanged. |
| Start-over | Forking user index 0 returned HTTP 200, conversation `9d77fdd8-3658-4415-aa4c-5ed7b3b7bdc2`, with no backend reference or transcript and the original prompt prepared for editing. |
| Pane/peek | The full pane and the real sidebar peek both enabled index-zero start-over and disabled derived forks with visible reasons. Storybook unavailable/degraded command and fork states were inspected. |
| Deterministic git | `/commit` committed the fixture file using the default message (`b9661a0`). Clean `/rebase` completed. `/merge` landed the session on the disposable target (`b2a62ed`) with the default merge message. The conversation still had only the single original assistant reply after all three commands. |
| Runtime diagnostics | Next.js MCP reported empty `configErrors` and `sessionErrors` after the probes. |

The disposable session/worktree and ticket were deleted through the application. The dev configuration was restored through PUT and a subsequent GET confirmed exact raw equality with the saved pre-probe configuration. CC continues to own the dev servers.

## Limits

This delivery enforces and discloses existing capabilities. It does not implement Cursor task execution, independent history forks, durable queueing, privileged instructions, or exact filesystem confinement; those belong to later children of #110. Adapter policy tests prove rejection before transport creation, not a provider confinement guarantee. A live Cursor turn was exercised; paid Claude/Codex provider acceptance and deliberately conflicted or failing-validation git scenarios were not repeated live here. Their supported paths and refusal outcomes are covered by the automated regression checks identified above.
