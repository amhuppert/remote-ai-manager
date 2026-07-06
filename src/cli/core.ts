import { z } from "zod";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runAsk } from "./commands/ask";
import { runCharter } from "./commands/charter";
import { runCodex } from "./commands/codex";
import { runConversation } from "./commands/conversation";
import { runDecisions } from "./commands/decisions";
import { runDev } from "./commands/dev";
import { runDocs } from "./commands/docs";
import { runNotify } from "./commands/notify";
import { runWorkflow } from "./commands/workflow";
import {
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  USAGE,
  checkFlags,
  failure,
  parseArgv,
  render,
  resolveToken,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "./shared";

export {
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
} from "./shared";
export type {
  CliEnv,
  CliHost,
  CliResult,
  FetchInit,
  FetchLike,
} from "./shared";

const handshakeResponseSchema = z.object({
  serverBuild: z.string(),
  identity: z.object({
    project: z.string().nullable(),
    session: z.string().nullable(),
    conversation: z.string().nullable(),
  }),
  tokenValid: z.boolean(),
});

function runVersion(flags: GlobalFlags): CliResult {
  const cliBuild = formatBuildStamp(BUILD_INFO);
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, `cctl ${cliBuild}\n`, { ok: true, cliBuild }),
    stderr: "",
  };
}

async function runDoctor(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const server = flags.server ?? env["CC_SERVER_URL"];
  if (!server) {
    return failure({
      exitCode: EXIT_USAGE,
      message:
        "cctl doctor: no server URL — pass --server or set CC_SERVER_URL",
      json,
    });
  }

  const { token, source: tokenSource } = await resolveToken(flags, env, host);
  const identity = {
    project: flags.project ?? env["CC_PROJECT"] ?? null,
    session: flags.session ?? env["CC_SESSION"] ?? null,
    conversation: flags.conversation ?? env["CC_CONVERSATION_ID"] ?? null,
  };

  const cliBuild = formatBuildStamp(BUILD_INFO);
  const url = new URL("/api/agent/handshake", server);
  for (const [key, value] of Object.entries(identity)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { "x-cc-cli-build": cliBuild };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await host.fetch(url.toString(), { method: "GET", headers });
  } catch (error) {
    return failure({
      exitCode: EXIT_CONNECTION,
      message: `cctl doctor: cannot reach the CC server at ${server} — is the CC server running?`,
      detail: error instanceof Error ? error.message : String(error),
      hint: "start the CC server, then re-run `cctl doctor`",
      json,
    });
  }

  if (response.status === 401) {
    const message =
      token === null
        ? "cctl doctor: no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token"
        : `cctl doctor: the server rejected the API token (source: ${tokenSource})`;
    return failure({
      exitCode: EXIT_CONNECTION,
      message,
      hint: "pass --token or set CC_API_TOKEN to the server's <configDir>/api-token value, then re-run `cctl doctor`",
      json,
    });
  }
  if (!response.ok) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `cctl doctor: handshake failed (HTTP ${response.status})`,
      json,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = handshakeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message:
        "cctl doctor: unexpected handshake response — is this a CC server?",
      json,
    });
  }

  const { serverBuild, identity: echoedIdentity, tokenValid } = parsed.data;
  const buildMatch = serverBuild === cliBuild;
  const warning = buildMatch
    ? ""
    : `warning: cctl build differs from server (cli=${cliBuild} server=${serverBuild}) — transient across a server restart\n`;

  const identityLine = [
    `project=${echoedIdentity.project ?? "-"}`,
    `session=${echoedIdentity.session ?? "-"}`,
    `conversation=${echoedIdentity.conversation ?? "-"}`,
  ].join(" ");
  const humanStdout = [
    `server        ${server}`,
    `server build  ${serverBuild}`,
    `cli build     ${cliBuild}`,
    `identity      ${identityLine}`,
    `token         valid (source: ${tokenSource ?? "-"})`,
  ].join("\n");

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${humanStdout}\n`, {
      ok: true,
      server,
      serverBuild,
      cliBuild,
      buildMatch,
      identity: echoedIdentity,
      tokenValid,
      tokenSource,
    }),
    stderr: warning,
  };
}

/**
 * The CLI core: pure (argv, env, host) -> result, no process/IO access — all
 * side effects go through the injected host.
 */
export async function runCli(
  argv: string[],
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const parsed = parseArgv(argv);
  if (parsed.kind === "error") {
    // The parse failed, so flags.json is unavailable — honor a literal --json.
    return usageFailure(parsed.message, argv.includes("--json"));
  }
  const { positionals, flags, values, lists } = parsed;
  const command = positionals[0];

  if (command === "version") return runVersion(flags);
  if (command === "doctor") {
    const denied = checkFlags(values, [], flags.json);
    if (denied) return denied;
    return runDoctor(flags, env, host);
  }

  if (command === "ask") {
    return runAsk(positionals.slice(1), flags, values, lists, env, host);
  }

  if (command === "notify") {
    return runNotify(positionals.slice(1), flags, values, env, host);
  }

  if (command === "docs") {
    return runDocs(positionals.slice(1), flags, values, env, host);
  }

  if (command === "dev") {
    return runDev(positionals.slice(1), flags, values, env, host);
  }

  if (command === "workflow") {
    return runWorkflow(positionals.slice(1), flags, values, env, host);
  }

  if (command === "charter") {
    return runCharter(positionals.slice(1), flags, values, env, host);
  }

  if (command === "decisions") {
    return runDecisions(positionals.slice(1), flags, values, env, host);
  }

  if (command === "codex") {
    return runCodex(positionals.slice(1), flags, values, env, host);
  }

  if (command === "conversation") {
    return runConversation(positionals.slice(1), flags, values, env, host);
  }

  if (command === undefined) {
    return {
      exitCode: EXIT_USAGE,
      stdout: flags.json
        ? `${JSON.stringify({ ok: false, error: "missing command" })}\n`
        : "",
      stderr: USAGE,
    };
  }
  return usageFailure(`unknown command "${command}"`, flags.json);
}
