import path from "node:path";
import {
  invocation,
  milliseconds,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type {
  CommandSpec,
  HandlerInput,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  cliRequest,
  cliRequestStream,
  encodePathSegment,
} from "../../transport";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import type { CcErrorCode } from "../../framework/context";
import { resolveRunningInstance } from "../dev/target";
import { fixtureSpecs, fixtureStatusCommand } from "./definitions";
import { readSseUntilDone } from "./prompt-stream";
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
interface FixtureTarget {
  url: string;
  worktreePath: string | null;
}
const conversationListSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    status: z.string().optional(),
    archived: z.boolean().optional(),
  }),
);
const createdSessionSchema = z.object({
  sessionName: z.string().min(1),
  conversations: z.array(z.object({ id: z.string().min(1) })).default([]),
});
const sessionsPath = (project: string) =>
  `/api/projects/${encodePathSegment(project)}/sessions`;
const conversationsPath = (project: string, session: string) =>
  `${sessionsPath(project)}/${encodePathSegment(session)}/conversations`;
const normalizeUrl = (value: string) =>
  new URL(value).toString().replace(/\/+$/, "");
const invalid = (what: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The ${what} response is invalid.`,
    }),
  }) as const;
const usage = (message: string) =>
  ({ ok: false, error: ccErrors.error("CC_USAGE", { message }) }) as const;
async function resolveTarget(
  app: CcApplication,
  flags: { readonly target?: string; readonly dev?: string },
) {
  if (flags.target) {
    const url = normalizeUrl(flags.target);
    const managing = app.globals.server ?? app.env.CC_SERVER_URL;
    if (managing && normalizeUrl(managing) === url)
      return usage(
        "Fixtures mutate real sessions; the managing CC instance is refused. Target a worktree dev server.",
      );
    return { ok: true, value: { url, worktreePath: null } } as const;
  }
  const resolved = await resolveRunningInstance(app, flags.dev);
  return resolved.ok
    ? ({
        ok: true,
        value: {
          url: resolved.value.instance.url,
          worktreePath: resolved.value.instance.worktreePath,
        },
      } as const)
    : resolved;
}
const requestParams = (target: FixtureTarget) =>
  ({
    server: target.url,
    token: null,
    tokenSource: null,
    unstamped: true,
  }) as const;
const configPaths = (target: FixtureTarget, conversation: string | null) =>
  target.worktreePath === null
    ? {}
    : {
        dbPath: path.join(target.worktreePath, ".config", "command-center.db"),
        ...(conversation
          ? {
              transcriptPath: path.join(
                target.worktreePath,
                ".config",
                "transcripts",
                `${conversation}.jsonl`,
              ),
            }
          : {}),
      };
async function projectNotFound(
  app: CcApplication,
  target: FixtureTarget,
  project: string,
) {
  const listed = await cliRequest(app.host, {
    ...requestParams(target),
    method: "GET",
    path: "/api/projects",
  });
  const parsed =
    listed.kind === "ok"
      ? z.array(z.object({ name: z.string() })).safeParse(listed.body)
      : null;
  return usage(
    `Project ${project} was not found on ${target.url}${parsed?.success ? `; available: ${parsed.data.map((project) => project.name).join(", ")}` : ""}.`,
  );
}
interface CreatedData {
  sessionName: string;
  conversationId: string | null;
  target: string;
  worktreePath: string | null;
  urls: { session: string; conversation?: string };
  dbPath?: string;
  transcriptPath?: string;
}
export const createHandler: Write<typeof fixtureSpecs.create> = {
  run: writeRunner<Input<typeof fixtureSpecs.create>, CreatedData, CcErrorCode>(
    {
      async run({ app, ctx }) {
        const resolved = await resolveTarget(app, ctx.flags);
        if (!resolved.ok) return { effect: "not_applied", result: resolved };
        const target = resolved.value;
        const project = ctx.args.project;
        const sessionName =
          ctx.flags.name ?? `fx-${ctx.clock.now().toString(36)}`;
        const recovery = recoveryFacts([{ kind: "project", id: project }]);
        const response = await cliRequest(app.host, {
          ...requestParams(target),
          method: "POST",
          path: sessionsPath(project),
          body: { mode: "normal", sessionName },
        });
        if (response.kind !== "ok")
          return response.kind === "error" && response.status === 404
            ? {
                effect: "not_applied",
                result: await projectNotFound(app, target, project),
              }
            : ccWriteFailure(response, recovery);
        const parsed = createdSessionSchema.safeParse(response.body);
        if (!parsed.success)
          return {
            effect: "unknown",
            recovery,
            result: invalid("fixture session creation"),
          };
        const name = parsed.data.sessionName;
        const conversationId = parsed.data.conversations[0]?.id ?? null;
        const urls = {
          session: `${target.url}/projects/${encodePathSegment(project)}/${encodePathSegment(name)}`,
          ...(conversationId
            ? {
                conversation: `${target.url}/conversations?c=${encodeURIComponent(conversationId)}`,
              }
            : {}),
        };
        if (!ctx.flags["skip-warm"])
          await Promise.allSettled(
            [
              urls.session,
              ...(urls.conversation ? [urls.conversation] : []),
              `${target.url}${conversationsPath(project, name)}`,
            ].map((url) => app.host.fetch(url, { method: "GET", headers: {} })),
          );
        return {
          effect: "applied",
          recovery: recoveryFacts([
            { kind: "fixture-session", id: `${project}/${name}` },
            ...(conversationId
              ? [{ kind: "conversation", id: conversationId }]
              : []),
          ]),
          result: {
            ok: true,
            data: {
              sessionName: name,
              conversationId,
              target: target.url,
              worktreePath: target.worktreePath,
              urls,
              ...configPaths(target, conversationId),
            },
            hint: hint(
              invocation(fixtureStatusCommand, {
                args: { project, "session-name": name },
                flags: { target: target.url },
              }),
              "Read the created fixture on its target instance",
            ),
          },
        };
      },
      text: (data) =>
        `created ${data.sessionName}${data.conversationId ? ` (conversation ${data.conversationId})` : ""}\nsession: ${data.urls.session}${data.urls.conversation ? `\nconversation: ${data.urls.conversation}` : ""}${data.transcriptPath ? `\ntranscript: ${data.transcriptPath}` : ""}`,
    },
  ),
};
export const deleteHandler: Write<typeof fixtureSpecs.delete> = {
  run: writeRunner<
    Input<typeof fixtureSpecs.delete>,
    {
      project: string;
      sessionName: string;
      target: string;
      worktreeRemoved: boolean;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTarget(app, ctx.flags);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const project = ctx.args.project;
      const sessionName = ctx.args["session-name"];
      const recovery = recoveryFacts([
        { kind: "fixture-session", id: `${project}/${sessionName}` },
      ]);
      const response = await cliRequest(app.host, {
        ...requestParams(resolved.value),
        method: "DELETE",
        path: `${sessionsPath(project)}?sessionName=${encodeURIComponent(sessionName)}`,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = z
        .object({ worktreeRemoved: z.boolean() })
        .safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: {
              ok: true,
              data: {
                project,
                sessionName,
                target: resolved.value.url,
                worktreeRemoved: parsed.data.worktreeRemoved,
              },
            },
          }
        : {
            effect: "unknown",
            recovery,
            result: invalid("fixture session deletion"),
          };
    },
    text: (data) =>
      `deleted ${data.project}/${data.sessionName} on ${data.target}; worktree removed: ${data.worktreeRemoved}`,
  }),
};
interface PromptData {
  conversationId: string;
  target: string;
  turn: "started" | "completed";
  dbPath?: string;
  transcriptPath?: string;
}
export const promptHandler: Write<typeof fixtureSpecs.prompt> = {
  run: writeRunner<Input<typeof fixtureSpecs.prompt>, PromptData, CcErrorCode>({
    async run({ app, ctx }) {
      const timeoutMs =
        ctx.flags.timeout === undefined
          ? null
          : Math.ceil(Number(ctx.flags.timeout) * 1000);
      if (timeoutMs !== null && !Number.isSafeInteger(timeoutMs))
        return {
          effect: "not_applied",
          result: usage("Timeout must be a finite number of seconds."),
        };
      const resolved = await resolveTarget(app, ctx.flags);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const target = resolved.value;
      const project = ctx.args.project;
      const session = ctx.args["session-name"];
      let conversationId = app.globals.conversation;
      if (conversationId === undefined) {
        const response = await cliRequest(app.host, {
          ...requestParams(target),
          method: "GET",
          path: conversationsPath(project, session),
        });
        if (response.kind !== "ok")
          return {
            effect: "not_applied",
            result:
              response.kind === "error" && response.status === 404
                ? await projectNotFound(app, target, project)
                : ccRequestFailure(response),
          };
        const parsed = conversationListSchema.safeParse(response.body);
        if (!parsed.success)
          return {
            effect: "not_applied",
            result: invalid("fixture conversation list"),
          };
        const conversations = parsed.data.filter(
          (conversation) => conversation.archived !== true,
        );
        const first = conversations[0];
        if (!first)
          return {
            effect: "not_applied",
            result: {
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message: `No conversations in ${project}/${session}.`,
              }),
            },
          };
        if (conversations.length > 1)
          return {
            effect: "not_applied",
            result: usage(
              `Multiple conversations (${conversations.map((item) => item.id).join(", ")}); select one with --conversation.`,
            ),
          };
        conversationId = first.id;
      }
      const recovery = recoveryFacts([
        { kind: "conversation", id: conversationId },
      ]);
      const response = await cliRequestStream(app.host, {
        ...requestParams(target),
        method: "POST",
        path: `${conversationsPath(project, session)}/${encodePathSegment(conversationId)}/prompt`,
        body: { prompt: ctx.flags.text },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const paths = configPaths(target, conversationId);
      const follow = hint(
        invocation(fixtureStatusCommand, {
          args: { project, "session-name": session },
          flags: { target: target.url },
        }),
        "Read the target turn's durable state",
      );
      if (!ctx.flags.wait) {
        await response.response.body?.cancel().catch(() => {});
        return {
          effect: "applied",
          recovery,
          result: {
            ok: true,
            data: {
              conversationId,
              target: target.url,
              turn: "started",
              ...paths,
            },
            hint: follow,
          },
        };
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      ctx.signal.addEventListener("abort", cancel, { once: true });
      if (ctx.signal.aborted) controller.abort();
      try {
        const reading = readSseUntilDone(response.response, controller.signal);
        const outcome =
          timeoutMs === null
            ? await reading
            : await Promise.race([
                reading,
                ctx.clock
                  .sleep(milliseconds(timeoutMs), controller.signal)
                  .then(
                    () => ({ kind: "timeout" }) as const,
                    () => ({ kind: "stopped" }) as const,
                  ),
              ]);
        if (outcome.kind === "done")
          return {
            effect: "applied",
            recovery,
            result: {
              ok: true,
              data: {
                conversationId,
                target: target.url,
                turn: "completed",
                ...paths,
              },
            },
          };
        const message =
          outcome.kind === "error"
            ? `Turn failed: ${outcome.message}`
            : outcome.kind === "timeout"
              ? `Turn observation timed out after ${ctx.flags.timeout}s; it may still run on the server.`
              : outcome.kind === "ended"
                ? "Stream ended without a done event; the turn outcome is unknown."
                : "Stopped observing the turn; it may still run on the server.";
        return {
          effect: "applied",
          recovery,
          result: {
            ok: false,
            error: ccErrors.error("CC_OPERATION_FAILED", {
              message,
              details: { target: target.url, conversationId, ...paths },
            }),
            hint: follow,
          },
        };
      } finally {
        controller.abort();
        ctx.signal.removeEventListener("abort", cancel);
      }
    },
    text: (data) =>
      `turn ${data.turn} in ${data.conversationId} on ${data.target}${data.transcriptPath ? `\ntranscript: ${data.transcriptPath}` : ""}${data.dbPath ? `\ndb: ${data.dbPath}` : ""}`,
  }),
};
export const statusHandler: Read<typeof fixtureSpecs.status> = {
  run: runner<
    Input<typeof fixtureSpecs.status>,
    {
      conversations: Array<{ id: string; name: string; status: string }>;
      target: string;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTarget(app, ctx.flags);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...requestParams(resolved.value),
        method: "GET",
        path: conversationsPath(ctx.args.project, ctx.args["session-name"]),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = conversationListSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: {
              conversations: parsed.data.map((item) => ({
                id: item.id,
                name: item.name ?? "",
                status: item.status ?? "unknown",
              })),
              target: resolved.value.url,
            },
          }
        : invalid("fixture conversation status");
    },
    text: ({ conversations, target }) =>
      `target: ${target}\n${conversations.length ? conversations.map((item) => `${item.id}  ${item.status}  ${item.name}`).join("\n") : "No conversations."}`,
  }),
};
