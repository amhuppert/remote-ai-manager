# D7 ephemeral workflows live browser verification

Date: 2026-08-15  
Managed URL: `http://localhost:3001` (returned by `cctl dev ensure nextjs`)  
Project: `plc-test-lab-b`  
Session: `d7-live-ephemeral-0814`  
Origin conversation: `b6a13ee8-04b9-4b7d-916c-96163e7c390f`
Missing-origin proof conversation: `6ea2a699-4f89-411e-b732-3b4dbaf4479e` (deleted through the production route)

Browser checks used the managed URL above and production API routes. The origin and non-origin conversations were ordinary Codex conversations. No fixture route, direct service call, or synthetic transcript mutation was used to launch or render an execution.

## Browser lifecycle evidence

| Check | Evidence |
| --- | --- |
| Launch-turn receipt card | Execution `0a5deb21-bd14-4021-a101-688f7977a7f5` renders at the original ordinary-conversation launch turn as `D7 declared result 0814-A`, `completed`, `One-off`, and `completion result recorded`. Its link is `/projects/plc-test-lab-b/d7-live-ephemeral-0814/workflow?execution=0a5deb21-bd14-4021-a101-688f7977a7f5`. |
| Current and History rail | While template execution `6d34e60f-3044-4674-966a-b6a7873204f2` was pending and running, it appeared in Current with name, status, origin tier/revision, result indicator, timestamp, description, origin conversation, and execution id. History remained newest-first. After release, the same row moved to the top of History as completed. |
| Stable explicit selection | The browser remained at execution A's explicit URL while the template run was launched, approved, changed from pending to running, and completed. A retained `aria-current=true` and its declared output remained rendered across each SSE invalidation. |
| Complete historical detail | Execution A renders its complete graph, both launch inputs (`DEFAULT-D7-0814-A`, `REQ-D7-0814-A`), declared result, context overview, task output, log/events, validation state, and shared document. The context History tab showed pending, started, task-completed, validation-passed, and completed events; the task transcript drawer showed two messages. |
| Historical actions unmounted | A fresh historical reload had History but no Current section. DOM inspection outside the execution rail found no button or link beginning with approve, reject, abort, abandon, pause, resume, edit, retry, or merge. The explicit URL selected A and rendered all ten History rows. |
| Template deletion independence | Project definition `d319f27c-ca60-4cf6-bd00-824beda051a8` launched execution `6d34e60f-3044-4674-966a-b6a7873204f2` at revision 1. After the production delete returned exit `0`, `workflow get` returned exit `2`, `Workflow not found`, and the project workflow list became empty. The by-id execution still returned HTTP `200`, the same template origin and owner, a 1,628-byte authored launch document, and captured marker `SHOULD-NOT-RUN-D7-0814-C`. |
| Deleted-origin tombstone and fallback | Ordinary Codex conversation `6ea2a699-4f89-411e-b732-3b4dbaf4479e` launched detached one-off execution `5102cea0-814f-4718-ac49-1c09631240e3` through `cctl workflow run`. While its delayed context was running, the production conversation DELETE returned `204`; the session immediately stopped resolving the origin while the execution remained running. The execution completed at boundary cursor `185` with `{ "delayed": true }`. History renders `Origin conversation deleted`, and `/api/notifications` returns exactly one session-scoped `workflow-result-ready` fallback with the execution deep link. After reload the count remained one. |
| Restart and reload recovery | After `cctl dev stop nextjs` and `cctl dev ensure nextjs`, the URL remained `http://localhost:3001`. A's explicit deep link reloaded with the same graph, result, inputs, events, and history. |
| Historical-only inactivity | The ordinary root and bounded setup conversations were archived through their production PATCH routes; the missing-origin launch conversation was deleted. `/api/conversations/active` then contained zero rows for the session, the current-execution route projected no active run, and History retained eleven rows. The fallback was marked read after its exactly-once count was captured, leaving no ambient topbar item. The explicit historical URL still rendered the completed graph and result. |

The durable store agrees with the browser projection: `graph_workflow_executions` has zero rows for the session and `graph_workflow_archived_executions` has eleven (`7` completed, `3` aborted, `1` halted). For the missing-origin execution, the origin conversation count is zero, the archived execution count is one, the boundary-ledger row is `delivered` at cursor `185`, and the unique notification dedupe key `graph-workflow-origin-missing:5102cea0-814f-4718-ac49-1c09631240e3` has exactly one row.

## Origin deletion integration remediation

The accepted browser criterion required a production deletion path, but this integrated build exposed only archive routes. Archiving deliberately preserves session membership and therefore cannot exercise the tombstone or fallback path. A session-conversation DELETE adapter now reaches the existing serialized session mutation boundary, accepts only idle `new` or `awaiting` conversations, stops the conversation actor before commit, deletes only the addressed state row, and removes its transcript after commit. Running and waiting conversations receive `409`; unknown conversations receive `404`. Credential-absent human UI requests retain session-wide authority; a credential-bearing caller is classified through the canonical optional-token and server-signed capability verifier and may delete only the conversation its verified conversation or lane capability names. Invalid tokens, unsigned agents, and cross-conversation agents are refused before the mutation or publication seam. A typed post-commit `conversation-deleted` event immediately removes the row from the session and Active caches, then invalidates the authoritative TanStack Query views. Structured events record authorization refusals, successful deletion, publication failure, and any post-commit transcript cleanup failure.

Red-green evidence:

- `vrun-e2d92c5b-66df-4f9a-ab82-a21e00943602`: the new route, handler, and service behavior tests failed before implementation.
- `vrun-e202f3b5-f58b-4bfe-b863-980654d0f817`: the route wiring and handler tests passed after the minimum implementation.
- `vrun-7a5cfa17-7ce3-4d8e-997d-0c046de24c9a`: the service behavior tests passed, including addressed-only deletion, transcript cleanup, survivor preservation, and running-conversation refusal.
- `vrun-ecb18f90-ee9b-4993-a615-91fa1971f006`: the post-commit publication and browser-cache reaction tests failed before the typed event existed.
- `vrun-5a69e1f4-4436-4d9c-a8b9-690e57bb988f`: the route publication and TanStack Query reaction tests passed after the event seam was added.
- `vrun-27cc3a48-8154-435b-845a-bc687cb288fa`: the aggregate changed-scope test suite passed.
- `vrun-2bde01c7-55c7-4715-add2-ad60c905c15d`: every touched test file passed after the final dependency-fixture adjustment.
- `vrun-9bc33fa2-e790-4ad4-8f07-6b60fe0d1f8c` and `vrun-767ba774-b636-4df5-a7a4-99d6090238d3`: full-fallback typecheck and changed-scope lint passed.
- `vrun-5d9c2f31-bc04-45d3-9ad5-20c3627a2570`: the principal regression tests failed before the authorization fix because a verified sibling and an unsigned token-bearing caller both received `204`.
- `vrun-fdc14c09-9160-4684-b027-5413b9375fb2`: the same route suite passed after the route adopted canonical classification and self-only agent deletion.
- `vrun-f1a7ae45-d9d0-4a7b-ba0f-4177cedf9e01`, `vrun-52eca4c0-4554-4d2d-8c72-c25dc80d5b77`, and `vrun-fffc53e9-bece-4350-808f-5814f50b8222`: post-remediation full-scope lint, typecheck, and test returned explicit passing JSON verdicts.

The live DELETE permanently removed conversation `6ea2a699-4f89-411e-b732-3b4dbaf4479e` and `.config/transcripts/6ea2a699-4f89-411e-b732-3b4dbaf4479e.jsonl`. It did not remove or rewrite the execution's launch document, event history, output, provenance, or result. A final disposable production create/delete returned `201` then `204`, and `/api/conversations/active` remained at zero for the historical-only session.

## Deletion principal remediation

Ordinary Codex conversation `4326b82a-d300-47d0-b5ce-a6d966fcb652` used the dev server's real `CC_API_TOKEN` and `CC_CONVERSATION_CAPABILITY` to DELETE idle sibling conversation `83dc93b2-0028-4b21-b9a8-8b877f0c5e45` through the production route. The response was HTTP `403` with `code: non_owner_principal`; a production membership read immediately afterward still returned the target as `new`. The scoped structured log records `principalKind: conversation`, the verified principal conversation, the addressed conversation, and trace `08e9b745-0173-465e-a251-424ffaf0da06` without logging either credential.

Credential-absent production DELETE then removed the target and both disposable actors, proving the human UI fallback remained session-wide. The final membership and read-only SQLite checks found zero disposable rows. The preserved missing-origin execution remained archived as `completed`, with owner `6ea2a699-4f89-411e-b732-3b4dbaf4479e`, `origin.kind = one_off`, and a 1,914-character launch document. Its origin count remains zero, result delivery remains `delivered` at boundary cursor `185`, and the unique missing-origin fallback notification count remains exactly one.

## Receipt-card integration remediation

Source history showed that commit `3d83e12d` intentionally deleted the in-process `start_graph_workflow` MCP surface in favor of `cctl`, but `WorkflowReceiptCard` still recognized only the retired MCP tool name. The production transcript for execution A contains a `Bash` tool use with:

```text
cctl workflow run --file .cc/temp/d7-declared-plan.json --inputs .cc/temp/d7-declared-inputs.json --json
```

followed by the exact structured launch receipt. The projector now recognizes successful JSON receipts paired with a `Bash` invocation whose command starts with `cctl workflow run` or `cctl workflow start`; the existing origin-id, success, schema, and execution-id dedupe gates remain in force.

Red-green evidence:

- `vrun-5cafc975-b3e3-491e-a23b-07a16cdcb934`: explicit failure of the new CLI-receipt behavior test; all 15,638 pre-existing tests passed.
- `vrun-1b482f60-7a7b-4494-9839-1582ee99de1a`: explicit passing changed-scope JSON verdict after the minimum projector change.
- Live DOM: exactly one card for execution A at the first message, with the exact deep link and completed result projection.

## Console and network findings

A post-remediation explicit-history reload logged the normal React development/HMR messages with zero errors and zero warnings. The preserved console contained one 404 from the intentional wrong-project scope check performed during CLI validation; it was not generated by the browser flow.

The fresh reload returned HTTP `200` for projects, SSE `/api/events`, active conversations, notifications, current execution, by-id execution, History, session membership, execution events, and result routes. The missing-origin flow additionally recorded `204` for the conversation DELETE and `200` for fallback read settlement and bounded setup-conversation archival. The only preserved 404 was the deliberate request against project `plc-test-lab` instead of `plc-test-lab-b`.

## Saved screenshots

- `evidence/d7-ephemeral-workflows-live-browser/launch-receipt-card.png` — original launch turn with execution A's live completed receipt card.
- `evidence/d7-ephemeral-workflows-live-browser/historical-deep-link-after-archive.png` — explicit execution A deep link, History-only rail, graph, inputs, result, and event overview.
- `evidence/d7-ephemeral-workflows-live-browser/historical-only-session.png` — session with zero active conversations and no historical execution card in ambient session UI.
- `evidence/d7-ephemeral-workflows-live-browser/active-work-empty.png` — global Active Work surface at zero conversations.
- `evidence/d7-ephemeral-workflows-live-browser/missing-origin-tombstone-and-fallback.png` — newest History row with `Origin conversation deleted`, declared result, complete graph, events, and no historical mutation control.
- `evidence/d7-ephemeral-workflows-live-browser/missing-origin-historical-only.png` — explicit missing-origin deep link after reload with zero active conversations and no unread fallback in the topbar.
- `evidence/d7-ephemeral-workflows-live-browser/missing-origin-principal-remediation.png` — post-remediation explicit deep link with History-only rail, preserved missing-origin execution result and event detail, and zero active conversations.
