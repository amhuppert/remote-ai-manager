Managed capabilities — design proposal, 22 September 2026; revised after alternative-design review

Alex, I recommend **native availability by default, scoped selection where it works, and precise disclosure where it does not**. Keep the existing inheritance and runtime machinery. Consolidate discovery and backend policy behind the facade, complete missing delivery, and correct the meaning of “applied.”

Alex approved implementation of this revised design in conversation `3526f6a0-a0a8-4406-8539-e4275afdcd81` on 22 September 2026. It follows [ENVELOPE.md](../../ENVELOPE.md) and the [audit](2026-09-22-managed-capabilities-audit.md). The audit baseline was `fa2de91e71cd213f13ee00d68e6c407b5dfeceb2`; current implementation and verification are recorded in the [delivery report](2026-09-22-managed-capabilities-implementation.md).

The [alternative design](../designs/managed-capabilities-design.md) prompted a simpler scheduling policy and a narrower first delivery. The [review dispositions](2026-09-22-managed-capabilities-alternative-review.md) explain the adopted changes and the remaining disagreements.

**1. The product contract**

- Native settings form the baseline. CC overrides retain global → project → session → conversation precedence. Project conversations use global → project → conversation. Reset removes the override and restores inheritance.
- Enabling a capability requests its delivery. Disabling requests its omission from future discovery/context where supported. This does not erase descriptions or tool results already in conversation history.
- Missing individual controls must not make the capability unavailable. A plugin can remain useful while some children follow its parent setting.
- A disabled parent suppresses its managed children where supported, without deleting child preferences. Re-enabling the parent restores each child's own resolved preference; it does not indiscriminately enable every child.
- Native capability settings remain backend-specific. Portable skills and MCP components should be reused through supported delivery paths, including Cursor's existing imports. This does not promise that a plugin's hooks, rules, commands, or agent semantics can all run unchanged on another backend.
- CC's bundled skills and injected workflow tools retain their existing host-owned treatment. User selection does not become a security boundary.

**2. Ownership: deepen the existing facade**

| Owner | Responsibility |
|---|---|
| Backend descriptor and adapter | Native inventory and defaults; stable identities; plugin ownership; native settings and SDK translation; delivery; control limitations and application timing |
| Capability and MCP domains | Scope lookup; override persistence and precedence; parent-child resolution; pending/applied bookkeeping; neutral API views |
| Existing conversation lifecycle | Safe application boundaries, runtime ownership, and acknowledgment routing |
| UI | Render selection, inheritance, timing, and limitations supplied by those contracts |

Add one discovery facet to the [backend descriptor](../../src/lib/agent-backends/descriptor.ts), returning a neutral catalog: opaque identity, kind, display name, source, native default, optional owner, and control support. Put its small contract at the backend seam; adapters must not import capability API schemas. Preserve the existing resolved-cascade and portable-MCP execution inputs.

Move the provider readers in `agent-capabilities/*-discovery.ts` beneath their adapters. Replace the provider dispatch table in [default-deps](../../src/lib/agent-capabilities/default-deps.ts) with descriptor lookup. Move provider declarations from [MCP metadata](../../src/lib/mcp/backend-capabilities.ts) into the descriptors; shared code retains the compatibility projection. Likewise, move the Cursor snapshot read currently performed by [route-defaults](../../src/lib/agent-capabilities/route-defaults.ts) behind the facade. Expose only its neutral delivered selection, including whether that selection is complete.

These replace current owners. They do not introduce another registry, orchestration service, or general capability framework. Native names, SDK options, manifest formats, credentials, and snapshot paths stay inside adapters. UI explanations may name the backend, but UI code does not decide behavior from that name.

**3. Discovery must describe what can be selected**

Inventory includes disabled items and children of disabled plugins. It uses the effective native settings for the actual launch directory, including project/local settings. Runtime sightings reconcile with those identities and ownership instead of appending duplicate rows.

A child's own native default describes its selection when its parent permits it, normally enabled unless independently disabled. Parent disable is applied separately by the resolver. Copying a disabled parent's state into the child's own default would leave the child off after CC enables the parent. Discovery must not depend on CC's resolved parent override.

Reuse Codex's existing [native skill catalog](../../src/lib/agent-backends/codex/skill-catalog.ts): expose its complete inventory before the enabled-only autocomplete filter. Remove duplicate filesystem skill discovery once native discovery covers that responsibility. Keep a bounded adapter-owned plugin reader while native plugin APIs remain unsuitable for production. Claude similarly consolidates its discovery and settings baseline; Cursor consumes supported components through adapter-owned readers.

Emit only CC-explicit skill decisions, but preserve native selector entries when an override requires emitting a replacement `skills.config` array. The adapter merges targeted changes with the native configuration; changing skill B must not erase a native disable of A. Discovery and translation share one effective Claude plugin-settings reader and one settings composer, including host-bundle suppression at every application point.

Durable identity and native invocation identity are distinct. Codex durable keys distinguish sources and survive equivalent session worktrees; native invocation uses the current absolute path. Claude standalone controls remain keyed by native skill name, matching its settings API and native same-name precedence; plugin children use qualified native identities. Source-specific control over same-name standalone Claude skills is outside this delivery. Shared code treats both adapters' durable IDs as opaque. Fix existing stored keys through a one-time, unambiguous source mapping where possible. Keep unmatched preferences visible as missing-source entries; never transfer them by display name or build a permanent alias subsystem.

For the first delivery, fix the recorded frontmatter comment bug in the existing scalar parser. A comment containing a colon must not become a field; quoted hashes and indented block-scalar content remain literal content. This is a bounded correction, not a claim of complete YAML support. Reconsider a proper YAML parser when structured agent declarations enter scope; retain specific diagnostics for unsupported execution fields meanwhile.

**4. MCP selection is additive to native availability**

The availability target is to stop treating absence from CC's MCP inventory as an instruction to disable native functionality. For ordinary conversations, retire Claude's blanket strict-source suppression and Codex's suppression of every unknown native server once the adapter's known-disable and precedence behavior is verified. Preserve existing hermetic task profiles separately. This is a bounded availability follow-up, not a prerequisite for shipping the initial correctness fixes.

This is not just changing a flag. Each adapter must distinguish a known disabled selection from an unknown native server. The existing [portable composer](../../src/lib/mcp/composer.ts) already preserves disabled entries; adapters must use an effective native override for those entries rather than assume omission disables an ambient copy. If that override cannot be applied reliably, report the limitation and leave native availability intact.

Use one delivery owner per server:

- On Claude and Codex, prefer native plugin delivery, including its MCP components. Discover those components for display and offer parent-plugin control initially. Offer individual server/tool controls only where the adapter can address the native component reliably, without duplicating its connection or credentials.
- On Cursor, a subsequent availability slice can extract needed, representable plugin MCP definitions into the existing `McpServerDefinition → resolver → PortableMcpConfig → bridge` path. Defer generic plugin importing and agent `mcpServers` translation from the first delivery. When agent references are added, they must use that same resolved server map rather than independent connections.
- Explicit CC/project definitions retain their current precedence. Plugin-qualified identities prevent unrelated same-name servers from colliding. Where a native server and a managed entry refer to the same native identity, adapter precedence must select one delivery. Do not deduplicate merely by URL or display name.
- Keep native delivery for plugin components whose path expansion, authentication, or format CC cannot represent. Such rows explain that individual CC control is unavailable. If discovery itself is incomplete, show a group-level limitation rather than implying the inventory is exhaustive.

This intentionally accepts coarser control of native plugin MCP. It avoids implementing a universal plugin interpreter merely to obtain every child toggle. Importing portable components is bounded work; emulating native plugin behavior is deferred.

Until that availability slice ships, explicitly identify undelivered plugin MCP components and point to the existing CC MCP configuration as a usable route. Prioritize a concrete needed server by its value and implementation cost; the number of installed plugins is not an architectural threshold. Preserve the availability target rather than making blanket suppression the permanent design.

**5. Requested, accepted, and observed are different facts**

Reuse existing overrides, applied/pending hashes, errors, and optional `appliedEnabled`. No second applied-state database is needed.

**Scheduling change adopted from the alternative:** saving a preference is immediate; ordinary runtime application happens at the next turn boundary. Retire idle-triggered application and its scheduling-only statuses once equivalent turn-start behavior is verified. Keep explicit next-conversation exceptions. The adapter still owns the application mechanism; moving its native call to turn start does not require deleting the execution seam or closing the subprocess.

| Existing fact | Meaning in the proposal |
|---|---|
| Resolved effective selection | What the saved preferences request after inheritance and parent resolution |
| Applied hash | The adapter accepted this configuration for the addressed runtime |
| Pending hash/status | A requested change still awaits its supported application boundary or a successful attempt |
| Optional `appliedEnabled` | An item state the adapter can establish from delivered configuration or runtime evidence; absent means unknown |
| Diagnostics/control support | What the accepted configuration cannot express, what was omitted, or why application failed |

Extend existing row/descriptor metadata with a small selection-effect contract: `omitted`, `calls-blocked`, or `not-applied`, plus an optional controlling parent and a plain-language explanation. Timing remains descriptor-owned, with item-level exceptions when needed. Mechanisms such as permission callbacks and bridges are private. This separates an effective control from a toggle that only blocks invocation or has no effect.

In [runtime-apply](../../src/lib/mcp/runtime-apply.ts), `deferred_to_next_turn` stays pending. Only actual successful application at the boundary or the existing exact-hash input-acceptance receipt advances applied state. Creation-time capability state follows the same rule; [seed promotion](../../src/lib/agent-capabilities/runtime-seed.ts) must not infer successful delivery from declared timing alone. Acceptance belongs where the backend actually accepts the input, which can occur during dispatch after shared pre-turn preparation.

Apply one MCP configuration at the latest boundary required by its supported changes. A server-only edit can use next-turn application; an edit that also changes creation-only exclusions waits in full for a new conversation. The adapter returns that neutral deferral explicitly through the existing apply-result contract. It must not apply the server portion and acknowledge the whole hash. This conservative rule preserves one MCP applied/pending pair and avoids introducing per-field application state. Unsupported portions remain identified limitations rather than boundaries to wait for.

Keep capability-kind and MCP acknowledgment state separate. Cursor can correctly accept new MCP while retaining its frozen skill selection. One aggregate desired/launch digest cannot describe that state and must not drive repeated recreation. A digest of constructed options is also not a provider-acceptance receipt. Generalize receipt naming if useful; retain the underlying evidence and revision semantics.

An acknowledgment for A cannot clear a newer pending B. Continue using current per-conversation serialization and short persistence writes. Re-read preferences at the ordinary application boundary; do not interrupt an active turn. A restarted runtime establishes its own acceptance rather than inheriting certainty from a previous process.

Do not recreate every runtime on a tooling change. Claude's controlled close can lose live background tasks; a resume handle preserves conversation continuity, not the subprocess's work. Codex already rebuilds native options per turn, and Cursor already replaces its MCP bridge independently. Use those existing mechanisms. Creation-only changes retain their disclosed timing until safe adapter-requested recreation is demonstrated; this proposal adds no background-task recovery mechanism to obtain faster toggles.

Partial support is a settled limitation, not an endlessly pending operation. Record acceptance with identified unsupported portions; do not report those items as successfully disabled. Unexpected application failure preserves the previous accepted state and the requested preference, with the current error. Retry through existing next-turn/refresh paths, without a new recovery loop.

Hashes do not reconstruct individual applied states. An incomplete or absent delivered catalog must not turn missing items into confirmed “off.” “Applied” also does not mean a remote MCP service is connected or healthy; reuse existing connection diagnostics for that question.

**6. Complete project-conversation isolation**

Use `ConversationTarget` for MCP conversation scope, routes, query keys, SSE identities, runtime lookup, and mutation fanout. Both route shapes compose the same operation. Persist in existing conversation `mcpOverrides` and `mcpRuntime`; no new scope or table is required.

Remove the [panel's project-wide fallback](../../src/components/agent-capabilities/McpCapabilityPanelContainer.tsx). Add the project-conversation route and update composition, mutation checks, and global/project fanout to include both conversation kinds. Read pending/error state into the view instead of returning an empty pending list. Existing state-store conversion remains the sole crossing into internal project-conversation storage identity.

This guarantee is firm: changing one conversation must never change its sibling's stored preference or runtime configuration, regardless of backend filtering limitations.

**7. Concrete backend choices**

| Backend | Proposed delivery and control |
|---|---|
| Claude | Native skills, plugins, and agents; native plugin MCP is the availability follow-up. Correct effective plugin settings, child identities, and host-plugin merging. Standalone skill selection remains native; plugin skills follow their parent. Individual native-agent controls become read-only unless a focused probe proves a useful exclusion. Apply supported MCP server updates through `setMcpServers` at turn start; translate supported timeout fields rather than discard the server. |
| Codex | Native skill inventory and selectors; preserve native disabled state for unoverridden items. Keep native agents available and disclose that CC does not manage them; defer adding an agent-group cascade. Retain the current managed-skills bridge initially, with delivery failures visible. Process-scoped roots remain a separate simplification candidate for conversations; exec-based tasks have different transport constraints. Supported changes apply next turn. |
| Cursor | Retain the selected skill catalog, supported plugin-component extraction, explicit custom agents, and current MCP bridge. Defer generic plugin MCP import and agent references from the first delivery, disclosing undelivered components. Keep current next-conversation skill/plugin/agent timing and next-turn MCP timing. |

For Claude per-tool filtering, prefer native `disallowedTools`: the installed SDK explicitly documents removal from model context, and CC already forwards it. Verify exact MCP tool names under the real permission mode before advertising that effect. Do not replace the broken permission callback with another call-denial hook solely for context control.

Initially, creation-only exclusion changes are labeled **new conversation**. Faster application requires demonstrated support; it is not inferred from `setMcpServers`. An allowlist is supported only with a complete known inventory or a verified native allowlist mechanism. Never turn “always allow these tools” into a claim that other tools are excluded. A failed verification leaves the server available and the individual control limited.

Optional tuning fields that cannot be translated may be omitted with a diagnostic while retaining the server. Do not omit required authentication, alter transport semantics, or claim an invalid definition is usable. Validate external definitions and show the affected failure without treating every capability error as a reason to refuse the whole conversation.

**8. UI behavior**

Keep the current drawer, backend selection, scope selector, rows, and reset behavior. Supported controls remain editable even when they apply later. Permanently unsupported individual controls are read-only; saved preferences remain visible and resettable. A read-only control does not disable its capability.

Use one small accessible info control at the affected row or group. Hover and keyboard focus expose a short explanation; click or tap opens the same detail, including a parent-control link when applicable. Compose the existing tooltip/popover primitives in one capability-feature component; a new foundational UI primitive is unnecessary unless broader reuse emerges. Avoid repeating a group-wide explanation on every child.

Adapter-authored notes supply the prose. Remove raw metadata enum labels and inline informational diagnostics. Keep typed control usability and timing so the UI never interprets a note to decide whether a toggle works. Permanent informational limitations live behind the indicator; unexpected failures that need action remain visible. Do not mechanically display every legacy warning inline if it merely describes a permanent backend limitation.

Example explanations:

- “Individual skills follow this plugin. Disable the plugin to remove them.”
- “Saved off. Still available in this conversation. Applies in a new conversation.”
- “Skills, agents, and MCP are available. Plugin hooks are not supported.”
- “Native servers may also be available. CC cannot control each one individually.”

Show compact pending/error state when action has not taken effect. Normal success needs no “applied” chip or pending decoration. Keep permanent limitations behind the info affordance; unexpected failed application gets a short visible row status with details on expansion. Display “current availability unknown” when evidence is absent, rather than inventing an on/off state. Existing MCP compatibility detail remains the expanded surface.

**9. Bounded delivery order and exclusions**

1. Correct project-conversation scope, the recorded parser bug, effective defaults/settings composition, and truthful acknowledgment handling. Ship accurate limitation/pending UI with the affected controls.
2. Consolidate descriptor discovery ownership, replace the Codex skill walker, correct stable identities/native selector merging, and move ordinary application to turn start. Remove superseded readers and idle scheduling after equivalent behavior is verified.
3. Address needed plugin MCP availability through bounded native delivery or portable definitions, with duplicate/known-disable behavior checked. Generic plugin importing, Codex agent controls, and structured agent MCP references are separate follow-ups.

Keep initial SDK verification focused: Claude exact tool exclusion and MCP replacement under the real launch mode; Codex native inventory and path-selector behavior. Verify native-versus-managed server precedence and disabling in the availability follow-up. If a proposed finer control fails, the predetermined outcome is available functionality with a disclosed limitation, not an expanding adapter project.

Defer automatic tool-list synchronization, a new bridge for Codex legacy SSE, native plugin hook/rule emulation, elaborate role suppression, and exhaustive rare plugin formats. Cursor inventory refresh remains tied to reconnection/configuration changes. Enterprise policy enforcement, adversarial-agent controls, distributed coordination, and background retry machinery remain outside this work.

Retaining the Codex bridge is a first-delivery scope decision, not a rule that two transport-specific implementations are always excessive. Evaluate process-scoped roots later by total lifecycle, concurrency, and cleanup complexity. Surface failure to deliver CC's host skills now; a louder log alone is insufficient operator feedback.

The [older MCP requirements](../../.kiro/specs/mcp-configuration/requirements.md) promise identical controls and next-turn application. This proposal deliberately revises those promises in line with Alex's current availability-first direction. Carry the accepted decisions into the governing specification before implementation; do not silently leave contradictory requirements behind.

**10. Complexity and verification**

The current scoped complexity assessment remains approximately **6/10**: five of the eight software-design-philosophy diagnostics broadly pass. The weak rows and their remedies are:

| Weak diagnostic | Specific improvement |
|---|---|
| Interfaces simpler than implementations | Reuse existing state and execution inputs; expose a catalog and semantic control outcomes rather than parallel provider metadata registries |
| Implementation changes remain local | Move discovery, native baselines, snapshot reads, and native selection policy beneath each adapter; remove the corresponding shared provider dispatch/branches |
| A newcomer can understand the contract from the boundary | Document requested selection, accepted configuration, observed state, and control effect separately; stop inferring delivery from timing |

Those changes address the remaining diagnostics. A 10/10 claim would require the resulting implementation to demonstrate the promised locality and deletion of duplicate paths; a diagram alone does not earn it.

Behavioral work starts with failing reproduction tests. Meaningful checks cover sibling project-conversation isolation and durable reload; fanout across both scopes; pending A/B acknowledgment ordering; failed/deferred/partial delivery; native disabled defaults and stable identities; parent disable/re-enable preserving child preference; plugin MCP delivered once; and unavailable controls retaining capability availability. Use the existing registered scoped test commands and complete seam/type checks at integration checkpoints.

Live adapter checks must inspect the actual advertised skills/tools or delivered definitions; manually calling a captured permission callback proves nothing about runtime invocation. Verify the UI in its drawer at desktop/mobile widths, with keyboard and touch access to limitations, pending, failure, and unknown states. The delivery report records implementation tests and live verification; the original proposal itself made no validation claim.
