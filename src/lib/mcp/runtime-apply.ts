/**
 * MCP runtime apply service.
 *
 * Orchestrates turn-start and after-override-change application of resolved
 * MCP config to a conversation's live backend runtime, honoring the
 * concurrency & ordering guarantees documented in the spec:
 *
 * - The effective config hash and apply disposition are computed OUTSIDE the
 *   state-store write queue (configuration resolution is file I/O and must not
 *   hold the global lock, per no-slow-work-in-critical-section); only a short
 *   pending-field write enters the queue. Strict ordering against a concurrent
 *   PATCH or turn start is provided by a per-conversation in-process apply
 *   serializer that both apply paths run through, so no two apply operations for
 *   one conversation overlap and the newest submission always wins.
 * - Apply disposition is decided per the backend's capabilities and the
 *   conversation runtime's current turn state. A running turn is never
 *   interrupted — configuration changes are recorded as pending and the
 *   next-turn apply picks them up.
 * - Receipt-based runtimes keep configuration pending until dispatch is acknowledged.
 * - `applyAfterOverrideChange` writes only pending fields
 *   (`pendingConfigHash`, `pendingServerKeys`, `lastApplyDisposition`,
 *   `lastApplyError`). Live Claude applies still flow through the runtime so
 *   the user sees the change immediately, but durable state tracks them as
 *   pending until the next turn start records the applied hash.
 * - On apply failure the previous `lastAppliedConfigHash` is preserved, a
 *   sanitized error is persisted, and the failure is surfaced through the
 *   apply result for diagnostics.
 */

import { computeEffectiveConfigHash } from "./config-hash";
import { publishEvent } from "@/lib/events/publication";
import type { McpConfigUpdatedEvent } from "./schemas";

import type {
  McpApplyResult,
  PortableMcpConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { createLogger } from "@/lib/logging";
import type {
  McpApplyDisposition,
  McpRuntimeApplicationState,
} from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { createStateStore as createStateManager } from "@/lib/state-store";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("mcp.runtime-apply");

type StateManager = ReturnType<typeof createStateManager>;

// ===========================================================================
// Task 10.1 — deterministic hash over the full emitted portable config
// ===========================================================================

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
  /** Ignored by the service — the service computes its own hash outside the
   * write queue, before the short pending-field write. Kept on the type so the
   * resolver can surface the hash to callers through the same data shape when
   * useful. */
  effectiveConfigHash?: string;
}

export interface McpRuntimeApplyDeps {
  applicationState: McpRuntimeApplicationStore;
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

interface AtTurnStartInput {
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

const applyChain = new Map<string, Promise<unknown>>();

export function createMcpRuntimeApplyService(
  deps: McpRuntimeApplyDeps,
): McpRuntimeApplyService {
  const { applicationState } = deps;

  // Per-conversation apply serializer. `resolvePortableForConversation` is file
  // I/O that must NOT hold the global state-store write queue
  // (no-slow-work-in-critical-section), so configuration resolution runs outside
  // it. That opens a window in which two apply operations for the same
  // conversation could otherwise interleave and let an older, slower resolve
  // overwrite — durably or on the LIVE runtime — what a newer operation already
  // applied. BOTH production apply paths run their ENTIRE body (existence read →
  // resolve → decide → runtime invoke → short durable write) through this
  // per-conversation FIFO chain, so for a given conversation no operation ever
  // overlaps another: the newest submission always applies last and wins, whether
  // it comes from an override PATCH (`applyAfterOverrideChange`) or a turn start
  // (`applyAtTurnStart`). This is a per-conversation in-process promise chain, NOT
  // the global write queue — it never blocks another conversation or the event
  // loop, and the short durable writes still go through the global queue via
  // `mutateConversation`. Durable pending state is the cross-restart source of
  // truth, reconciled fresh at turn start, so the chain can reset on restart.

  function runSerialized<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = applyChain.get(conversationId) ?? Promise.resolve();
    // Run `fn` after the predecessor settles either way — a failed apply must not
    // poison the chain for the operation queued behind it.
    const run = previous.then(fn, fn);
    // The stored tail never rejects, so a rejection can't break the chain.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    applyChain.set(conversationId, tail);
    void tail.then(() => {
      // Drop the entry once this was the last queued op, bounding map growth.
      if (applyChain.get(conversationId) === tail) {
        applyChain.delete(conversationId);
      }
    });
    return run;
  }

  function applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult> {
    return runSerialized(input.conversationId, () =>
      applyAfterOverrideChangeInner(input),
    );
  }

  async function applyAfterOverrideChangeInner(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult> {
    // --- Phase 1: existence pre-read → resolve + hash + disposition, ENTIRELY
    // OUTSIDE the write queue. The focused `getConversation` (mirroring
    // `applyAtTurnStart`) means a missing conversation rejects before any resolver
    // I/O runs. Configuration resolution (`resolvePortableForConversation`) is
    // file I/O that performs no write, so it must not hold the queue
    // (no-slow-work-in-critical-section). Only the short pending-field write below
    // opens a critical section; the runtime invocation (Phase 2) stays outside the
    // lock. Ordering against a concurrent PATCH or turn start is guaranteed by the
    // per-conversation `runSerialized` chain wrapping this whole body — no two
    // apply ops for one conversation overlap, so a stale resolve can never clobber
    // a newer one.
    const existing = await applicationState.read(input);
    if (!existing.found) {
      throw new Error(
        `Conversation "${input.conversationId}" not found in session "${input.sessionName}" during mcp.applyAfterOverrideChange.resolve`,
      );
    }

    const resolved = await deps.resolvePortableForConversation({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      backend: input.backend,
    });
    const hash = computeEffectiveConfigHash(resolved.portable);
    const decision = decideApplyDisposition({
      runtime: deps.getRuntime(input.conversationId),
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

    // After-override-change path writes only pending fields; never mutates
    // lastAppliedConfigHash. A short synchronous critical section — the resolve
    // above already ran outside the lock.
    await writeConversationRuntime(
      applicationState,
      input,
      "mcp.applyAfterOverrideChange",
      (existing) => ({
        ...(existing ?? {}),
        pendingConfigHash: hash,
        pendingServerKeys: [...input.changedServerKeys],
        lastApplyDisposition: plannedDisposition,
        // Clear any prior error — this is a fresh attempt.
        lastApplyError: undefined,
      }),
    );

    const phase1 = {
      portable: resolved.portable,
      hash,
      decision,
      plannedDisposition,
    };

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

    // Live idle apply or next-turn staging. Both go through
    // applyPortableMcpConfig; the runtime reports which one happened.
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
      // preserve lastAppliedConfigHash. No supersession check needed — the
      // serializer guarantees the next op has not started yet.
      await recordFailureAfterOverride(
        applicationState,
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
        applicationState,
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

    // Final disposition reflects the runtime's actual behavior: a live idle
    // apply returns `applied_now`; a staging backend returns
    // `deferred_to_next_turn`.
    await recordFinalDispositionAfterOverride(
      applicationState,
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

  function applyAtTurnStart(
    input: AtTurnStartInput,
  ): Promise<ConversationApplyResult> {
    return runSerialized(input.conversationId, () =>
      applyAtTurnStartInner(input),
    );
  }

  async function applyAtTurnStartInner(
    input: AtTurnStartInput,
  ): Promise<ConversationApplyResult> {
    // Phase 1: resolve + hash + read `previous` ENTIRELY OUTSIDE the write
    // queue. Configuration resolution (`resolvePortableForConversation`) is file
    // I/O that performs no write, so it must not hold the queue
    // (no-slow-work-in-critical-section); a focused `getConversation` supplies
    // the only state it needs (`conv.mcpRuntime`). Reading `previous` before
    // resolving means a missing conversation throws before any I/O, and keeps
    // the concurrency model intact: a newer PATCH landing after this resolve is
    // anticipated below by the pending-hash reconciliation on success.
    const existing = await applicationState.read(input);
    if (!existing.found) {
      throw new Error(
        `Conversation "${input.conversationId}" not found in session "${input.sessionName}" during mcp.applyAtTurnStart.resolve`,
      );
    }
    const previous: McpRuntimeApplicationState | undefined = existing.state
      ? { ...existing.state }
      : undefined;
    const resolved = await deps.resolvePortableForConversation({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      backend: input.backend,
    });
    const phase1 = {
      portable: resolved.portable,
      hash: computeEffectiveConfigHash(resolved.portable),
      previous,
    };

    const previouslyApplied = phase1.previous?.lastAppliedConfigHash;
    const storedPending = phase1.previous?.pendingConfigHash;

    const runtime = deps.getRuntime(input.conversationId);

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

    if (!runtime?.applyPortableMcpConfig) {
      // No active runtime. Record pending and bail. lastAppliedConfigHash
      // untouched.
      await writeConversationRuntime(
        applicationState,
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
        applicationState,
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
        applicationState,
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

    if (runtime.mcpConfigDelivery === "input-accepted") {
      await writeConversationRuntime(
        applicationState,
        input,
        "mcp.awaitDispatchReceipt",
        (existing) => ({
          ...existing,
          pendingConfigHash: phase1.hash,
          lastApplyDisposition: "deferred_to_next_turn",
        }),
      );
      return {
        conversationId: input.conversationId,
        backend: input.backend,
        disposition: "deferred_to_next_turn",
        effectiveConfigHash: phase1.hash,
      };
    }

    // Success: turn-start path is the single writer of lastAppliedConfigHash.
    // Clear pending only if the applied hash equals the stored pending hash —
    // otherwise a newer PATCH landed after our resolve and its pending hash
    // must survive to drive the subsequent turn.
    await writeConversationRuntime(
      applicationState,
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

  // The backend's declared between-turn apply mode is the sole decision
  // input — never backend identity.
  const betweenTurnApply = getBackendDescriptor(backend).mcp.betweenTurnApply;
  switch (betweenTurnApply) {
    case "next-turn":
      // Always stages — the backend's per-turn reconstruction picks up the
      // new portable at the start of the next turn, so a running turn is
      // never interrupted and staging is safe mid-turn.
      return { kind: "stage" };
    case "unsupported":
      // No between-turn mechanism at all: record pending only; the turn-start
      // apply owns delivery.
      return { kind: "defer-running" };
    case "live-when-idle":
      // Live when idle, defer while running. Turn activity is the runtime's
      // declared `isTurnActive`; absent means not-active.
      if (runtime.isTurnActive === true) return { kind: "defer-running" };
      return { kind: "apply-live" };
  }
}

// ===========================================================================
// State write helpers (Task 10.3)
// ===========================================================================

export interface McpRuntimeIdentity {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}
export interface McpRuntimeApplicationStore {
  read(
    identity: McpRuntimeIdentity,
  ): Promise<
    { found: false } | { found: true; state?: McpRuntimeApplicationState }
  >;
  update(
    identity: McpRuntimeIdentity,
    label: string,
    updater: (
      state: McpRuntimeApplicationState | undefined,
    ) => McpRuntimeApplicationState,
  ): Promise<void>;
}

export function createMcpRuntimeApplicationStore(
  store: Pick<StateManager, "getConversation" | "mutateConversation">,
): McpRuntimeApplicationStore {
  return {
    async read(identity) {
      const conversation = await store.getConversation(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
      return conversation
        ? { found: true, state: conversation.mcpRuntime }
        : { found: false };
    },
    async update(identity, label, updater) {
      await store.mutateConversation(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
        label,
        (conversation) => {
          conversation.mcpRuntime = updater(conversation.mcpRuntime);
        },
      );
    },
  };
}

async function writeConversationRuntime(
  applicationState: McpRuntimeApplicationStore,
  input: McpRuntimeIdentity,
  label: string,
  updater: (
    existing: McpRuntimeApplicationState | undefined,
  ) => McpRuntimeApplicationState,
): Promise<void> {
  await applicationState.update(input, label, (state) =>
    pruneRuntimeState(updater(state)),
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
  applicationState: McpRuntimeApplicationStore,
  input: AfterOverrideChangeInput,
  pendingHash: string,
  sanitized: string,
): Promise<void> {
  await writeConversationRuntime(
    applicationState,
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
  applicationState: McpRuntimeApplicationStore,
  input: AfterOverrideChangeInput,
  disposition: McpApplyDisposition,
): Promise<void> {
  await writeConversationRuntime(
    applicationState,
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
  const raw = getErrorMessage(err);
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

export async function recordMcpConfigReceipt(
  applicationState: McpRuntimeApplicationStore,
  identity: McpRuntimeIdentity & { projectName: string },
  hash: string,
  emit: (event: McpConfigUpdatedEvent) => void = publishEvent,
): Promise<void> {
  let effectiveConfigHash = hash;
  let changedServerKeys: string[] = [];
  await writeConversationRuntime(
    applicationState,
    identity,
    "mcp.dispatchReceipt",
    (state) => {
      effectiveConfigHash = state?.pendingConfigHash ?? hash;
      changedServerKeys = [...(state?.pendingServerKeys ?? [])];
      const next = { ...state, lastAppliedConfigHash: hash };
      if (next.pendingConfigHash && next.pendingConfigHash !== hash)
        return next;
      delete next.pendingConfigHash;
      delete next.pendingServerKeys;
      delete next.lastApplyError;
      next.lastApplyDisposition = "applied_now";
      return next;
    },
  );
  emit({
    type: "mcp-config-updated",
    level: "conversation",
    projectName: identity.projectName,
    sessionName: identity.sessionName,
    conversationId: identity.conversationId,
    changedServerKeys,
    effectiveConfigHash,
  });
  logger.info("mcp.dispatch_receipt", {
    conversationId: identity.conversationId,
    configHash: hash,
  });
}
