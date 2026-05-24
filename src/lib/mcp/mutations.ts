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

export type McpMutationScope =
  | { level: "global" }
  | { level: "project"; projectName: string }
  | { level: "session"; projectName: string; sessionName: string }
  | {
      level: "conversation";
      projectName: string;
      sessionName: string;
      conversationId: string;
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
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/conversations/${encodeURIComponent(scope.conversationId)}/mcp-config`;
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
      return mcpConfigKeys.conversation(
        scope.projectName,
        scope.sessionName,
        scope.conversationId,
      );
  }
}

function scopedInvalidations(scope: McpMutationScope): readonly QueryKey[] {
  switch (scope.level) {
    case "global":
      return [mcpConfigKeys.all];
    case "project":
      return [mcpConfigKeys.project(scope.projectName)];
    case "session":
      return [mcpConfigKeys.session(scope.projectName, scope.sessionName)];
    case "conversation":
      return [
        mcpConfigKeys.conversation(
          scope.projectName,
          scope.sessionName,
          scope.conversationId,
        ),
      ];
  }
}

/**
 * Optimistically edit every matching cached MCP view at the given scope and
 * return a rollback function.
 */
function applyOptimisticViewUpdate(
  queryClient: ReturnType<typeof useQueryClient>,
  scopeKey: QueryKey,
  edit: (
    server: McpConfigViewResponse["servers"][number],
  ) => McpConfigViewResponse["servers"][number],
  shouldEdit: (server: McpConfigViewResponse["servers"][number]) => boolean,
): () => void {
  const snapshots: Array<readonly [QueryKey, McpConfigViewResponse]> = [];
  const caches = queryClient.getQueryCache().findAll({ queryKey: scopeKey });
  for (const entry of caches) {
    const data = entry.state.data as McpConfigViewResponse | undefined;
    if (!data) continue;
    snapshots.push([entry.queryKey, data]);
    queryClient.setQueryData<McpConfigViewResponse>(entry.queryKey, {
      ...data,
      servers: data.servers.map((s) => (shouldEdit(s) ? edit(s) : s)),
    });
  }
  return () => {
    for (const [key, value] of snapshots) {
      queryClient.setQueryData(key, value);
    }
  };
}

interface PatchContext {
  rollback: () => void;
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

  return useMutation<
    void,
    Error,
    { serverKey: string; enabled: boolean },
    PatchContext
  >({
    mutationFn: ({ serverKey, enabled }) =>
      patchMcp(
        scope,
        [{ type: "set-server-enabled", serverKey, enabled }],
        "mcp-toggle-server",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, enabled }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (s) => ({ ...s, enabled, pending: true }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useResetMcpServerMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<void, Error, { serverKey: string }, PatchContext>({
    mutationFn: ({ serverKey }) =>
      patchMcp(
        scope,
        [{ type: "reset-server", serverKey }],
        "mcp-reset-server",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (s) => ({ ...s, pending: true }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useToggleMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<
    void,
    Error,
    { serverKey: string; toolName: string; enabled: boolean },
    PatchContext
  >({
    mutationFn: ({ serverKey, toolName, enabled }) =>
      patchMcp(
        scope,
        [{ type: "set-tool-enabled", serverKey, toolName, enabled }],
        "mcp-toggle-tool",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, toolName, enabled }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (server) => ({
          ...server,
          pending: true,
          tools: {
            ...server.tools,
            tools: server.tools.tools.map((t) =>
              t.name === toolName ? { ...t, enabled, pending: true } : t,
            ),
          },
        }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useResetMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<
    void,
    Error,
    { serverKey: string; toolName: string },
    PatchContext
  >({
    mutationFn: ({ serverKey, toolName }) =>
      patchMcp(
        scope,
        [{ type: "reset-tool", serverKey, toolName }],
        "mcp-reset-tool",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, toolName }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (server) => ({
          ...server,
          pending: true,
          tools: {
            ...server.tools,
            tools: server.tools.tools.map((t) =>
              t.name === toolName ? { ...t, pending: true } : t,
            ),
          },
        }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
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
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/conversations/${encodeURIComponent(scope.conversationId)}/mcp-config/tools/${encodedServer}`;
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
          queryKey: mcpToolsKeys.inventory(
            scope.projectName,
            scope.sessionName,
            scope.conversationId,
            serverKey,
          ),
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
