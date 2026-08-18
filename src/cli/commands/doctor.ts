import { z } from "zod";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  connectionFailure,
  failure,
  readSessionEnv,
  render,
  resolveToken,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

const handshakeResponseSchema = z.object({
  serverBuild: z.string(),
  identity: z.object({
    project: z.string().nullable(),
    session: z.string().nullable(),
    conversation: z.string().nullable(),
  }),
  tokenValid: z.boolean(),
  /** Absent on servers older than the build-parity recovery path. */
  cliPath: z.string().optional(),
});

/**
 * `cctl doctor` — connectivity, build-stamp, and identity diagnosis against
 * `/api/agent/handshake` (docs/design/cc-cli/01 §5).
 *
 * It lives here rather than in `core.ts` because it READS the session env and
 * publishes the resolved identity, which makes it a classified command under the
 * R2.4 inventory. `session-env-inventory.arch.test.ts` attributes a session-env
 * read to a command by source file, so a command sitting in `core.ts` was scanned
 * as infrastructure and could never be seen as unclassified.
 *
 * The handshake endpoint is scope-agnostic — it echoes whatever identity it is
 * given — so `doctor` is project-supported: a project agent diagnosing its server
 * connection reports `session=-` rather than losing the command.
 */
export async function runDoctor(
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "doctor", json);
  if (denied) return denied;

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
  // A project conversation's neutralized session must report as absent here, not
  // as an empty `?session=` query param the handshake would treat as a name.
  const identity = {
    project: flags.project ?? env["CC_PROJECT"] ?? null,
    session: flags.session ?? readSessionEnv(env),
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
    return connectionFailure({
      message: `cctl doctor: cannot reach the CC server at ${server} — is the CC server running?`,
      detail: getErrorMessage(error),
      hint: "start the CC server, then re-run `cctl doctor`",
      json,
    });
  }

  if (response.status === 401) {
    const message =
      token === null
        ? "cctl doctor: no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token"
        : `cctl doctor: the server rejected the API token (source: ${tokenSource})`;
    return connectionFailure({
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

  const {
    serverBuild,
    identity: echoedIdentity,
    tokenValid,
    cliPath,
  } = parsed.data;
  const buildMatch = serverBuild === cliBuild;
  // Naming the wrong cause here is worse than saying nothing: an agent that
  // reads "transient" runs the command anyway, against a surface from another
  // tree. Every CC server publishes its own cctl, so skew means wrong binary
  // until proven otherwise, and the recovery is that server's own path.
  const warning = buildMatch
    ? ""
    : [
        `warning: this cctl is build ${cliBuild}; ${server} is build ${serverBuild}`,
        cliPath === undefined
          ? "  that server publishes its own cctl at <its configDir>/bin/cctl — run that binary against it"
          : `  run that server's own binary instead: ${cliPath}`,
        "  (a server restart alone does not change the stamp — a differing stamp is a differing build)",
        "",
      ].join("\n");

  const identityLine = [
    `project=${echoedIdentity.project ?? "-"}`,
    `session=${echoedIdentity.session ?? "-"}`,
    `conversation=${echoedIdentity.conversation ?? "-"}`,
  ].join(" ");
  const humanStdout = [
    `server        ${server}`,
    `server build  ${serverBuild}`,
    `cli build     ${cliBuild}`,
    ...(cliPath === undefined ? [] : [`server cctl   ${cliPath}`]),
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
