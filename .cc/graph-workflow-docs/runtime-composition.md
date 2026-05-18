# Runtime Composition — module map

Conversation-start composition lives in `src/lib/agent-capabilities/`:

- `runtime-composer.ts` (`composeConversationStartRuntime`) — backend-scoped
  glue. Resolves plugins first when present, threads the plugin enablement
  map into child cascades (`claude-skills`, `claude-agents`, `codex-skills`),
  routes to the backend translator, computes per-cascade runtime hashes, and
  seeds `AgentCapabilityRuntimeApplicationState`.
- `claude-runtime-translator.ts` (`translateClaudeRuntimeCapabilities`) —
  Claude cascades only. Emits minimal plugin delta via
  `translateClaudePluginEnablement` (preserves native extended settings by
  omission), `"on"/"off"` skill overrides for CC-explicit decisions only, and
  the sub-agent suppression strategy metadata + `disabledAgentNames`.
- `codex-runtime-translator.ts` (`translateCodexRuntimeCapabilities`) —
  verification-gated wrapper over `translateCodexCapabilities`. Always
  returns `{ config: {}, applySemantics: "next-turn" }`. Surfaces the gated
  diagnostics with `backend: "codex"` and the correct `cascadeKind`.
- `runtime-hashes.ts` — deterministic per-cascade hashing
  (`computeCascadeRuntimeHash`), conversation-start seeding
  (`seedRuntimeApplicationState`), and per-attempt outcome recording
  (`recordApplyOutcome`, `sanitizeApplyError`).

## Contract pins downstream apply work depends on

- The composer **never** seeds runtime state for verification-gated cascades
  (`codex-skills`, `codex-plugins`). The apply service must not treat their
  absence as pending work.
- Non-gated cascades are seeded even when their emitted row set is empty so
  the apply service has a baseline hash to compare drift against on later
  edits.
- Claude conversation-start composition seeds `lastApplyStatus:
  "staged-next-turn"` for every emitted cascade. Live-apply (`idle-live-apply`
  for `claude-skills`/`claude-plugins`) promotes to `applied` via
  `recordApplyOutcome` only after the SDK confirms.
- Codex always seeds `staged-next-turn`. The translator's
  `applySemantics: "next-turn"` is authoritative — Codex apply must never
  attempt live application.
- Stale plugin overrides flow through the Claude runtime translator into
  `translateClaudePluginEnablement` so its `claude-plugin-override-stale`
  diagnostic surfaces with `backend: "claude"` and
  `cascadeKind: "claude-plugins"`. The resolver also emits its own
  `agent-capability-stale-override` info diagnostic for the same row.
- Plugin-disabled child skills/agents are emitted as explicit `off` because
  the resolver's parent-child overlay sets `effectiveState.enabled = false`
  with `originLayer` pointing at the layer that disabled the plugin. Apply
  must rely on `reloadPlugins()` semantics for full removal but the explicit
  `off` keeps the runtime accurate until reload completes.
- `composeConversationStartRuntime` is pure: no I/O, no SDK calls. All
  discovery results, native plugin snapshots, and override chains are
  caller-provided so the apply service and integration tests can exercise it
  deterministically.

## Failure isolation pins

- A cascade listed in `failedCascadeKinds` is skipped entirely: no
  resolution, no translator call, no seeded state. Sibling cascades on the
  same backend compose normally.
- Per-cascade emission failures inside the translator surface as
  `AgentCapabilityDiagnostic` entries on the composer's `diagnostics` list;
  the cascade still seeds with whatever rows did make it through.
- Codex with `pluginsView === undefined` does not produce a
  `codex-plugins-unavailable` diagnostic — the gated diagnostic only fires
  when discovery actually exercised the cascade with items.
