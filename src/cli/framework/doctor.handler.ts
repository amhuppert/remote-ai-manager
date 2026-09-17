import { runner, type HandlerInput, type ReadHandler } from "cli-for-agents";
import {
  probeHandshake,
  type HandshakeFacts,
} from "../commands/handshake-probe";
import { readSessionEnv, resolveToken } from "../transport";
import { resolveCcHost, type CcHostSource } from "./host-source";
import type { CcErrorCode } from "./context";
import { ccErrors, type ccGlobalFlags } from "./family";
import type { doctorSpec } from "./doctor.definition";

type Input = HandlerInput<
  typeof doctorSpec,
  never,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;

export function createDoctorHandler(
  source: CcHostSource,
): ReadHandler<
  typeof doctorSpec,
  never,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
> {
  return {
    run: runner<Input, HandshakeFacts, CcErrorCode>({
      async run({ ctx }) {
        const server = ctx.globals.server ?? ctx.env["CC_SERVER_URL"];
        if (!server) {
          return {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: "no server URL — pass --server or set CC_SERVER_URL",
            }),
          };
        }
        const host = await resolveCcHost(source, ctx.env, ctx.signal);
        const token = await resolveToken(ctx.globals, ctx.env, host);
        const outcome = await probeHandshake(host, {
          server,
          token: token.token,
          tokenSource: token.source,
          identity: {
            project: ctx.globals.project ?? ctx.env["CC_PROJECT"] ?? null,
            session: ctx.globals.session ?? readSessionEnv(ctx.env),
            conversation:
              ctx.globals.conversation ?? ctx.env["CC_CONVERSATION_ID"] ?? null,
          },
        });
        if (outcome.kind === "unreachable") {
          return {
            ok: false,
            error: ccErrors.error("CC_CONNECTION", {
              message: `cannot reach the CC server at ${server} — is the CC server running?`,
              details: { detail: outcome.detail },
            }),
          };
        }
        if (outcome.kind === "unauthorized") {
          const ambient = ctx.env["CC_SERVER_URL"];
          const crossInstance = ambient !== undefined && ambient !== server;
          return {
            ok: false,
            error: ccErrors.error("CC_CONNECTION", {
              message:
                token.token === null
                  ? "no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token"
                  : crossInstance
                    ? `${server} rejected the API token — the one in this environment (source: ${token.source ?? "-"}) authenticates ${ambient}, and every CC instance mints its own`
                    : `the server rejected the API token (source: ${token.source ?? "-"})`,
              details: {
                server,
                tokenSource: token.source,
                recovery:
                  crossInstance && token.token !== null
                    ? "read that instance's token from its own <configDir>/api-token, or run cctl dev doctor to resolve this session's dev-server token"
                    : "pass --token or set CC_API_TOKEN to the server's <configDir>/api-token value, then re-run cctl doctor",
              },
            }),
          };
        }
        if (outcome.kind === "http_error") {
          return {
            ok: false,
            error: ccErrors.error("CC_OPERATION_FAILED", {
              message: `handshake failed (HTTP ${outcome.status})`,
              details: { status: outcome.status },
            }),
          };
        }
        if (outcome.kind === "not_a_cc_server") {
          return {
            ok: false,
            error: ccErrors.error("CC_INVALID_RESPONSE", {
              message: "unexpected handshake response — is this a CC server?",
            }),
          };
        }
        return {
          ok: true,
          data: outcome.facts,
          ...(outcome.facts.buildMatch
            ? {}
            : {
                issues: [
                  {
                    code: "CC_BUILD_MISMATCH",
                    message: `this cctl is build ${outcome.facts.cliBuild}; ${server} is build ${outcome.facts.serverBuild}. Run that server's own binary: ${outcome.facts.cliPath}`,
                  },
                ],
              }),
        };
      },
      text: (facts) =>
        [
          `server        ${facts.server}`,
          `server build  ${facts.serverBuild}`,
          `cli build     ${facts.cliBuild}`,
          `config dir    ${facts.configDir}`,
          `server cctl   ${facts.cliPath}`,
          `identity      project=${facts.identity.project ?? "-"} session=${facts.identity.session ?? "-"} conversation=${facts.identity.conversation ?? "-"}`,
          `token         ${facts.tokenValid ? "valid" : "invalid"} (source: ${facts.tokenSource ?? "-"})`,
        ].join("\n"),
    }),
  };
}
