import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import {
  stopDevServerInstanceRequestSchema,
  type DevServerOverviewResponse,
  type StopDevServerInstanceRequest,
} from "@/lib/dev-server/schemas";

/** Stable identity of one listed instance; matches the stop request fields. */
export function devServerInstanceId(ref: StopDevServerInstanceRequest): string {
  return [
    ref.projectName,
    ref.sessionName ?? "",
    ref.worktreePath,
    ref.serverName,
  ].join("::");
}

function projectServerUrl(
  projectName: string,
  serverName: string,
  action: string,
): string {
  return `/api/projects/${encodeURIComponent(projectName)}/dev-servers/${encodeURIComponent(serverName)}/${action}`;
}

export interface ProjectDevServerRef {
  projectName: string;
  serverName: string;
}

/**
 * Start a project-root server from the overview. The row flips to `starting`
 * immediately; the route answers 202 at its acceptance boundary and the
 * `dev-server-status` events carry readiness.
 */
export function useStartProjectDevServerMutation(options?: {
  onError?(error: Error, ref: ProjectDevServerRef): void;
}) {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation(queryClient, {
      ...(options?.onError === undefined ? {} : { onError: options.onError }),
      mutationFn: (ref: ProjectDevServerRef) =>
        mutationFetch(
          projectServerUrl(ref.projectName, ref.serverName, "start"),
          "dev-servers.start-project",
          { method: "POST" },
        ),
      updates: [
        cacheUpdate<ProjectDevServerRef, DevServerOverviewResponse>({
          key: () => devServerKeys.overview(),
          update: (old, ref) =>
            old && {
              projects: old.projects.map((project) =>
                project.projectName !== ref.projectName
                  ? project
                  : {
                      ...project,
                      servers: project.servers.map((server) =>
                        server.owner.kind === "project" &&
                        server.serverName === ref.serverName
                          ? {
                              ...server,
                              status: "starting",
                              errorMessage: null,
                            }
                          : server,
                      ),
                    },
              ),
            },
        }),
      ],
    }),
  );
}

/**
 * Stop one listed instance. The status enum has no "stopping" value, so the
 * in-flight stop is surfaced through `usePendingDevServerStops` rather than an
 * optimistic status patch.
 */
export function useStopDevServerInstanceMutation(options?: {
  onError?(error: Error, ref: StopDevServerInstanceRequest): void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: devServerKeys.stopInstance(),
    ...(options?.onError === undefined ? {} : { onError: options.onError }),
    mutationFn: (ref: StopDevServerInstanceRequest) =>
      mutationFetch("/api/dev-servers/stop", "dev-servers.stop-instance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: devServerKeys.overview() }),
  });
}

/** Instance ids with a stop in flight, across every mounted caller. */
export function usePendingDevServerStops(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: devServerKeys.stopInstance(), status: "pending" },
    select: (mutation) => {
      const parsed = stopDevServerInstanceRequestSchema.safeParse(
        mutation.state.variables,
      );
      return parsed.success ? devServerInstanceId(parsed.data) : null;
    },
  });
  return new Set(ids.filter((id): id is string => id !== null));
}

/**
 * Stop the unmanaged listener that blocked a project-root start. The route
 * re-verifies that the listener runs from the project's checkout before
 * signalling it.
 */
export function useStopUnmanagedProjectDevServerMutation(options?: {
  onSuccess?(input: ProjectDevServerRef & { port: number }): void;
  onError?(error: Error, input: ProjectDevServerRef & { port: number }): void;
}) {
  return useMutation({
    ...(options?.onSuccess === undefined
      ? {}
      : {
          onSuccess: (
            _data: unknown,
            input: ProjectDevServerRef & { port: number },
          ) => options.onSuccess?.(input),
        }),
    ...(options?.onError === undefined ? {} : { onError: options.onError }),
    mutationFn: (input: ProjectDevServerRef & { port: number }) =>
      mutationFetch(
        projectServerUrl(input.projectName, input.serverName, "stop-unmanaged"),
        "dev-servers.stop-unmanaged-project",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ port: input.port }),
        },
      ),
  });
}
