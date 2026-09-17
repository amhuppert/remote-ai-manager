import {
  mutation,
  recoveryFacts,
  writeRunner,
  type MutationHandler,
  type StandardSchema,
} from "cli-for-agents";
import { z } from "zod";
import {
  BATCH_WITHOUT_WORK_MESSAGE,
  batchCarriesWork,
  createAuthoringSpecInputSchema,
  createSpecInitialElementSchema,
  draftElementBatchDocumentSchema,
  draftElementDocumentSchema,
  type DraftElementInput,
  type DraftElementBatchRemoval,
} from "@/lib/specs/authoring-service";
import { draftHealth } from "@/lib/specs/draft-health";
import {
  specElementSchema,
  specElementVersionSchema,
  specRevisionSchema,
  specSchema,
} from "@/lib/specs/schemas";
import { specLintViewSchema } from "@/lib/specs/view-schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import { encodePathSegment } from "../../transport";
import type * as S from "./native-write-definitions";
import {
  actionPath,
  bareHandle,
  currentRevision,
  postValue,
  readEditContext,
  readValue,
  refused,
  resolveWrite,
  scalar,
  specPath,
  specRecovery,
  statusHint,
  usage,
  type WriteContext,
} from "./native-write-support";

const savedSchema = z
  .object({
    element: specElementSchema,
    version: specElementVersionSchema,
    revived: z.boolean().optional(),
    handle: z.string().min(1).nullable().optional(),
  })
  .strict();
const createdSchema = savedSchema
  .extend({ spec: specSchema, draft: specRevisionSchema })
  .strict();
const batchSchema = z
  .object({
    revisionId: z.string().min(1),
    written: z.array(
      savedSchema.extend({
        index: z.number().int().nonnegative(),
        elementId: z.string().min(1),
      }),
    ),
  })
  .strict();
const createFlagsSchema = createAuthoringSpecInputSchema.omit({
  projectPath: true,
  actor: true,
  initialElement: true,
});
type Create = MutationHandler<
  typeof S.specCreateSpec,
  CcApplication,
  WriteContext,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  z.infer<typeof createSpecInitialElementSchema>
>;
const create: Create = {
  decode: createSpecInitialElementSchema,
  async prepare({ app, ctx }) {
    const parsed = createFlagsSchema.safeParse({
      slug: ctx.flags.slug,
      name: ctx.flags.name,
      gatePolicy: { preset: ctx.flags.preset },
    });
    if (!parsed.success)
      return usage(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    return resolveWrite(app, ctx.flags.slug);
  },
  commit: writeRunner<
    Parameters<Create["commit"]>[0],
    z.infer<typeof createdSchema>,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const context = prepared.value;
      const response = await postValue(
        app,
        context,
        `/api/specs/${encodePathSegment(context.project)}/actions/create`,
        {
          slug: ctx.flags.slug,
          name: ctx.flags.name,
          gatePolicy: { preset: ctx.flags.preset },
          initialElement: payload,
        },
        createdSchema,
        specRecovery(ctx.flags.slug),
      );
      if (!response.ok) return response.report;
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "spec", id: response.value.spec.id },
          { kind: "spec-revision", id: response.value.draft.id },
          { kind: "spec-element", id: response.value.element.id },
        ]),
        result: {
          ok: true,
          data: response.value,
          hint: statusHint(app, ctx.flags.slug),
        },
      };
    },
  }),
};
export const createHandler = mutation(create);

type DraftPayload =
  | { kind: "single"; element: DraftElementInput }
  | {
      kind: "batch";
      elements: DraftElementInput[];
      removals: DraftElementBatchRemoval[];
    };
const keyedSchema = draftElementBatchDocumentSchema.refine(batchCarriesWork, {
  message: BATCH_WITHOUT_WORK_MESSAGE,
  path: ["elements"],
});
const decode: StandardSchema<DraftPayload> = {
  "~standard": {
    version: 1,
    vendor: "command-center",
    validate(value) {
      if (Array.isArray(value)) {
        const parsed = z
          .array(draftElementDocumentSchema)
          .min(1)
          .safeParse(value);
        return parsed.success
          ? { value: { kind: "batch", elements: parsed.data, removals: [] } }
          : { issues: parsed.error.issues };
      }
      if (
        typeof value === "object" &&
        value !== null &&
        ("elements" in value || "removals" in value)
      ) {
        const parsed = keyedSchema.safeParse(value);
        return parsed.success
          ? { value: { kind: "batch", ...parsed.data } }
          : { issues: parsed.error.issues };
      }
      const parsed = draftElementDocumentSchema.safeParse(value);
      return parsed.success
        ? { value: { kind: "single", element: parsed.data } }
        : { issues: parsed.error.issues };
    },
  },
};

type DraftPrepared = {
  context: WriteContext;
  revisionId: string;
  blockingBefore?: number;
};
type Saved = z.infer<typeof savedSchema> & { index?: number };
type DraftData = {
  revisionId: string;
  written: Array<
    | Saved
    | {
        index?: number;
        elementId: string;
        elementVersion: number;
        handle?: string | null;
      }
  >;
  removals: DraftElementBatchRemoval[];
  lint?: { blockingBefore: number; blockingAfter: number };
};
async function blocking(
  app: CcApplication,
  context: WriteContext,
  slug: string,
): Promise<number | undefined> {
  const response = await readValue(
    app,
    context,
    `${specPath(context, slug)}/lint`,
    specLintViewSchema,
  );
  return response.ok
    ? draftHealth(response.value.findings).blocking
    : undefined;
}
function writtenData(
  written: Saved[],
  quiet: boolean | undefined,
): DraftData["written"] {
  return quiet
    ? written.map((item) => ({
        ...(item.index === undefined ? {} : { index: item.index }),
        elementId: item.element.id,
        elementVersion: item.version.elementVersion,
        ...(item.handle === undefined ? {} : { handle: item.handle }),
      }))
    : written;
}
type Draft = MutationHandler<
  typeof S.specDraftSpec,
  CcApplication,
  DraftPrepared,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  DraftPayload
>;
const draft: Draft = {
  decode,
  async prepare({ app, ctx }) {
    const resolved = await resolveWrite(app, ctx.args.slug);
    if (!resolved.ok) return resolved;
    const edit = await readEditContext(app, resolved.value, ctx.args.slug);
    if (!edit.ok) return edit;
    const revision = currentRevision(edit.value);
    if (!revision.ok) return revision;
    const before = await blocking(app, resolved.value, ctx.args.slug);
    return {
      ok: true,
      value: {
        context: resolved.value,
        revisionId: revision.value,
        ...(before === undefined ? {} : { blockingBefore: before }),
      },
    };
  },
  commit: writeRunner<Parameters<Draft["commit"]>[0], DraftData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const { context, revisionId, blockingBefore } = prepared.value;
      const recovery = recoveryFacts([
        { kind: "spec-revision", id: revisionId },
      ]);
      let written: Saved[];
      const removals = payload.kind === "batch" ? payload.removals : [];
      if (payload.kind === "single") {
        const response = await postValue(
          app,
          context,
          actionPath(context, ctx.args.slug, "draft-upsert"),
          { revisionId, ...payload.element },
          savedSchema,
          recovery,
        );
        if (!response.ok) return response.report;
        written = [response.value];
      } else {
        const response = await postValue(
          app,
          context,
          actionPath(context, ctx.args.slug, "draft-batch"),
          {
            revisionId,
            elements: payload.elements,
            ...(removals.length ? { removals } : {}),
          },
          batchSchema,
          recovery,
        );
        if (!response.ok) return response.report;
        written = response.value.written;
      }
      const after = await blocking(app, context, ctx.args.slug);
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: {
            revisionId,
            written: writtenData(written, ctx.flags.quiet),
            removals,
            ...(blockingBefore === undefined || after === undefined
              ? {}
              : { lint: { blockingBefore, blockingAfter: after } }),
          },
          hint: statusHint(app, ctx.args.slug),
        },
      };
    },
  }),
};
export const draftHandler = mutation(draft);

export const removeHandler = scalar<
  typeof S.specRemoveSpec,
  {
    revisionId: string;
    removed: Array<DraftElementBatchRemoval & { handle: string }>;
  }
>(async ({ app, ctx }) => {
  if (!ctx.args.handles.length)
    return {
      effect: "not_applied",
      result: usage("Remove requires at least one content handle."),
    };
  const handles: string[] = [];
  for (const raw of ctx.args.handles) {
    const handle = bareHandle(raw, ctx.args.slug, "content");
    if (!handle.ok) return { effect: "not_applied", result: handle };
    if (handles.includes(handle.value))
      return {
        effect: "not_applied",
        result: usage(`Duplicate removal handle ${handle.value}.`),
      };
    handles.push(handle.value);
  }
  const resolved = await resolveWrite(app, ctx.args.slug);
  if (!resolved.ok) return { effect: "not_applied", result: resolved };
  let revisionId: string | undefined;
  const removed: Array<DraftElementBatchRemoval & { handle: string }> = [];
  for (const handle of handles) {
    const edit = await readEditContext(
      app,
      resolved.value,
      ctx.args.slug,
      handle,
    );
    if (!edit.ok) return { effect: "not_applied", result: edit };
    const revision = currentRevision(edit.value);
    if (!revision.ok) return { effect: "not_applied", result: revision };
    if (revisionId !== undefined && revisionId !== revision.value)
      return {
        effect: "not_applied",
        result: refused(
          "The current revision changed during removal lookup; read the handles again before retrying.",
        ),
      };
    revisionId = revision.value;
    if (!edit.value.element)
      return {
        effect: "not_applied",
        result: refused(`The current revision does not contain ${handle}.`),
      };
    removed.push({
      handle,
      elementId: edit.value.element.elementId,
      baseElementVersion: edit.value.element.elementVersion,
    });
  }
  if (revisionId === undefined)
    return {
      effect: "not_applied",
      result: usage("Remove requires at least one content handle."),
    };
  const recovery = recoveryFacts([{ kind: "spec-revision", id: revisionId }]);
  const response = await postValue(
    app,
    resolved.value,
    actionPath(resolved.value, ctx.args.slug, "draft-batch"),
    {
      revisionId,
      elements: [],
      removals: removed.map(({ elementId, baseElementVersion }) => ({
        elementId,
        baseElementVersion,
      })),
    },
    batchSchema,
    recovery,
  );
  return response.ok
    ? {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: { revisionId, removed },
          hint: statusHint(app, ctx.args.slug),
        },
      }
    : response.report;
});
