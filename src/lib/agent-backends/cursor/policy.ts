import type { LocalAgentOptions, SettingSource, ToolName } from "@cursor/sdk";

/**
 * The SDK exports the sandbox option only through `LocalAgentOptions`, so the
 * shape is derived rather than restated — a Phase 2 change to it fails
 * typecheck here instead of silently drifting.
 */
type SandboxOptions = NonNullable<LocalAgentOptions["sandboxOptions"]>;

/**
 * The fixed Phase 1 Cursor execution policy (spec D11).
 *
 * These are `Agent.create` / `Agent.resume` options the SDK does not persist,
 * so the worker establishes them at create and re-passes the full set on every
 * resume; per-send options carry only the model and MCP map. Every value here
 * is a constant with no user-configurable path — Command Center adds no
 * tool-configuration surface in Phase 1, and the descriptor declares native
 * mid-turn ask unsupported. Filesystem and network limits use agent instructions.
 *
 * Type-only SDK imports keep the option shapes checked against the real SDK
 * without loading it: the SDK is a worker-process dependency, and the server
 * must be able to import this module without pulling in native assets.
 */

/**
 * Phase 1 runs unsandboxed. Command Center claims no filesystem or network
 * confinement for Cursor, so declaring the sandbox off matches what the
 * descriptor reports rather than implying a confinement that was never tested.
 */
export const CURSOR_SANDBOX_OPTIONS: SandboxOptions = { enabled: false };

/**
 * Auto-review would gate local tool calls behind a classifier that can fail
 * closed mid-turn, and no mid-turn approval UI exists to resolve it.
 */
export const CURSOR_AUTO_REVIEW = false;

/**
 * No ambient Cursor settings layer is loaded: user, project, and MDM settings
 * on the host would otherwise silently change what a Command Center run does.
 * Inline MCP configuration (D13) is passed explicitly instead.
 */
export const CURSOR_SETTING_SOURCES: readonly SettingSource[] = [];

/**
 * Transport and stall auto-retry, set explicitly rather than inherited from the
 * SDK's headless-embedder default so the tested configuration is the one that
 * ships. Retries stay on for transport resilience; a retried turn reports no
 * token usage (D18), which is what keeps retry from double-counting usage.
 */
export const CURSOR_ENABLE_AGENT_RETRIES = true;

/**
 * Deny-list only, with no `tools` allowlist: every other default-toolset tool
 * (shell, file operations, search, subagents through `task`, and the MCP
 * family) stays available, including tools the platform adds after this SDK.
 *
 * The two interactive tools are denied because no mid-turn approval UI exists.
 * Per the SDK's documented semantics this denial is main-loop scope only —
 * subagents launched through `task` keep their own platform-curated toolsets,
 * so this is main-loop policy, not a complete-toolset guarantee. A subagent
 * that surfaces an interactive request anyway is never awaited (no approval
 * handler is registered), so the turn resolves through the stall and timeout
 * bounds as a bounded typed failure rather than hanging.
 */
export const CURSOR_DISALLOWED_TOOLS: readonly ToolName[] = [
  "askQuestion",
  "await",
];

export interface CursorPhase1Policy {
  readonly sandboxOptions: SandboxOptions;
  readonly autoReview: boolean;
  readonly settingSources: readonly SettingSource[];
  readonly enableAgentRetries: boolean;
  readonly disallowedTools: readonly ToolName[];
}

/**
 * The whole policy as one frozen value, so the worker passes a single object it
 * cannot partially apply or mutate. Deliberately has no `tools` key: adding one
 * would turn the deny list into an allowlist and silently drop every tool the
 * platform adds later.
 */
export const CURSOR_PHASE1_POLICY: CursorPhase1Policy = Object.freeze({
  sandboxOptions: Object.freeze({ ...CURSOR_SANDBOX_OPTIONS }),
  autoReview: CURSOR_AUTO_REVIEW,
  settingSources: Object.freeze([...CURSOR_SETTING_SOURCES]),
  enableAgentRetries: CURSOR_ENABLE_AGENT_RETRIES,
  disallowedTools: Object.freeze([...CURSOR_DISALLOWED_TOOLS]),
});
