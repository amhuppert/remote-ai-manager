import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveSessionContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl notify "<message>" [--title <t>]` — send a push to the user via the
 * session notifications endpoint (docs/design/cc-cli/02 §2.1). A notification
 * is terminal: on success there is deliberately NO hint. When push is
 * unconfigured the endpoint returns 409 and the CLI exits 1 with the server's
 * one-line reason (agents treat that as non-fatal).
 */
export async function runNotify(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, flagNamesFor("notify"), json);
  if (denied) return denied;

  const message = rest[0];
  if (message === undefined) {
    return usageFailure("notify requires a message argument", json);
  }
  if (rest.length > 1) {
    return usageFailure(
      "notify takes a single message argument — quote multi-word messages",
      json,
    );
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, session, token, tokenSource } = resolved.context;

  const title = values["title"];
  const body: { message: string; title?: string } = { message };
  if (title !== undefined) body.title = title;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "POST",
    path: `/api/projects/${encodePathSegment(project)}/sessions/${encodePathSegment(session)}/notifications`,
    body,
  });

  // Session/project not found is a caller mistake (exit 2), not a server outage.
  if (result.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(result, json);
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, "notification sent\n", { ok: true }),
    stderr: "",
  };
}
