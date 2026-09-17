import { explicitScopeFlags } from "../../framework/context";
import { quoteLiteralText } from "../../framework/literal-text";
import {
  binaryArtifact,
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
  JsonData,
  Omission,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import {
  listNativeMemoryExceptions,
  renderNativeMemoryDisclosureLine,
  type NativeMemoryException,
} from "@/lib/agent-backends/native-memory";
import { renderMemoryArtifactHandle } from "@/lib/memory/artifact-handles";
import type { MemoryNote, MemoryReviewQueueEntry } from "@/lib/memory/schemas";
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
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import {
  memoryListCommand,
  memoryReviewCommand,
  memoryGetCommand,
  memoryUpdateCommand,
  memoryLinkCommand,
  memoryUnlinkCommand,
  memoryMarkReviewedCommand,
  memoryArchiveCommand,
  memoryDeleteCommand,
  memoryObserveRederivationCommand,
  memorySpecs,
} from "./definitions";
import * as responses from "./responses";
import { memoryFailure, type MemoryRecovery } from "./failure";

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
type VisibleNote = JsonData<MemoryNote>;
const notePath = (slug: string, suffix = "") =>
  `/api/memory/notes/${encodePathSegment(slug)}${suffix}`;
function scoped(path: string, scope: string | undefined) {
  return scope === undefined
    ? path
    : `${path}?scope=${encodeURIComponent(scope)}`;
}
function invalid(what: string) {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message: `The ${what} response is invalid.`,
    }),
  } as const;
}
function usage(message: string) {
  return { ok: false, error: ccErrors.error("CC_USAGE", { message }) } as const;
}
function noteRow(note: VisibleNote) {
  return `${note.slug} [${note.scope}/${note.kind}/${note.lifecycle}] rev ${note.revision} — ${note.hook}`;
}
function noteText(note: VisibleNote) {
  return [
    noteRow(note),
    `index-mode: ${note.indexMode}  updated: ${note.updatedAt}`,
    ...(note.aliases.length ? [`aliases: ${note.aliases.join(", ")}`] : []),
    ...(note.statusNote
      ? [
          `status: ${note.statusNote.text} (as of ${note.statusNote.updatedAt}; review after ${note.statusNote.reviewAfter})`,
        ]
      : []),
    ...(note.reviewAfter ? [`review after: ${note.reviewAfter}`] : []),
    ...(note.expiresAt ? [`expires: ${note.expiresAt}`] : []),
    ...(note.body ? ["", note.body] : []),
  ].join("\n");
}
function omissionText(
  label: string,
  omission: Pick<Omission, "total" | "returned">,
  reveal: string | null,
) {
  return `${label}: ${omission.total.kind === "known" ? omission.total.count : "unknown"} total, ${omission.returned} shown${reveal === null ? "" : `\nnext: ${reveal}`}`;
}

export const recallHandler: Read<typeof memorySpecs.recall> = {
  run: runner<
    Input<typeof memorySpecs.recall>,
    z.infer<typeof responses.recallResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: "/api/memory/recall",
        headers: { "x-cc-conversation-id": resolved.value.conversation },
        body: {
          ...(ctx.args.query ? { query: ctx.args.query } : {}),
          ...(ctx.flags.related ? { related: ctx.flags.related } : {}),
          ...(ctx.flags.scope ? { scope: ctx.flags.scope } : {}),
          ...(ctx.flags.budget === undefined
            ? {}
            : { budgetChars: ctx.flags.budget }),
        },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = responses.recallResponseSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalid("memory recall");
    },
    text: ({ pack }) => quoteLiteralText(pack.text),
  }),
};
export const indexHandler: Read<typeof memorySpecs.index> = {
  run: runner<
    Input<typeof memorySpecs.index>,
    z.infer<typeof responses.indexResponseSchema> & {
      nativeMemoryExceptions: readonly NativeMemoryException[];
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      if (app.globals.session !== undefined)
        return usage(
          "memory index previews a conversation's delivery; pass --conversation instead of --session.",
        );
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams({
        conversation: resolved.value.conversation,
      });
      if (ctx.flags.full) query.set("full", "true");
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `/api/memory/index?${query}`,
        headers: { "x-cc-conversation-id": resolved.value.conversation },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = responses.indexResponseSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: {
              ...parsed.data,
              nativeMemoryExceptions: listNativeMemoryExceptions(
                listBackendCatalogEntries(),
              ),
            },
          }
        : invalid("memory index");
    },
    text: ({ block, nativeMemoryExceptions }) =>
      quoteLiteralText(
        [
          renderNativeMemoryDisclosureLine(nativeMemoryExceptions),
          block?.text ?? "No memory delivery is due for this conversation.",
        ]
          .filter((line) => line !== null)
          .join("\n"),
      ),
  }),
};
export const listHandler: Read<typeof memorySpecs.list> = {
  run: runner<
    Input<typeof memorySpecs.list>,
    {
      notes: readonly MemoryNote[];
      omission: Omission;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams();
      if (ctx.flags.scope) query.set("scope", ctx.flags.scope);
      if (ctx.flags.lifecycle) query.set("lifecycle", ctx.flags.lifecycle);
      if (ctx.flags.archived) query.set("archived", "true");
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `/api/memory/notes${query.size ? `?${query}` : ""}`,
        headers: { "x-cc-conversation-id": resolved.value.conversation },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = responses.noteListResponseSchema.safeParse(response.body);
      if (!parsed.success) return invalid("memory list");
      const notes = parsed.data.notes;
      const source = {
        items: notes.slice(0, ctx.flags.limit),
        total: { kind: "known", count: count(notes.length) } as const,
      };
      const bounded = page(
        notes.length > ctx.flags.limit
          ? {
              ...source,
              more: true,
              reveal: invocation(memoryListCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  ...ctx.flags,
                  conversation: resolved.value.conversation,
                  project: resolved.value.project,
                  limit: notes.length,
                },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          notes: bounded.items,
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ notes, omission, revealCommand }) =>
      quoteLiteralText(
        [
          omissionText("notes", omission, revealCommand),
          ...notes.map(noteRow),
        ].join("\n"),
      ),
  }),
};
export const getHandler: Read<typeof memorySpecs.get> = {
  run: runner<
    Input<typeof memorySpecs.get>,
    z.infer<typeof responses.noteDetailResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams();
      if (ctx.flags.scope) query.set("scope", ctx.flags.scope);
      if (ctx.flags.archived) query.set("archived", "true");
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${notePath(ctx.args.slug)}${query.size ? `?${query}` : ""}`,
        headers: { "x-cc-conversation-id": resolved.value.conversation },
      });
      if (response.kind !== "ok")
        return memoryFailure(
          response,
          (slug, scope) =>
            invocation(memoryGetCommand, {
              args: { slug },
              flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
            }),
          explicitScopeFlags(app),
        );
      const parsed = responses.noteDetailResponseSchema.safeParse(
        response.body,
      );
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalid("memory note");
    },
    text: ({ note, links, lineage }) =>
      quoteLiteralText(
        [
          noteText(note),
          ...links.map(
            (link) =>
              `${link.kind}: ${renderMemoryArtifactHandle(link.artifact)}`,
          ),
          ...(lineage.supersedes ? [`supersedes: ${lineage.supersedes}`] : []),
          ...(lineage.supersededBy
            ? [`superseded by: ${lineage.supersededBy}`]
            : []),
        ].join("\n"),
      ),
  }),
};

type MutationSchema =
  | typeof responses.noteResponseSchema
  | typeof responses.createResponseSchema
  | typeof responses.linkResponseSchema
  | typeof responses.reviewedResponseSchema
  | typeof responses.promoteResponseSchema;
type MutationData = z.infer<MutationSchema>;
async function writeMemory(
  app: CcApplication,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body: Record<string, unknown> | undefined,
  schema: MutationSchema,
  recover?: MemoryRecovery,
): Promise<CommitReport<MutationData, CcErrorCode>> {
  const resolved = await resolveCcProjectConversation(app);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  const recovery = recoveryFacts([
    { kind: "conversation", id: resolved.value.conversation },
  ]);
  const response = await cliRequest(app.host, {
    ...resolved.value,
    method,
    path,
    headers: { "x-cc-conversation-id": resolved.value.conversation },
    ...(body === undefined ? {} : { body }),
  });
  if (response.kind !== "ok")
    return {
      ...ccWriteFailure(response, recovery),
      result: memoryFailure(response, recover, explicitScopeFlags(app)),
    };
  const parsed = schema.safeParse(response.body);
  if (!parsed.success)
    return {
      effect: "unknown",
      recovery,
      result: invalid("memory write; inspect the note before retrying"),
    };
  const note = "note" in parsed.data ? parsed.data.note : parsed.data.promoted;
  return {
    effect: "applied",
    recovery: recoveryFacts([
      { kind: "memory", id: `${note.scope}:${note.slug}` },
    ]),
    result: { ok: true, data: parsed.data },
  };
}
function mutationText(data: JsonData<MutationData>) {
  const note = "note" in data ? data.note : data.promoted;
  return [
    noteText(note),
    ...(note.lifecycle === "proposed"
      ? ["Global proposal awaits human approval in the Memory Library."]
      : []),
    ...("advisories" in data
      ? [
          ...data.advisories.overlapCandidates.map(
            (candidate) =>
              `overlap: ${candidate.slug} [${candidate.scope}] — ${candidate.hook}`,
          ),
          ...data.advisories.hookWarnings.map(
            (warning) => `${warning.code}: ${warning.message}`,
          ),
        ]
      : []),
    ...("link" in data
      ? [`${data.link.kind}: ${renderMemoryArtifactHandle(data.link.artifact)}`]
      : []),
    ...("statusReLease" in data && data.statusReLease
      ? [
          `status re-leased: ${data.statusReLease.text}; as of ${data.statusReLease.updatedAt}; review after ${data.statusReLease.reviewAfter}`,
        ]
      : []),
    ...("superseded" in data ? [`supersedes: ${data.superseded.slug}`] : []),
  ].join("\n");
}
type EditFlags = {
  readonly hook?: string;
  readonly body?: string;
  readonly slug?: string;
  readonly alias?: readonly string[];
  readonly "status-note"?: string;
  readonly "index-mode"?: string;
  readonly "review-after"?: string;
  readonly "expires-at"?: string;
};
function editBody(flags: EditFlags): Record<string, unknown> {
  return {
    ...(flags.hook === undefined ? {} : { hook: flags.hook }),
    ...(flags.body === undefined ? {} : { body: flags.body }),
    ...(flags.slug === undefined ? {} : { slug: flags.slug }),
    ...(flags.alias?.length ? { aliases: [...flags.alias] } : {}),
    ...(flags["status-note"] === undefined
      ? {}
      : {
          statusNote:
            flags["status-note"] === "none" ? null : flags["status-note"],
        }),
    ...(flags["index-mode"] === undefined
      ? {}
      : { indexMode: flags["index-mode"] }),
    ...(flags["review-after"] === undefined
      ? {}
      : {
          reviewAfter:
            flags["review-after"] === "none" ? null : flags["review-after"],
        }),
    ...(flags["expires-at"] === undefined
      ? {}
      : {
          expiresAt:
            flags["expires-at"] === "none" ? null : flags["expires-at"],
        }),
  };
}
export const createHandler: Write<typeof memorySpecs.create> = {
  run: writeRunner<Input<typeof memorySpecs.create>, MutationData, CcErrorCode>(
    {
      run: ({ app, ctx }) =>
        writeMemory(
          app,
          "POST",
          "/api/memory/notes",
          {
            scope: ctx.flags.scope ?? "project",
            kind: ctx.flags.kind ?? "lesson",
            ...editBody(ctx.flags),
            ...(ctx.flags.supersedes === undefined
              ? {}
              : { supersedes: ctx.flags.supersedes }),
          },
          responses.createResponseSchema,
        ),
      text: (data) => quoteLiteralText(mutationText(data)),
    },
  ),
};
function updateRecovery(
  ctx: Input<typeof memorySpecs.update>["ctx"],
  slug: string,
  scope: "global" | "project" | "session",
) {
  const { hook, body, "status-note": statusNote, ...rest } = ctx.flags;
  const fileFor = (name: string) =>
    ctx.inputFiles.find(
      (source) =>
        source.kind === "flag" && source.name === name && source.path !== "-",
    )?.path;
  const hookFile = fileFor("hook");
  const bodyFile = fileFor("body");
  const statusFile = fileFor("status-note");
  const inlineHook: { hook: string } | { hook?: never } =
    hook === undefined ? {} : { hook };
  const inlineBody: { body: string } | { body?: never } =
    body === undefined ? {} : { body };
  const inlineStatus: { "status-note": string } | { "status-note"?: never } =
    statusNote === undefined ? {} : { "status-note": statusNote };
  const flags = {
    ...rest,
    ...(hookFile === undefined ? inlineHook : { "hook-file": hookFile }),
    ...(bodyFile === undefined ? inlineBody : { "body-file": bodyFile }),
    ...(statusFile === undefined
      ? inlineStatus
      : { "status-note-file": statusFile }),
    scope,
  };
  // Native invocation tokens cannot embed terminal controls; inline multiline
  // prose needs the original request repeated with scope instead of a new token.
  if (
    Object.values(flags).some((value) =>
      (Array.isArray(value) ? value : [value]).some(
        (part) => typeof part === "string" && /[\p{Cc}\p{Cs}]/u.test(part),
      ),
    )
  )
    return null;
  return invocation(memoryUpdateCommand, {
    args: { slug },
    flags: { ...explicitScopeFlags(ctx), ...flags },
  });
}
export const updateHandler: Write<typeof memorySpecs.update> = {
  run: writeRunner<Input<typeof memorySpecs.update>, MutationData, CcErrorCode>(
    {
      async run({ app, ctx }) {
        const body = editBody(ctx.flags);
        if (Object.keys(body).length === 0)
          return {
            effect: "not_applied",
            result: usage("Supply at least one field to update."),
          };
        return writeMemory(
          app,
          "PATCH",
          scoped(notePath(ctx.args.slug), ctx.flags.scope),
          { baseRevision: ctx.flags["if-revision"], ...body },
          responses.noteResponseSchema,
          (slug, scope) => updateRecovery(ctx, slug, scope),
        );
      },
      text: (data) => quoteLiteralText(mutationText(data)),
    },
  ),
};
export const linkHandler: Write<typeof memorySpecs.link> = {
  run: writeRunner<Input<typeof memorySpecs.link>, MutationData, CcErrorCode>({
    run: ({ app, ctx }) =>
      writeMemory(
        app,
        "POST",
        scoped(notePath(ctx.args.slug, "/links"), ctx.flags.scope),
        { artifact: ctx.flags.artifact, kind: ctx.flags.kind },
        responses.linkResponseSchema,
        (slug, scope) =>
          invocation(memoryLinkCommand, {
            args: { slug },
            flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
          }),
      ),
    text: (data) => quoteLiteralText(mutationText(data)),
  }),
};
export const unlinkHandler: Write<typeof memorySpecs.unlink> = {
  run: writeRunner<Input<typeof memorySpecs.unlink>, MutationData, CcErrorCode>(
    {
      run: ({ app, ctx }) =>
        writeMemory(
          app,
          "DELETE",
          scoped(notePath(ctx.args.slug, "/links"), ctx.flags.scope),
          { artifact: ctx.flags.artifact, kind: ctx.flags.kind },
          responses.linkResponseSchema,
          (slug, scope) =>
            invocation(memoryUnlinkCommand, {
              args: { slug },
              flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
            }),
        ),
      text: (data) =>
        quoteLiteralText(`Unlinked artifact.\n${mutationText(data)}`),
    },
  ),
};
export const markReviewedHandler: Write<typeof memorySpecs.markReviewed> = {
  run: writeRunner<
    Input<typeof memorySpecs.markReviewed>,
    MutationData,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      writeMemory(
        app,
        "POST",
        scoped(notePath(ctx.args.slug, "/reviewed"), ctx.flags.scope),
        {
          target: ctx.flags.status ? "statusNote" : "note",
          ...(ctx.flags["if-revision"] === undefined
            ? {}
            : { baseRevision: ctx.flags["if-revision"] }),
        },
        responses.reviewedResponseSchema,
        (slug, scope) =>
          invocation(memoryMarkReviewedCommand, {
            args: { slug },
            flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
          }),
      ),
    text: (data) => quoteLiteralText(mutationText(data)),
  }),
};
export const promoteHandler: Write<typeof memorySpecs.promote> = {
  run: writeRunner<
    Input<typeof memorySpecs.promote>,
    MutationData,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      writeMemory(
        app,
        "POST",
        notePath(ctx.args.slug, "/promote"),
        {
          ...editBody(ctx.flags),
          ...(ctx.flags["if-revision"] === undefined
            ? {}
            : { baseRevision: ctx.flags["if-revision"] }),
        },
        responses.promoteResponseSchema,
      ),
    text: (data) => quoteLiteralText(mutationText(data)),
  }),
};
export const archiveHandler: Write<typeof memorySpecs.archive> = {
  run: writeRunner<
    Input<typeof memorySpecs.archive>,
    MutationData,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      writeMemory(
        app,
        "POST",
        scoped(notePath(ctx.args.slug, "/archive"), ctx.flags.scope),
        {
          ...(ctx.flags["if-revision"] === undefined
            ? {}
            : { baseRevision: ctx.flags["if-revision"] }),
        },
        responses.noteResponseSchema,
        (slug, scope) =>
          invocation(memoryArchiveCommand, {
            args: { slug },
            flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
          }),
      ),
    text: (data) => quoteLiteralText(mutationText(data)),
  }),
};
export const deleteHandler: Write<typeof memorySpecs.delete> = {
  run: writeRunner<Input<typeof memorySpecs.delete>, MutationData, CcErrorCode>(
    {
      async run({ app, ctx }) {
        if (!ctx.flags.confirm)
          return {
            effect: "not_applied",
            result: {
              ...usage("Permanent deletion requires --confirm."),
              hint: hint(
                invocation(memoryArchiveCommand, {
                  args: { slug: ctx.args.slug },
                  flags: {
                    ...explicitScopeFlags(app),
                    ...(ctx.flags.scope === undefined
                      ? {}
                      : { scope: ctx.flags.scope }),
                  },
                }),
                "Archive instead to retain history",
              ),
            },
          };
        return writeMemory(
          app,
          "DELETE",
          scoped(notePath(ctx.args.slug), ctx.flags.scope),
          undefined,
          responses.noteResponseSchema,
          (slug, scope) =>
            invocation(memoryDeleteCommand, {
              args: { slug },
              flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
            }),
        );
      },
      text: (data) => quoteLiteralText(mutationText(data)),
    },
  ),
};
export const observeRederivationHandler: Read<
  typeof memorySpecs.observeRederivation
> = {
  run: runner<
    Input<typeof memorySpecs.observeRederivation>,
    z.infer<typeof responses.rederivedResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: scoped(notePath(ctx.args.slug, "/rederived"), ctx.flags.scope),
        headers: { "x-cc-conversation-id": resolved.value.conversation },
        body: {
          ...(ctx.flags.artifact === undefined
            ? {}
            : { artifact: ctx.flags.artifact }),
        },
      });
      if (response.kind !== "ok")
        return memoryFailure(
          response,
          (slug, scope) =>
            invocation(memoryObserveRederivationCommand, {
              args: { slug },
              flags: { ...explicitScopeFlags(app), ...ctx.flags, scope },
            }),
          explicitScopeFlags(app),
        );
      const parsed = responses.rederivedResponseSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalid("memory rederivation");
    },
    text: ({ observed }) =>
      quoteLiteralText(
        `Recorded rederivation of ${observed.slug}${observed.executionId ? ` in execution ${observed.executionId}` : ""}${observed.contextId ? ` context ${observed.contextId}` : ""}.`,
      ),
  }),
};
export const reviewHandler: Read<typeof memorySpecs.review> = {
  run: runner<
    Input<typeof memorySpecs.review>,
    {
      entries: readonly (MemoryReviewQueueEntry & { reviewCommand: string })[];
      omission: Omission;
      revealCommand: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams();
      if (ctx.flags["project-candidates"])
        query.set("projectCandidates", "true");
      if (ctx.flags.promotable) query.set("promotionCandidates", "true");
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `/api/memory/review${query.size ? `?${query}` : ""}`,
        headers: { "x-cc-conversation-id": resolved.value.conversation },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = responses.reviewQueueResponseSchema.safeParse(
        response.body,
      );
      if (!parsed.success) return invalid("memory review queue");
      const entries = parsed.data.entries;
      const source = {
        items: entries.slice(0, ctx.flags.limit),
        total: { kind: "known", count: count(entries.length) } as const,
      };
      const bounded = page(
        entries.length > ctx.flags.limit
          ? {
              ...source,
              more: true,
              reveal: invocation(memoryReviewCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  ...ctx.flags,
                  project: resolved.value.project,
                  conversation: resolved.value.conversation,
                  limit: entries.length,
                },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          entries: bounded.items.map((entry) => ({
            ...entry,
            reviewCommand: renderInvocation(
              invocation(memoryMarkReviewedCommand, {
                args: { slug: entry.note.slug },
                flags: { ...explicitScopeFlags(app), scope: entry.note.scope },
              }),
              "cctl",
            ),
          })),
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ entries, omission, revealCommand }) =>
      quoteLiteralText(
        [
          omissionText("review entries", omission, revealCommand),
          ...entries.map(
            (entry) =>
              `${noteRow(entry.note)}\n  ${entry.reviewCommand}\n  ${[...entry.staleness.map((reason) => (reason.cause === "expiry" ? "expired" : `${reason.target} review due`)), ...(entry.promotionCandidate ? ["promotion candidate"] : [])].join(", ")}`,
          ),
        ].join("\n"),
      ),
  }),
};
export const exportHandler: Read<typeof memorySpecs.export> = {
  run: runner<
    Input<typeof memorySpecs.export>,
    { noteCount: number; generatedAt: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProjectConversation(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: scoped("/api/memory/export", ctx.flags.scope),
        headers: { "x-cc-conversation-id": resolved.value.conversation },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = responses.exportResponseSchema.safeParse(response.body);
      if (!parsed.success) return invalid("memory export");
      const { archive, noteCount, generatedAt } = parsed.data;
      return {
        ok: true,
        binary: binaryArtifact<{ noteCount: number; generatedAt: string }>({
          bytes: new TextEncoder().encode(archive),
          mediaType: "text/markdown",
          basename: "memory.md",
          summary: { noteCount, generatedAt },
        }),
      };
    },
    text: ({ noteCount, generatedAt }) =>
      quoteLiteralText(
        `Exported ${noteCount} notes; generated ${generatedAt}.`,
      ),
  }),
};
