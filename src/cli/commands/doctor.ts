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
import { probeHandshake, type HandshakeFacts } from "./handshake-probe";

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
 *
 * `doctor` diagnoses ONE server, the one it is pointed at. Diagnosing the
 * managing/dev-server PAIR is `cctl dev doctor`, which owns the dev-server
 * registry and each instance's own token.
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

  const outcome = await probeHandshake(host, {
    server,
    token,
    tokenSource,
    identity,
  });

  if (outcome.kind === "unreachable") {
    return connectionFailure({
      message: `cctl doctor: cannot reach the CC server at ${server} — is the CC server running?`,
      detail: outcome.detail,
      hint: "start the CC server, then re-run `cctl doctor`",
      json,
    });
  }
  if (outcome.kind === "unauthorized") {
    return tokenFailure({
      server,
      ambient: env["CC_SERVER_URL"],
      token,
      tokenSource,
      json,
    });
  }
  if (outcome.kind === "http_error") {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `cctl doctor: handshake failed (HTTP ${outcome.status})`,
      json,
    });
  }
  if (outcome.kind === "not_a_cc_server") {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message:
        "cctl doctor: unexpected handshake response — is this a CC server?",
      json,
    });
  }

  const facts = outcome.facts;
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${humanReport(facts)}\n`, {
      ok: true,
      server: facts.server,
      serverBuild: facts.serverBuild,
      cliBuild: facts.cliBuild,
      buildMatch: facts.buildMatch,
      identity: facts.identity,
      tokenValid: facts.tokenValid,
      tokenSource: facts.tokenSource,
      // Both are what the build-skew refusal's own hint sends the caller here
      // for: which binary to re-run, and which instance's state they are in.
      ...(facts.cliPath === undefined ? {} : { cliPath: facts.cliPath }),
      ...(facts.configDir === undefined ? {} : { configDir: facts.configDir }),
    }),
    stderr: skewWarning(facts),
  };
}

/**
 * A rejected token is ambiguous in a way that matters: every CC instance mints
 * its own, and the one in the environment belongs to the instance that launched
 * this agent. Read as "your token is broken", the caller re-reads the same file;
 * read as "wrong instance", they go get the right one.
 */
function tokenFailure(input: {
  server: string;
  ambient: string | undefined;
  token: string | null;
  tokenSource: string | null;
  json: boolean;
}): CliResult {
  const { server, ambient, token, tokenSource, json } = input;
  if (token === null) {
    return connectionFailure({
      message:
        "cctl doctor: no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token",
      hint: "pass --token or set CC_API_TOKEN to the server's <configDir>/api-token value, then re-run `cctl doctor`",
      json,
    });
  }
  const crossInstance = ambient !== undefined && ambient !== server;
  return connectionFailure({
    message: crossInstance
      ? `cctl doctor: ${server} rejected the API token — the one in this environment (source: ${tokenSource ?? "-"}) authenticates ${ambient}, and every CC instance mints its own`
      : `cctl doctor: the server rejected the API token (source: ${tokenSource})`,
    hint: crossInstance
      ? "read that instance's token from its own <configDir>/api-token, or run `cctl dev doctor` — it resolves this session's dev server and uses that server's token for you"
      : "pass --token or set CC_API_TOKEN to the server's <configDir>/api-token value, then re-run `cctl doctor`",
    json,
  });
}

function humanReport(facts: HandshakeFacts): string {
  const identityLine = [
    `project=${facts.identity.project ?? "-"}`,
    `session=${facts.identity.session ?? "-"}`,
    `conversation=${facts.identity.conversation ?? "-"}`,
  ].join(" ");
  return [
    `server        ${facts.server}`,
    `server build  ${facts.serverBuild}`,
    `cli build     ${facts.cliBuild}`,
    ...(facts.configDir === undefined
      ? []
      : [`config dir    ${facts.configDir}`]),
    ...(facts.cliPath === undefined ? [] : [`server cctl   ${facts.cliPath}`]),
    `identity      ${identityLine}`,
    `token         valid (source: ${facts.tokenSource ?? "-"})`,
  ].join("\n");
}

/**
 * Naming the wrong cause here is worse than saying nothing: an agent that reads
 * "transient" runs the command anyway, against a surface from another tree.
 * Every CC server publishes its own cctl, so skew means wrong binary until
 * proven otherwise, and the recovery is that server's own path.
 */
function skewWarning(facts: HandshakeFacts): string {
  if (facts.buildMatch) return "";
  return [
    `warning: this cctl is build ${facts.cliBuild}; ${facts.server} is build ${facts.serverBuild}`,
    facts.cliPath === undefined
      ? "  that server publishes its own cctl at <its configDir>/bin/cctl — run that binary against it"
      : `  run that server's own binary instead: ${facts.cliPath}`,
    "  (a server keeps the build it booted with, so a differing stamp is a differing build)",
    "",
  ].join("\n");
}
