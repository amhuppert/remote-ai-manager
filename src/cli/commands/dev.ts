import { devServersStatusResponseSchema } from "@/lib/dev-server/schemas";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveSessionContext,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
  type SessionContext,
} from "../shared";

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

/** Mirrors the service's derivation (dev-server/service.ts); the routes emit port, not localUrl. */
function localUrlFor(port: number | null): string | null {
  return port !== null ? `http://localhost:${port}` : null;
}

function devServersPath(context: SessionContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/dev-servers`;
}

function formatServerBlock(server: DevServerRuntimeState): string {
  return [
    `${server.serverName} — ${server.status}`,
    `  local:  ${localUrlFor(server.port) ?? "-"}`,
    `  remote: ${server.remoteUrl ?? "-"}`,
  ].join("\n");
}

/** A non-ok request against a dev route: a 404 is a caller/config mistake (exit 2), else the shared mapping. */
function devFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind === "error" && result.status === 404) {
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequest(result, json);
}

function noDevServersFailure(json: boolean): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message:
      "no dev servers are configured for this project — add a `devServers` entry to CommandCenter.json",
    json,
  });
}

export async function runDev(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "dev requires a subcommand: list, ensure, or stop",
      json,
    );
  }
  if (sub === "list") {
    return runDevList(rest.slice(1), flags, values, env, host);
  }
  if (sub === "ensure") {
    return runDevEnsure(rest.slice(1), flags, values, env, host);
  }
  if (sub === "stop") {
    return runDevStop(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown dev subcommand "${sub}"`, json);
}

async function runDevList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("dev list"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("dev list takes no arguments", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: devServersPath(context),
  });
  if (result.kind !== "ok") return devFailure(result, json);

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
  const denied = checkFlags(values, flagNamesFor("dev ensure"), json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure(
      "dev ensure takes at most one <serverName> argument",
      json,
    );
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  const listPath = devServersPath(context);

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
    if (listResult.kind !== "ok") return devFailure(listResult, json);
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
    path: `${listPath}/${encodePathSegment(targetName)}/start`,
  });
  if (startResult.kind !== "ok") {
    if (
      startResult.kind === "error" &&
      startResult.code === "NO_DEV_SERVERS_CONFIGURED"
    ) {
      return noDevServersFailure(json);
    }
    return devFailure(startResult, json);
  }

  // Block until liveness: poll the list route until the target runs, errors, or times out.
  const maxPolls = Math.ceil(ENSURE_TIMEOUT_MS / POLL_INTERVAL_MS);
  for (let attempt = 0; ; attempt++) {
    const listResult = await cliRequest(host, {
      server: context.server,
      token: context.token,
      tokenSource: context.tokenSource,
      method: "GET",
      path: listPath,
    });
    if (listResult.kind !== "ok") return devFailure(listResult, json);
    const parsed = devServersStatusResponseSchema.safeParse(listResult.body);
    const target = parsed.success
      ? parsed.data.servers.find((s) => s.serverName === targetName)
      : undefined;

    if (target?.status === "running") {
      const localUrl = localUrlFor(target.port);
      const hint = `drive the app at ${localUrl ?? "the local URL"}; re-check liveness with 'cctl dev list'`;
      return {
        exitCode: EXIT_OK,
        stdout: render(json, `${formatServerBlock(target)}\n`, {
          ok: true,
          server: { ...target, localUrl },
          hint,
        }),
        stderr: "",
      };
    }
    if (target?.status === "error") {
      const detail =
        target.recentOutput.length > 0
          ? target.recentOutput.join("\n")
          : undefined;
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `dev server "${targetName}" failed to start${target.errorMessage ? `: ${target.errorMessage}` : ""}`,
        ...(detail ? { detail } : {}),
        json,
      });
    }
    if (attempt >= maxPolls) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `dev server "${targetName}" did not reach running state within ${ENSURE_TIMEOUT_MS}ms`,
        json,
      });
    }
    await host.sleep(POLL_INTERVAL_MS);
  }
}

async function runDevStop(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("dev stop"), json);
  if (denied) return denied;

  const name = rest[0];
  if (name === undefined) {
    return usageFailure("dev stop requires a <serverName> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("dev stop takes a single <serverName> argument", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${devServersPath(context)}/${encodePathSegment(name)}/stop`,
  });
  if (result.kind !== "ok") return devFailure(result, json);

  // No hint — stop is terminal.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `stopped ${name}\n`, { ok: true }),
    stderr: "",
  };
}
