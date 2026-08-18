import { devServersStatusResponseSchema } from "@/lib/dev-server/schemas";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import { dispatchGroup } from "../dispatch";
import { awaitJob } from "../job-wait";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveSessionContext,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";
import { devServerRequestPath, inferDevCommandTarget } from "./dev-target";

const DEV_TARGET_ERROR_CODES = new Set([
  "INVALID_DEV_SERVER_TARGET",
  "WORKFLOW_EXECUTION_NOT_ACTIVE",
  "WORKFLOW_CONTEXT_NOT_FOUND",
  "WORKFLOW_WORKTREE_UNAVAILABLE",
]);

/**
 * `cctl dev list|ensure|stop` — dev-server management over the existing
 * dev-server routes (docs/design/cc-cli/02 §2.3). The routes are unchanged;
 * this is CLI mapping only.
 *
 * `ensure` does the blocking the design calls for. The START route returns 202
 * immediately (`wait: false`), so the CLI polls the list route until the target
 * server reaches `running`, errors, or a bounded timeout elapses.
 */

const POLL_INTERVAL_MS = 500;
const ENSURE_TIMEOUT_MS = 60_000;

/**
 * One readiness poll's outcome. The target may be missing from an otherwise
 * readable list — a name that never appears is still a wait that must end, so
 * absence is a status rather than a failure.
 */
type DevEnsureStatus =
  | { kind: "request_failed"; result: CliResult }
  | { kind: "listed"; target: DevServerRuntimeState | undefined };

/** Mirrors the service's derivation (dev-server/service.ts); the routes emit port, not localUrl. */
function localUrlFor(port: number | null): string | null {
  return port !== null ? `http://localhost:${port}` : null;
}

/**
 * The failure reason and the log path are the two facts an agent acts on after
 * a server misbehaves, so they render in text whenever the envelope carries
 * them rather than only under `--json`.
 */
function formatServerBlock(server: DevServerRuntimeState): string {
  return [
    `${server.serverName} — ${server.status}`,
    `  local:  ${localUrlFor(server.port) ?? "-"}`,
    `  remote: ${server.remoteUrl ?? "-"}`,
    ...(server.errorMessage ? [`  error:  ${server.errorMessage}`] : []),
    ...(server.logFilePath ? [`  log:    ${server.logFilePath}`] : []),
  ].join("\n");
}

function noDevServersFailure(json: boolean): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message:
      "no dev servers are configured for this project — add a `devServers` entry to CommandCenter.json",
    json,
  });
}

function devRequestFailure(
  result: Exclude<Awaited<ReturnType<typeof cliRequest>>, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (
    result.kind === "error" &&
    result.code !== undefined &&
    DEV_TARGET_ERROR_CODES.has(result.code)
  ) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: result.error,
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequestNotFoundAsUsage(result, json);
}

export async function runDev(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["dev"],
    rest,
    json: flags.json,
    handlers: {
      list: (r) => runDevList(r, flags, values, env, host),
      ensure: (r) => runDevEnsure(r, flags, values, env, host),
      stop: (r) => runDevStop(r, flags, values, env, host),
    },
  });
}

async function runDevList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "dev list", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("dev list takes no arguments", json);
  }

  const inferred = inferDevCommandTarget(flags, env);
  if (!inferred.ok) return usageFailure(inferred.message, json);

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: devServerRequestPath(context, inferred.target),
  });
  if (result.kind !== "ok") return devRequestFailure(result, json);

  const parsed = devServersStatusResponseSchema.safeParse(result.body);
  const servers = parsed.success ? parsed.data.servers : [];
  const humanBody =
    servers.length === 0
      ? "no dev servers configured for this project\n"
      : `${servers.map(formatServerBlock).join("\n\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      servers: servers.map((s) => ({ ...s, localUrl: localUrlFor(s.port) })),
    }),
    stderr: "",
  };
}

async function runDevEnsure(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "dev ensure", json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure(
      "dev ensure takes at most one <serverName> argument",
      json,
    );
  }

  const inferred = inferDevCommandTarget(flags, env);
  if (!inferred.ok) return usageFailure(inferred.message, json);

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  const listPath = devServerRequestPath(context, inferred.target);

  // The START route needs a server name in its path. When the caller omits one,
  // list first to pick the single configured server — surfacing no-servers and
  // ambiguity exactly as the service would.
  let targetName = rest[0];
  if (targetName === undefined) {
    const listResult = await cliRequest(host, {
      server: context.server,
      token: context.token,
      tokenSource: context.tokenSource,
      method: "GET",
      path: listPath,
    });
    if (listResult.kind !== "ok") return devRequestFailure(listResult, json);
    const parsed = devServersStatusResponseSchema.safeParse(listResult.body);
    const servers = parsed.success ? parsed.data.servers : [];
    if (servers.length === 0) return noDevServersFailure(json);
    if (servers.length > 1) {
      return usageFailure(
        `multiple dev servers configured (${servers
          .map((s) => s.serverName)
          .join(", ")}); pass a name to select one`,
        json,
      );
    }
    targetName = servers[0]!.serverName;
  }

  const startResult = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: devServerRequestPath(
      context,
      inferred.target,
      `/${encodePathSegment(targetName)}/start`,
    ),
  });
  if (startResult.kind !== "ok") {
    if (
      startResult.kind === "error" &&
      startResult.code === "NO_DEV_SERVERS_CONFIGURED"
    ) {
      return noDevServersFailure(json);
    }
    return devRequestFailure(startResult, json);
  }

  // Block until liveness: poll the list route until the target runs, errors, or times out.
  // The polling closures outlive the control-flow narrowing that resolved the name.
  const name = targetName;
  return awaitJob<DevEnsureStatus>(host, {
    json,
    timeoutMs: ENSURE_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    async poll() {
      const listResult = await cliRequest(host, {
        server: context.server,
        token: context.token,
        tokenSource: context.tokenSource,
        method: "GET",
        path: listPath,
      });
      if (listResult.kind !== "ok") {
        return {
          ok: true,
          status: {
            kind: "request_failed",
            result: devRequestFailure(listResult, json),
          },
        };
      }
      const parsed = devServersStatusResponseSchema.safeParse(listResult.body);
      return {
        ok: true,
        status: {
          kind: "listed",
          target: parsed.success
            ? parsed.data.servers.find((s) => s.serverName === name)
            : undefined,
        },
      };
    },
    classify(status) {
      if (status.kind === "request_failed") {
        return { terminal: true, result: status.result };
      }
      const target = status.target;
      if (target?.status === "running") {
        const localUrl = localUrlFor(target.port);
        const hint = `drive the app at ${localUrl ?? "the local URL"}; re-check liveness with 'cctl dev list'`;
        return {
          terminal: true,
          result: {
            exitCode: EXIT_OK,
            stdout: render(json, `${formatServerBlock(target)}\n`, {
              ok: true,
              server: { ...target, localUrl },
              hint,
            }),
            stderr: "",
          },
        };
      }
      if (target?.status === "error") {
        const detail =
          target.recentOutput.length > 0
            ? target.recentOutput.join("\n")
            : undefined;
        return {
          terminal: true,
          result: failure({
            exitCode: EXIT_OPERATION_FAILED,
            message: `dev server "${name}" failed to start${target.errorMessage ? `: ${target.errorMessage}` : ""}`,
            ...(detail ? { detail } : {}),
            json,
          }),
        };
      }
      return { terminal: false };
    },
    onTimeout: () => ({
      exitCode: EXIT_OPERATION_FAILED,
      message: `dev server "${name}" did not reach running state within ${ENSURE_TIMEOUT_MS}ms`,
      hint: "inspect the server and its log file with 'cctl dev list'",
      json,
    }),
    forensics(last) {
      if (last === null || last.kind !== "listed") return [];
      const target = last.target;
      if (target === undefined) {
        return [`last status: "${name}" was absent from the dev-server list`];
      }
      return [
        `last status: ${target.status}`,
        ...(target.logFilePath ? [`log: ${target.logFilePath}`] : []),
        ...(target.recentOutput.length > 0
          ? [
              "recent output:",
              ...target.recentOutput.map((line) => `  ${line}`),
            ]
          : []),
      ];
    },
  });
}

async function runDevStop(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "dev stop", json);
  if (denied) return denied;

  const name = rest[0];
  if (name === undefined) {
    return usageFailure("dev stop requires a <serverName> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("dev stop takes a single <serverName> argument", json);
  }

  const inferred = inferDevCommandTarget(flags, env);
  if (!inferred.ok) return usageFailure(inferred.message, json);

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: devServerRequestPath(
      context,
      inferred.target,
      `/${encodePathSegment(name)}/stop`,
    ),
  });
  if (result.kind !== "ok") return devRequestFailure(result, json);

  // No hint — stop is terminal.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `stopped ${name}\n`, { ok: true }),
    stderr: "",
  };
}
