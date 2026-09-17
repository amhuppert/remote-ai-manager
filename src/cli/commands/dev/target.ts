import type { Failure } from "cli-for-agents";
import { devServersStatusResponseSchema } from "@/lib/dev-server/schemas";
import { cliRequest, type SessionContext } from "../../transport";
import {
  resolveCcSession,
  type CcErrorCode,
  type CcContextResult,
} from "../../framework/context";
import { ccErrors, type CcApplication } from "../../framework/family";
import {
  ccRequestFailure,
  type CcFailedRequest,
} from "../../framework/request";
import {
  devServerRequestPath,
  inferDevCommandTarget,
  type DevCommandTarget,
  type DevInstance,
} from "../dev/routing";
export { devServerRequestPath };
export type DevTarget = { context: SessionContext; target: DevCommandTarget };
export function invalidDev(what: string) {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The ${what} response is invalid.`,
    }),
  } as const;
}
export function devUsage(message: string) {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) } as const;
}
export async function resolveDevTarget(
  app: CcApplication,
): Promise<CcContextResult<DevTarget>> {
  const inferred = inferDevCommandTarget(app.globals, app.env);
  if (!inferred.ok) return devUsage(inferred.message);
  const resolved = await resolveCcSession(app);
  return resolved.ok
    ? { ok: true, value: { context: resolved.value, target: inferred.target } }
    : resolved;
}
const targetCodes = new Set([
  "NO_DEV_SERVERS_CONFIGURED",
  "INVALID_DEV_SERVER_TARGET",
  "WORKFLOW_EXECUTION_NOT_ACTIVE",
  "WORKFLOW_CONTEXT_NOT_FOUND",
  "WORKFLOW_WORKTREE_UNAVAILABLE",
]);
export function devFailure(response: CcFailedRequest) {
  return ccRequestFailure(
    response,
    response.kind === "error" && targetCodes.has(response.code ?? "")
      ? { errorCode: "CC_OPERATION_FAILED" }
      : {},
  );
}
export async function resolveRunningInstance(
  app: CcApplication,
  name?: string,
): Promise<
  | { ok: true; value: DevTarget & { instance: DevInstance } }
  | Failure<never, CcErrorCode>
> {
  const resolved = await resolveDevTarget(app);
  if (!resolved.ok) return resolved;
  const { context, target } = resolved.value;
  const response = await cliRequest(app.host, {
    ...context,
    method: "GET",
    path: devServerRequestPath(context, target),
    unstamped: true,
  });
  if (response.kind !== "ok") {
    if (response.kind === "error" && response.status === 404)
      return ccRequestFailure(
        {
          ...response,
          error: `${response.error}. CC_SERVER_URL must name the managing instance; select another dev instance with --target.`,
        },
        { errorCode: "CC_OPERATION_FAILED" },
      );
    return devFailure(response);
  }
  const parsed = devServersStatusResponseSchema.safeParse(response.body);
  if (!parsed.success) return invalidDev("development server registry");
  const running = parsed.data.servers.filter(
    (server) => server.status === "running" && server.port !== null,
  );
  if (!running.length)
    return {
      ok: false,
      error: ccErrors.error("CC_OPERATION_FAILED", {
        message:
          "No running development server; start one with cctl dev ensure.",
      }),
    };
  const chosen =
    name === undefined
      ? running.length === 1
        ? running[0]
        : undefined
      : running.find((server) => server.serverName === name);
  if (!chosen)
    return devUsage(
      `Choose one running server (${running.map((server) => server.serverName).join(", ")}) using its name or --dev.`,
    );
  return {
    ok: true,
    value: {
      ...resolved.value,
      instance: {
        serverName: chosen.serverName,
        url: `http://localhost:${chosen.port}`,
        worktreePath: chosen.worktreePath,
      },
    },
  };
}
