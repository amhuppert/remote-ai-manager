# Cascade Resolver — Kiro Task 4

Status: complete. Module lives at `src/lib/agent-capabilities/resolver.ts`; tests at `resolver.test.ts` (30 cases, all green).

## Public API

```ts
import {
  resolveCascadeView,
  resolvePluginEnablement,
  type PluginCascadeKind,
  type PluginEnablementMap,
  type ResolveCascadeViewInput,
  type ResolvePluginEnablementInput,
} from "@/lib/agent-capabilities/resolver";
```

### `resolveCascadeView(input): AgentCapabilityViewResponse`

Pure. Composes one cascade's view from:

- `cascadeKind` + `metadata` (from `defaultAgentCapabilityMetadataRegistry`).
- `scope`: `AgentCapabilityScopeContext` (`level` + optional project/session/conversation names).
- `overrideChain`: ordered broadest → narrowest. Entries shaped as `{ layer, overrides }`. Layers above the requested scope are skipped by the caller; the resolver never reaches up past what is passed.
- `discoveredItems`: canonical `AgentCapabilityDiscoveredItem[]`.
- `pluginResolution` (optional): output of `resolvePluginEnablement()` for the matching plugin cascade. Drives child force-disable for `claude-skills`, `claude-agents`, `codex-skills`.
- `runtimeApplyState` (optional): conversation-level `AgentCapabilityRuntimeApplicationState`.
- `discoveryDiagnostics` (optional): carried through; resolver only appends `agent-capability-stale-override` diagnostics.

Returns a fully populated `AgentCapabilityViewResponse` including `metadata`, `items` (sorted by `itemId` for hash determinism), `diagnostics`, and `effectiveHash`.

### `resolvePluginEnablement(input): PluginEnablementMap`

Pure helper that walks the override chain narrowest → broadest, returning a `Map<pluginId, { enabled, originLayer }>`. Seeds with native defaults so plugins with no override are still represented. Pass this map as `pluginResolution` on `resolveCascadeView()` for child cascades.

Required input field `pluginCascadeKind` (`"claude-plugins" | "codex-plugins"`) names the single cascade to read out of each layer. Plugin parent-child disable is a within-backend relationship: Claude plugins force Claude children, Codex plugins force Codex children, never crosswise. Two backends with coincidentally identical plugin ids never collide because the function ignores sibling plugin cascades on the same layer. Callers that need both backends' maps must call this helper twice, once per `pluginCascadeKind`.

## Behavior pins (tests enforce)

- **Four-layer precedence**: narrowest explicit override wins; native fallback when no layer has an entry. Origin layer is preserved separately from inherited effective state via `ownEffectiveState` vs `effectiveState`.
- **Deterministic hash**: identical inputs (regardless of override or discovery insertion order) produce identical `effectiveHash`. Hash inputs deliberately exclude runtime apply status so apply lifecycle events do not flap the hash.
- **Stale rows**: any override id missing from current discovery surfaces as a row with `stale: true`, `runtimeVisibility: "stale"`, `runtimeEmittable: false`. Stored value and origin layer are preserved. A stale row reactivates automatically when discovery later returns the item. One `agent-capability-stale-override` diagnostic emits per stale row.
- **Apply-failure diagnostics**: when a row resolves to `applyStatus: "rejected"` and the runtime state carries a `lastApplyError`, the resolver emits one `agent-capability-apply-failed` diagnostic (severity `error`) per responsible row. The diagnostic is attached to the row's own `diagnostics` array and also pushed into the response-level `diagnostics`. "Responsible" means: when the runtime has a non-empty `pendingItemIds`, only those items get the diagnostic; otherwise the failure is treated as cascade-wide and every rejected row gets it. The sanitized `lastApplyError` string is reused verbatim — sanitization happens in the apply service, not here.
- **Plugin parent-child disable**: child cascade rows with `owningPluginId` are force-disabled in `effectiveState` (with `inheritedDisableReason: { pluginId, originLayer }`) when the parent plugin resolves disabled. `ownEffectiveState` retains the child's pre-disable resolution so a parent re-enable restores child intent. Sibling cascades and unowned items are not touched.
- **Runtime apply status**: derived from `metadata.compositionSupport` + `runtimeApplyState`, never from cascade-name branching.
  - `compositionSupport === "verification-gated"` → `applyStatus: "unsupported"` regardless of runtime state (covers `codex-skills`, `codex-plugins`).
  - Item in `runtimeState.pendingItemIds` → uses `lastApplyStatus` (e.g. `staged-idle`, `staged-next-turn`, `deferred-next-conversation`).
  - Otherwise → mirrors `lastApplyStatus` if present; `applied` if only an `appliedHash` is recorded; `none` when no runtime record exists.
- **Runtime-emittable invariant**: `runtimeEmittable = !stale && !verification-gated && runtimeVisibility !== "unavailable"`. Runtime composition (task 6.x) must filter on this field instead of re-deriving the predicate.

## Composing a backend view

To build a backend's full view (plugins + skills + agents), resolve plugins first, then thread that map into the child resolves:

```ts
const pluginView = resolveCascadeView({
  cascadeKind: "claude-plugins",
  metadata: registry.get("claude-plugins"),
  overrideChain,
  discoveredItems: discoveredPlugins,
  scope,
});

const claudePluginMap = resolvePluginEnablement({
  pluginCascadeKind: "claude-plugins",
  discoveredPlugins: discoveredClaudePlugins,
  overrideChain,
});

const skillsView = resolveCascadeView({
  cascadeKind: "claude-skills",
  metadata: registry.get("claude-skills"),
  overrideChain,
  discoveredItems: discoveredSkills,
  pluginResolution: claudePluginMap,
  scope,
});
```

`resolvePluginEnablement()` and `resolveCascadeView()` both walk the same override chain, so callers reuse the chain they already constructed; the resolver itself never reads filesystem state.

## Read this when

- Implementing task 6.x runtime composition — feed `resolveCascadeView()` output into the per-backend translator and rely on `runtimeEmittable` to filter rows.
- Implementing task 7.x apply fanout — `effectiveHash` is what `pendingHash` / `appliedHash` should compare against.
- Implementing task 8.x API routes — return `resolveCascadeView()` output directly; the schema parse already runs at the boundary inside the response schema.
- Implementing task 9.x UI panels — `applyStatus`, `stale`, `runtimeVisibility`, `runtimeEmittable`, and `inheritedDisableReason` are the only fields the UI needs to switch on; do not re-derive from cascade kind.
