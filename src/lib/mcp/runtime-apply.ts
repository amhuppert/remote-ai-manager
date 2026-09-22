/**
 * Save MCP preferences for the next turn and persist actual delivery outcomes.
 * Configuration resolution and runtime calls stay outside the state-store queue.
 * Saves serialize their resolutions; turn delivery preserves newer pending state.
 */

import {
  conversationTargetStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { computeEffectiveConfigHash } from "./config-hash";
import { publishEvent } from "@/lib/events/publication";
import type { McpConfigUpdatedEvent } from "./schemas";

import type {
  McpApplyResult,
  PortableMcpConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
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
    target: ConversationTarget;
    backend: AgentBackendId;
  }): Promise<ResolvedPortableForConversation>;
  now?(): Date;
}

export interface AfterOverrideChangeInput {
  projectPath: string;
  target: ConversationTarget;
  backend: AgentBackendId;
  changedServerKeys: readonly string[];
}

interface AtTurnStartInput {
  projectPath: string;
  target: ConversationTarget;
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

const saveChain = new Map<string, Promise<unknown>>();

export function createMcpRuntimeApplyService(
  deps: McpRuntimeApplyDeps,
): McpRuntimeApplyService {
  const { applicationState } = deps;

  // Serialize save resolutions so a slower earlier save cannot overwrite a later one.
  // Turn delivery waits for existing saves but does not block new preferences.
  function runSerialized<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = saveChain.get(conversationId) ?? Promise.resolve();
    // Run `fn` after the predecessor settles either way — a failed apply must not
    // poison the chain for the operation queued behind it.
    const run = previous.then(fn, fn);
    // The stored tail never rejects, so a rejection can't break the chain.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    saveChain.set(conversationId, tail);
    void tail.then(() => {
      // Drop the entry once this was the last queued op, bounding map growth.
      if (saveChain.get(conversationId) === tail) {
        saveChain.delete(conversationId);
      }
    });
    return run;
  }

  function applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult> {
    return runSerialized(input.target.conversationId, () =>
      applyAfterOverrideChangeInner(input),
    );
  }

  async function applyAfterOverrideChangeInner(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult> {
    // Resolve outside the write queue; the save chain orders competing resolutions.
    const existing = await applicationState.read(input);
    if (!existing.found) {
      throw new Error(
        `Conversation "${input.target.conversationId}" not found during mcp.applyAfterOverrideChange.resolve`,
      );
    }

    const resolved = await deps.resolvePortableForConversation({
      projectPath: input.projectPath,
      target: input.target,
      backend: input.backend,
    });
    const hash = computeEffectiveConfigHash(resolved.portable);
    const runtime = deps.getRuntime(input.target.conversationId);
    const disposition =
      runtime?.status === "alive"
        ? "deferred_to_next_turn"
        : "no_active_runtime";
    await writeConversationRuntime(
      applicationState,
      input,
      "mcp.applyAfterOverrideChange",
      (previous) => ({
        ...previous,
        pendingConfigHash: hash,
        pendingServerKeys: [...input.changedServerKeys],
        lastApplyDisposition: disposition,
        lastApplyError: undefined,
      }),
    );
    return {
      conversationId: input.target.conversationId,
      backend: input.backend,
      disposition,
      effectiveConfigHash: hash,
    };
  }

  async function applyAtTurnStart(
    input: AtTurnStartInput,
  ): Promise<ConversationApplyResult> {
    await saveChain.get(input.target.conversationId);
    return applyAtTurnStartInner(input);
  }

  async function applyAtTurnStartInner(
    input: AtTurnStartInput,
  ): Promise<ConversationApplyResult> {
    // Keep the read snapshot so a later saved preference survives this delivery.
    const existing = await applicationState.read(input);
    if (!existing.found) {
      throw new Error(
        `Conversation "${input.target.conversationId}" not found during mcp.applyAtTurnStart.resolve`,
      );
    }
    const previous: McpRuntimeApplicationState | undefined = existing.state
      ? { ...existing.state }
      : undefined;
    const resolved = await deps.resolvePortableForConversation({
      projectPath: input.projectPath,
      target: input.target,
      backend: input.backend,
    });
    const phase1 = {
      portable: resolved.portable,
      hash: computeEffectiveConfigHash(resolved.portable),
      previous,
    };

    const previouslyApplied = phase1.previous?.lastAppliedConfigHash;
    const storedPending = phase1.previous?.pendingConfigHash;

    const runtime = deps.getRuntime(input.target.conversationId);

    if (previouslyApplied === phase1.hash) {
      // A reset can match actual accepted configuration. Clear only that same
      // pending selection, preserving a newer save made while this resolve ran.
      if (storedPending === phase1.hash) {
        await writeConversationRuntime(
          applicationState,
          input,
          "mcp.applyAtTurnStart.already-applied",
          (current) => {
            if (
              current?.pendingConfigHash !== phase1.hash ||
              current.lastAppliedConfigHash !== phase1.hash
            )
              return current ?? {};
            const next = {
              ...current,
              lastApplyDisposition: "applied_now" as const,
            };
            delete next.pendingConfigHash;
            delete next.pendingServerKeys;
            delete next.lastApplyError;
            return next;
          },
        );
      }
      logger.debug("turn-start.noop", {
        conversationId: input.target.conversationId,
      });
      return {
        conversationId: input.target.conversationId,
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
        (existing) =>
          pendingStateChanged(existing, previous)
            ? (existing ?? {})
            : {
                ...existing,
                pendingConfigHash: phase1.hash,
                lastApplyDisposition: "no_active_runtime",
              },
      );
      return {
        conversationId: input.target.conversationId,
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
        conversationId: input.target.conversationId,
        backend: input.backend,
      });
      await writeConversationRuntime(
        applicationState,
        input,
        "mcp.applyAtTurnStart.failure",
        (existing) =>
          pendingStateChanged(existing, previous)
            ? (existing ?? {})
            : {
                ...existing,
                lastApplyDisposition: "rejected",
                lastApplyError: sanitized,
              },
      );
      return {
        conversationId: input.target.conversationId,
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
        (existing) =>
          pendingStateChanged(existing, previous)
            ? (existing ?? {})
            : {
                ...existing,
                lastApplyDisposition: "rejected",
                lastApplyError: sanitized,
              },
      );
      return {
        conversationId: input.target.conversationId,
        backend: input.backend,
        disposition: "rejected",
        effectiveConfigHash: phase1.hash,
        error: sanitized,
      };
    }

    if (
      applyResult.disposition === "deferred_to_next_conversation" ||
      applyResult.disposition === "deferred_to_next_turn"
    ) {
      await writeConversationRuntime(
        applicationState,
        input,
        "mcp.awaitDispatchReceipt",
        (existing) =>
          pendingStateChanged(existing, previous)
            ? (existing ?? {})
            : {
                ...existing,
                pendingConfigHash: phase1.hash,
                lastApplyDisposition: applyResult.disposition,
              },
      );
      return {
        conversationId: input.target.conversationId,
        backend: input.backend,
        disposition: applyResult.disposition,
        effectiveConfigHash: phase1.hash,
      };
    }

    // Record actual delivery. Clear pending only if it matches the applied hash —
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
        };
        const currentPending = existing?.pendingConfigHash ?? storedPending;
        if (currentPending && currentPending !== phase1.hash) return next;
        next.lastApplyDisposition = applyResult.disposition;
        delete next.lastApplyError;
        if (currentPending === phase1.hash) {
          delete next.pendingConfigHash;
          delete next.pendingServerKeys;
        }
        return next;
      },
    );
    return {
      conversationId: input.target.conversationId,
      backend: input.backend,
      disposition: applyResult.disposition,
      effectiveConfigHash: phase1.hash,
    };
  }

  return { applyAfterOverrideChange, applyAtTurnStart };
}

function pendingStateChanged(
  current: McpRuntimeApplicationState | undefined,
  previous: McpRuntimeApplicationState | undefined,
): boolean {
  return (
    current?.pendingConfigHash !== previous?.pendingConfigHash ||
    current?.lastAppliedConfigHash !== previous?.lastAppliedConfigHash
  );
}

// ===========================================================================
// Decision helper (Task 10.2)
// ===========================================================================

export interface McpRuntimeIdentity {
  projectPath: string;
  target: ConversationTarget;
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
        conversationTargetStoreSessionName(identity.target),
        identity.target.conversationId,
      );
      return conversation
        ? { found: true, state: conversation.mcpRuntime }
        : { found: false };
    },
    async update(identity, label, updater) {
      await store.mutateConversation(
        identity.projectPath,
        conversationTargetStoreSessionName(identity.target),
        identity.target.conversationId,
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
  identity: McpRuntimeIdentity,
  hash: string,
  options: {
    emit?: (event: McpConfigUpdatedEvent) => void;
    error?: string;
  } = {},
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
      if (options.error)
        return {
          ...next,
          lastApplyDisposition: "rejected",
          lastApplyError: options.error,
        };
      if (next.pendingConfigHash && next.pendingConfigHash !== hash)
        return next;
      delete next.pendingConfigHash;
      delete next.pendingServerKeys;
      delete next.lastApplyError;
      next.lastApplyDisposition = "applied_now";
      return next;
    },
  );
  (options.emit ?? publishEvent)({
    type: "mcp-config-updated",
    level: "conversation",
    target: identity.target,
    changedServerKeys,
    effectiveConfigHash,
  });
  logger.info("mcp.dispatch_receipt", {
    conversationId: identity.target.conversationId,
    configHash: hash,
  });
}
