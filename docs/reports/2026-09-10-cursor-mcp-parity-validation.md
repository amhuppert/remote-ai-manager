# Cursor MCP parity validation — ticket #114

Date: 2026-09-10. Installed provider: @cursor/sdk 1.0.28.

Status: implementation, local verification, and the authenticated five-turn transport matrix passed. Ticket #114 remains In Progress because provider-wide configuration authority and permission behavior are not fully established. strictAuthoritativeConfig remains false.

## Implementation

- Conversation MCP PATCH selects agentBackend, including Cursor, instead of the unrelated backend property. Cursor changes stage for the next turn whether the runtime is idle or running.
- Portable configuration, canonical discovery, worker IPC and the SDK port carry stdio, HTTP and SSE, explicit headers/bearer credentials, allow/deny tool policy, and startup/tool deadlines.
- A worker-owned loopback MCP bridge uses real MCP SDK clients for upstream transports. It filters advertised tools and independently checks direct calls; denied tools never reach the upstream. The bridge applies bounded initialization/inventory and tool-call deadlines. Auth, disconnect and protocol tool-error diagnostics do not forward raw upstream errors.
- SDK sends always contain the complete inline map, including an explicit empty map. Replacement closes prior bridge endpoints. Disabled servers are omitted, duplicate portable IDs reject the configuration, and any rejected server rejects the replacement. Unsupported OAuth controls and malformed deadlines are explicit failures.
- IPC version 4 prevents a stale worker from accepting fields it cannot enforce.
- Authored controls survive discovery. View resolution and runtime composition share policy resolution. Individual tool overrides do not accidentally turn unrelated enabled tools off. Inventory and execution share case-insensitive Authorization precedence and bearer environment resolution.
- Configuration remains pending until the worker acknowledges dispatch after bridge preparation. The receipt identifies the exact dispatched hash, preserves a newer pending change, persists state, and publishes an MCP view invalidation.
- Expanded MCP rows show transport compatibility. The label describes transport support; it does not claim provider configuration authority.

## Evidence already observed

All regression loops used registered cctl validation with an explicit test-file path and require-match. Provider substitutes are used only to exercise CC behavior; they are not evidence of provider guarantees.

| Behavior | Failing reproduction | Passing evidence |
| --- | --- | --- |
| Cursor route backend identity and idle/running staging | Route returned Claude instead of Cursor | Included in vrun-840e8642-a207-42e7-b435-43374a14beef |
| Pending state until receipt; newer pending hash preserved | Turn start prematurely replaced the applied hash | Included in vrun-840e8642-a207-42e7-b435-43374a14beef |
| Receipt publishes view invalidation | vrun-b209413b-c17b-473e-9a71-c7c1157bf14d | vrun-c4abaacc-9bef-488e-b92f-3d9b9e6da977 |
| Real bridge auth, filtering, deadlines, environment, disconnect and sanitized tool errors | vrun-457f0288-3b21-4c94-aa89-4e75d120ccb9 includes raw error leak | vrun-007c5d18-7a3d-4932-bdb6-1d5aa721f8c9 |
| Real endpoint replacement and explicit empty send through SDK port seam | Existing lifecycle exercised against real bridge clients | vrun-f559657a-724b-4f33-92c4-3739148621bd |
| SSE bearer probing and explicit lowercase Authorization precedence | vrun-7590c989-d927-474a-9a90-c4b6bccf8b22 | vrun-b585863a-9584-44ae-9503-571cbd3f74e7 |
| Inventory authentication diagnostics | vrun-01d09d91-ab7c-405a-983b-155515ddd89e | vrun-7578cdfb-707f-41b3-ae34-88dafb9cb40e; probe regression vrun-cd648b26-f100-4dff-84b6-1b1420d40793 |
| Cursor translation with shared header resolution | Covered by translation regressions | vrun-92f5ff34-d0d1-4446-b07d-d604d823bf29 |

A broad checkpoint passed 5,931 tests and exposed the inventory-policy regression and an obsolete SSE rejection expectation. Both were corrected and their focused suites passed. The subsequent registered changed-scope regression passed: vrun-a090ec73-8db1-4ae5-90e5-6b6fc7f26054. The runner returned a passing verdict without an aggregate test count. The focused receipt-notification and authentication-diagnostic runs also passed after their final edits. Final static checks passed: typecheck vrun-27cccab8-2acf-410a-89c5-afe26ac35860, lint vrun-ed4e1024-6023-4ca6-86ef-363cc1ad3ebf, seams vrun-ea6f26b1-05ba-444e-82e8-06b2613f20fc, and format vrun-2ec4b305-7203-4710-902c-eee9e29df3d9.

The session dev server at localhost:3001 used the worktree-local .config datastore and three ticket114 fixture servers. Its actual discovery API returned ready inventories for stdio, authenticated HTTP and authenticated SSE. The HTTP authored allowlist displayed one of three tools enabled. Enabling the denied tool through the UI changed the count to two and persisted its explicit override in .config/mcp-global.json. The unrelated slow tool remained disabled. SSE displayed Cursor transport support and Codex unavailability. Next.js MCP reported no configuration or session errors.

Storybook at localhost:6006 and the actual configuration page were inspected with rendered screenshots, including desktop expanded rows and compatibility-chip wrapping at a 390px mobile viewport. The browser tool returned screenshots inline; its configured file-root restriction rejected saving them into this session path, so there is no screenshot file artifact.

The ticket114 fixture definitions and overrides were removed after verification, fixture servers and browser tabs were closed, and the session preview servers were stopped to free memory for validation.

The production worker bundle built successfully from this branch (370 modules) immediately before the authenticated test.

## Authenticated validation observed

Alex authorized the prepared five-turn matrix and the SDK's auxiliary filesystem access under ~/.cursor. The matrix ran against @cursor/sdk 1.0.28 on 2026-09-10 at 22:35 UTC. Vitest selected only src/lib/agent-backends/cursor/acceptance/mcp-parity.acceptance.test.ts in the cursor-acceptance project: one test file and one matrix test passed in 44.49 seconds, including 43.12 seconds of test execution.

| Turn | Configuration | Observed behavior |
| --- | --- | --- |
| 1 | Create with stdio, authenticated HTTP and authenticated SSE | Actual HTTP and SSE fixtures each executed allowed once; stdio returned the explicit environment marker. |
| 2 | Close the worker, resume its saved reference with the same map | HTTP and SSE each executed allowed again; stdio returned the same environment marker. |
| 3 | Replace the full map with a differently named HTTP server | The replacement tool executed once; SSE received no additional tool call. |
| 4 | Send an explicit empty map | Attempts to use prior and ambient tool names caused no additional upstream calls. |
| 5 | Create another agent with an empty map | The ambient server received no requests despite conflicting project configuration files. |

The independent ambient fixture was named both http (a collision with the inline map) and ambientOnly in scratch .cursor/mcp.json and .mcp.json files. Its total request count was zero. Final fixture call counts were HTTP 3 and SSE 2. All five worker outcomes were completed and each turn emitted inputAccepted. Native events contained neither the actual API credential nor the fixture bearer secret. These observations cover this account and these exercised turns; zero requests alone is not a universal provider guarantee of tool absence.

Evidence root: .cc/temp/cursor-mcp-live-20260910T223451Z. It contains console.log, published.jsonl, durable-state-summary.json, raw native events, scratch workspaces, SDK stores and logs. The test checked real server activity, not only model descriptions.

After the workers closed, the persisted SDK store contained two agents, both idle with checkpoint references and no activeRunId. Its five run records had provider status finished: turns 1–4 belonged to the resumed agent and turn 1 to the empty-create agent. This independently confirms the saved-reference resume sequence and terminal durable state. All five raw artifact byte counts and SHA-256 digests matched the published manifest.

| Raw artifact | Bytes | SHA-256 |
| --- | --- | --- |
| mcp-parity-869c4a1c-679d-4e71-9418-eb46f48ef883.jsonl | 21876 | 9987a584c05bfa699ef1057cb9d0df0c362ccfd865bb3c9ecda0a14f07bc5425 |
| mcp-parity-cfa62502-c768-4d88-bdc7-dcb31d19d0e3.jsonl | 17833 | 931376bcc71607b109a4ced0cedf77c71937cc1bdbdb9877848a8b32d736e09a |
| mcp-parity-64a81eea-edef-4d77-816a-7deb71759fbc.jsonl | 12309 | b8955079729ed544caf7fd18fe72a7e29accc5ceb2c4b0979689c98d5995496b |
| mcp-parity-c526794b-6e03-4937-a526-e8e2292c9569.jsonl | 32765 | 2b29a2f486e28685e3be355f5bca39588c1b5215a1ee2fbe9a7412edea640f40 |
| mcp-parity-16710f73-fc21-4021-b6c6-e8da11bda076.jsonl | 21367 | d44f2935f568aeb31adaaff5bf86f75618b92e45c1c994291ba359fbe535ffc3 |

The managing server registers format, lint, typecheck, seams and unit tests, but not cursor-acceptance. The authorized diagnostic launcher at .cc/temp/run-cursor-mcp.mjs used the existing acceptance credential gate and explicitly selected this one file with passWithNoTests false, one fork worker, and the cursor-acceptance project. Its console verdict confirms the test matched. A registered unit-test pass is not presented as authenticated evidence.

The live test closed every worker and fixture server in its cleanup. Existing user settings were not modified. The harness redirected configurable SDK workspace data and the agent store into the evidence root; Alex's authorization covered the SDK's remaining auxiliary ~/.cursor access.

## Remaining provider requirements

Installed SDK options.d.ts exposes native HTTP/SSE and headers but no startup/tool deadlines or per-tool MCP controls. The worker bridge enforces those controls before advertising tools and on every direct call. Explicit inline maps, including empty maps, select the SDK's inline MCP session path. The installed dist/esm/357.js createSessionMcpLease path disables project, user and plugin MCP loaders for an inline override. The live matrix confirms project-conflict suppression for this account across the exercised lifecycle.

The same SDK executor constructs authenticated dashboard services and sets respectAdminControls whenever an API key is present, independently of settingSources. No public AgentOptions switch disables those authenticated controls. A controlled team/admin policy fixture or a provider-supported effective-configuration/provenance contract is still needed to establish how those policies affect the resolved map. No dashboard policy was modified in this validation.

The public disallowedTools documentation (options.d.ts:295–323) explicitly limits exclusions to the main agent loop; subagents retain their own curated toolsets. CC's bridge enforces filters on every request to its endpoints, but this test does not prove the complete provider tool set or permission boundary of a delegated subagent. A provider permission test must exercise both the main agent and a real subagent, including resume, before claiming that boundary.

Remaining authority matrix rows are conflicting ambient user/MDM/plugin layers and authenticated team/admin policies, plus effective native permission behavior for main agents and subagents. Project layers, explicit empty configuration, full replacement, saved-reference resume, and explicit stdio environment delivery now have live evidence. Arbitrary environment exclusion, direct denied-tool calls, deadline enforcement, authentication failures, disconnects and error redaction have real MCP client/server tests at the bridge boundary. Those tests do not substitute for a provider-wide guarantee.

The apply receipt means CC prepared its bridge and dispatched the exact configuration with the turn. It does not assert that Cursor's later admin or permission checks accepted every tool. Likewise, the UI's compatibility label reports transport support. strictAuthoritativeConfig remains false, and ticket completion is not claimed.
