import { explicitScopeFlags } from "../../framework/context";
import { quoteLiteralText } from "../../framework/literal-text";
import {
  count,
  invocation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type {
  CommandSpec,
  CommitReport,
  HandlerInput,
  Omission,
  ReadHandler,
  ReportedRecovery,
  WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import {
  notepadCommentReplySchema,
  notepadListItemSchema,
  notepadSchema,
  resolvedNotepadCommentThreadSchema,
  type Notepad,
  type NotepadCommentReply,
  type NotepadListItem,
  type ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  resolveCcProjectConversation,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  ccRequestFailure,
  ccWriteFailure,
  type CcFailedRequest,
} from "../../framework/request";
import {
  notepadCommentListCommand,
  notepadGetCommand,
  notepadListCommand,
  type notepadAppendSpec,
  type notepadCommentListSpec,
  type notepadCommentReplySpec,
  type notepadCreateSpec,
  type notepadGetSpec,
  type notepadListSpec,
  type notepadUpdateSpec,
} from "./definitions";

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
const notepadResponseSchema = z.object({ notepad: notepadSchema });
const listResponseSchema = z.object({
  notepads: z.array(notepadListItemSchema),
});
const commentListResponseSchema = z.object({
  comments: z.array(resolvedNotepadCommentThreadSchema),
});
const replyResponseSchema = z.object({ reply: notepadCommentReplySchema });

type NotepadReceipt = { notepad: Omit<Notepad, "content"> };
function receipt(notepad: Notepad): NotepadReceipt {
  const { content: _content, ...metadata } = notepad;
  return { notepad: metadata };
}

function notepadPath(id: string): string {
  return `/api/notepads/${encodePathSegment(id)}`;
}

function metadata(notepad: Omit<Notepad, "content">): string {
  const scope =
    notepad.scope === "global"
      ? "global"
      : `project(${notepad.projectPath ?? "unknown"})`;
  return `scope: ${scope}  revision: ${notepad.revision}  write-mode: ${notepad.writeMode}  updated: ${notepad.updatedAt}`;
}

function listRow(item: NotepadListItem): string {
  const scope =
    item.scope === "global"
      ? "global"
      : `project(${item.projectName ?? item.projectPath ?? "unknown"})`;
  return [
    item.id,
    scope,
    `rev ${item.revision}`,
    item.writeMode,
    ...(item.pinned ? ["pinned"] : []),
    ...(item.archived ? ["archived"] : []),
    item.name,
  ].join("  ");
}

function omissionLines(
  label: string,
  omission: Pick<Omission, "total" | "returned">,
  revealCommand: string | null,
): string[] {
  const total =
    omission.total.kind === "known" ? String(omission.total.count) : "unknown";
  return [
    `${label}: ${total} total, ${omission.returned} shown`,
    ...(revealCommand === null ? [] : [`next: ${revealCommand}`]),
  ];
}

function refusalOptions(response: CcFailedRequest) {
  return response.kind === "error" &&
    response.status === 404 &&
    response.code === "not_found"
    ? { errorCode: "CC_OPERATION_FAILED" as const }
    : {};
}

function invalidResponse(what: string, error?: z.ZodError) {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The ${what} response is invalid.`,
      ...(error
        ? {
            issues: error.issues.map((issue) => ({
              code: "CC_INVALID_RESPONSE_FIELD",
              message: issue.message,
              path: issue.path.map((segment) =>
                typeof segment === "symbol" ? String(segment) : segment,
              ),
            })),
          }
        : {}),
    }),
  } as const;
}

function unacknowledgedNotepad(
  recovery: ReportedRecovery,
): CommitReport<NotepadReceipt, CcErrorCode> {
  return {
    effect: "unknown",
    recovery,
    result: invalidResponse(
      "notepad write; inspect the current notepad before retrying",
    ),
  };
}

export const listHandler: Read<typeof notepadListSpec> = {
  run: runner<
    Input<typeof notepadListSpec>,
    {
      notepads: readonly NotepadListItem[];
      omission: Omission;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const query = new URLSearchParams();
      if (ctx.flags.global) query.set("scope", "global");
      else query.set("project", resolved.value.project);
      if (ctx.flags.archived) query.set("archived", "true");
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `/api/notepads?${query}`,
      });
      if (response.kind !== "ok")
        return ccRequestFailure(response, refusalOptions(response));
      const parsed = listResponseSchema.safeParse(response.body);
      if (!parsed.success) return invalidResponse("notepad list");
      const notepads = parsed.data.notepads;
      const more = notepads.length > ctx.flags.limit;
      const source = {
        items: notepads.slice(0, ctx.flags.limit),
        total: { kind: "known", count: count(notepads.length) } as const,
      };
      const bounded = page(
        more
          ? {
              ...source,
              more: true,
              reveal: invocation(notepadListCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  ...(ctx.flags.global
                    ? {}
                    : { project: resolved.value.project }),
                  limit: notepads.length,
                  ...(ctx.flags.global ? { global: true } : {}),
                  ...(ctx.flags.archived ? { archived: true } : {}),
                },
              }),
            }
          : { ...source, more: false },
      );
      const first = bounded.items[0];
      return {
        ok: true,
        data: {
          notepads: bounded.items,
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
        ...(first
          ? {
              hint: hint(
                invocation(notepadGetCommand, {
                  flags: { ...explicitScopeFlags(app) },
                  args: { "notepad-id": first.id },
                }),
                "Read a listed notepad",
              ),
            }
          : {}),
      };
    },
    text: ({ notepads, omission, revealCommand }) =>
      quoteLiteralText(
        `${[...omissionLines("notepads", omission, revealCommand), ...notepads.map(listRow)].join("\n")}\n`,
      ),
  }),
};

export const getHandler: Read<typeof notepadGetSpec> = {
  run: runner<Input<typeof notepadGetSpec>, { notepad: Notepad }, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: notepadPath(ctx.args["notepad-id"]),
      });
      if (response.kind !== "ok")
        return ccRequestFailure(response, refusalOptions(response));
      const parsed = notepadResponseSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalidResponse("notepad read", parsed.error);
    },
    text: ({ notepad }) =>
      quoteLiteralText(
        `${notepad.id}  ${notepad.name}\n${metadata(notepad)}\n\n${notepad.content.replace(/\n$/u, "")}\n`,
      ),
  }),
};

export const createHandler: Write<typeof notepadCreateSpec> = {
  run: writeRunner<
    Input<typeof notepadCreateSpec>,
    NotepadReceipt,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok)
        return {
          effect: "not_applied",
          result: { ok: false, error: resolved.error },
        };
      const recovery = recoveryFacts([
        { kind: "conversation", id: resolved.value.conversation },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: "/api/notepads",
        headers: { "x-cc-conversation-id": resolved.value.conversation },
        body: {
          scope: ctx.flags.global ? "global" : "project",
          ...(ctx.flags.global ? {} : { project: resolved.value.project }),
          name: ctx.flags.name,
          ...(ctx.flags.content === undefined
            ? {}
            : { content: ctx.flags.content }),
        },
      });
      if (response.kind !== "ok")
        return ccWriteFailure(response, recovery, refusalOptions(response));
      const parsed = notepadResponseSchema.safeParse(response.body);
      if (!parsed.success) return unacknowledgedNotepad(recovery);
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "notepad", id: parsed.data.notepad.id },
        ]),
        result: {
          ok: true,
          data: receipt(parsed.data.notepad),
          hint: hint(
            invocation(notepadGetCommand, {
              flags: { ...explicitScopeFlags(app) },
              args: { "notepad-id": parsed.data.notepad.id },
            }),
            "Read the created notepad",
          ),
        },
      };
    },
    text: ({ notepad }) =>
      quoteLiteralText(
        `created ${notepad.id}  ${notepad.name}\n${metadata(notepad)}\n`,
      ),
  }),
};

async function writeContent(
  {
    app,
    ctx,
  }: Input<typeof notepadUpdateSpec> | Input<typeof notepadAppendSpec>,
  operation: "update" | "append",
): Promise<CommitReport<NotepadReceipt, CcErrorCode>> {
  const resolved = await resolveCcProjectConversation(app);
  if (!resolved.ok)
    return {
      effect: "not_applied",
      result: { ok: false, error: resolved.error },
    };
  const recovery = recoveryFacts([
    { kind: "notepad", id: ctx.args["notepad-id"] },
  ]);
  const response = await cliRequest(app.host, {
    ...resolved.value,
    method: "POST",
    path: `${notepadPath(ctx.args["notepad-id"])}/content`,
    headers: { "x-cc-conversation-id": resolved.value.conversation },
    body: {
      operation,
      baseRevision: ctx.flags["if-revision"],
      content: ctx.flags.content,
    },
  });
  if (response.kind !== "ok")
    return ccWriteFailure(response, recovery, refusalOptions(response));
  const parsed = notepadResponseSchema.safeParse(response.body);
  if (!parsed.success) return unacknowledgedNotepad(recovery);
  return {
    effect: "applied",
    recovery,
    result: { ok: true, data: receipt(parsed.data.notepad) },
  };
}

export const updateHandler: Write<typeof notepadUpdateSpec> = {
  run: writeRunner<
    Input<typeof notepadUpdateSpec>,
    NotepadReceipt,
    CcErrorCode
  >({
    run: (input) => writeContent(input, "update"),
    text: ({ notepad }) =>
      quoteLiteralText(
        `updated ${notepad.id}  ${notepad.name}\n${metadata(notepad)}\n`,
      ),
  }),
};
export const appendHandler: Write<typeof notepadAppendSpec> = {
  run: writeRunner<
    Input<typeof notepadAppendSpec>,
    NotepadReceipt,
    CcErrorCode
  >({
    run: (input) => writeContent(input, "append"),
    text: ({ notepad }) =>
      quoteLiteralText(
        `appended to ${notepad.id}  ${notepad.name}\n${metadata(notepad)}\n`,
      ),
  }),
};

function author(kind: "user" | "agent", conversationId: string | null): string {
  return kind === "agent" && conversationId !== null
    ? `agent ${conversationId}`
    : kind;
}

function labelledLines(label: string, text: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [`  ${label}: ${first}`, ...rest.map((line) => `    ${line}`)];
}

function commentBlock(
  thread: Omit<ResolvedNotepadCommentThread, "replies"> & {
    readonly replies: readonly NotepadCommentReply[];
  },
): string {
  const { comment, passage, replies } = thread;
  return [
    `${comment.id}  ${comment.status}  ${passage.state}  ${passage.location}  ${author(comment.authorKind, comment.authorConversationId)}`,
    ...labelledLines("quote", passage.quote),
    ...labelledLines("body", comment.body),
    ...replies.flatMap((reply) =>
      labelledLines(
        `reply ${reply.id}  ${author(reply.authorKind, reply.authorConversationId)}`,
        reply.body,
      ),
    ),
  ].join("\n");
}

export const commentListHandler: Read<typeof notepadCommentListSpec> = {
  run: runner<
    Input<typeof notepadCommentListSpec>,
    {
      comments: readonly ResolvedNotepadCommentThread[];
      omission: Omission;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const query = new URLSearchParams();
      if (ctx.flags.status) query.set("status", ctx.flags.status);
      const search = query.size === 0 ? "" : `?${query}`;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${notepadPath(ctx.args["notepad-id"])}/comments${search}`,
      });
      if (response.kind !== "ok")
        return ccRequestFailure(response, refusalOptions(response));
      const parsed = commentListResponseSchema.safeParse(response.body);
      if (!parsed.success) return invalidResponse("notepad comment list");
      const comments = parsed.data.comments;
      const source = {
        items: comments.slice(0, ctx.flags.limit),
        total: { kind: "known", count: count(comments.length) } as const,
      };
      const bounded = page(
        comments.length > ctx.flags.limit
          ? {
              ...source,
              more: true,
              reveal: invocation(notepadCommentListCommand, {
                args: { "notepad-id": ctx.args["notepad-id"] },
                flags: {
                  ...explicitScopeFlags(app),
                  project: resolved.value.project,
                  limit: comments.length,
                  ...(ctx.flags.status ? { status: ctx.flags.status } : {}),
                },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          comments: bounded.items,
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ comments, omission, revealCommand }) =>
      quoteLiteralText(
        `${[...omissionLines("comments", omission, revealCommand), ...comments.map(commentBlock)].join("\n")}\n`,
      ),
  }),
};

export const commentReplyHandler: Write<typeof notepadCommentReplySpec> = {
  run: writeRunner<
    Input<typeof notepadCommentReplySpec>,
    { reply: NotepadCommentReply },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok)
        return {
          effect: "not_applied",
          result: { ok: false, error: resolved.error },
        };
      const recovery = recoveryFacts([
        { kind: "notepad", id: ctx.args["notepad-id"] },
        { kind: "notepad-comment", id: ctx.args["comment-id"] },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: `${notepadPath(ctx.args["notepad-id"])}/comments/${encodePathSegment(ctx.args["comment-id"])}/replies`,
        headers: { "x-cc-conversation-id": resolved.value.conversation },
        body: { body: ctx.flags.body },
      });
      if (response.kind !== "ok")
        return ccWriteFailure(response, recovery, refusalOptions(response));
      const parsed = replyResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalidResponse(
            "notepad comment reply; inspect the thread before retrying",
          ),
        };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "notepad-comment-reply", id: parsed.data.reply.id },
        ]),
        result: {
          ok: true,
          data: parsed.data,
          hint: hint(
            invocation(notepadCommentListCommand, {
              args: { "notepad-id": ctx.args["notepad-id"] },
              flags: { ...explicitScopeFlags(app), status: "open" },
            }),
            "Read remaining open comments",
          ),
        },
      };
    },
    text: ({ reply }) =>
      quoteLiteralText(
        `replied to ${reply.commentId}\nreply: ${reply.id}  ${author(reply.authorKind, reply.authorConversationId)}  ${reply.createdAt}\n`,
      ),
  }),
};
