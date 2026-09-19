import { explicitScopeFlags, sessionReference } from "../../framework/context";
import {
  bytes,
  invocation,
  milliseconds,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type {
  CommandSpec,
  HandlerInput,
  JsonData,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  devServerRuntimeStateSchema,
  devServersStatusResponseSchema,
  type DevServerRuntimeState,
} from "@/lib/dev-server/schemas";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccWriteFailure } from "../../framework/request";
import type { CcErrorCode } from "../../framework/context";
import {
  probeHandshake,
  type HandshakeFacts,
  type HandshakeOutcome,
} from "../handshake-probe";
import { devListCommand, devSpecs } from "./definitions";
import {
  devFailure,
  devServerRequestPath,
  devUsage,
  invalidDev,
  resolveDevTarget,
  resolveRunningInstance,
} from "./target";
type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Server = DevServerRuntimeState & { localUrl: string | null };
const serverData = (server: DevServerRuntimeState): Server => ({
  ...server,
  localUrl: server.port === null ? null : `http://localhost:${server.port}`,
});
const serverText = (server: JsonData<Server>) =>
  [
    `${server.serverName} — ${server.status}`,
    `  local: ${server.localUrl ?? "-"}`,
    `  remote: ${server.remoteUrl ?? "-"}`,
    ...(server.errorMessage ? [`  server error: ${server.errorMessage}`] : []),
    ...(server.logFilePath ? [`  log: ${server.logFilePath}`] : []),
  ].join("\n");
export const listHandler: Read<typeof devSpecs.list> = {
  run: runner<Input<typeof devSpecs.list>, { servers: Server[] }, CcErrorCode>({
    async run({ app }) {
      const resolved = await resolveDevTarget(app);
      if (!resolved.ok) return resolved;
      const { context, target } = resolved.value;
      const response = await cliRequest(app.host, {
        ...context,
        method: "GET",
        path: devServerRequestPath(context, target),
      });
      if (response.kind !== "ok") return devFailure(response);
      const parsed = devServersStatusResponseSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: { servers: parsed.data.servers.map(serverData) } }
        : invalidDev("development server list");
    },
    text: ({ servers }) =>
      servers.length
        ? servers.map(serverText).join("\n\n")
        : "No dev servers configured for this project.",
  }),
};
export const ensureHandler: Write<typeof devSpecs.ensure> = {
  run: writeRunner<
    Input<typeof devSpecs.ensure>,
    { server: Server },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveDevTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const { context, target } = resolved.value;
      const listPath = devServerRequestPath(context, target);
      let name = ctx.args["server-name"];
      if (name === undefined) {
        const response = await cliRequest(app.host, {
          ...context,
          method: "GET",
          path: listPath,
        });
        if (response.kind !== "ok")
          return { effect: "not_applied", result: devFailure(response) };
        const parsed = devServersStatusResponseSchema.safeParse(response.body);
        if (!parsed.success)
          return {
            effect: "not_applied",
            result: invalidDev("development server list"),
          };
        const first = parsed.data.servers[0];
        if (!first)
          return {
            effect: "not_applied",
            result: {
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message:
                  "No dev servers are configured; add devServers to CommandCenter.json.",
              }),
            },
          };
        if (parsed.data.servers.length > 1)
          return {
            effect: "not_applied",
            result: devUsage(
              `Choose a configured server: ${parsed.data.servers.map((server) => server.serverName).join(", ")}.`,
            ),
          };
        name = first.serverName;
      }
      const recovery = recoveryFacts([
        sessionReference(context.session),
        { kind: "dev-server", id: encodePathSegment(name) },
      ]);
      const started = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: devServerRequestPath(
          context,
          target,
          `/${encodePathSegment(name)}/start`,
        ),
      });
      if (started.kind !== "ok")
        return {
          ...ccWriteFailure(started, recovery),
          result: devFailure(started),
        };
      const admitted = z
        .object({
          status: z.literal("accepted"),
          server: devServerRuntimeStateSchema,
        })
        .safeParse(started.body);
      if (!admitted.success)
        return {
          effect: "unknown",
          recovery,
          result: invalidDev("development server start"),
        };
      let last: DevServerRuntimeState | undefined = admitted.data.server;
      const until = ctx.clock.now() + 60_000;
      for (;;) {
        const response = await cliRequest(app.host, {
          ...context,
          method: "GET",
          path: listPath,
        });
        if (response.kind !== "ok")
          return { effect: "applied", recovery, result: devFailure(response) };
        const parsed = devServersStatusResponseSchema.safeParse(response.body);
        if (!parsed.success)
          return {
            effect: "applied",
            recovery,
            result: invalidDev("development server readiness"),
          };
        last = parsed.data.servers.find((server) => server.serverName === name);
        if (last?.status === "running")
          return {
            effect: "applied",
            recovery,
            result: {
              ok: true,
              data: { server: serverData(last) },
              hint: hint(
                invocation(devListCommand, {
                  flags: { ...explicitScopeFlags(app) },
                }),
                "Recheck liveness after driving the returned local URL",
              ),
            },
          };
        const failure = (message: string) =>
          ({
            effect: "applied",
            recovery,
            result: {
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message,
                details: { server: last ?? null },
              }),
              hint: hint(
                invocation(devListCommand, {
                  flags: { ...explicitScopeFlags(app) },
                }),
                "Inspect current server state and its log path",
              ),
            },
          }) as const;
        if (last?.status === "error")
          return failure(
            `Dev server ${name} failed to start${last.errorMessage ? `: ${last.errorMessage}` : ""}.`,
          );
        if (ctx.clock.now() >= until)
          return failure(
            `Dev server ${name} did not reach running state within 60000ms.`,
          );
        try {
          await ctx.clock.sleep(milliseconds(500), ctx.signal);
        } catch {
          return failure(
            `Stopped waiting for dev server ${name}; the accepted start may still be running.`,
          );
        }
      }
    },
    text: ({ server }) => serverText(server),
  }),
};
export const stopHandler: Write<typeof devSpecs.stop> = {
  run: writeRunner<
    Input<typeof devSpecs.stop>,
    { serverName: string; status: "ok" },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveDevTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const { context, target } = resolved.value;
      const name = ctx.args["server-name"];
      const recovery = recoveryFacts([
        sessionReference(context.session),
        { kind: "dev-server", id: encodePathSegment(name) },
      ]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: devServerRequestPath(
          context,
          target,
          `/${encodePathSegment(name)}/stop`,
        ),
      });
      if (response.kind !== "ok")
        return {
          ...ccWriteFailure(response, recovery),
          result: devFailure(response),
        };
      const parsed = z
        .object({ status: z.literal("ok") })
        .safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: {
              ok: true,
              data: { serverName: name, status: parsed.data.status },
            },
          }
        : {
            effect: "unknown",
            recovery,
            result: invalidDev("development server stop"),
          };
    },
    text: ({ serverName }) => `stopped ${serverName}`,
  }),
};
function probeFailure(
  label: string,
  outcome: Exclude<HandshakeOutcome, { kind: "ok" }>,
) {
  return {
    ok: false,
    error: ccErrors.error(
      outcome.kind === "unreachable" || outcome.kind === "unauthorized"
        ? "CC_CONNECTION"
        : "CC_OPERATION_FAILED",
      {
        message:
          outcome.kind === "unauthorized"
            ? `${label} rejected its own API token.`
            : outcome.kind === "unreachable"
              ? `${label} is unreachable.`
              : `${label} returned an unreadable or failed CC handshake.`,
        ...(outcome.kind === "unreachable"
          ? { details: { detail: outcome.detail } }
          : {}),
      },
    ),
  } as const;
}
const instanceFacts = (facts: HandshakeFacts) => ({
  server: facts.server,
  serverBuild: facts.serverBuild,
  buildMatch: facts.buildMatch,
  configDir: facts.configDir,
  cliPath: facts.cliPath,
});
type InstanceFacts = ReturnType<typeof instanceFacts>;
export const doctorHandler: Read<typeof devSpecs.doctor> = {
  run: runner<
    Input<typeof devSpecs.doctor>,
    {
      managing: InstanceFacts;
      dev: InstanceFacts & { serverName: string; worktreePath: string | null };
      cliBuild: string;
      sameInstance: boolean;
      bareTalksTo: string;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveRunningInstance(
        app,
        ctx.args["server-name"],
      );
      if (!resolved.ok) return resolved;
      const { context, instance } = resolved.value;
      const identity = {
        project: context.project,
        session: context.session,
        conversation:
          app.globals.conversation ?? app.env.CC_CONVERSATION_ID ?? null,
      };
      const managing = await probeHandshake(app.host, { ...context, identity });
      if (managing.kind !== "ok")
        return probeFailure("The managing server", managing);
      if (instance.worktreePath === null)
        return {
          ok: false,
          error: ccErrors.error("CC_CONNECTION", {
            message:
              "The dev server's worktree token location is unavailable; restart it with cctl dev ensure.",
          }),
        };
      let token: string;
      try {
        token = new TextDecoder("utf-8", { fatal: true })
          .decode(
            await ctx.host.files.read(
              `${instance.worktreePath}/.config/api-token`,
              bytes(8192),
              ctx.signal,
            ),
          )
          .trim();
      } catch {
        return {
          ok: false,
          error: ccErrors.error("CC_CONNECTION", {
            message: `Cannot read the dev instance token from ${instance.worktreePath}/.config/api-token.`,
          }),
        };
      }
      if (!token)
        return {
          ok: false,
          error: ccErrors.error("CC_CONNECTION", {
            message:
              "The dev instance token is empty; start it with cctl dev ensure.",
          }),
        };
      const dev = await probeHandshake(app.host, {
        server: instance.url,
        token,
        tokenSource: "file",
        identity,
      });
      if (dev.kind !== "ok") return probeFailure("The dev server", dev);
      const sameInstance = managing.facts.configDir === dev.facts.configDir;
      return {
        ok: true,
        data: {
          managing: instanceFacts(managing.facts),
          dev: {
            ...instanceFacts(dev.facts),
            serverName: instance.serverName,
            worktreePath: instance.worktreePath,
          },
          cliBuild: managing.facts.cliBuild,
          sameInstance,
          bareTalksTo: context.server,
        },
      };
    },
    text: ({ managing, dev, cliBuild, sameInstance, bareTalksTo }) =>
      `managing: ${managing.server}\n  build: ${managing.serverBuild}\n  config: ${managing.configDir}\n  cctl: ${managing.cliPath}\ndev ${dev.serverName}: ${dev.server}\n  build: ${dev.serverBuild}\n  config: ${dev.configDir}\n  cctl: ${dev.cliPath}\n  worktree: ${dev.worktreePath ?? "unknown"}\ncli build: ${cliBuild}\nbare cctl talks to ${bareTalksTo}${sameInstance ? " (same instance)" : "; the dev instance has separate database, logs, and transcripts. Use fixture to produce state there."}`,
  }),
};
