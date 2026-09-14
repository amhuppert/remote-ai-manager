# Cursor auxiliary consumers — ticket #116

Verified on 2026-09-14 against the assigned ticket worktree, `@cursor/sdk` 1.0.28, and Composer 2.5 (`fast: "true"`). The session Next.js server served this worktree at the URL returned by `cctl dev ensure nextjs` (`http://localhost:3001`). Its configuration and database lived in this worktree's `.config`; test projects and Git repositories lived under `.cc/temp/cursor-live`. No production project or main checkout was modified.

## Implementation

- Session naming uses the configured naming backend, model, parameters, and timeout. The automatic conversation naming toggle does not suppress explicit session naming. Failed or timed-out results cannot become session names.
- Durable task turns carry a trusted conversation target independently of permission to access CC APIs. Cursor uses that target to open the conversation's existing store, or create its store when an auxiliary task is the first turn. Hosted results retain native Cursor references that normal chat can resume. Standalone tasks retain their existing reference format. Isolated tasks and formatting repair do not inherit the hosted target.
- Turn normalization drops non-enumerable metadata from generated JSON Schema objects. Zod 4's hidden `~standard` functions previously became enumerable during record parsing and made workflow snapshot cloning fail during a real `/ticket` run.
- Naming and compaction settings disclose Cursor's instruction-based limits without disabling selection or requiring acknowledgment. Naming explains that the selected model serves both sessions and conversations. Compaction explicitly describes saved-transcript artifacts and distinguishes them from native provider compaction. Both sections have Cursor Storybook variants.
- Other consumers already dispatched through the shared task interfaces. Targeted coverage now exercises Cursor selection, domain output, and persistence at those consumer boundaries, including real Cursor adapter translation for validation and conflict assistance.

## Live results

All rows below used actual Cursor SDK calls. Provider seams were not substituted in these runs. Scratch configuration selected Cursor; persisted backend fields and structured dispatch logs identify the actual runner. Unit/contract coverage additionally makes alternative backend selection fail, so a silent Claude or Codex substitution cannot satisfy those assertions. Live runs did not revoke the machine's other provider credentials.

Evidence paths below are relative to `.cc/temp/cursor-live/` and are intentionally retained as ignored local artifacts for review. The scratch database, transcripts, and structured logs remain under `.config/`.

| Consumer | Observed result and durable evidence |
| --- | --- |
| `cctl agent` | Real authenticated CLI run `51e077c5-9570-4d06-b631-2cfd14e125c3` completed with `C116_AGENT 323`, Cursor backend, and an empty reference-document array. Re-read from `agent_run_records`. See `agent-result.json`, `agent_run_records.json`. |
| Session `/ticket` | Ticket `auxiliary#3` persisted with its conversation snapshot attachment after resuming Cursor conversation `ea8ec8bd-7763-49d0-81a8-001b10ff9d43`. See `ticket-3.json`, `ticket-green.json`. |
| Project `/ticket` | Ticket `auxiliary#4` persisted with a conversation attachment after resuming project conversation `57581d06-cc59-4304-87c3-101d756eacbc`. See `ticket-4.json`, `project-ticket.sse`. |
| `/ticket` as the first action | Ticket `auxiliary#6` persisted from empty project conversation `56f1756c-8d20-4ff9-ad1a-80328943a825`. Its saved native reference was `agent-3352d767-13c0-463f-89f1-e1d01f51826a`. A subsequent ordinary chat turn recalled the ticket's amber counter without tools. The check asserted the response after that specific user turn, plus the persisted reference. See `ticket-6.json`, `ticket-first-green-readback.json`, `chat-after-ticket-green.sse`. |
| Quick Ticket enrichment | `auxiliary#2` retained diagnostics and acquired the persisted `agent-triage` attachment from Cursor JSON. Separately, `auxiliary#1` retained its ticket and diagnostics when Cursor returned 2,376 bytes against the 2,048-byte enrichment limit. The failure identified `output_size`; the successful result was 2,029 bytes. See `ticket-1.json`, `ticket-2.json` and the structured enrichment logs. |
| Conversation naming | The session conversation was automatically named **Fix Lavender Retry Counter**, saved with backend `cursor`, and read back through the authenticated conversation API. See `conversation-readback.json`. |
| Session naming | The production session-name service returned **Lavender Retry Diagnostics** using configured Cursor. A session with that generated name was created through the authenticated API and read back. See `session-name.json`, `named-session.json`, `sessions.json`. |
| Compaction | Real `cctl conversation compact --wait` persisted completed artifact `b95abd07-4acb-4865-b4f1-fbd6e764e0a7`, Cursor model provenance, source hash, sequence coverage 0–12, and cited summary content. Later messages correctly made the artifact stale. See `compact-result.json`. This is CC transcript compaction. |
| Generated commit message | Live `/commit` generated **Document lavender retry counter verification**, created commit `339e18b`, and persisted completed job `470155f6-02a7-4566-9302-72a7cdf5913b`. Dispatch recorded `usedFallback: false`. See `commit.json`, `git-commit.txt`, `job_records.json`. |
| Generated merge context | Live `/merge` generated a message and nonempty resolution context, then completed the scratch merge at `c49453632448bb6fab97bcee1d70b5fdddf91247`. Job `e8f902e9-8551-42d7-b9cd-3f66739ea279` was persisted completed with `usedFallback: false`. See `merge.json`, `job_records.json`. |
| Validation auto-fix | The production fresh-task path repaired `answer.cjs` from 322 to 323 in a scratch repository. The real Node assertion passed after the change; service result was `fixed`. See `validation-fix.json`, `backend-probe.ts`, `backend-probe.log`. |
| Conflict analysis | The production fresh-task path analyzed a real Git conflict in `colors.txt`. The check verified that analysis left its contents unchanged. See `conflicts.json`, `backend-probe.ts`. |
| Conflict resolution | The production resolver removed the conflict, preserved lavender, green, and blue, and staged a result with no unmerged paths or conflict markers. See `conflicts.json`, `repair-repo/colors.txt`. |

The service-level naming, validation, and conflict probe used the production default dependencies and actual SDK in a Node bundle. SQLite could not run directly under Bun; the Node bundle was a probe-launch adjustment, not a provider substitute. CLI/API consumers used the authenticated session dev server.

## Regression and UI verification

Behavior-level reproductions failed on the missing behavior before the fixes: configured Cursor session naming, rejection of timed-out partial names, hosted Cursor continuation (including fresh session/project task turns), and serializable generated schemas. Single-file registered runs confirmed those failures and then passed. Existing consumer tests were extended to Cursor; presentation and model-selection wiring had no additional test-first step.

Focused coverage includes CLI admission/result persistence, ticket snapshot persistence, enrichment output validation, naming persistence, artifact provenance, commit/merge dispatch, validation auto-fix, conflict analysis/resolution, schema normalization, formatting-repair isolation, Cursor task references, and naming/compaction config admission and warnings.

Final registered checks:

- Task adapter, conversation actors, turn normalization, facade, and vocabulary: five files passed with required matches (`vrun-e21e112e-7c72-4976-a3dc-2549a301c952`).
- Full typecheck passed (`vrun-15826ed5-f740-405c-8c50-92a2328d4b99`).
- Changed-file lint passed (`vrun-ed4fbf5c-fadb-4f2e-b17c-dbed40b1f81f`).
- Formatting passed (`vrun-6dd2e90a-a4fa-4377-ae6a-81d8190a709e`).
- Session naming and validation/conflict assistance passed after final logging and formatting edits (`vrun-d804bf89-a7ca-4276-9bde-3239f3c68dea`, two matched files).
- Architecture seams passed (`vrun-e31491a1-ab3f-4b73-8314-ae44ec3e7ee1`).
- Broader affected-test checkpoint passed (`vrun-ebec098b-5a95-42f2-ae3f-1624887257de`, `--scope changed`). This run overlapped the final continuation refinements; the five-file check above separately verified their final state.

Desktop and 390-pixel mobile screenshots were inspected for both settings sections: `naming-desktop.png`, `naming-mobile.png`, `compaction-desktop.png`, and `compaction-mobile.png`. Cursor remained selected and enabled; the warning required no acknowledgment. A dev-server restart was necessary to replace a retained task-runner instance before the final fresh-conversation live proof.

## Limits and retained state

Cursor's filesystem ownership/read-only limits remain agent instructions, not enforced isolation. The settings disclose the existing network/tool-approval limitations. This work does not claim native provider compaction, native structured-output enforcement, or metrics that the SDK does not supply. JSON output still passes domain validation; bounded enrichment can fail while ticket creation succeeds. Deterministic Git behavior and explicit assistance-failure fallbacks remain intentional and separately covered.

No unresolved provider requirement blocks this consumer group under the governing migration policy. The sibling workflow matrix remains outside this ticket. Scratch tickets, sessions, repositories, transcripts, and evidence are retained only in the isolated development datastore for review; they are not production tickets or sessions. The browser and session dev server were stopped after verification.
