/**
 * Seam burn-down allowlists (consolidated plan §0.4 / §3.5.2), consumed by the
 * architecture-seams rules in eslint.config.mjs. Every entry is an EXISTING
 * offender captured from the tree when the seam rule was introduced, tagged
 * with the plan phase that deletes it. Entries are only ever REMOVED (as the
 * owning phase migrates the offender) — never add one to admit new code.
 * Paths are repo-relative.
 */

/**
 * Files outside src/lib/agent-backends/ that import adapter internals
 * (agent-backends/{claude,codex}/**) or a provider SDK package directly.
 */
export const BACKEND_SEAM_ALLOWLIST = [
  // Design-sanctioned shared-reader edge (phase-1 slice designs, Blocker 3
  // §3.3.4): discovery imports `parseNativePluginEntries` from the Claude
  // runtime-config adapter so the enabledPlugins shape is decoded in exactly
  // one place. Deliberate capabilities → backends edge, not burn-down debt.
  "src/lib/agent-capabilities/claude-discovery.ts",
  // Phase 4 (codex-runs generalizes to AgentTaskRunner; §3.1.7 census).
  "src/lib/codex-runs/service.ts",
];

/**
 * Sanctioned SSE publication/transport modules: the only places a raw
 * events/broadcaster VALUE import is legitimate. Everything else publishes
 * through the typed publication layer (`@/lib/events/publication`) or takes a
 * PublishFn via DI (type-only imports are always allowed). The rule runs at
 * error level (plan Phase 4.1d).
 */
export const SSE_PUBLICATION_SANCTIONED = [
  // Typed publication layer: owns tracing, lifecycle projection, and the
  // broadcaster adapter (Blocker 5 design §5.2.1).
  "src/lib/events/publication.ts",
  // SSE transport: owns the wire, subscribes/replays the broadcast stream.
  "src/lib/events/sse-route-handlers.ts",
];

/**
 * Exact (importer file → target feature) edges crossing a src/features/<a>/ →
 * src/features/<b>/ boundary (structure.md violation). Each entry exempts only
 * that edge — the rule keeps checking allowlisted files, so a new import into
 * any other feature still fails. Empty: every offender has been promoted to
 * src/components// src/hooks/ (structure.md). The list stays here so the lint
 * rule can be re-armed the instant a new cross-feature edge is introduced —
 * adding an entry to admit new code is forbidden.
 *
 * Final promotions (Phase 5.1): the ConversationSidebar sidebar/ subtree (incl.
 * PeekPopover, ConversationSidebar.helpers) → src/components/session/sidebar/;
 * the PromptComposer prompt/ subtree + its self-contained leaves
 * (DebugStatusStrip, DebugModeToggle, MobilePromptToolbar, CollabConfigRow) →
 * src/components/session/; and use-voice-wiring / use-clear-input-hotkey /
 * use-sidebar-persistent-filters → src/hooks/. Earlier waves cleared spawn-card
 * (→ project-detail), DiffPanel (→ src/components/git/), use-user-input-gate
 * (→ src/hooks/), and the CreateSessionModal test edge.
 */
export const CROSS_FEATURE_ALLOWLIST = [];

/**
 * Non-test files outside src/lib/state-store/ that construct a store instance.
 * Test files (*.test.ts/tsx) are exempt in the rule itself.
 */
export const STATE_STORE_CONSTRUCTION_ALLOWLIST = [
  // Shared test fixture: real repos over a fresh :memory: DB (see
  // persistence-testing steering); never runs in production.
  "src/lib/shared/testing/persistence-fixture.ts",
];

export const GRAPH_OWNERSHIP_ALLOWLIST = [];
