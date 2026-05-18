"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch, mutationFetch } from "@/lib/api-client";
import { computeAgentCapabilityInvalidations } from "@/lib/agent-capabilities/sse-invalidation";
import { agentCapabilityKeys } from "@/lib/query-keys";
import {
  agentCapabilityInventorySchema,
  agentCapabilityInvalidationHintsSchema,
  agentCapabilityPatchRequestSchema,
  agentCapabilityViewResponseSchema,
  type AgentCapabilityApplyStatus,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityOverrideOperation,
  type AgentCapabilityPatchRequest,
  type AgentCapabilityViewResponse,
} from "@/lib/schemas";

export type AgentCapabilityScope =
  | { level: "global" }
  | { level: "project"; projectName: string }
  | { level: "session"; projectName: string; sessionName: string }
  | {
      level: "conversation";
      projectName: string;
      sessionName: string;
      conversationId: string;
    };

interface QueryOptions {
  enabled?: boolean;
}

interface PatchContext {
  rollback: () => void;
}

interface ToggleVariables {
  itemId: string;
  enabled: boolean;
}

interface ResetVariables {
  itemId: string;
}

const agentCapabilityViewEnvelopeSchema = z.object({
  view: agentCapabilityViewResponseSchema,
});

const agentCapabilityPatchResponseSchema = z.object({
  view: agentCapabilityViewResponseSchema,
  effectiveHash: z.string(),
  changedItemIds: z.array(z.string()),
  invalidationHints: agentCapabilityInvalidationHintsSchema,
});

const agentCapabilityRefreshResponseSchema = z.object({
  inventory: agentCapabilityInventorySchema,
  view: agentCapabilityViewResponseSchema,
  invalidationHints: agentCapabilityInvalidationHintsSchema,
});

export function agentCapabilityScopeQueryKey(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
): QueryKey {
  switch (scope.level) {
    case "global":
      return agentCapabilityKeys.global(cascadeKind);
    case "project":
      return agentCapabilityKeys.project(scope.projectName, cascadeKind);
    case "session":
      return agentCapabilityKeys.session(
        scope.projectName,
        scope.sessionName,
        cascadeKind,
      );
    case "conversation":
      return agentCapabilityKeys.conversation(
        scope.projectName,
        scope.sessionName,
        scope.conversationId,
        cascadeKind,
      );
  }
}

export function agentCapabilityScopeUrl(scope: AgentCapabilityScope): string {
  switch (scope.level) {
    case "global":
      return "/api/config/agent-capabilities";
    case "project":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/agent-capabilities`;
    case "session":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/agent-capabilities`;
    case "conversation":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/conversations/${encodeURIComponent(scope.conversationId)}/agent-capabilities`;
  }
}

export function agentCapabilityRefreshScopeUrl(
  scope: AgentCapabilityScope,
): string {
  return `${agentCapabilityScopeUrl(scope)}/refresh`;
}

export function useAgentCapabilityViewQuery(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
  options?: QueryOptions,
): UseQueryResult<AgentCapabilityViewResponse, Error> {
  return useQuery({
    queryKey: agentCapabilityScopeQueryKey(scope, cascadeKind),
    queryFn: async () => {
      const envelope = await apiFetch(
        `${agentCapabilityScopeUrl(scope)}?cascadeKind=${encodeURIComponent(cascadeKind)}`,
        agentCapabilityViewEnvelopeSchema,
      );
      return envelope.view;
    },
    enabled: options?.enabled ?? true,
  });
}

export function useToggleAgentCapabilityItemMutation(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
): UseMutationResult<
  AgentCapabilityViewResponse,
  Error,
  ToggleVariables,
  PatchContext
> {
  return usePatchAgentCapabilityMutation(scope, cascadeKind, (vars) => [
    {
      type: "set-item-enabled",
      itemId: vars.itemId,
      enabled: vars.enabled,
    },
  ]);
}

export function useResetAgentCapabilityItemMutation(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
): UseMutationResult<
  AgentCapabilityViewResponse,
  Error,
  ResetVariables,
  PatchContext
> {
  return usePatchAgentCapabilityMutation(scope, cascadeKind, (vars) => [
    {
      type: "reset-item",
      itemId: vars.itemId,
    },
  ]);
}

export function useRefreshAgentCapabilityMutation(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
): UseMutationResult<AgentCapabilityViewResponse, Error, void, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await mutationFetch(
        agentCapabilityRefreshScopeUrl(scope),
        "agent-capabilities-refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cascadeKind }),
        },
        agentCapabilityRefreshResponseSchema,
      );
      return response.view;
    },
    onSuccess: (view) => {
      queryClient.setQueryData(
        agentCapabilityScopeQueryKey(scope, cascadeKind),
        view,
      );
    },
    onSettled: () => {
      invalidateCapabilityScope(queryClient, scope, cascadeKind);
    },
  });
}

function usePatchAgentCapabilityMutation<TVars extends { itemId: string }>(
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
  buildOperations: (vars: TVars) => readonly AgentCapabilityOverrideOperation[],
): UseMutationResult<AgentCapabilityViewResponse, Error, TVars, PatchContext> {
  const queryClient = useQueryClient();
  const queryKey = agentCapabilityScopeQueryKey(scope, cascadeKind);

  return useMutation<AgentCapabilityViewResponse, Error, TVars, PatchContext>({
    mutationFn: async (vars) => {
      const request = buildPatchRequest(
        cascadeKind,
        buildOperations(vars),
        readEffectiveHash(queryClient, queryKey),
      );
      const response = await mutationFetch(
        agentCapabilityScopeUrl(scope),
        "agent-capabilities-patch",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
        agentCapabilityPatchResponseSchema,
      );
      return response.view;
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      return {
        rollback: applyOptimisticPendingState(
          queryClient,
          queryKey,
          vars.itemId,
        ),
      };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
    },
    onSettled: () => {
      invalidateCapabilityScope(queryClient, scope, cascadeKind);
    },
  });
}

function buildPatchRequest(
  cascadeKind: AgentCapabilityCascadeKind,
  operations: readonly AgentCapabilityOverrideOperation[],
  expectedHash: string | undefined,
): AgentCapabilityPatchRequest {
  return agentCapabilityPatchRequestSchema.parse({
    cascadeKind,
    operations,
    ...(expectedHash !== undefined ? { expectedHash } : {}),
  });
}

function readEffectiveHash(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
): string | undefined {
  const cached =
    queryClient.getQueryData<AgentCapabilityViewResponse>(queryKey);
  return cached?.effectiveHash;
}

function applyOptimisticPendingState(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
  itemId: string,
): () => void {
  const snapshots: Array<readonly [QueryKey, AgentCapabilityViewResponse]> = [];
  const queries = queryClient.getQueryCache().findAll({ queryKey });

  for (const query of queries) {
    const data = query.state.data;
    const parsed = agentCapabilityViewResponseSchema.safeParse(data);
    if (!parsed.success) continue;
    snapshots.push([query.queryKey, parsed.data]);
    queryClient.setQueryData<AgentCapabilityViewResponse>(query.queryKey, {
      ...parsed.data,
      items: parsed.data.items.map((row) =>
        row.itemId === itemId
          ? {
              ...row,
              applyStatus: optimisticApplyStatus(parsed.data),
            }
          : row,
      ),
    });
  }

  return () => {
    for (const [key, value] of snapshots) {
      queryClient.setQueryData(key, value);
    }
  };
}

function optimisticApplyStatus(
  view: AgentCapabilityViewResponse,
): AgentCapabilityApplyStatus {
  if (
    view.metadata?.compositionSupport === "verification-gated" ||
    view.metadata?.compositionSupport === "diagnostic-only"
  ) {
    return "unsupported";
  }

  if (view.metadata?.applySemantics === "idle-live-apply") {
    return "staged-idle";
  }

  if (view.metadata?.applySemantics === "next-turn") {
    return "staged-next-turn";
  }

  if (view.metadata?.applySemantics === "next-conversation") {
    return "deferred-next-conversation";
  }

  return "none";
}

function invalidateCapabilityScope(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: AgentCapabilityScope,
  cascadeKind: AgentCapabilityCascadeKind,
): void {
  for (const invalidation of computeAgentCapabilityInvalidations({
    level: scope.level as AgentCapabilityCascadeLayer,
    cascadeKind,
    ...scopeNames(scope),
  })) {
    void queryClient.invalidateQueries({ queryKey: invalidation.queryKey });
  }
}

function scopeNames(scope: AgentCapabilityScope): {
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
} {
  if (scope.level === "global") return {};
  if (scope.level === "project") {
    return { projectName: scope.projectName };
  }
  if (scope.level === "session") {
    return {
      projectName: scope.projectName,
      sessionName: scope.sessionName,
    };
  }
  return {
    projectName: scope.projectName,
    sessionName: scope.sessionName,
    conversationId: scope.conversationId,
  };
}
