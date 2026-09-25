"use client";

import { useCallback, useState } from "react";
import { parseUnmanagedConflict } from "@/hooks/use-dev-servers";
import {
  usePendingDevServerStops,
  useStartProjectDevServerMutation,
  useStopDevServerInstanceMutation,
  useStopUnmanagedProjectDevServerMutation,
  type ProjectDevServerRef,
} from "@/lib/dev-server/mutations";
import type { StopDevServerInstanceRequest } from "@/lib/dev-server/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { DevServerProjectNotice } from "./DevServerOverview";

const logger = createClientLogger("dev-server-overview");

/**
 * Overview actions plus the per-project notices they raise: a start blocked
 * by an unmanaged listener (resolvable in place) or any other failed start or
 * stop. A project shows at most its latest notice.
 */
export function useDevServerOverviewActions() {
  const [notices, setNotices] = useState<
    Readonly<Record<string, DevServerProjectNotice>>
  >({});
  const setNotice = useCallback(
    (projectName: string, notice: DevServerProjectNotice | null) =>
      setNotices((current) => {
        const next = { ...current };
        if (notice === null) delete next[projectName];
        else next[projectName] = notice;
        return next;
      }),
    [],
  );

  const start = useStartProjectDevServerMutation({
    onError: (error, ref) => {
      const conflict = parseUnmanagedConflict(error);
      logger.warn("dev_server_overview.start_failed", {
        projectName: ref.projectName,
        serverName: ref.serverName,
        conflict: conflict !== null,
      });
      setNotice(
        ref.projectName,
        conflict !== null
          ? { kind: "conflict", ...conflict }
          : {
              kind: "error",
              title: `Could not start ${ref.serverName}`,
              message: error.message,
            },
      );
    },
  });

  const stop = useStopDevServerInstanceMutation({
    onError: (error, ref) => {
      logger.warn("dev_server_overview.stop_failed", {
        projectName: ref.projectName,
        serverName: ref.serverName,
      });
      setNotice(ref.projectName, {
        kind: "error",
        title: `Could not stop ${ref.serverName}`,
        message: error.message,
      });
    },
  });

  const stopUnmanaged = useStopUnmanagedProjectDevServerMutation({
    onSuccess: (input) => {
      setNotice(input.projectName, null);
      start.mutate({
        projectName: input.projectName,
        serverName: input.serverName,
      });
    },
    onError: (error, input) =>
      setNotice(input.projectName, {
        kind: "error",
        title: `Could not stop the process on port ${input.port}`,
        message: error.message,
      }),
  });

  const pendingStopIds = usePendingDevServerStops();

  return {
    notices,
    pendingStopIds,
    isStoppingUnmanaged: stopUnmanaged.isPending,
    startServer: (ref: ProjectDevServerRef) => {
      setNotice(ref.projectName, null);
      start.mutate(ref);
    },
    stopServer: (ref: StopDevServerInstanceRequest) => {
      setNotice(ref.projectName, null);
      stop.mutate(ref);
    },
    dismissNotice: (projectName: string) => setNotice(projectName, null),
    stopUnmanagedAndRetry: (projectName: string) => {
      const notice = notices[projectName];
      if (notice?.kind !== "conflict") return;
      stopUnmanaged.mutate({
        projectName,
        serverName: notice.serverName,
        port: notice.port,
      });
    },
  };
}
