import { explicitScopeFlags } from "../../framework/context";
import {
  count,
  invocation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type { CommitReport, Omission } from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import {
  ticketRelationshipDeleteResponseSchema,
  ticketRelationshipMutationResponseSchema,
  ticketRelationshipPageSchema,
  ticketRelationshipViewSchema,
  ticketStatusUpdateCreateResponseSchema,
  ticketStatusUpdatePageSchema,
  ticketStatusUpdateSchema,
} from "@/lib/tickets/schemas";
import { decodeTicketKeysetCursor } from "@/lib/tickets/ticket-keyset-cursor";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  buildRelationshipOutline,
  buildStatusUpdateOutline,
  renderRelationshipDetailText,
  renderStatusUpdateDetailText,
  type TicketRelationshipOutline,
  type TicketStatusUpdateOutline,
} from "./disclosure";
import {
  relationListCommand,
  statusListCommand,
  ticketSpecs,
} from "./definitions";
import {
  identifier,
  invalid,
  resolveTicket,
  targetPath,
  ticketFailure,
  ticketWriteFailure,
  usage,
  type Input,
  type Read,
  type Write,
  type CcErrorCode,
  type TicketTarget,
} from "./target";
import type { CcApplication } from "../../framework/family";

function relationPath(target: TicketTarget, id?: string) {
  return targetPath(
    target,
    `/relationships${id === undefined ? "" : `/${encodePathSegment(id)}`}`,
  );
}
function statusPath(target: TicketTarget, id?: string) {
  return targetPath(
    target,
    `/status-updates${id === undefined ? "" : `/${encodePathSegment(id)}`}`,
  );
}
function validCursor(cursor: string | undefined) {
  return cursor === undefined || decodeTicketKeysetCursor(cursor) !== null;
}

export const relationListHandler: Read<typeof ticketSpecs.relationList> = {
  run: runner<
    Input<typeof ticketSpecs.relationList>,
    {
      relationships: readonly TicketRelationshipOutline[];
      omission: Omission;
      nextCursor: string | null;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (!validCursor(ctx.flags.cursor))
        return usage("Use the opaque cursor returned by the preceding page.");
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams({ limit: String(ctx.flags.limit) });
      if (ctx.flags.role) query.set("role", ctx.flags.role);
      if (ctx.flags.cursor) query.set("cursor", ctx.flags.cursor);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${relationPath(resolved.value)}?${query}`,
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = ticketRelationshipPageSchema.safeParse(response.body);
      if (
        !parsed.success ||
        parsed.data.items.length > ctx.flags.limit ||
        (parsed.data.nextCursor !== null &&
          parsed.data.total <= parsed.data.items.length)
      )
        return invalid("relationship page");
      const { items, total, nextCursor } = parsed.data;
      const source = {
        items: items.map((item) =>
          buildRelationshipOutline(
            item,
            identifier(resolved.value),
            app.globals.server,
          ),
        ),
        total: { kind: "known", count: count(total) } as const,
      };
      const bounded = page(
        nextCursor === null
          ? { ...source, more: false }
          : {
              ...source,
              more: true,
              reveal: invocation(relationListCommand, {
                args: { ticket: identifier(resolved.value) },
                flags: {
                  ...explicitScopeFlags(app),
                  ...ctx.flags,
                  cursor: nextCursor,
                },
              }),
            },
      );
      return {
        ok: true,
        data: {
          relationships: bounded.items,
          omission: bounded.omission,
          nextCursor,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ relationships, omission, revealCommand }) =>
      [
        `relationships: ${omission.total.kind === "known" ? omission.total.count : "unknown"} total, ${omission.returned} shown`,
        ...(revealCommand ? [`next: ${revealCommand}`] : []),
        ...relationships.flatMap((item) => [
          `${item.id} ${item.role} — ${item.otherTicket} [${item.otherStatus}] ${item.otherTitle} — ${item.descriptionPreview}`,
          `get: ${item.getCommand}`,
        ]),
      ].join("\n"),
  }),
};
export const relationGetHandler: Read<typeof ticketSpecs.relationGet> = {
  run: runner<
    Input<typeof ticketSpecs.relationGet>,
    {
      relationship: z.infer<typeof ticketRelationshipViewSchema>;
      ticket: string;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: relationPath(resolved.value, ctx.args["relationship-id"]),
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = ticketRelationshipViewSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: {
              relationship: parsed.data,
              ticket: identifier(resolved.value),
            },
          }
        : invalid("relationship read");
    },
    text: ({ relationship, ticket }) =>
      renderRelationshipDetailText(
        ticketRelationshipViewSchema.parse(relationship),
        ticket,
      ),
  }),
};

type MutationSchema =
  | typeof ticketRelationshipMutationResponseSchema
  | typeof ticketRelationshipDeleteResponseSchema
  | typeof ticketStatusUpdateCreateResponseSchema;
type MutationData =
  | { relationship: TicketRelationshipOutline }
  | { relationshipId: string }
  | { update: TicketStatusUpdateOutline };
function mutationReceipt(
  data: z.infer<MutationSchema>,
  ticket: string,
  server?: string,
): MutationData {
  if ("relationship" in data)
    return {
      relationship: buildRelationshipOutline(data.relationship, ticket, server),
    };
  if ("relationshipId" in data) return { relationshipId: data.relationshipId };
  return { update: buildStatusUpdateOutline(data.update, ticket, server) };
}
async function writeRelation(
  app: CcApplication,
  target: TicketTarget,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  schema: MutationSchema,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<CommitReport<MutationData, CcErrorCode>> {
  const recovery = recoveryFacts([{ kind: "ticket", id: identifier(target) }]);
  const response = await cliRequest(app.host, {
    ...target,
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });
  if (response.kind !== "ok") return ticketWriteFailure(response, recovery);
  const parsed = schema.safeParse(response.body);
  if (!parsed.success)
    return {
      effect: "unknown",
      recovery,
      result: invalid("ticket relationship/status write"),
    };
  return {
    effect: "applied",
    recovery,
    result: {
      ok: true,
      data: mutationReceipt(
        parsed.data,
        identifier(target),
        app.globals.server,
      ),
    },
  };
}
function mutationText(data: import("cli-for-agents").JsonData<MutationData>) {
  if ("relationship" in data)
    return `relationship ${data.relationship.id} ${data.relationship.role} — ${data.relationship.otherTicket}\n${data.relationship.descriptionPreview}\nget: ${data.relationship.getCommand}`;
  if ("relationshipId" in data)
    return `removed relationship ${data.relationshipId}`;
  return `added status update ${data.update.id}\n${data.update.bodyPreview}\nget: ${data.update.getCommand}`;
}
export const relationAddHandler: Write<typeof ticketSpecs.relationAdd> = {
  run: writeRunner<
    Input<typeof ticketSpecs.relationAdd>,
    MutationData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const source = await resolveTicket(app, ctx.args.ticket);
      if (!source.ok) return { effect: "not_applied", result: source };
      const target = await resolveTicket(app, ctx.args.other);
      if (!target.ok) return { effect: "not_applied", result: target };
      return writeRelation(
        app,
        source.value,
        "POST",
        relationPath(source.value),
        ticketRelationshipMutationResponseSchema,
        {
          target: {
            projectName: target.value.projectName,
            number: target.value.number,
          },
          role: ctx.flags.role,
          ...(ctx.flags.description === undefined
            ? {}
            : { description: ctx.flags.description }),
        },
      );
    },
    text: mutationText,
  }),
};
export const relationUpdateHandler: Write<typeof ticketSpecs.relationUpdate> = {
  run: writeRunner<
    Input<typeof ticketSpecs.relationUpdate>,
    MutationData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return writeRelation(
        app,
        resolved.value,
        "PATCH",
        relationPath(resolved.value, ctx.args["relationship-id"]),
        ticketRelationshipMutationResponseSchema,
        { description: ctx.flags.description },
      );
    },
    text: mutationText,
  }),
};
export const relationRemoveHandler: Write<typeof ticketSpecs.relationRemove> = {
  run: writeRunner<
    Input<typeof ticketSpecs.relationRemove>,
    MutationData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      return writeRelation(
        app,
        resolved.value,
        "DELETE",
        relationPath(resolved.value, ctx.args["relationship-id"]),
        ticketRelationshipDeleteResponseSchema,
      );
    },
    text: mutationText,
  }),
};
export const statusAddHandler: Write<typeof ticketSpecs.statusAdd> = {
  run: writeRunner<
    Input<typeof ticketSpecs.statusAdd>,
    MutationData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (app.globals.conversation !== undefined)
        return {
          effect: "not_applied",
          result: usage(
            "Status update provenance comes only from CC_CONVERSATION_ID; --conversation is not accepted.",
          ),
        };
      if (ctx.flags.body.trim() === "")
        return {
          effect: "not_applied",
          result: usage("Status update body must be non-empty."),
        };
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const conversation = app.env.CC_CONVERSATION_ID?.trim();
      if (resolved.value.token !== null && !conversation)
        return {
          effect: "not_applied",
          result: usage(
            "Authenticated status updates require CC_CONVERSATION_ID for durable provenance.",
          ),
        };
      return writeRelation(
        app,
        resolved.value,
        "POST",
        statusPath(resolved.value),
        ticketStatusUpdateCreateResponseSchema,
        { bodyMarkdown: ctx.flags.body },
        conversation ? { "x-cc-conversation-id": conversation } : undefined,
      );
    },
    text: mutationText,
  }),
};
export const statusListHandler: Read<typeof ticketSpecs.statusList> = {
  run: runner<
    Input<typeof ticketSpecs.statusList>,
    {
      updates: readonly TicketStatusUpdateOutline[];
      omission: Omission;
      nextCursor: string | null;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (!validCursor(ctx.flags.cursor))
        return usage("Use the opaque cursor returned by the preceding page.");
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams({ limit: String(ctx.flags.limit) });
      if (ctx.flags.cursor) query.set("cursor", ctx.flags.cursor);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${statusPath(resolved.value)}?${query}`,
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = ticketStatusUpdatePageSchema.safeParse(response.body);
      if (
        !parsed.success ||
        parsed.data.items.length > ctx.flags.limit ||
        (parsed.data.nextCursor !== null &&
          parsed.data.total <= parsed.data.items.length)
      )
        return invalid("status update page");
      const { items, total, nextCursor } = parsed.data;
      const source = {
        items: items.map((item) =>
          buildStatusUpdateOutline(
            item,
            identifier(resolved.value),
            app.globals.server,
          ),
        ),
        total: { kind: "known", count: count(total) } as const,
      };
      const bounded = page(
        nextCursor === null
          ? { ...source, more: false }
          : {
              ...source,
              more: true,
              reveal: invocation(statusListCommand, {
                args: { ticket: identifier(resolved.value) },
                flags: {
                  ...explicitScopeFlags(app),
                  ...ctx.flags,
                  cursor: nextCursor,
                },
              }),
            },
      );
      return {
        ok: true,
        data: {
          updates: bounded.items,
          omission: bounded.omission,
          nextCursor,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ updates, omission, revealCommand }) =>
      [
        `status updates: ${omission.total.kind === "known" ? omission.total.count : "unknown"} total, ${omission.returned} shown`,
        ...(revealCommand ? [`next: ${revealCommand}`] : []),
        ...updates.flatMap((item) => [
          `${item.id} ${item.createdAt} ${item.authorLabel} (${item.backend ?? "user"}${item.conversationId ? `, conversation ${item.conversationId}` : ""}) — ${item.bodyPreview}`,
          `get: ${item.getCommand}`,
        ]),
      ].join("\n"),
  }),
};
export const statusGetHandler: Read<typeof ticketSpecs.statusGet> = {
  run: runner<
    Input<typeof ticketSpecs.statusGet>,
    { update: z.infer<typeof ticketStatusUpdateSchema>; ticket: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveTicket(app, ctx.args.ticket);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: statusPath(resolved.value, ctx.args["update-id"]),
      });
      if (response.kind !== "ok") return ticketFailure(response);
      const parsed = ticketStatusUpdateSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: { update: parsed.data, ticket: identifier(resolved.value) },
          }
        : invalid("status update read");
    },
    text: ({ update, ticket }) =>
      renderStatusUpdateDetailText(
        ticketStatusUpdateSchema.parse(update),
        ticket,
      ),
  }),
};
