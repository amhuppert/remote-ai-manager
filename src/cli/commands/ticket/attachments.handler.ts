import { explicitScopeFlags } from "../../framework/context";
import path from "node:path";
import {
  binaryArtifact,
  bytes,
  invocation,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type { CommitReport, JsonData } from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import {
  effectiveSnapshotStatus,
  resolvedAttachmentSchema,
  ticketAttachmentSchema,
  deletedTicketAttachmentSchema,
  type TicketAttachment,
  type ResolvedAttachment,
} from "@/lib/tickets/schemas";
import { cliRequest, encodePathSegment, readSessionEnv } from "../../transport";
import {
  conversationReadCommands,
  attachmentRefreshCommand as snapshotRefreshCommand,
} from "@/lib/tickets/attachment-commands";
import { resolveCcProject } from "../../framework/context";
import { ticketFailure, ticketWriteFailure } from "./target";
import {
  attachmentGetCommand,
  attachmentRefreshCommand,
  ticketSpecs,
} from "./definitions";
import {
  identifier,
  invalid,
  resolveTicket,
  targetPath,
  usage,
  type Input,
  type Read,
  type Write,
  type CcErrorCode,
  type TicketTarget,
} from "./target";
import type { CcApplication } from "../../framework/family";

function attachmentPath(target: TicketTarget, id?: string) {
  return targetPath(
    target,
    `/attachments${id === undefined ? "" : `/${encodePathSegment(id)}`}`,
  );
}
type AttachmentReceipt = Omit<TicketAttachment, "description" | "payload"> & {
  descriptionPreview: string;
  payload:
    | Exclude<TicketAttachment["payload"], { kind: "note" }>
    | { kind: "note" };
};
type AttachedData = {
  attachment: AttachmentReceipt;
  ticket: string;
  snapshotRead: string | null;
  getCommand: string;
};
function attachmentReceipt(attachment: TicketAttachment): AttachmentReceipt {
  const { description, payload, ...metadata } = attachment;
  return {
    ...metadata,
    descriptionPreview: description.replace(/\s+/gu, " ").slice(0, 160),
    payload: payload.kind === "note" ? { kind: "note" } : payload,
  };
}
function attachmentText({
  attachment,
  ticket,
  snapshotRead,
  getCommand,
}: JsonData<AttachedData>) {
  const payload = attachment.payload;
  const state =
    payload.kind === "conversation" ? effectiveSnapshotStatus(payload) : null;
  return `${attachment.id} ${payload.kind} on ${ticket} — ${attachment.descriptionPreview}${state !== null && state !== "captured" ? `\nsnapshot ${state}${payload.kind === "conversation" && payload.snapshotError ? `: ${payload.snapshotError}` : ""}${snapshotRead ? `\nretry: ${snapshotRead}` : ""}` : ""}\nget: ${getCommand}`;
}
async function mutateAttachment(
  app: CcApplication,
  target: TicketTarget,
  method: "POST" | "PATCH",
  path: string,
  input: {
    body?: Record<string, unknown>;
    rawBody?: Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
  },
): Promise<CommitReport<AttachedData, CcErrorCode>> {
  const recovery = recoveryFacts([{ kind: "ticket", id: identifier(target) }]);
  const response = await cliRequest(app.host, {
    ...target,
    method,
    path,
    ...input,
  });
  if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
  const parsed = ticketAttachmentSchema.safeParse(response.body);
  if (!parsed.success)
    return {
      effect: "unknown",
      recovery,
      result: invalid("ticket attachment write"),
    };
  const attachment = parsed.data;
  const snapshotRead =
    attachment.payload.kind === "conversation" &&
    effectiveSnapshotStatus(attachment.payload) !== "captured"
      ? renderInvocation(
          invocation(attachmentRefreshCommand, {
            flags: { ...explicitScopeFlags(app) },
            args: {
              ticket: identifier(target),
              "attachment-id": attachment.id,
            },
          }),
          "cctl",
        )
      : null;
  return {
    effect: "applied",
    recovery: recoveryFacts([
      { kind: "ticket", id: identifier(target) },
      { kind: "attachment", id: attachment.id },
    ]),
    result: {
      ok: true,
      data: {
        attachment: attachmentReceipt(attachment),
        ticket: identifier(target),
        snapshotRead,
        getCommand: renderInvocation(
          invocation(attachmentGetCommand, {
            flags: { ...explicitScopeFlags(app) },
            args: {
              ticket: identifier(target),
              "attachment-id": attachment.id,
            },
          }),
          "cctl",
        ),
      },
    },
  };
}
function multipart(
  fileName: string,
  content: Uint8Array,
  metadata: Record<string, unknown>,
) {
  const boundary = `----cctl-ticket-${crypto.randomUUID()}`;
  const safeName = fileName.replace(/["\r\n\\]/g, "_");
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${safeName}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const rawBody = new Uint8Array(head.length + content.length + tail.length);
  rawBody.set(head);
  rawBody.set(content, head.length);
  rawBody.set(tail, head.length + content.length);
  return {
    rawBody,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
export const attachFileHandler: Write<typeof ticketSpecs.attachFile> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachFile>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      let content: Uint8Array;
      try {
        content = await ctx.host.files.read(
          ctx.args.path,
          bytes(20 * 1024 * 1024),
          ctx.signal,
        );
      } catch {
        return {
          effect: "not_applied",
          result: usage(
            `Cannot read ${ctx.args.path} within the 20 MiB upload limit.`,
          ),
        };
      }
      const fileName = path.basename(ctx.args.path);
      return mutateAttachment(
        app,
        resolved.value,
        "POST",
        attachmentPath(resolved.value),
        multipart(fileName, content, {
          description: ctx.flags.description,
          fileName,
          ...(ctx.flags["media-type"]
            ? { mediaType: ctx.flags["media-type"] }
            : {}),
        }),
      );
    },
    text: attachmentText,
  }),
};
export const attachNoteHandler: Write<typeof ticketSpecs.attachNote> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachNote>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (ctx.args.markdown !== undefined && ctx.flags.markdown !== undefined)
        return {
          effect: "not_applied",
          result: usage(
            "Supply note prose once, as positional Markdown or --markdown/--markdown-file.",
          ),
        };
      const markdown = ctx.args.markdown ?? ctx.flags.markdown;
      if (markdown === undefined)
        return {
          effect: "not_applied",
          result: usage("Supply the note Markdown or --markdown-file."),
        };
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return mutateAttachment(
        app,
        resolved.value,
        "POST",
        attachmentPath(resolved.value),
        {
          body: {
            description: ctx.flags.description,
            payload: { kind: "note", markdown },
          },
        },
      );
    },
    text: attachmentText,
  }),
};
export const attachConversationHandler: Write<
  typeof ticketSpecs.attachConversation
> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachConversation>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const ambient = await resolveCcProject(app);
      if (!ambient.ok) return { effect: "not_applied", result: ambient };
      const explicit = ctx.args["conversation-id"] ?? app.globals.conversation;
      const conversationId = explicit ?? app.env.CC_CONVERSATION_ID;
      if (!conversationId)
        return {
          effect: "not_applied",
          result: usage(
            "Supply a conversation id with --conversation or run from a CC conversation.",
          ),
        };
      const sessionName =
        explicit === undefined
          ? (app.globals.session ?? readSessionEnv(app.env))
          : (app.globals.session ?? null);
      return mutateAttachment(
        app,
        resolved.value,
        "POST",
        attachmentPath(resolved.value),
        {
          body: {
            description: ctx.flags.description,
            payload: {
              kind: "conversation",
              projectName: ambient.value.project,
              sessionName,
              conversationId,
            },
          },
        },
      );
    },
    text: attachmentText,
  }),
};
export const attachSessionHandler: Write<typeof ticketSpecs.attachSession> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachSession>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const ambient = await resolveCcProject(app);
      if (!ambient.ok) return { effect: "not_applied", result: ambient };
      return mutateAttachment(
        app,
        resolved.value,
        "POST",
        attachmentPath(resolved.value),
        {
          body: {
            description: ctx.flags.description,
            payload: {
              kind: "session",
              projectName: ambient.value.project,
              sessionName: ctx.args["session-name"],
            },
          },
        },
      );
    },
    text: attachmentText,
  }),
};

function attachmentCommandsForServer(
  attachment: ResolvedAttachment,
  ticket: string,
  server: string | undefined,
): ResolvedAttachment {
  if (server === undefined) return attachment;
  if (attachment.kind === "session") {
    return {
      ...attachment,
      readCommands: attachment.conversationIds.flatMap((conversationId) =>
        conversationReadCommands(
          conversationId,
          {
            projectName: attachment.projectName,
            sessionName: attachment.sessionName,
          },
          server,
        ),
      ),
    };
  }
  if (attachment.kind !== "conversation") return attachment;
  if ("state" in attachment) {
    return {
      ...attachment,
      retryCommand: snapshotRefreshCommand(
        ticket,
        attachment.attachment.id,
        server,
      ),
    };
  }
  const payload = attachment.attachment.payload;
  if (payload.kind !== "conversation") return attachment;
  return {
    ...attachment,
    readCommands: attachment.sourceAvailable
      ? conversationReadCommands(
          attachment.conversationId,
          {
            projectName: path.basename(payload.projectPath),
            sessionName: attachment.sessionName,
          },
          server,
        )
      : [],
  };
}

export const attachmentGetHandler: Read<typeof ticketSpecs.attachmentGet> = {
  run: runner<
    Input<typeof ticketSpecs.attachmentGet>,
    | { attachment: ResolvedAttachment; ticket: string }
    | {
        ticket: string;
        attachmentId: string;
        fileName: string;
        mediaType: string | null;
        sizeBytes: number;
      },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: attachmentPath(resolved.value, ctx.args["attachment-id"]),
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = resolvedAttachmentSchema.safeParse(response.body);
      if (!parsed.success) return invalid("resolved ticket attachment");
      const attachment = attachmentCommandsForServer(
        parsed.data,
        identifier(resolved.value),
        app.globals.server,
      );
      if (attachment.kind === "file" && attachment.encoding === "base64") {
        const content = Buffer.from(attachment.content, "base64");
        if (
          content.toString("base64") !== attachment.content ||
          content.byteLength !== attachment.sizeBytes
        )
          return invalid("binary attachment bytes");
        return {
          ok: true,
          binary: binaryArtifact<{
            ticket: string;
            attachmentId: string;
            fileName: string;
            mediaType: string | null;
            sizeBytes: number;
          }>({
            bytes: content,
            mediaType: attachment.mediaType ?? "application/octet-stream",
            basename: path.basename(attachment.fileName),
            summary: {
              ticket: identifier(resolved.value),
              attachmentId: attachment.attachment.id,
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
              sizeBytes: attachment.sizeBytes,
            },
          }),
        };
      }
      return {
        ok: true,
        data: { attachment, ticket: identifier(resolved.value) },
      };
    },
    text: (data) => {
      if (!("attachment" in data))
        return `file ${data.fileName} on ${data.ticket} (${data.mediaType ?? "unknown type"}, ${data.sizeBytes} bytes)`;
      const resolved = data.attachment;
      const header = `${resolved.attachment.id} ${resolved.kind} on ${data.ticket} — ${resolved.attachment.description}`;
      if (resolved.kind === "note") return `${header}\n\n${resolved.markdown}`;
      if (resolved.kind === "file")
        return `${header}\nfile: ${resolved.fileName} (${resolved.mediaType ?? "unknown type"}, ${resolved.sizeBytes} bytes)\n\n${resolved.content}`;
      if (resolved.kind === "session")
        return `${header}\nsession: ${resolved.projectName}/${resolved.sessionName} (${resolved.finished ? "finished" : "live"}, ${resolved.conversationIds.length} conversations)\n${resolved.readCommands.map((command) => `read: ${command}`).join("\n")}`;
      if ("state" in resolved)
        return `${header}\nconversation: ${resolved.conversationId}\nsnapshot ${resolved.state}${resolved.state === "failed" ? `: ${resolved.error}` : ""}\nretry: ${resolved.retryCommand}`;
      return `${header}\nconversation: ${resolved.conversationId}${resolved.sessionName ? ` (session ${resolved.sessionName})` : ""}\nsource: ${resolved.source} (captured ${resolved.capturedAt}; source ${resolved.sourceAvailable ? "available" : "no longer available"})\n\n${resolved.markdown}\n${resolved.readCommands.map((command) => `read: ${command}`).join("\n")}`;
    },
  }),
};
export const attachmentUpdateHandler: Write<
  typeof ticketSpecs.attachmentUpdate
> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachmentUpdate>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const body = {
        ...(ctx.flags.description === undefined
          ? {}
          : { description: ctx.flags.description }),
        ...(ctx.flags.markdown === undefined
          ? {}
          : { markdown: ctx.flags.markdown }),
      };
      if (!Object.keys(body).length)
        return {
          effect: "not_applied",
          result: usage("Supply --description or --markdown to update."),
        };
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return mutateAttachment(
        app,
        resolved.value,
        "PATCH",
        attachmentPath(resolved.value, ctx.args["attachment-id"]),
        { body },
      );
    },
    text: attachmentText,
  }),
};
export const attachmentRefreshHandler: Write<
  typeof ticketSpecs.attachmentRefresh
> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachmentRefresh>,
    AttachedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return mutateAttachment(
        app,
        resolved.value,
        "POST",
        `${attachmentPath(resolved.value, ctx.args["attachment-id"])}/refresh-snapshot`,
        {},
      );
    },
    text: attachmentText,
  }),
};
export const attachmentRemoveHandler: Write<
  typeof ticketSpecs.attachmentRemove
> = {
  run: writeRunner<
    Input<typeof ticketSpecs.attachmentRemove>,
    { removed: import("zod").z.infer<typeof deletedTicketAttachmentSchema> },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const recovery = recoveryFacts([
        { kind: "ticket", id: identifier(resolved.value) },
        { kind: "attachment", id: ctx.args["attachment-id"] },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "DELETE",
        path: attachmentPath(resolved.value, ctx.args["attachment-id"]),
      });
      if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
      const parsed = deletedTicketAttachmentSchema.safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: { ok: true, data: { removed: parsed.data } },
          }
        : {
            effect: "unknown",
            recovery,
            result: invalid("attachment removal"),
          };
    },
    text: ({ removed }) =>
      `removed ${removed.kind} attachment ${removed.attachmentId}`,
  }),
};
