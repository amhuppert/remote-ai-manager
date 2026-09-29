# Cursor–Claude parity audit — 2026-09-29

Cursor has broad application coverage, but incomplete Claude parity. Ordinary conversations, project conversations, tasks, graph workflows, collaboration, images, model selection, structured-output validation, and most agent-assisted features are integrated. The largest extension gaps are skill compatibility and discovery, native plugin behavior, and functionality lost through Cursor's MCP bridge.

This audit examines commit `f1a300beca0ce26632266eee9a117f84effdbb80`, with installed `@cursor/sdk` **1.0.31** and `@anthropic-ai/claude-agent-sdk` **0.3.284**. Findings come from current production paths, installed SDK contracts, and a fresh scoped test run. No authenticated model turns or browser flows were run; previous live results are identified as historical. Application code and live configuration were not changed.

| Area | Assessment | Practical consequence |
| --- | --- | --- |
| Managed Command Center skills | Available, different delivery | Cursor receives a catalog instructing it to read skill files; Claude receives a native SDK plugin. |
| User/project skills | Partial parity | Different search roots, rejected metadata, frozen selection, and a catalog size ceiling. |
| Plugins | Limited subset | Cursor imports supported skills and agents from local plugins, without native plugin behavior. |
| MCP tools and transports | Broad parity | stdio, HTTP, SSE, configuration overrides, filtering, and deadlines work through CC's bridge. |
| Other MCP functionality and status | Incomplete | Resources are not forwarded; tool inventory can become stale; startup failures can still receive an applied receipt. |
| Application features | Broad coverage with weaker guarantees | Checkpoints are absent; context metrics, post-turn background completion, confinement, and some provider controls differ. |

**1. Skills are available to Cursor, but not in the same way as Claude.**

Both normal execution facets receive the managed Command Center skill bundle. All 12 bundled skills satisfy Cursor's catalog restrictions. Hermetic, isolated one-shot tasks intentionally omit skills and tooling.

Claude attaches the managed bundle as a native SDK-local plugin. Cursor builds a metadata catalog containing skill names, descriptions, and file paths, with an instruction to read `SKILL.md` when relevant. It does not send native skill objects. The catalog is delivered in user-message text, so neither delivery receipts nor an enabled capability row establish that the model actually read a skill.

Sources: [Claude attachment](../../src/lib/agent-backends/claude/managed-skills.ts), lines 50–58; [Cursor catalog rendering](../../src/lib/agent-backends/cursor/capability-catalog.ts), lines 374–401; [Cursor prompt construction](../../src/lib/agent-backends/cursor/conversation-runtime.ts), lines 1915–1934.

Four material compatibility gaps remain:

- **Existing Claude installations do not automatically carry over.** Cursor scans user/project `.cursor/skills` and `.agents/skills`; it does not scan `.claude/skills` or Claude's installed-plugin inventory. A shared `.agents/skills` copy can make a plain skill discoverable, subject to the restrictions below.
- **Extra frontmatter can remove the entire skill.** Cursor accepts only `name`, `description`, `license`, and `compatibility`. Fields such as `metadata`, `argument-hint`, `user-invocable`, `disable-model-invocation`, or `allowed-tools` cause omission with a diagnostic. Some require behavioral support, but even `metadata` is rejected. In this checkout, 15 of 17 immediate `.agents/skills/*/SKILL.md` files pass; `kiro-steering` and `kiro-steering-custom` are excluded for their metadata blocks. The parser also flattens their nested `shared-rules` key into an unsupported field. Claude's discovery does not impose this rejection.
- **Changes require a new conversation.** Cursor persists the selected catalog and agents in `cc-capabilities.json` and reuses that snapshot on resume. Restarting the runtime does not adopt new enablement choices or a new managed-bundle catalog. Claude declares next-turn application for skills/plugins. Skill file contents themselves are not snapshotted, so this is selection/catalog freezing, not immutable user-skill contents.
- **The catalog can block launch.** It has a hard **16,384-character** ceiling, with no paging or fallback. Exceeding it throws an error asking the user to disable skills. Earlier documentation calls this 16 KiB, but the implementation counts JavaScript string length.

Sources: [Cursor discovery and filtering](../../src/lib/agent-backends/cursor/capability-catalog.ts), lines 155–181, 235–245, 397–400; [snapshot reuse](../../src/lib/agent-backends/cursor/capability-delivery.ts), lines 57–95; [Claude capability timing](../../src/lib/agent-backends/claude/descriptor.ts), lines 94–117; [Claude skill discovery](../../src/lib/agent-backends/claude/capability-discovery.ts), lines 374–418.

**2. Cursor plugin support is a component importer, not native plugin parity.**

Cursor discovers only `~/.cursor/plugins/local/<directory>`. It accepts `.cursor-plugin/plugin.json`, `.claude-plugin/plugin.json`, or `plugin.json` inside those directories. It does not import Cursor marketplace/cache activation, Claude's installed-plugin registry, or native plugin enablement. Discovered entries start enabled and then pass through CC's capability overrides. Symlinks escaping the local-plugin root are rejected, so linking a Claude cache entry there is not a supported shortcut.

Only supported **skills and agent definitions** are imported. Plugin **hooks, rules, commands, MCP servers, variables, and other behavior are omitted**, with a diagnostic. Skill-derived slash entries still work through the catalog, but that does not implement a plugin's separate command definitions. Agent definitions are also narrowed: unsupported frontmatter, including tool-policy fields, causes omission; accepted descriptions, body prompts, and models are passed to SDK `agents`.

Claude reads native user/project/local `enabledPlugins`, joins it to `~/.claude/plugins/installed_plugins.json`, and uses native SDK loading. Cursor deliberately disables ambient setting sources and substitutes CC's subset. The installed Cursor SDK includes plugin setting sources and native skill/plugin machinery, so these omissions should not all be classified as SDK impossibilities. Enabling native loading would still need to preserve CC's selection and isolation contracts.

Sources: [Cursor plugin scan](../../src/lib/agent-backends/cursor/capability-catalog.ts), lines 245–333; [discovery defaults and disclosure](../../src/lib/agent-backends/cursor/capability-discovery.ts), lines 20–40; [Cursor launch policy](../../src/lib/agent-backends/cursor/policy.ts), line 43; [Claude native records](../../src/lib/agent-backends/claude/runtime-config/plugin-native-records.ts), lines 76–96; [Claude plugin discovery](../../src/lib/agent-backends/claude/capability-discovery.ts), lines 271–348.

A useful counterexample to a simple feature ranking: Cursor can select individual imported agents and plugin skills, while Claude's native integration cannot independently disable every plugin child. Nevertheless, enabling the same plugin name on both backends does not imply equivalent behavior.

**3. MCP transport support is substantial; the remaining gaps are above transport level.**

Both backends consume CC's global `<config-dir>/.mcp.json` and the active worktree's root `.mcp.json`, followed by global → project → session → conversation overrides. Native `.cursor/mcp.json` is not automatically imported. Cursor supports stdio, streamable HTTP, SSE, explicit environment/cwd, headers, bearer credentials, server enablement, per-tool filtering, and startup/tool deadlines. Standard task execution uses the same runtime; isolated tasks intentionally receive no MCP tooling.

Some portable controls are stronger on Cursor: its bridge supports fields such as `cwd` and bearer-token environment references that Claude's translator rejects. OAuth-shaped `auth` configuration is unsupported by the shared discovery layer on both backends, so it is not a Cursor-specific defect.

Sources: [shared discovery](../../src/lib/mcp/discovery-command-center.ts), lines 63–76 and 296; [override composition](../../src/lib/mcp/compose-for-conversation.ts), line 125; [portable translation](../../src/lib/agent-backends/mcp-translation.ts), line 120; [Cursor translation](../../src/lib/agent-backends/cursor/mcp-translation.ts).

The remaining MCP findings are:

| Finding | Impact and evidence |
| --- | --- |
| **Failed startup can be reported as applied** | The bridge omits failed servers, but only warns the model and worker log. Cursor emits the requested configuration hash without `mcpConfigError`; the shared receipt clears pending/error state and writes `applied_now`. Claude propagates configuration errors. This is a concrete CC observability defect. Sources: [bridge](../../src/lib/agent-backends/cursor/worker/mcp-bridge.ts), line 254; [SDK wrapper](../../src/lib/agent-backends/cursor/worker/sdk-port.ts), line 177; [Cursor receipt](../../src/lib/agent-backends/cursor/conversation-runtime.ts), line 1463; [shared receipt](../../src/lib/mcp/runtime-apply.ts), line 534; [Claude receipt](../../src/lib/agent-backends/claude/conversation-runtime.ts), line 419. |
| **Resources are not forwarded** | Cursor's bridge advertises only tools and implements only `tools/list` and `tools/call`; resources, resource templates, reads, and prompts have no forwarding handlers. Claude connects directly and its SDK exposes resource tools. CC's bridge is a confirmed blocker; actual Cursor resource usability after fixing it needs live verification. Claude prompt-command exposure was not established. Source: [bridge](../../src/lib/agent-backends/cursor/worker/mcp-bridge.ts), lines 133–142. |
| **Tool inventory can become stale** | Tools are captured at bridge startup. Identical configuration reuses the bridge on later turns; there is no `tools/list_changed` handling, and CC does not rebuild or invalidate the bridge on tool-call failure. A UI refresh performs a separate probe and does not refresh this runtime. Startup failures do get retried next turn. Sources: [inventory snapshot](../../src/lib/agent-backends/cursor/worker/mcp-bridge.ts), line 237; [bridge reuse](../../src/lib/agent-backends/cursor/worker/sdk-port.ts), lines 169–178. |
| **Tool error details are erased** | Every `isError` result becomes a generic availability/configuration message, losing validation hints and structured error content even when the server is healthy. This is deliberate secret protection applied too broadly, with a recovery-quality cost. Source: [error replacement](../../src/lib/agent-backends/cursor/worker/mcp-bridge.ts), lines 167–176. |
| **Different timing and authority** | Cursor applies MCP changes next turn, rather than Claude's live idle-runtime updates; some Claude tool-filter changes also require a new conversation. Cursor cannot guarantee its supplied map is authoritative over provider administration. Sources: [Cursor MCP capabilities](../../src/lib/agent-backends/cursor/mcp-capabilities.ts); [Claude apply](../../src/lib/agent-backends/claude/conversation-runtime.ts), lines 657–676; [strict Claude config](../../src/lib/agent-backends/claude/query-session.ts), line 646. |

Two qualifications prevent overstating Claude parity: the current inventory UI uses a separate direct probe for **both** backends, not Claude's runtime inventory method; and neither shared inventory imports plugin MCP. Cursor definitely omits plugin MCP, but whether Claude-native plugin servers remain accessible under strict configuration was not live-verified. The Claude SDK describes plugin-owned servers surviving `setMcpServers`, so shared-inventory absence alone cannot settle that question.

**4. Other material differences remain.**

| Area | Current gap |
| --- | --- |
| Governing instructions | Cursor places them in user-message text. The installed SDK now exposes a server-gated `systemPrompt` option, but CC does not pass it. It replaces the entire main-agent harness, leaves subagents unchanged, and must be reapplied on resume; account access is untested. The earlier claim that no SDK field exists is stale. See [SDK options](../../node_modules/@cursor/sdk/dist/esm/options.d.ts), lines 368–388; [CC adapter](../../src/lib/agent-backends/cursor/worker/sdk-port.ts), lines 99–121. |
| Confinement and approvals | Cursor disables sandbox and auto-review and expresses write/network restrictions as instructions. Exact path ownership and read-only policies therefore have weaker guarantees than Claude. The SDK's sandbox option still lacks a path allowlist. See [policy](../../src/lib/agent-backends/cursor/policy.ts), lines 30–43; [instruction translation](../../src/lib/agent-backends/cursor/runtime-policy.ts), lines 57–91. |
| Checkpoints and forks | Cursor checkpoints, checkpoint forks, and handoff capture are disabled pending continuation evidence; do not infer SDK impossibility. Ordinary forks seed bounded visible transcript text rather than native provider state. See [descriptor](../../src/lib/agent-backends/cursor/descriptor.ts), lines 136–151; [synthetic fork](../../src/lib/agent-backends/cursor/continuity.ts), lines 370–392. |
| Context and background work | No numeric context occupancy/window metrics. Native summary observation supplies a weaker signal, not confirmed compaction completion. Subagents work within a turn, but CC cannot observe post-turn completion or wake the conversation; unfinished tasks are marked lost. See [descriptor](../../src/lib/agent-backends/cursor/descriptor.ts), lines 139–144; [background contract](../../src/lib/agent-backends/cursor/background-tasks.ts), lines 123–126. |
| Native memory | CC cannot disable or verify Cursor's provider memory; the shared-memory policy is advisory. Claude applies native disable settings. See [Cursor declaration](../../src/lib/agent-backends/cursor/descriptor.ts), lines 69–72. |
| Interaction | Live steering is text-only; attachments wait for the next turn. CC's custom question tool works, but expires after five minutes and does not reconnect across restart. Native Cursor questions remain denied. See [steering](../../src/lib/agent-backends/cursor/conversation-runtime.ts), lines 350–365; [question bridge](../../src/lib/agent-backends/cursor/worker/question-bridge.ts). |
| Credentials | Cursor strips inherited credential-shaped environment variables; Claude inherits the server environment. Scripts relying on ambient credentials can therefore work under Claude and fail under Cursor. Explicit MCP credentials and CC's own session contract still work. See [documented launch contract](../cursor-backend.md). |
| Cost | Exact per-turn billing attribution is unavailable, and an account without usage-endpoint access has unknown dollar cost. The previously observed account refusal was not retested. See [billing ledger](../../src/lib/agent-backends/cursor/billing-ledger.ts). |
| Quick Ticket enrichment | The earlier live audit saw two over-budget responses fail without a triage note. The current 2 KiB, single-turn, fail-closed implementation remains, but those historical failures do not establish that every current Cursor request fails. See [enrichment](../../src/lib/tickets/enrichment.ts), lines 220–232 and 271–277. |

**5. Evidence and recommended order of work.**

The [September 21 report](2026-09-21-cursor-parity-final-validation.md) reports 45 verified rows and 9 unresolved rows. This is not a percentage of Claude parity: a row can be verified while documenting a reduced substitute, or even an unavailable feature. Its matrix tests check coverage, descriptor consistency, document consistency, and evidence references; they do not prove native plugin equivalence or SDK limitations. The now-stale `systemPrompt` assertion illustrates that distinction.

Fresh registered validation passed **six explicitly matched test files**, run `vrun-35b1e2e6-1f9a-4afd-bad9-b50c398a100b`:

- `src/lib/agent-backends/cursor/capability-catalog.test.ts`
- `src/lib/agent-backends/cursor/capability-delivery.test.ts`
- `src/lib/agent-capabilities/cursor-runtime-state.test.ts`
- `src/lib/agent-backends/cursor/mcp-translation.test.ts`
- `src/lib/agent-backends/cursor/worker/mcp-bridge.test.ts`
- `src/lib/agent-backends/cursor/acceptance/parity-matrix.test.ts`

These passing tests support the existing delivery paths; they do not refute the missing behaviors identified above. No implementation change was made, so there was no red-green-refactor cycle.

Recommended order:

1. Make skill/plugin availability predictable: accept harmless metadata, disclose omitted behavior, and decide how existing user installations should be shared across backends.
2. Propagate actual MCP startup failures into durable runtime state and the UI.
3. Extend MCP beyond the current static tool bridge: resources, inventory change handling, recovery after disconnects, and useful sanitized error details.
4. Decide whether native Cursor plugin loading or a broader CC importer should supply hooks, commands, rules, and plugin MCP; verify that choice with representative real plugins.
5. Revisit skill refresh and catalog scaling, then test the gated system-prompt mechanism and checkpoint continuation rather than treating old provider-limit claims as permanent.

This is an audit and proposed work order, not a claim that the gaps have been fixed.
