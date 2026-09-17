import { explicitScopeFlags } from "../../framework/context";
import type { CcApplication } from "../../framework/family";
import {
  count,
  invocation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type { Omission } from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  buildAttachmentIndex,
  renderAttachmentIndexLines,
  type AttachmentIndexEntry,
} from "@/lib/tickets/attachment-index";
import {
  createTicketResponseSchema,
  deletedTicketSchema,
  effectiveSnapshotStatus,
  startTicketOutputSchema,
  ticketAttachmentSchema,
  ticketDetailSchema,
  ticketLinkSummarySchema,
  ticketListItemSchema,
  type TicketListItem,
} from "@/lib/tickets/schemas";
import { cliRequest } from "../../transport";
import { resolveCcProject, resolveCcServer } from "../../framework/context";
import { ticketFailure, ticketWriteFailure } from "./target";
import {
  buildTicketGetProjection,
  renderTicketGetText,
  ticketGetProjectionSchema,
  type TicketGetProjection,
} from "./disclosure";
import {
  attachmentGetCommand,
  getCommand,
  listCommand,
  ticketSpecs,
} from "./definitions";
import {
  identifier,
  invalid,
  resolveTicket,
  targetPath,
  ticketPath,
  usage,
  type Input,
  type Read,
  type Write,
  type CcErrorCode,
} from "./target";

function ticketReceipt(
  app: CcApplication,
  ticket: z.infer<typeof ticketDetailSchema>,
) {
  return {
    id: ticket.id,
    projectName: ticket.projectName,
    number: ticket.number,
    title: ticket.title,
    workType: ticket.workType,
    status: ticket.status,
    updatedAt: ticket.updatedAt,
    getCommand: renderInvocation(
      invocation(getCommand, {
        flags: { ...explicitScopeFlags(app) },
        args: { ticket: identifier(ticket) },
      }),
      "cctl",
    ),
  };
}
type TicketReceipt = ReturnType<typeof ticketReceipt>;
type CreatedReceipt = {
  ticket: TicketReceipt;
  warnings: z.infer<typeof createTicketResponseSchema>["warnings"];
};
type StartedReceipt = Omit<
  z.infer<typeof startTicketOutputSchema>,
  "ticket"
> & {
  ticket: TicketReceipt;
  mode: "agent" | "prepared";
  snapshotReads: readonly string[];
};

export const createHandler: Write<typeof ticketSpecs.create> = {
  run: writeRunner<
    Input<typeof ticketSpecs.create>,
    CreatedReceipt,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const recovery = recoveryFacts([
        { kind: "project", id: resolved.value.project },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: ticketPath(resolved.value.project),
        body: {
          title: ctx.flags.title,
          workType: ctx.flags.type,
          ...(ctx.flags.description === undefined
            ? {}
            : { description: ctx.flags.description }),
          ...(ctx.flags.status === undefined
            ? {}
            : { status: ctx.flags.status }),
        },
      });
      if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
      const parsed = createTicketResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalid("ticket creation"),
        };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "ticket", id: parsed.data.ticket.id },
        ]),
        result: {
          ok: true,
          data: {
            ticket: ticketReceipt(app, parsed.data.ticket),
            warnings: parsed.data.warnings,
          },
        },
      };
    },
    text: ({ ticket, warnings }) =>
      `created ${identifier(ticket)}  ${ticket.title}${warnings.length ? `\n${warnings.map((warning) => warning.message).join("\n")}` : ""}`,
  }),
};

async function resolveListTarget(
  app: import("../../framework/family").CcApplication,
  all: boolean,
) {
  if (all) {
    const resolved = await resolveCcServer(app);
    return resolved.ok
      ? ({ ok: true, value: { ...resolved.value, project: null } } as const)
      : resolved;
  }
  return resolveCcProject(app);
}

export const listHandler: Read<typeof ticketSpecs.list> = {
  run: runner<
    Input<typeof ticketSpecs.list>,
    {
      tickets: readonly (TicketListItem & {
        attachmentIndex?: readonly AttachmentIndexEntry[];
      })[];
      omission: Omission;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveListTarget(app, ctx.flags.all === true);
      if (!resolved.ok) return resolved;
      const path =
        resolved.value.project === null
          ? "/api/tickets"
          : ticketPath(resolved.value.project);
      const query = new URLSearchParams();
      if (ctx.flags.status) query.set("status", ctx.flags.status);
      if (ctx.flags.type) query.set("workType", ctx.flags.type);
      if (ctx.flags.sort) query.set("sort", ctx.flags.sort);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${path}${query.size ? `?${query}` : ""}`,
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = z.array(ticketListItemSchema).safeParse(response.body);
      if (!parsed.success) return invalid("ticket list");
      const tickets: Array<
        TicketListItem & { attachmentIndex?: AttachmentIndexEntry[] }
      > = [];
      for (const ticket of parsed.data.slice(0, ctx.flags.limit)) {
        if (!ctx.flags.attachments) {
          tickets.push(ticket);
          continue;
        }
        let attachmentIndex: AttachmentIndexEntry[] = [];
        if (ticket.attachmentCount > 0) {
          const response = await cliRequest(app.host, {
            ...resolved.value,
            method: "GET",
            path: `${ticketPath(ticket.projectName, ticket.number)}/attachments`,
          });
          if (response.kind !== "ok") return ticketFailure(response);
          const parsed = z
            .object({ attachments: z.array(ticketAttachmentSchema) })
            .safeParse(response.body);
          if (!parsed.success)
            return invalid(`ticket attachment index for ${identifier(ticket)}`);
          attachmentIndex = buildAttachmentIndex({
            identifier: identifier(ticket),
            attachments: parsed.data.attachments,
            mode: "bounded",
            ...(app.globals.server === undefined
              ? {}
              : { server: app.globals.server }),
          });
        }
        tickets.push({ ...ticket, attachmentIndex });
      }
      const source = {
        items: tickets,
        total: { kind: "known", count: count(parsed.data.length) } as const,
      };
      const bounded = page(
        parsed.data.length > tickets.length
          ? {
              ...source,
              more: true,
              reveal: invocation(listCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  ...ctx.flags,
                  ...(resolved.value.project === null
                    ? {}
                    : { project: resolved.value.project }),
                  limit: parsed.data.length,
                },
              }),
            }
          : { ...source, more: false },
      );
      const first = tickets[0];
      return {
        ok: true,
        data: {
          tickets: bounded.items,
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
        ...(first
          ? {
              hint: hint(
                invocation(getCommand, {
                  flags: { ...explicitScopeFlags(app) },
                  args: { ticket: identifier(first) },
                }),
                "Read a listed ticket",
              ),
            }
          : {}),
      };
    },
    text: ({ tickets, omission, revealCommand }) =>
      [
        `tickets: ${omission.total.kind === "known" ? omission.total.count : "unknown"} total, ${omission.returned} shown`,
        ...(revealCommand ? [`next: ${revealCommand}`] : []),
        ...tickets.flatMap((ticket) => [
          `${identifier(ticket)}  ${ticket.status}  ${ticket.workType}  attachments: ${ticket.attachmentCount}  ${ticket.title}`,
          ...renderAttachmentIndexLines(
            (ticket.attachmentIndex ?? []).map((entry) => ({
              ...entry,
              commands: [...entry.commands],
            })),
          ),
        ]),
      ].join("\n"),
  }),
};

export const getHandler: Read<typeof ticketSpecs.get> = {
  run: runner<
    Input<typeof ticketSpecs.get>,
    TicketGetProjection & { sessionLines: string[] },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: targetPath(resolved.value),
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = ticketDetailSchema.safeParse(response.body);
      if (!parsed.success)
        return invalid(`ticket read for ${identifier(resolved.value)}`);
      const detail = parsed.data;
      let links: Record<
        string,
        z.infer<typeof ticketLinkSummarySchema>
      > | null = null;
      if (detail.sessions.some((link) => link.endedAt === null)) {
        const response = await cliRequest(app.host, {
          ...resolved.value,
          method: "GET",
          path: `${ticketPath(resolved.value.projectName)}/session-links`,
        });
        if (response.kind === "ok") {
          const parsed = z
            .record(z.string(), ticketLinkSummarySchema)
            .safeParse(response.body);
          if (parsed.success) links = parsed.data;
        }
      }
      const sessionLines = detail.sessions.length
        ? [
            `sessions: ${detail.sessions
              .map((link) => {
                if (link.endedAt !== null)
                  return `${link.sessionName} (ended: ${link.endReason ?? "unknown"})`;
                const current = links?.[link.sessionName];
                return `${link.sessionName} (${current?.ticketId === detail.id && current.linkedAt === link.linkedAt && current.active ? "active" : "status unknown"})`;
              })
              .join(", ")}`,
          ]
        : [];
      const attachmentIndex = buildAttachmentIndex({
        identifier: identifier(detail),
        attachments: detail.attachments,
        mode: "full",
        ...(app.globals.server === undefined
          ? {}
          : { server: app.globals.server }),
      });
      return {
        ok: true,
        data: {
          ...buildTicketGetProjection(
            detail,
            attachmentIndex,
            app.globals.server,
          ),
          sessionLines,
        },
      };
    },
    text: (data) =>
      renderTicketGetText(
        ticketGetProjectionSchema.parse({
          ticket: data.ticket,
          attachmentIndex: data.attachmentIndex,
        }),
        [...data.sessionLines],
      ),
  }),
};

export const updateHandler: Write<typeof ticketSpecs.update> = {
  run: writeRunner<
    Input<typeof ticketSpecs.update>,
    { ticket: TicketReceipt },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const body = {
        ...(ctx.flags.title === undefined ? {} : { title: ctx.flags.title }),
        ...(ctx.flags.description === undefined
          ? {}
          : { description: ctx.flags.description }),
        ...(ctx.flags.status === undefined ? {} : { status: ctx.flags.status }),
        ...(ctx.flags.type === undefined ? {} : { workType: ctx.flags.type }),
      };
      if (Object.keys(body).length === 0)
        return {
          effect: "not_applied",
          result: usage("Supply at least one field to update."),
        };
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const recovery = recoveryFacts([
        { kind: "ticket", id: identifier(resolved.value) },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "PATCH",
        path: targetPath(resolved.value),
        body,
      });
      if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
      const parsed = ticketDetailSchema.safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: {
              ok: true,
              data: { ticket: ticketReceipt(app, parsed.data) },
            },
          }
        : { effect: "unknown", recovery, result: invalid("ticket update") };
    },
    text: ({ ticket }) => `updated ${identifier(ticket)}  ${ticket.title}`,
  }),
};
export const deleteHandler: Write<typeof ticketSpecs.delete> = {
  run: writeRunner<
    Input<typeof ticketSpecs.delete>,
    { deleted: z.infer<typeof deletedTicketSchema> },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const recovery = recoveryFacts([
        { kind: "ticket", id: identifier(resolved.value) },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "DELETE",
        path: targetPath(resolved.value),
      });
      if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
      const parsed = deletedTicketSchema.safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: { ok: true, data: { deleted: parsed.data } },
          }
        : { effect: "unknown", recovery, result: invalid("ticket deletion") };
    },
    text: ({ deleted }) => `deleted ${identifier(deleted)}`,
  }),
};
export const startHandler: Write<typeof ticketSpecs.start> = {
  run: writeRunner<
    Input<typeof ticketSpecs.start>,
    StartedReceipt,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (ctx.flags.model === undefined && ctx.flags["model-param"].length)
        return {
          effect: "not_applied",
          result: usage("--model-param requires --model."),
        };
      const parameters: Record<string, string> = {};
      for (const entry of ctx.flags["model-param"]) {
        const separator = entry.indexOf("=");
        const key = entry.slice(0, separator).trim();
        const value = entry.slice(separator + 1).trim();
        if (
          separator < 1 ||
          key === "" ||
          value === "" ||
          Object.hasOwn(parameters, key)
        )
          return {
            effect: "not_applied",
            result: usage(
              "Each --model-param must be a distinct non-empty id=value pair.",
            ),
          };
        Object.defineProperty(parameters, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const recovery = recoveryFacts([
        { kind: "ticket", id: identifier(resolved.value) },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: targetPath(resolved.value, "/start"),
        body: {
          mode: ctx.flags.mode,
          ...(ctx.flags.backend ? { backend: ctx.flags.backend } : {}),
          ...(ctx.flags.model
            ? { modelSelection: { modelId: ctx.flags.model, parameters } }
            : {}),
        },
      });
      if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
      const parsed = startTicketOutputSchema.safeParse(response.body);
      if (!parsed.success)
        return { effect: "unknown", recovery, result: invalid("ticket start") };
      const snapshotReads = parsed.data.ticket.attachments.flatMap(
        (attachment) =>
          attachment.payload.kind === "conversation" &&
          effectiveSnapshotStatus(attachment.payload) !== "captured"
            ? [
                renderInvocation(
                  invocation(attachmentGetCommand, {
                    flags: { ...explicitScopeFlags(app) },
                    args: {
                      ticket: identifier(parsed.data.ticket),
                      "attachment-id": attachment.id,
                    },
                  }),
                  "cctl",
                ),
              ]
            : [],
      );
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "session", id: parsed.data.sessionName },
          { kind: "conversation", id: parsed.data.conversationId },
        ]),
        result: {
          ok: true,
          data: {
            ...parsed.data,
            ticket: ticketReceipt(app, parsed.data.ticket),
            mode: ctx.flags.mode,
            snapshotReads,
          },
        },
      };
    },
    text: (data) =>
      `started ${identifier(data.ticket)} in ${data.mode} mode\nsession: ${data.sessionName}\n${data.mode === "prepared" ? "prepared — the session waits for your first prompt" : data.initialPromptQueued ? "agent kickoff queued" : "agent kickoff could not be queued — send the first prompt manually"}${data.snapshotReads.length ? `\nSnapshots still capturing:\n${data.snapshotReads.map((command) => `check: ${command}`).join("\n")}` : ""}`,
  }),
};
