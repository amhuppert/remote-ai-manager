/**
 * Capability-override mutation service.
 *
 * Wraps the global and scoped persistence stores with two pieces of behavior
 * the stores themselves do not own:
 *
 *  1. Expected-hash conflict detection. When the caller passes
 *     `expectedHash`, the service installs a precondition on the store patch
 *     that runs *inside* the serialized write boundary (the global-store
 *     write mutex or the state-manager mutate boundary). The precondition
 *     recomputes the effective hash and throws `CapabilityHashConflictError`
 *     when it disagrees with `expectedHash`. Because the precondition runs
 *     under the same lock as the read and the write, two concurrent patches
 *     sharing the same `expectedHash` cannot both succeed.
 *  2. Fanout metadata. After a successful write, the service returns the
 *     changed item ids, target scope, cascade kind, post-write effective
 *     hash, and the recomputed view — exactly the inputs the API route uses
 *     to broadcast `agent-capabilities-updated` SSE events and to invalidate
 *     downstream queries.
 *
 * The hash/view computation is injected (`computeEffectiveHash`,
 * `computeView`) so this service stays decoupled from the resolver work that
 * lands in task 4. Anything that can produce the canonical view + hash pair
 * for a scope/cascade satisfies the contract.
 *
 * Write atomicity is inherited from the underlying store: the global store
 * writes via temp-then-rename inside a per-store mutex; the scope store
 * routes through the state manager's mutate boundary. We never persist a
 * partial batch.
 *
 * Sanitized logging is enforced: accepted/rejected/failed outcomes record
 * scope identifiers, cascade kind, and changed-item counts only — never raw
 * operation payloads or native source contents.
 */

import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import {
  agentCapabilityPatchRequestSchema,
  AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityPatchRequest,
  type AgentCapabilityViewResponse,
} from "@/lib/schemas";

import type { GlobalCapabilityOverrideStore } from "./global-store";
import { redactAgentCapabilityText } from "./redaction";
import type { ScopeCapabilityOverrideStore } from "./scope-store";

const logger = createLogger("agent-capabilities.mutation-service");

export type MutationScope =
  | { level: "global" }
  | { level: "project"; projectPath: string }
  | { level: "session"; projectPath: string; sessionName: string }
  | {
      level: "conversation";
      projectPath: string;
      sessionName: string;
      conversationId: string;
    };

export interface MutationRequest {
  scope: MutationScope;
  request: AgentCapabilityPatchRequest;
}

interface MutationAppliedResult {
  status: "applied";
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: readonly string[];
  effectiveHash: string;
  view: AgentCapabilityViewResponse;
  operationId: string;
}

interface MutationConflictResult {
  status: "conflict";
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  expectedHash: string;
  actualHash: string;
  latestView: AgentCapabilityViewResponse;
  operationId: string;
}

export type MutationResult = MutationAppliedResult | MutationConflictResult;

export interface CapabilityMutationServiceDeps {
  globalStore: GlobalCapabilityOverrideStore;
  scopeStore: ScopeCapabilityOverrideStore;
  computeEffectiveHash(
    scope: MutationScope,
    cascadeKind: AgentCapabilityCascadeKind,
  ): Promise<string>;
  computeView(
    scope: MutationScope,
    cascadeKind: AgentCapabilityCascadeKind,
  ): Promise<AgentCapabilityViewResponse>;
  /**
   * Optional fanout hook invoked after a successful patch persists. Production
   * wires this to the capability runtime apply service so override changes
   * fan out to affected active conversations (live-apply idle Claude, stage
   * Codex for next turn, defer Claude sub-agents to the next conversation).
   * Failures inside the hook are caught and logged so a fanout error never
   * masks a successful persist.
   */
  applyAfterMutation?(input: {
    scope: MutationScope;
    cascadeKind: AgentCapabilityCascadeKind;
    changedItemIds: readonly string[];
    operationId: string;
  }): Promise<void>;
  createOperationId?(): string;
}

export interface CapabilityMutationService {
  mutate(input: MutationRequest): Promise<MutationResult>;
}

class CapabilityHashConflictError extends Error {
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(expectedHash: string, actualHash: string) {
    super(
      `Capability hash conflict: expected=${expectedHash} actual=${actualHash}`,
    );
    this.name = "CapabilityHashConflictError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export function createCapabilityMutationService(
  deps: CapabilityMutationServiceDeps,
): CapabilityMutationService {
  const {
    globalStore,
    scopeStore,
    computeEffectiveHash,
    computeView,
    applyAfterMutation,
  } = deps;
  const createOperationId = deps.createOperationId ?? randomUUID;

  async function mutate(input: MutationRequest): Promise<MutationResult> {
    const parsedRequest = agentCapabilityPatchRequestSchema.parse(
      input.request,
    );
    const { cascadeKind, operations, expectedHash } = parsedRequest;
    const scope = input.scope;
    const scopeContext = describeScope(scope);
    const backend = AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[cascadeKind];
    const operationId = createOperationId();

    const precondition =
      expectedHash === undefined
        ? undefined
        : async () => {
            const actualHash = await computeEffectiveHash(scope, cascadeKind);
            if (actualHash !== expectedHash) {
              throw new CapabilityHashConflictError(expectedHash, actualHash);
            }
          };

    let changedItemIds: readonly string[];
    try {
      changedItemIds = await applyPatch(
        scope,
        cascadeKind,
        operations,
        precondition,
      );
    } catch (err) {
      if (err instanceof CapabilityHashConflictError) {
        const latestView = await computeView(scope, cascadeKind);
        logger.info("mutation.rejected", {
          reason: "hash_conflict",
          cascadeKind,
          backend,
          operationId,
          expectedHash: err.expectedHash,
          actualHash: err.actualHash,
          ...scopeContext,
        });
        return {
          status: "conflict",
          scope,
          cascadeKind,
          expectedHash: err.expectedHash,
          actualHash: err.actualHash,
          latestView,
          operationId,
        };
      }
      logger.error("mutation.failed", {
        cascadeKind,
        backend,
        operationId,
        error: redactAgentCapabilityText(getErrorMessage(err)),
        ...scopeContext,
      });
      throw err;
    }

    const effectiveHash = await computeEffectiveHash(scope, cascadeKind);
    const view = await computeView(scope, cascadeKind);

    logger.info("mutation.applied", {
      cascadeKind,
      backend,
      operationId,
      changedCount: changedItemIds.length,
      effectiveHash,
      ...scopeContext,
    });

    if (applyAfterMutation) {
      try {
        await applyAfterMutation({
          scope,
          cascadeKind,
          changedItemIds,
          operationId,
        });
      } catch (err) {
        logger.error("mutation.apply_fanout_failed", {
          cascadeKind,
          backend,
          operationId,
          error: redactAgentCapabilityText(getErrorMessage(err)),
          ...scopeContext,
        });
      }
    }

    return {
      status: "applied",
      scope,
      cascadeKind,
      changedItemIds,
      effectiveHash,
      view,
      operationId,
    };
  }

  async function applyPatch(
    scope: MutationScope,
    cascadeKind: AgentCapabilityCascadeKind,
    operations: AgentCapabilityPatchRequest["operations"],
    precondition: (() => Promise<void>) | undefined,
  ): Promise<readonly string[]> {
    switch (scope.level) {
      case "global": {
        const result = await globalStore.patch({
          cascadeKind,
          operations,
          precondition,
        });
        return result.changedItemIds;
      }
      case "project": {
        const result = await scopeStore.patchProject(scope.projectPath, {
          cascadeKind,
          operations,
          precondition,
        });
        return result.changedItemIds;
      }
      case "session": {
        const result = await scopeStore.patchSession(
          scope.projectPath,
          scope.sessionName,
          { cascadeKind, operations, precondition },
        );
        return result.changedItemIds;
      }
      case "conversation": {
        const result = await scopeStore.patchConversation(
          scope.projectPath,
          scope.sessionName,
          scope.conversationId,
          { cascadeKind, operations, precondition },
        );
        return result.changedItemIds;
      }
      default: {
        const exhaustive: never = scope;
        throw new Error(
          `Unsupported capability mutation scope: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  return { mutate };
}

function describeScope(scope: MutationScope): Record<string, string> {
  switch (scope.level) {
    case "global":
      return { level: "global" };
    case "project":
      return { level: "project", projectPath: scope.projectPath };
    case "session":
      return {
        level: "session",
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
      };
    case "conversation":
      return {
        level: "conversation",
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
        conversationId: scope.conversationId,
      };
  }
}
