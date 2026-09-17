import { z } from "zod";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { getErrorMessage } from "@/lib/shared/errors";
import type { CliHost, TokenSource } from "../transport";

/**
 * "Which CC server is this, and is my binary its own?" — the one question
 * `/api/agent/handshake` answers, asked the same way by every command that has
 * to tell two CC instances apart.
 *
 * It exists as its own module because more than one command needs the answer
 * and the answer is only useful undivided: a build stamp says which BUILD, a
 * config dir says which INSTANCE, and confusing the two is the failure this
 * whole surface exists to catch. Reporting is deliberately left to the caller —
 * the facts are shared, the wording is each command's own.
 */

const handshakeResponseSchema = z.object({
  serverBuild: z.string(),
  identity: z.object({
    project: z.string().nullable(),
    session: z.string().nullable(),
    conversation: z.string().nullable(),
  }),
  tokenValid: z.boolean(),
  cliPath: z.string(),
  configDir: z.string(),
});

export type HandshakeIdentity = z.infer<
  typeof handshakeResponseSchema
>["identity"];

export interface HandshakeFacts {
  server: string;
  serverBuild: string;
  cliBuild: string;
  /** False when this binary is not the one `server` published. */
  buildMatch: boolean;
  identity: HandshakeIdentity;
  tokenValid: boolean;
  tokenSource: TokenSource | null;
  /** The cctl `server` publishes — the recovery binary for a build mismatch. */
  cliPath: string;
  /** The state directory `server` owns — its DB, logs, and transcripts. */
  configDir: string;
}

export type HandshakeOutcome =
  | { kind: "ok"; facts: HandshakeFacts }
  | { kind: "unreachable"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "http_error"; status: number }
  | { kind: "not_a_cc_server" };

export interface HandshakeProbeParams {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  identity: HandshakeIdentity;
}

/**
 * The stamp travels even when the caller expects a mismatch: it is what makes
 * the server report one, and a probe that hid it could not diagnose skew at all.
 */
export async function probeHandshake(
  host: CliHost,
  params: HandshakeProbeParams,
): Promise<HandshakeOutcome> {
  const cliBuild = formatBuildStamp(BUILD_INFO);
  const url = new URL("/api/agent/handshake", params.server);
  for (const [key, value] of Object.entries(params.identity)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { "x-cc-cli-build": cliBuild };
  if (params.token !== null) {
    headers["authorization"] = `Bearer ${params.token}`;
  }

  let response: Response;
  try {
    response = await host.fetch(url.toString(), { method: "GET", headers });
  } catch (error) {
    return { kind: "unreachable", detail: getErrorMessage(error) };
  }

  if (response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) return { kind: "http_error", status: response.status };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = handshakeResponseSchema.safeParse(body);
  if (!parsed.success) return { kind: "not_a_cc_server" };

  return {
    kind: "ok",
    facts: {
      server: params.server,
      serverBuild: parsed.data.serverBuild,
      cliBuild,
      buildMatch: parsed.data.serverBuild === cliBuild,
      identity: parsed.data.identity,
      tokenValid: parsed.data.tokenValid,
      tokenSource: params.tokenSource,
      cliPath: parsed.data.cliPath,
      configDir: parsed.data.configDir,
    },
  };
}
