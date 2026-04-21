/**
 * MCP runtime apply service.
 *
 * Orchestrates turn-start and after-override-change application of resolved
 * MCP config to a conversation's live backend runtime, honoring the
 * concurrency & ordering guarantees documented in the spec:
 *
 * - The effective config hash is computed inside the state mutator's critical
 *   section (so it reflects the post-write override chain plus current source
 *   discovery and is strictly ordered against concurrent PATCHes).
 * - Apply disposition is decided per the backend's capabilities and the
 *   conversation runtime's current turn state. A running turn is never
 *   interrupted — configuration changes are recorded as pending and the
 *   next-turn apply picks them up.
 * - `applyAtTurnStart` is the sole writer of `lastAppliedConfigHash`.
 * - `applyAfterOverrideChange` writes only pending fields
 *   (`pendingConfigHash`, `pendingServerKeys`, `lastApplyDisposition`,
 *   `lastApplyError`). Live Claude applies still flow through the runtime so
 *   the user sees the change immediately, but durable state tracks them as
 *   pending until the next turn start records the applied hash.
 * - On apply failure the previous `lastAppliedConfigHash` is preserved, a
 *   sanitized error is persisted, and the failure is surfaced through the
 *   apply result for diagnostics.
 */

import { createHash } from "node:crypto";

import type {
  McpApplyResult,
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import { createLogger } from "@/lib/logging";
import type {
  AgentBackendId,
  ConversationState,
  McpApplyDisposition,
  McpRuntimeApplicationState,
} from "@/lib/schemas";
import { createStateManager } from "@/lib/state";

const logger = createLogger("mcp.runtime-apply");

type StateManager = ReturnType<typeof createStateManager>;

// ===========================================================================
// Task 10.1 — deterministic hash over the full emitted portable config
// ===========================================================================

/**
 * Compute a stable SHA-256 digest over the full emitted portable MCP config
 * (user-resolved servers + protected gateway servers). The hash is order-
 * insensitive w.r.t. server list and tool filter list order — semantically
 * equivalent configs must collide so that a no-op reorder doesn't invalidate
 * `lastAppliedConfigHash`. Used for change detection only; never exposed in
 * the UI.
 */
export function computeEffectiveConfigHash(
  portable: PortableMcpConfig,
): string {
  const canonical = canonicalizePortable(portable);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

interface CanonicalPortableServer {
  id: string;
  transport: string;
  fields: Array<[string, unknown]>;
}

function canonicalizePortable(portable: PortableMcpConfig): {
  servers: readonly CanonicalPortableServer[];
} {
  const servers = portable.servers.map((s) => canonicalizeServer(s));
  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { servers };
}

function canonicalizeServer(
  server: PortableMcpServerConfig,
): CanonicalPortableServer {
  const fields: Array<[string, unknown]> = [];
  for (const key of Object.keys(server).sort()) {
    if (key === "id" || key === "transport") continue;
    const value = (server as unknown as Record<string, unknown>)[key];
    fields.push([key, normalizeField(key, value)]);
  }
  return { id: server.id, transport: server.transport, fields };
}

function normalizeField(key: string, value: unknown): unknown {
  if (key === "enabledTools" || key === "disabledTools") {
    if (Array.isArray(value)) {
      return [...value].sort();
    }
  }
  if (
    (key === "env" || key === "headers") &&
    value &&
    typeof value === "object"
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

// ===========================================================================
// Service contract
// ===========================================================================

/**
 * Returned by `McpRuntimeApplyDeps.resolvePortableForConversation`.
 *
 * Callers resolve discovery + overrides + composition outside the service so
 * the service stays focused on hash computation, decision logic, and state
 * persistence.
 */
export interface ResolvedPortableForConversation {
  portable: PortableMcpConfig;
  /** Ignored by the service — the service computes its own hash inside the
   * mutator's critical section. Kept on the type so the resolver can surface
   * the hash to callers through the same data shape when useful. */
  effectiveConfigHash?: string;
}

export interface McpRuntimeApplyDeps {
  stateManager: StateManager;
  getRuntime(conversationId: string): ConversationBackendRuntime | undefined;
  resolvePortableForConversation(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    backend: AgentBackendId;
  }): Promise<ResolvedPortableForConversation>;
  now?(): Date;
}

export interface AfterOverrideChangeInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
  changedServerKeys: readonly string[];
}

export interface AtTurnStartInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
}

export interface ConversationApplyResult {
  conversationId: string;
  backend: AgentBackendId;
  disposition: McpApplyDisposition;
  effectiveConfigHash: string;
  error?: string;
}

export interface McpRuntimeApplyService {
  applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult>;
  applyAtTurnStart(input: AtTurnStartInput): Promise<ConversationApplyResult>;
}

// ===========================================================================
// Factory
// ===========================================================================

export function createMcpRuntimeApplyService(
  deps: McpRuntimeApplyDeps,
): McpRuntimeApplyService {
  const { stateManager } = deps;

  async function applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult> {
    // --- Phase 1: inside the mutator critical section ---
    // Resolve, compute hash, capture decision, and persist pending-only fields.
    // We intentionally do NOT invoke the runtime here — that happens after
    // the lock is released so slow apply paths cannot stall the mutex.
    const phase1 = await stateManager.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "mcp.applyAfterOverrideChange",
      async (conv) => {
        const resolved = await deps.resolvePortableForConversation({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          backend: input.backend,
        });
        const hash = computeEffectiveConfigHash(resolved.portable);

        const runtime = deps.getRuntime(input.conversationId);
        const decision = decideApplyDisposition({
          runtime,
          backend: input.backend,
        });

        const plannedDisposition: McpApplyDisposition =
          decision.kind === "apply-live"
            ? "applied_now"
            : decision.kind === "stage"
              ? "deferred_to_next_turn"
              : decision.kind === "defer-running"
                ? "deferred_to_next_turn"
                : "no_active_runtime";

        // After-override-change path writes only pending fields; never
        // mutates lastAppliedConfigHash.
        conv.mcpRuntime = {
          ...(conv.mcpRuntime ?? {}),
          pendingConfigHash: hash,
          pendingServerKeys: [...input.changedServerKeys],
          lastApplyDisposition: plannedDisposition,
          // Clear any prior error — this is a fresh attempt.
          ...(conv.mcpRuntime?.lastApplyError !== undefined
            ? { lastApplyError: undefined }
            : {}),
        };

        return {
          portable: resolved.portable,
          hash,
          decision,
          plannedDisposition,
        };
      },
    );

    // --- Phase 2: invoke the runtime (outside the lock) ---
    const runtime = deps.getRuntime(input.conversationId);
    if (
      phase1.decision.kind === "no-runtime" ||
      phase1.decision.kind === "defer-running" ||
      !runtime?.applyPortableMcpConfig
    ) {
      logger.info("after-change.disposition", {
        conversationId: input.conversationId,
        disposition: phase1.plannedDisposition,
        changedCount: input.changedServerKeys.length,
      });
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: phase1.plannedDisposition,
        effectiveConfigHash: phase1.hash,
      };
    }

    // Claude idle or Codex (staging). Both go through applyPortableMcpConfig.
    let applyResult: McpApplyResult;
    try {
      applyResult = await runtime.applyPortableMcpConfig(phase1.portable);
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      logger.error("after-change.apply_throw", {
        conversationId: input.conversationId,
        backend: input.backend,
      });
      // Phase 3 (failure): record rejected disposition + sanitized error,
      // preserve lastAppliedConfigHash.
      await recordFailureAfterOverride(
        stateManager,
        input,
        phase1.hash,
        sanitized,
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "rejected",
        effectiveConfigHash: phase1.hash,
        error: sanitized,
      };
    }

    if (
      applyResult.disposition === "rejected" ||
      applyResult.disposition === "unsupported"
    ) {
      const sanitized = formatApplyResultError(applyResult);
      await recordFailureAfterOverride(
        stateManager,
        input,
        phase1.hash,
        sanitized,
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "rejected",
        effectiveConfigHash: phase1.hash,
        error: sanitized,
      };
    }

    // Final disposition reflects the runtime's actual behavior. A Claude idle
    // apply returns `applied_now`; Codex staging returns
    // `deferred_to_next_turn`.
    await recordFinalDispositionAfterOverride(
      stateManager,
      input,
      applyResult.disposition,
    );

    logger.info("after-change.apply_ok", {
      conversationId: input.conversationId,
      backend: input.backend,
      disposition: applyResult.disposition,
    });
    return {
      conversationId: input.conversationId,
      backend: input.backend,
      disposition: applyResult.disposition,
      effectiveConfigHash: phase1.hash,
    };
  }

  async function applyAtTurnStart(
    input: AtTurnStartInput,
  ): Promise<ConversationApplyResult> {
    // Phase 1: resolve + hash + check inside the lock. The check-and-skip is
    // eager enough that most idle next-turn paths short-circuit without ever
    // contacting the runtime.
    const phase1 = await stateManager.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "mcp.applyAtTurnStart.resolve",
      async (conv) => {
        const resolved = await deps.resolvePortableForConversation({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          backend: input.backend,
        });
        const hash = computeEffectiveConfigHash(resolved.portable);
        const previous: McpRuntimeApplicationState | undefined = conv.mcpRuntime
          ? { ...conv.mcpRuntime }
          : undefined;
        return { portable: resolved.portable, hash, previous };
      },
    );

    const previouslyApplied = phase1.previous?.lastAppliedConfigHash;
    const storedPending = phase1.previous?.pendingConfigHash;

    if (previouslyApplied === phase1.hash) {
      // Nothing to apply. Do NOT mutate state — we already match the applied
      // hash. Tests assert this path does not touch the runtime.
      logger.debug("turn-start.noop", {
        conversationId: input.conversationId,
      });
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "applied_now",
        effectiveConfigHash: phase1.hash,
      };
    }

    const runtime = deps.getRuntime(input.conversationId);
    if (!runtime?.applyPortableMcpConfig) {
      // No active runtime. Record pending and bail. lastAppliedConfigHash
      // untouched.
      await writeConversationRuntime(
        stateManager,
        input,
        "mcp.applyAtTurnStart.no-runtime",
        (existing) => ({
          ...existing,
          pendingConfigHash: phase1.hash,
          lastApplyDisposition: "no_active_runtime",
        }),
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "no_active_runtime",
        effectiveConfigHash: phase1.hash,
      };
    }

    let applyResult: McpApplyResult;
    try {
      applyResult = await runtime.applyPortableMcpConfig(phase1.portable);
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      logger.error("turn-start.apply_throw", {
        conversationId: input.conversationId,
        backend: input.backend,
      });
      await writeConversationRuntime(
        stateManager,
        input,
        "mcp.applyAtTurnStart.failure",
        (existing) => ({
          // preserve lastAppliedConfigHash exactly
          ...existing,
          lastApplyDisposition: "rejected",
          lastApplyError: sanitized,
        }),
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "rejected",
        effectiveConfigHash: phase1.hash,
        error: sanitized,
      };
    }

    if (
      applyResult.disposition === "rejected" ||
      applyResult.disposition === "unsupported"
    ) {
      const sanitized = formatApplyResultError(applyResult);
      await writeConversationRuntime(
        stateManager,
        input,
        "mcp.applyAtTurnStart.rejected",
        (existing) => ({
          ...existing,
          lastApplyDisposition: "rejected",
          lastApplyError: sanitized,
        }),
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "rejected",
        effectiveConfigHash: phase1.hash,
        error: sanitized,
      };
    }

    // Success: turn-start path is the single writer of lastAppliedConfigHash.
    // Clear pending only if the applied hash equals the stored pending hash —
    // otherwise a newer PATCH landed after our resolve and its pending hash
    // must survive to drive the subsequent turn.
    await writeConversationRuntime(
      stateManager,
      input,
      "mcp.applyAtTurnStart.success",
      (existing) => {
        const next: McpRuntimeApplicationState = {
          ...existing,
          lastAppliedConfigHash: phase1.hash,
          lastApplyDisposition: applyResult.disposition,
        };
        // Drop stale error on success.
        delete next.lastApplyError;
        const currentPending = existing?.pendingConfigHash ?? storedPending;
        if (currentPending === phase1.hash) {
          delete next.pendingConfigHash;
          delete next.pendingServerKeys;
        }
        return next;
      },
    );
    return {
      conversationId: input.conversationId,
      backend: input.backend,
      disposition: applyResult.disposition,
      effectiveConfigHash: phase1.hash,
    };
  }

  return { applyAfterOverrideChange, applyAtTurnStart };
}

// ===========================================================================
// Decision helper (Task 10.2)
// ===========================================================================

type ApplyDecision =
  | { kind: "no-runtime" }
  | { kind: "defer-running" }
  | { kind: "apply-live" }
  | { kind: "stage" };

function decideApplyDisposition(input: {
  runtime: ConversationBackendRuntime | undefined;
  backend: AgentBackendId;
}): ApplyDecision {
  const { runtime, backend } = input;
  if (!runtime || runtime.status !== "alive") {
    return { kind: "no-runtime" };
  }

  if (backend === "codex") {
    // Codex always stages — its per-turn instance reconstruction picks up the
    // new portable at the start of the next turn.
    return { kind: "stage" };
  }

  // Claude: live when idle, defer while running.
  const isTurnActive = isClaudeTurnActive(runtime);
  if (isTurnActive) return { kind: "defer-running" };
  return { kind: "apply-live" };
}

function isClaudeTurnActive(runtime: ConversationBackendRuntime): boolean {
  // The Claude runtime exposes `isTurnActive` as a read-only property on its
  // internal query session; surfaced through the runtime as a read in tests.
  const candidate = (runtime as unknown as { isTurnActive?: unknown })
    .isTurnActive;
  return candidate === true;
}

// ===========================================================================
// State write helpers (Task 10.3)
// ===========================================================================

async function writeConversationRuntime(
  stateManager: StateManager,
  input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  label: string,
  updater: (
    existing: McpRuntimeApplicationState | undefined,
  ) => McpRuntimeApplicationState,
): Promise<void> {
  await stateManager.mutateConversation(
    input.projectPath,
    input.sessionName,
    input.conversationId,
    label,
    (conv: ConversationState) => {
      const next = updater(conv.mcpRuntime);
      conv.mcpRuntime = pruneRuntimeState(next);
    },
  );
}

function pruneRuntimeState(
  state: McpRuntimeApplicationState,
): McpRuntimeApplicationState {
  const out: McpRuntimeApplicationState = {};
  if (state.lastAppliedConfigHash !== undefined)
    out.lastAppliedConfigHash = state.lastAppliedConfigHash;
  if (state.pendingConfigHash !== undefined)
    out.pendingConfigHash = state.pendingConfigHash;
  if (state.pendingServerKeys !== undefined)
    out.pendingServerKeys = state.pendingServerKeys;
  if (state.lastApplyDisposition !== undefined)
    out.lastApplyDisposition = state.lastApplyDisposition;
  if (state.lastApplyError !== undefined)
    out.lastApplyError = state.lastApplyError;
  return out;
}

async function recordFailureAfterOverride(
  stateManager: StateManager,
  input: AfterOverrideChangeInput,
  pendingHash: string,
  sanitized: string,
): Promise<void> {
  await writeConversationRuntime(
    stateManager,
    input,
    "mcp.applyAfterOverrideChange.failure",
    (existing) => ({
      // preserve lastAppliedConfigHash exactly
      ...(existing?.lastAppliedConfigHash !== undefined
        ? { lastAppliedConfigHash: existing.lastAppliedConfigHash }
        : {}),
      pendingConfigHash: pendingHash,
      pendingServerKeys: [...input.changedServerKeys],
      lastApplyDisposition: "rejected",
      lastApplyError: sanitized,
    }),
  );
}

async function recordFinalDispositionAfterOverride(
  stateManager: StateManager,
  input: AfterOverrideChangeInput,
  disposition: McpApplyDisposition,
): Promise<void> {
  await writeConversationRuntime(
    stateManager,
    input,
    "mcp.applyAfterOverrideChange.finalize",
    (existing) => ({
      ...(existing ?? {}),
      lastApplyDisposition: disposition,
    }),
  );
}

// ===========================================================================
// Error sanitization
// ===========================================================================

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

function formatApplyResultError(result: McpApplyResult): string {
  const pieces: string[] = [];
  for (const [serverId, msg] of Object.entries(result.errors)) {
    pieces.push(`${serverId}: ${msg}`);
  }
  const joined = pieces.join("; ") || `apply ${result.disposition}`;
  return redactSecrets(joined);
}

/**
 * Scrub obvious secret patterns from runtime error messages before persisting.
 * We can't catch every variant, but we can strip the common shapes carried by
 * SDK error messages (bearer tokens, explicit TOKEN=..., KEY=... assignments)
 * so durable state does not echo them to the UI.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:TOKEN|KEY|SECRET|PASSWORD|PASS)=\S+/gi, "[redacted]");
}
