Managed capabilities implementation — 22 September 2026

Implements the approved first delivery in the [revised design](2026-09-22-managed-capabilities-design-proposal.md). The [legacy MCP](../../.kiro/specs/mcp-configuration/design.md) and [capability](../../.kiro/specs/agent-capabilities-configuration/design.md) specs record the amendment and conversation approval without changing historical approval records.

Delivered behavior

- Project conversations own MCP overrides, runtime state, tools queries, mutations, and invalidation. Project/global changes fan out to both conversation scopes; SQLite reload tests prove sibling isolation.
- Saves retain requested preferences. Ordinary application runs at the next turn; idle mutation and its duplicate scheduling path are removed. MCP and individual capability kinds record actual acceptance separately. Deferred/failed/partial delivery retains pending intent, and accepted-input events refresh the UI. Concurrent saves survive earlier deliveries, including across separate service instances.
- Claude discovery uses effective user/project/local plugin settings, qualified plugin children, and independent child defaults. One settings composer preserves CC's managed plugin suppression during both launch and updates.
- Codex discovery uses the complete native catalog, native names and paths, and effective config selectors. Source-specific IDs preserve identity across equivalent worktrees; explicit changes merge with effective native disabled selectors. Unmatched old preferences stay visible instead of being reassigned by name. A managed-skills bridge failure is visible as a nonfatal conversation notice.
- Discovery, delivery snapshots, control support, and MCP metadata live behind the backend facade. Unsupported individual Claude agents/plugin skills retain their saved preferences but are not emitted as successful controls. Cursor's frozen capability snapshot remains independent of its next-input MCP configuration.
- The first delivery represents control support with a typed `configurable` flag, adapter-authored notes, and existing timing/delivery fields. No invocation-only blocking control ships, so it does not add the proposed three-way selection-effect enum; unsupported controls are read-only and resettable.
- Claude external MCP servers enter through `setMcpServers` from launch onward. The installed SDK does not remove initial static-option servers by omission from later mutations; using one mutable set fixes additions/removals without closing the process. Exact tool exclusions remain creation options. Changing exclusions for an enabled server defers the entire configuration to a new conversation; removing a server with old exclusions still applies next turn.
- Claude tool timeouts map to native milliseconds. Unsupported startup timing and allowlists are disclosed while retaining useful server availability; essential launch/authentication fields still produce explicit configuration errors when unsupported.
- A focused frontmatter fix ignores comments containing colons while retaining hashes inside indented blocks.
- Small accessible information controls expose limitations. Saved/current differences, pending boundaries, and failures remain clear; normal success has no extra status chip. Desktop/mobile layouts, hover, keyboard focus, Enter/Escape, focus return, and touch were inspected in the session Storybook.

Native verification

Installed SDKs: Claude `0.3.257`, Codex `0.153.3`.

The Claude probe ran the actual SDK subprocess and external MCP servers against a local HTTP endpoint that recorded outbound model tool definitions. With the production permission-bypass mode, the visible tool remained and the excluded tool was absent for stdio, Streamable HTTP, and SSE. A two-input probe confirmed `setMcpServers` removes the original dynamically attached server and advertises the replacement without restarting the subprocess. No paid model response was used. SDK in-process host tools did not follow the same exclusion path; CC's mandatory host capabilities remain outside user toggles.

The Codex probe used native `skills/list` and `config/read` against a temporary project. It found native names differing from directory names, preserved an existing disabled skill while enabling another, and verified the exact path selector omits only the intended skill. Native catalog enabled flags alone did not reflect all effective selectors, so the adapter normalizes the complete catalog against effective native configuration.

Probe sources are retained as local artifacts under `.cc/temp/managed-capabilities-probe/` and `.cc/temp/probe-codex-catalog.ts`. UI screenshots are `.cc/temp/capability-controls-{desktop,mobile-info}.png` and `.cc/temp/mcp-controls-{desktop,mobile-info}.png`.

Validation

Focused failing reproductions preceded behavioral fixes; coverage includes durable scope isolation, concurrent preference/receipt ordering, deferred and partial delivery, native defaults and selectors, supported controls, and UI publication.

| Check | Result | Run |
|---|---|---|
| Combined changed-scope regression | 1,298 files passed; three skipped; one outdated assertion failed (corrected below) | `vrun-c65c6dbe-ede1-4f96-ba89-d6fa75b6b5b2` |
| Corrected consumer-locality test file | Passed; one file matched with `--require-match` | `vrun-54758df5-6897-45aa-8e30-22396800d9a1` |
| Typecheck (full) | Passed | `vrun-d17a0caf-9dc7-459a-b429-11250b1f32fc` |
| Lint (changed) | Passed | `vrun-153656de-db40-407b-ae4b-cbf09f4e54ce` |
| Architecture seams (full) | Passed | `vrun-ba2e3f4c-3d41-4f1a-821b-7acc4c603cc9` |
| Format (changed) | Passed | `vrun-b5ddd25a-5aa8-405a-8083-e92ce378982b` |

The combined run completed all 1,302 selected files: 20,181 tests passed, eight were skipped, and one failed. That final assertion in `consumer-locality.test.ts` expected a deferred MCP configuration to advance the applied hash. It now verifies that the configuration remains pending without an acceptance receipt. No production code changed after this complete regression run. The corrected file passed its focused rerun; all 1,299 unskipped files therefore have passing evidence across these two runs. The entire combined command was not repeated after this test-only correction.

Architecture baselines were reduced: backend identity branches from five to two (the historical migration), and backend implementation imports from one to zero. No ceiling was raised.

The scoped design assessment is approximately **7.5/10**: six of the eight software-design-philosophy diagnostics pass. Backend ownership and duplicate idle scheduling improved. Two diagnostics remain below the target: interface simplicity (capability and MCP application bookkeeping still expose several related state concepts), and understanding boundaries without reading implementations (historical timing/status vocabulary coexists with acceptance receipts). Reaching 10/10 would require simplifying that existing state surface and consolidating its contract documentation while preserving independent acknowledgments. This delivery does not add another abstraction solely to improve the score.

UI verification used the session Storybook at 1280×900 and 390×844, with no browser console warnings or errors. Native probes and screenshots supplement the automated checks; no authenticated model-conversation matrix across all three backends was run.

Bounded follow-ups

Native plugin MCP delivery/precedence remains a separate availability slice; plugin MCP is not automatically imported and the UI directs users to canonical MCP configuration. Codex agent controls, structured Cursor agent MCP references, generic plugin importing, full YAML parsing, dynamic inventory synchronization, and a replacement Codex host-skill bridge remain deferred as designed. Claude same-name standalone skills follow native name precedence. This delivery adds no security enforcement layer, runtime recreation for ordinary settings changes, or compatibility alias registry.
