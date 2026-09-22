import {
  type ConversationTarget,
  conversationTargetApiBase,
} from "@/lib/conversations/conversation-target";
import { computeMcpConfigInvalidations } from "./sse-invalidation";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { mcpConfigKeys, mcpToolsKeys } from "./query-keys";
import {
  mcpToolInventoryResultSchema,
  type McpConfigViewResponse,
  type McpOverrideOperation,
} from "./schemas";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  cachePrefixUpdate,
  createOptimisticMutation,
  type OptimisticCacheUpdate,
} from "@/lib/api/optimistic";

export type McpMutationScope =
  | { level: "global" }
  | { level: "project"; projectName: string }
  | { level: "session"; projectName: string; sessionName: string }
  | {
      level: "conversation";
      target: ConversationTarget;
    };

function mcpScopeUrl(scope: McpMutationScope): string {
  switch (scope.level) {
    case "global":
      return "/api/config/mcp";
    case "project":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/mcp-config`;
    case "session":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/mcp-config`;
    case "conversation":
      return `${conversationTargetApiBase(scope.target)}/mcp-config`;
  }
}

function mcpScopeQueryKey(scope: McpMutationScope): QueryKey {
  switch (scope.level) {
    case "global":
      return mcpConfigKeys.global();
    case "project":
      return mcpConfigKeys.project(scope.projectName);
    case "session":
      return mcpConfigKeys.session(scope.projectName, scope.sessionName);
    case "conversation":
      return mcpConfigKeys.conversation(scope.target);
  }
}

function scopedInvalidations(scope: McpMutationScope): readonly QueryKey[] {
  return computeMcpConfigInvalidations(scope).map((match) => match.queryKey);
}

type McpServerView = McpConfigViewResponse["servers"][number];

/**
 * Optimistic edit over every cached MCP view under the scope key (the view is
 * cached per concrete scope, so a scope-level mutation must patch them all).
 */
function serverEditUpdate<TVars>(
  scopeKey: QueryKey,
  shouldEdit: (server: McpServerView, vars: TVars) => boolean,
  edit: (server: McpServerView, vars: TVars) => McpServerView,
): OptimisticCacheUpdate<TVars> {
  return cachePrefixUpdate<TVars, McpConfigViewResponse>({
    prefix: () => scopeKey,
    update: (old, vars) =>
      old
        ? {
            ...old,
            servers: old.servers.map((s) =>
              shouldEdit(s, vars) ? edit(s, vars) : s,
            ),
          }
        : undefined,
  });
}

function readEffectiveConfigHash(
  queryClient: ReturnType<typeof useQueryClient>,
  scopeKey: QueryKey,
): string | undefined {
  const cached = queryClient.getQueryData<McpConfigViewResponse>(scopeKey);
  return cached?.effectiveConfigHash;
}

async function patchMcp(
  scope: McpMutationScope,
  operations: readonly McpOverrideOperation[],
  traceLabel: string,
  expectedEffectiveConfigHash?: string,
): Promise<void> {
  await mutationFetch(mcpScopeUrl(scope), traceLabel, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operations,
      ...(expectedEffectiveConfigHash !== undefined
        ? { expectedEffectiveConfigHash }
        : {}),
    }),
  });
}

export function useToggleMcpServerMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        serverKey,
        enabled,
      }: {
        serverKey: string;
        enabled: boolean;
      }) =>
        patchMcp(
          scope,
          [{ type: "set-server-enabled", serverKey, enabled }],
          "mcp-toggle-server",
          readEffectiveConfigHash(queryClient, scopeKey),
        ),
      updates: [
        serverEditUpdate<{ serverKey: string; enabled: boolean }>(
          scopeKey,
          (s, vars) => s.serverKey === vars.serverKey,
          (s, vars) => ({ ...s, enabled: vars.enabled, pending: true }),
        ),
      ],
      invalidateKeys: () => scopedInvalidations(scope),
    }),
  );
}

export function useResetMcpServerMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({ serverKey }: { serverKey: string }) =>
        patchMcp(
          scope,
          [{ type: "reset-server", serverKey }],
          "mcp-reset-server",
          readEffectiveConfigHash(queryClient, scopeKey),
        ),
      updates: [
        serverEditUpdate<{ serverKey: string }>(
          scopeKey,
          (s, vars) => s.serverKey === vars.serverKey,
          (s) => ({ ...s, pending: true }),
        ),
      ],
      invalidateKeys: () => scopedInvalidations(scope),
    }),
  );
}

export function useToggleMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        serverKey,
        toolName,
        enabled,
      }: {
        serverKey: string;
        toolName: string;
        enabled: boolean;
      }) =>
        patchMcp(
          scope,
          [{ type: "set-tool-enabled", serverKey, toolName, enabled }],
          "mcp-toggle-tool",
          readEffectiveConfigHash(queryClient, scopeKey),
        ),
      updates: [
        serverEditUpdate<{
          serverKey: string;
          toolName: string;
          enabled: boolean;
        }>(
          scopeKey,
          (s, vars) => s.serverKey === vars.serverKey,
          (server, vars) => ({
            ...server,
            pending: true,
            tools: {
              ...server.tools,
              tools: server.tools.tools.map((t) =>
                t.name === vars.toolName
                  ? { ...t, enabled: vars.enabled, pending: true }
                  : t,
              ),
            },
          }),
        ),
      ],
      invalidateKeys: () => scopedInvalidations(scope),
    }),
  );
}

export function useResetMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        serverKey,
        toolName,
      }: {
        serverKey: string;
        toolName: string;
      }) =>
        patchMcp(
          scope,
          [{ type: "reset-tool", serverKey, toolName }],
          "mcp-reset-tool",
          readEffectiveConfigHash(queryClient, scopeKey),
        ),
      updates: [
        serverEditUpdate<{ serverKey: string; toolName: string }>(
          scopeKey,
          (s, vars) => s.serverKey === vars.serverKey,
          (server, vars) => ({
            ...server,
            pending: true,
            tools: {
              ...server.tools,
              tools: server.tools.tools.map((t) =>
                t.name === vars.toolName ? { ...t, pending: true } : t,
              ),
            },
          }),
        ),
      ],
      invalidateKeys: () => scopedInvalidations(scope),
    }),
  );
}

function mcpScopeToolsUrl(scope: McpMutationScope, serverKey: string): string {
  const encodedServer = encodeURIComponent(serverKey);
  switch (scope.level) {
    case "global":
      return `/api/config/mcp/tools/${encodedServer}`;
    case "project":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/mcp-config/tools/${encodedServer}`;
    case "session":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/mcp-config/tools/${encodedServer}`;
    case "conversation":
      return `${conversationTargetApiBase(scope.target)}/mcp-config/tools/${encodedServer}`;
  }
}

export function useRefreshMcpToolsMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverKey: string) =>
      mutationFetch(
        mcpScopeToolsUrl(scope, serverKey),
        "mcp-refresh-tools",
        { method: "POST" },
        mcpToolInventoryResultSchema,
      ),
    onSuccess: (_data, serverKey) => {
      if (scope.level === "conversation") {
        void queryClient.invalidateQueries({
          queryKey: mcpToolsKeys.inventory(scope.target, serverKey),
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: mcpToolsKeys.all });
      }
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
