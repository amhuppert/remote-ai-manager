# Managed capabilities: design for the audit findings

Status: proposal, 22 September 2026. Responds to
[the managed capability audit](../reports/2026-09-22-managed-capabilities-audit.md)
under the constraints Alex set afterwards: stay inside `ENVELOPE.md`, keep
backend knowledge behind the backend facade, prefer availability over
disabling, disclose what CC cannot do through a subtle indicator, and do not
add complexity except to handle inherent complexity that is unhandled today.

A parallel proposal written by the source conversation on the same day lives at
[docs/reports/2026-09-22-managed-capabilities-design-proposal.md](../reports/2026-09-22-managed-capabilities-design-proposal.md).
The two agree on most points; the final section lists where they differ and
which points this document adopted from it.

## Summary

Five decisions cover every finding. Two of them delete machinery.

| Decision | One sentence |
|---|---|
| D1 | Every capability and MCP change applies at the next turn start, and "applied" is recorded only from what the runtime attests it launched with. |
| D2 | A backend's native inventory is the source of truth for discovery; CC keeps its own scanner only where no native inventory exists. |
| D3 | Disabling means remove from the model's context first, refuse the call second, disclose third; each backend uses the native lever that does the most of that. |
| D4 | One neutral "support note" vocabulary feeds one small indicator; info-level diagnostics move behind it and stop rendering inline. |
| D5 | Project conversations get the same MCP scope as session conversations. |

Treatment of the thirteen findings and four limitations:

| Treatment | Items |
|---|---|
| Fix as ordinary correctness | 1, 2, 3, 4, 5, 6, 10, 11 (parser half) |
| Replace with something simpler | 1 and 2 (recreation instead of two live paths), 6 (native `skills/list` instead of a scanner) |
| Accept and disclose | 8, 9, A, B, C, D, Cursor next-conversation timing |
| Defer until usage justifies it | 7, 11 (agent MCP half), 12, 13, Codex `plugin/list` |

Live usage checked on this machine on 22 September: one plugin ships an MCP
server (`ai-resources` → `web-debugger`); the project `.claude/settings.json`
enables a plugin the user settings do not (`typescript-lsp`), so finding 3 is
real; no Codex agents, symlinked user skills, SSE servers, timeout fields, tool
allowlists, frontmatter comments, or agent `mcpServers` declarations exist.

## Where complexity sits today

Scored with the design-philosophy diagnostics, the current capability design is
6/10. Three rows fail, and each maps to a finding.

- **Interfaces are not simpler than implementations.** A change travels
  through three timing vocabularies (`CapabilityApplyTiming`,
  `applySemantics`, `McpBetweenTurnApplyMode`), seven capability apply
  statuses, five MCP dispositions, and two runtime apply seams
  (`applyCapabilityConfig`, `applyPortableMcpConfig`) plus a receipt path.
  The UI renders the enum names raw (`idle-live-apply translator`).
- **Knowledge has more than one owner.** Claude's plugin baseline is read by
  discovery and by the adapter from user settings only, while the runtime
  loads user, project, and local settings (finding 3). Claude `Settings` are
  composed at creation and again, differently, on live apply (finding 4).
  Codex skill identity is computed by a CC filesystem walker while CC already
  calls the native `skills/list` for the command popup (finding 6).
- **Contracts are not what they promise.** "Applied" is written from a plan,
  not from the runtime (finding 2). `strictAuthoritativeConfig: true` holds
  while suppression can fail open (finding 8). `canUseTool` promises
  enforcement that `bypassPermissions` skips (finding 1).

The design below fixes those three rows without adding a layer. Target score
after delivery: 9/10. The remaining miss is that Cursor's frozen-per-conversation
catalog is a policy a newcomer cannot see from the interface; D4 discloses it
but does not remove it.

## D1. One application model: next turn start, attested by the runtime

### The promise

A change to capabilities or MCP is durable the moment it is saved and takes
effect at the start of the next turn. Nothing is applied while a conversation
is idle, because the model can only observe tooling when a turn runs; idle
application only pre-computes what turn start would do anyway. The one
exception that stays is Cursor skills, plugins, and agents, which remain fixed
for the life of a conversation (declared `next_conversation`, disclosed by D4).

### The mechanism

- **Desired tooling digest.** The shared pre-turn pipeline already resolves
  the capability cascade and the portable MCP config. It hashes both into one
  `toolingDigest` and adds that field to `DesiredRuntimeConfiguration` in
  `src/lib/workflows/conversation/pre-turn/runtime-recreate.ts`.
- **Runtime attestation.** `ConversationBackendRuntime` gains one read-only
  field, `launchDigest`: the digest of the tooling the runtime actually built
  its session or turn from. It generalizes the existing Cursor-only
  `capabilitiesAtCreation`.
- **Backend application is native and private.** Claude and Cursor MCP and
  Claude agents apply through the existing resume-preserving
  `recreate-runtime` path when the digest differs: the actor closes the runtime
  and recreates it from the persisted ref, exactly as it does today for a
  changed model or write policy. Codex rebuilds its options per turn and stamps
  the digest when it does. No new seam is introduced.
- **Recording reality.** The apply services write `applied` only when the
  runtime's `launchDigest` equals the desired digest after pre-turn; otherwise
  the change stays `pending`, or `deferred-next-conversation` where the
  descriptor declares that timing. A launch that dropped or altered something
  returns `notes` (dropped servers or fields, incomplete native suppression),
  which the service stores as the conversation's last apply notes for D4.

### What this deletes

- Claude `applyPortableMcpConfig`, `onPortableMcpApplied`, the
  `createPortableMcpFilterLookup` lookup, and the MCP branch of
  `native-tooling.ts` (`createCanUseTool`), which `bypassPermissions` skips.
- `buildNativeToolPolicies` and the remote `tools` policy emission in
  `mcp-translation.ts` (superseded by D3).
- The `live-when-idle` value of `McpBetweenTurnApplyMode` and the matching
  branch of `decideApplyDisposition`; when every backend declares next-turn,
  the field itself goes.
- The premature applied-hash write in `runtime-apply.ts` and the
  `input-accepted` receipt special case, both replaced by attestation.
- MCP dispositions collapse from five to three: `pending`, `applied`,
  `rejected`.

### What this relaxes, and needs Alex's decision

The MCP spec's requirement 5.5 prefers a backend's native live-update path
where one exists, and Claude's SDK does expose `setMcpServers`. This design
does not use it: per-tool hiding on Claude is creation-bound (D3), so a live
server-set path would have to coexist with recreation for tool changes. One
path is simpler and nothing observable is lost. Requirement 5.6 already
permits reconstruction at the next turn.

**Optional second step, also Alex's call:** retire Claude's idle live-apply of
skills and plugins (`applyFlagSettings` plus `reloadPlugins` while idle) and
fold it into the same turn-start attestation. That would delete the idle-drain
planner, the `staged-idle` status, the turn-active deferral in
`applyCapabilityConfig`, and, with it, the separate
`BackendRuntimeConfigAdapter` seam, leaving one pre-turn contract per runtime.
It is a deletion of working code and is not assumed by the rest of this
design. Recommendation: do it, because it removes a whole class of state and
the native calls can still be made at turn start instead of at idle.

## D2. Native inventory is the source of truth for discovery

### Discovery lives under each adapter

Today `agent-capabilities/claude-discovery.ts` and `codex-discovery.ts` read
provider files from above the backend seam, and `default-deps.ts` dispatches
to them through a table keyed by cascade kind. That is provider knowledge
outside the facade. The existing `CascadeDiscoveryProvider` contract moves onto
the descriptor as one optional facet, `capabilityDiscovery`, returning the
neutral `AgentCapabilityInventory`; each adapter directory owns its reader
(Cursor already works this way through its catalog). The dispatch table is
deleted and the shared code asks the registry. This is a relocation of
existing code, not new behavior, and the seam validator should be extended to
keep provider paths out of `agent-capabilities/`.

### Codex skills (finding 6)

Replace the filesystem walk in `agent-capabilities/codex-discovery.ts` with the
native inventory CC already consumes for the command popup:
`CodexSkillCatalog` over `skills/list`, which returns `name`, `path`, `scope`,
`enabled`, and `pluginId`. The catalog runs in a bounded app-server process
without a model turn, and the discovery cache already bounds how often it runs.

- `itemId` stays the native `name` (stable across machines); `nativeDefault`
  comes from the native `enabled`; `owningPluginId` from `pluginId`; the
  source ref carries the native `path`.
- Emission follows Claude's existing convention: only rows with a CC decision
  (`originLayer !== "native"`) become `skills.config` entries, so an
  untouched skill keeps its native state. Entries select by `path` from the
  inventory, which is exact even when two skills share a name; a shared name
  is one CC override applied to both, disclosed on the row.
- Symlinked and non-default roots come for free. The walker and its
  `CODEX_SKILL_DISCOVERY_PATHS` are deleted.
- Codex plugins keep the current filesystem discovery until `plugin/list`
  leaves "under development".

### Claude (findings 3 and 4)

The SDK has no at-rest inventory call, so the file scan stays, with one owner
per fact:

- `plugin-native-records.ts` reads user, project, and local settings and
  merges `enabledPlugins` with Claude's precedence (local over project over
  user). Discovery and translation both call it; the adapter never reads
  settings itself. A CC override equal to the effective native state is still
  omitted, but now against the effective state.
- Children of every installed plugin are scanned regardless of native
  enablement; a child's `nativeDefault` is its parent's effective state. The
  resolver's existing parent-disable inheritance then does the right thing
  when CC enables a natively disabled plugin.
- Plugin child ids are the qualified `<plugin>:<name>` Claude itself uses for
  skills, and the live probe merges by that id only, so runtime discoveries
  never append an unowned duplicate. Verify the qualified form against
  `supportedCommands()` during implementation.
- One `composeClaudeSettings(resolved, managedSkills)` function produces the
  `Settings` object for both creation and live apply, so the managed-bundle
  suppression of the old installed CC plugin is merged every time.

### Cursor (finding 11)

Keep the catalog; there is no native selective inventory. Fix the shared
frontmatter parser in `src/lib/commands/frontmatter.ts` to skip comment lines,
which all three backends' discovery share.

## D3. Disabling removes from context first, refuses second, discloses third

| Backend | Skills and plugins | Agents | MCP servers | Individual MCP tools |
|---|---|---|---|---|
| Claude | Native flag layer (unchanged); plugin-owned skills disclosed as not individually controllable | `PreToolUse` hook denies `Agent`/`Task` for a disabled `subagent_type`; description stays in context (disclosed) | Omitted from `mcpServers` at launch (unchanged) | `disallowedTools` with `mcp__<server>__<tool>` names at launch: removed from context, independent of transport and permission mode |
| Codex | Native `skills.config` and `plugins` (D2) | Not managed (disclosed) | Native `enabled` (unchanged) | Native `enabled_tools` / `disabled_tools` (unchanged) |
| Cursor | Selected catalog at conversation start (unchanged, disclosed) | Explicit definitions at creation (unchanged) | Omitted from the bridge map (unchanged) | Bridge filters inventory and invocation (unchanged) |

Details that change:

- **Claude tools (finding 1).** Hiding a tool is the goal, and
  `disallowedTools` is the native lever that does it for stdio and remote
  servers alike. The per-tool deny list is computed from the portable config's
  `disabledTools`. A definition-level allowlist (`enabledTools`) has no
  hiding equivalent on Claude without the tool inventory, so it becomes a
  server diagnostic ("Claude applies disabled tools only"); nothing on this
  machine uses one.
- **Claude agents (finding 1).** The hook replaces the `canUseTool`
  composition and recognizes both `Agent` and `Task`. Hooks resolve before the
  permission layer, so `bypassPermissions` does not skip them; this is the one
  claim below that needs a live check. Because the hook is bound at launch and
  D1 recreates on change, Claude agents move from `next_conversation` to
  `next_turn`.
- **Claude MCP fields (finding 5).** `toolTimeoutSec` maps to the SDK's
  per-server `timeout` in milliseconds. `startupTimeoutSec` has no field: the
  field is dropped and noted, the server is kept. Nothing rejects a whole
  server for a representable field.
- **Codex suppression (finding 8).** When `codex mcp list` fails or skips
  entries, the turn proceeds (availability first) and the launch notes record
  "native MCP servers may also be attached this turn". The descriptor keeps
  `strictAuthoritativeConfig: true` for the normal case; the exception is
  reported per conversation rather than pretended away.
- **Plugin-owned skills on Claude (limitation A).** Their rows report
  `unsupported` with the note "part of plugin X; Claude applies individual
  toggles to standalone skills only; disable the plugin to remove it". No
  `skillOverrides` entry is emitted for them.
- **Plugin-provided MCP servers (finding 9).** CC keeps not delivering them.
  Discovery reads the server names from a local plugin's `.mcp.json` so the
  plugin row can say "this plugin's MCP servers (web-debugger) are not
  attached by Command Center; add them to the CC MCP file to use them". If
  that note starts mattering, the growth path is importing them into the MCP
  inventory with plugin ownership; today one server on one machine does not
  justify the cross-backend plugin identity that would require.

## D4. Disclosure: one vocabulary, one indicator

### Data

- `AgentCapabilityMetadata` gains `notes: readonly string[]`, authored by the
  backend adapter in plain language, describing delivery and timing for that
  cascade (for example, Cursor: "Loaded as a selected catalog when the
  conversation starts. Changes apply to new conversations. Native plugin
  hooks, rules, and commands are not applied."). The raw enum label leaves the
  header.
- Rows keep `applyStatus` and `diagnostics`. Info-severity diagnostics become
  the row's notes; warning and error diagnostics remain inline because they
  ask for action.
- MCP server rows already carry `compatibility.backends[].reason`; the
  conversation-level view carries the last launch notes from D1.
- A backend with no cascade for a kind declares that absence once
  (`"Codex sub-agents are not managed by Command Center"`) so the panel can
  say so instead of showing nothing.

### UI

- One primitive, `SupportIndicator`, in `src/components/ui/`: a small tertiary
  info glyph that is a real button with an accessible label. Hover or keyboard
  focus shows the first note in the existing Tooltip; click or tap opens the
  existing Popover with every note. It renders nothing when there are no
  notes.
- Placement: after the cascade title; after a row's name only when that row
  has notes or is `unsupported`; on MCP server rows for compatibility; on the
  MCP panel header for conversation-level launch notes.
- Removed: the raw metadata label, inline rendering of info diagnostics, and
  the "verification gated" and "diagnostic only" wording, which becomes notes.
- Status chips stay only for states that need attention: `pending`,
  `deferred to next conversation`, and `failed`. A change that applied
  normally shows no chip; success is the quiet default.

## D5. Project conversations get a real MCP scope (finding 10)

Persistence already exists: the shared conversation row codec stores
`mcpOverrides` and `mcpRuntimeApplicationState` for project conversations.
The gap is routing and reads.

- Add `/api/projects/[name]/conversations/[conversationId]/mcp-config` and its
  `tools/[serverKey]` leaf, mirroring the agent-capabilities project
  conversation routes and joining the route-contract inventories in
  `CONTEXT.md`.
- `ComposePortableMcpDeps.readConversationOverrides` takes a
  `ConversationTarget` and reads the project conversation record for project
  scope instead of a session record.
- Global and project fanout enumerate project conversations alongside session
  conversations.
- `McpCapabilityPanelContainer` stops mapping a project conversation to
  project scope and uses the same `conversationCapabilityScope` the
  capability panels use.

## Deliberately unhandled

- Codex agents cascade (finding 7): no agents exist on this machine, and the
  native schema has no per-role enable flag. Disclosed once.
- Codex `skills/extraRoots/set` (finding 12): would add a second delivery path
  while exec-based tasks still need the checkout link. The bridge stays; a
  path collision now logs at error level and appears in launch notes instead
  of passing silently.
- Cursor tool-list-change subscriptions (finding 13): the bridge reconnects on
  configuration change, which covers the realistic case.
- Cursor agent `mcpServers` frontmatter (finding 11, second half): no usage;
  the existing diagnostic already discloses it.
- Malformed entries in `codex mcp list` output: counted into the "incomplete
  suppression" note, not individually handled.
- Codex legacy SSE transport (limitation B) and Cursor provider policy
  (limitation D): already declared through the compatibility registry.

## Complexity accounting

Estimates from the current files; exact counts belong to the delivery plan.

| Change | Lines removed | Lines added |
|---|---|---|
| Codex native skill inventory replaces the walker (D2) | ~350 | ~60 |
| Claude live MCP path, permission-layer MCP filter, remote tool policies (D1, D3) | ~180 | ~70 (`disallowedTools`, hook) |
| Live-when-idle MCP branch, receipt path, premature applied write (D1) | ~80 | ~60 (digest, attestation) |
| Claude settings composer and effective plugin baseline (D2) | ~40 | ~60 |
| Project-conversation MCP routes and reads (D5) | 0 | ~150 (mirrors existing) |
| Support notes and indicator (D4) | ~60 | ~120 |
| Optional: retire idle live-apply and the runtime-config seam (D1 step 2) | ~450 | ~40 |

Every addition either owns a fact that had two owners or adds a route that
mirrors an existing one. No new orchestration layer, state machine, or
abstraction is introduced.

## Delivery order

1. **D5 project-conversation MCP** and the **frontmatter parser fix**: pure
   correctness, no seam changes, TDD from failing route and parser tests.
2. **D2 Claude baseline and settings composer**: failing tests reproduce the
   project-settings baseline case and the lost host suppression.
3. **D3 Claude `disallowedTools` and hook** plus **D1 digest and
   attestation**: introduces `launchDigest`, adds `toolingDigest` to the
   recreation comparison, deletes the live MCP path. Run `seams` and
   `typecheck`; the runtime interface changes.
4. **D2 Codex native inventory**: delete the walker after the catalog-backed
   provider passes the same contract tests.
5. **D4 indicator and notes**: `ui-primitive` for `SupportIndicator`, then the
   panel migrations.
6. **Optional D1 step 2** only with Alex's explicit approval.

Live checks the design depends on, each a single conversation:

- A `PreToolUse` hook deny blocks an `Agent` call under `bypassPermissions`.
- `disallowedTools` with an `mcp__<server>__<tool>` name removes the tool from
  the model's tool list in the init message.
- `supportedCommands()` reports plugin skills in the qualified form the
  discovery ids use.
- Codex accepts `skills.config` entries that select by `path`.
- A resume-preserving Claude recreation after an MCP change resumes cleanly
  (the known resume hazard concerns sessions that died with background tasks,
  not a controlled close; confirm).

## Governing specifications

The legacy MCP and agent-capabilities specifications promise idle live-apply
for Claude and prefer native live update where it exists. Whatever Alex
accepts below should be carried into those requirements before implementation
starts, so the specification and the code do not disagree.

## Decisions requested from Alex

1. Accept next-turn application for Claude MCP and agents through runtime
   recreation instead of `setMcpServers` plus a live tool filter (relaxes MCP
   spec 5.5, permitted by 5.6). Recommended.
2. Approve the optional deletion of Claude idle live-apply and the
   `BackendRuntimeConfigAdapter` seam. Recommended, separately approvable.
3. Confirm disclose-only handling of plugin-provided MCP servers for now.
   Recommended.

## Comparison with the parallel proposal

Both documents keep the inheritance model, complete project-conversation MCP
scope through `ConversationTarget`, consolidate discovery and native baselines
behind the facade, replace the Codex filesystem scanner with the native
`skills/list` inventory, make "applied" mean what the runtime accepted, prefer
Claude `disallowedTools` for context removal, let plugin-owned Claude skills
follow their parent, keep Cursor's timing, and use one small info control for
limitations. This document adopted three points from the other: relocating
discovery under each adapter through a descriptor facet, revising the
governing specifications when decisions are accepted, and showing no chip on
normal success.

The substantive differences, with this document's recommendation:

| Topic | Other proposal | This document | Recommendation |
|---|---|---|---|
| Native and plugin MCP servers | Stop Claude strict-source and Codex unknown-server suppression for ordinary conversations; deliver plugin MCP natively; import Cursor plugin MCP into the bridge; adapters must distinguish known-disabled from unknown-native and prevent duplicate connections | Keep suppression; disclose per plugin which servers are not attached; import later if usage grows | Disclose now. One server on one machine does not pay for native-versus-managed precedence and duplicate-connection handling, and the repo `.mcp.json` is already read by both CC and Claude, so lifting strict mode creates exactly that duplicate. Revisit when a second plugin ships MCP. |
| Claude MCP updates | `setMcpServers` for server edits; an edit that also changes creation-only exclusions waits for a new conversation | No live path; any MCP or agent change recreates the runtime at the next turn, so exclusions also apply next turn | Recreation. One mechanism instead of two boundaries, faster effect for exclusions, and it deletes the live path and the callback filter. Cost: one process restart at the next turn after a change. |
| Claude agent toggles | Read-only and descriptive unless a probe proves a useful exclusion; no call-denial hook for context control | Keep the toggle; a `PreToolUse` hook refuses disabled agents; the note says the description stays in context | Keep the toggle with the honest note. The hook replaces the broken callback line for line, so complexity is neutral. If the live check fails, fall back to read-only as the other proposal suggests. |
| Codex agents | One selectable group with descriptive roles | Not managed; disclosed once | Not managed. No agents exist on this machine; a group toggle adds a cascade kind for nothing. |
| Codex managed skills | `skills/extraRoots/set` for conversations, bridge for tasks | Bridge for both, loud on collision | Bridge. Two delivery paths for one bundle is the kind of duplication the rest of this design removes. |
| Cursor plugin MCP and agent `mcpServers` | Add both through the resolved server map | Defer; existing diagnostics disclose | Defer. No agent declares `mcpServers` and no Cursor plugin is installed. |
| Cursor frontmatter | A proper YAML parser | Skip comment lines in the shared line parser | Line parser. The current parser already handles block scalars; comments are the only observed gap and no file on this machine has one. |
