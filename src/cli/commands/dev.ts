import { devServersStatusResponseSchema } from "@/lib/dev-server/schemas";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import { dispatchGroup } from "../dispatch";
import { awaitJob } from "../job-wait";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  connectionFailure,
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
import {
  devServerRequestPath,
  inferDevCommandTarget,
  resolveRunningDevInstance,
} from "./dev-target";
import {
  probeHandshake,
  type HandshakeFacts,
  type HandshakeOutcome,
} from "./handshake-probe";

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
      doctor: (r) => runDevDoctor(r, flags, values, env, host),
    },
  });
}

/** One instance's line block in the `dev doctor` report. */
function instanceBlock(
  heading: string,
  facts: HandshakeFacts,
  extra: string[] = [],
): string[] {
  return [
    heading,
    `  build       ${facts.serverBuild}`,
    ...(facts.configDir === undefined
      ? []
      : [`  config dir  ${facts.configDir}`]),
    ...(facts.cliPath === undefined ? [] : [`  its cctl    ${facts.cliPath}`]),
    ...extra,
  ];
}

/**
 * `cctl dev doctor [<serverName>]` — "which CC instance am I driving?"
 *
 * A worktree dev server is a SECOND, fully independent CC instance: its own
 * database, transcripts, logs, api-token, and published cctl. Nothing else in
 * the CLI shows that, and the split is invisible in the happy path — reads of
 * discovered state (projects, files) look identical against either instance,
 * and only server-owned durable state (validation runs, workflow executions,
 * jobs, notifications, conversations) diverges. So an agent runs a state-
 * producing verb against the managing server, looks for it in the dev server's
 * UI, finds nothing, and concludes the feature is broken.
 *
 * This prints both instances side by side and names which one a bare `cctl`
 * verb reaches. Two properties are what make it usable at the moment of
 * confusion: it resolves the dev server itself (no port or path to know), and
 * it authenticates with THAT server's token, since the ambient one belongs to
 * the managing instance and would only 401.
 */
async function runDevDoctor(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "dev doctor", json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure("dev doctor takes at most one <serverName>", json);
  }

  const session = await resolveSessionContext(flags, env, host);
  if (!session.ok) return session.result;
  const context = session.context;

  const resolved = await resolveRunningDevInstance({
    flags,
    selector: {
      name: rest[0],
      disambiguate: "name one: `cctl dev doctor <serverName>`",
    },
    context,
    env,
    host,
  });
  if (!resolved.ok) return resolved.result;
  const instance = resolved.instance;

  const identity = {
    project: context.project,
    session: context.session,
    conversation: flags.conversation ?? env["CC_CONVERSATION_ID"] ?? null,
  };

  const managing = await probeHandshake(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    identity,
  });
  if (managing.kind !== "ok") {
    return probeFailure(
      `the managing server ${context.server}`,
      managing,
      json,
    );
  }

  // The dev instance mints its own token; the ambient one authenticates the
  // managing server and is exactly what makes a hand-rolled `doctor --server
  // <devUrl>` 401. Its config dir is the worktree convention the dev script
  // sets (CC_CONFIG_DIR=$PWD/.config) — enough to get in, after which the
  // handshake reports where that instance's state actually lives.
  const tokenPath =
    instance.worktreePath === null
      ? null
      : `${instance.worktreePath}/.config/api-token`;
  const devToken =
    tokenPath === null
      ? null
      : ((await host.readTextFile(tokenPath))?.trim() ?? "");
  if (devToken === null || devToken === "") {
    return connectionFailure({
      message: `no API token for the dev server at ${instance.url}${tokenPath === null ? "" : ` — nothing readable at ${tokenPath}`}`,
      hint: "start it with `cctl dev ensure` (a CC server provisions its token on first boot), then re-run",
      json,
    });
  }

  const dev = await probeHandshake(host, {
    server: instance.url,
    token: devToken,
    tokenSource: "file",
    identity,
  });
  if (dev.kind !== "ok") {
    return probeFailure(`the dev server ${instance.url}`, dev, json);
  }

  const sameInstance =
    managing.facts.configDir !== undefined &&
    managing.facts.configDir === dev.facts.configDir;
  const bareTalksTo = sameInstance ? "both (one instance)" : context.server;

  const human = [
    ...instanceBlock(
      `managing      ${context.server}  (your agent session lives here)`,
      managing.facts,
    ),
    ...instanceBlock(
      `dev ${instance.serverName}    ${instance.url}  (worktree instance${sameInstance ? "" : " — separate database, logs, transcripts"})`,
      dev.facts,
      instance.worktreePath === null
        ? []
        : [`  worktree    ${instance.worktreePath}`],
    ),
    `cli build     ${managing.facts.cliBuild}`,
    `bare \`cctl\`   ${bareTalksTo}`,
  ].join("\n");

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, {
      ok: true,
      managing: instanceFacts(context.server, managing.facts),
      dev: {
        serverName: instance.serverName,
        worktreePath: instance.worktreePath,
        ...instanceFacts(instance.url, dev.facts),
      },
      cliBuild: managing.facts.cliBuild,
      sameInstance,
      ...(sameInstance
        ? {}
        : {
            hint: `state produced by a bare \`cctl\` verb lands on ${context.server} and never appears in ${instance.url} — run the verb from a session ON the dev server (\`cctl fixture\`) to produce state there`,
          }),
    }),
    stderr: "",
  };
}

function instanceFacts(server: string, facts: HandshakeFacts) {
  return {
    server,
    serverBuild: facts.serverBuild,
    buildMatch: facts.buildMatch,
    ...(facts.configDir === undefined ? {} : { configDir: facts.configDir }),
    ...(facts.cliPath === undefined ? {} : { cliPath: facts.cliPath }),
  };
}

/** Render a failed probe as the exit class its cause belongs to. */
function probeFailure(
  label: string,
  outcome: Exclude<HandshakeOutcome, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (outcome.kind === "unreachable") {
    return connectionFailure({
      message: `cannot reach ${label}`,
      detail: outcome.detail,
      hint: "check it is running with `cctl dev list`, then re-run",
      json,
    });
  }
  if (outcome.kind === "unauthorized") {
    return connectionFailure({
      message: `${label} rejected its own API token`,
      hint: "restart it with `cctl dev ensure` so it re-provisions <configDir>/api-token",
      json,
    });
  }
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message:
      outcome.kind === "http_error"
        ? `${label} failed the handshake (HTTP ${outcome.status})`
        : `${label} returned an unreadable handshake — is it a CC server?`,
    json,
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
