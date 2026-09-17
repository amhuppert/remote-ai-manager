import {
  runner,
  type CommandSpec,
  type HandlerInput,
  type ReadHandler,
  type Result,
  type JsonValue,
} from "cli-for-agents";
import { z } from "zod";
import { draftHealth } from "@/lib/specs/draft-health";
import { formatElementHandle, parseElementHandle } from "@/lib/specs/handles";
import { specMeasuresReportSchema } from "@/lib/specs/measures";
import {
  specCommentsViewSchema,
  specCommentViewSchema,
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specLintViewSchema,
  specProjectSearchViewSchema,
  specSearchViewSchema,
  specSectionViewSchema,
} from "@/lib/specs/view-schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { encodePathSegment } from "../../transport";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import type {
  specCommentsSpec,
  specGetSpec,
  specLintSpec,
  specListSpec,
  specMeasuresSpec,
  specSearchSpec,
  specSectionGetSpec,
} from "./native-definitions";
import { readSpecJson, specPath } from "./native-request";

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

export const listHandler: Read<typeof specListSpec> = {
  run: runner<
    Input<typeof specListSpec>,
    z.infer<typeof specInventoryViewSchema>,
    CcErrorCode
  >({
    run: ({ app }) =>
      readSpecJson(
        app,
        (context) => `/api/specs/${encodePathSegment(context.project)}`,
        specInventoryViewSchema,
      ),
    text: ({ specs }) =>
      specs.length
        ? `${specs.map((item) => `${item.spec.slug}  ${item.phase.primary}  ${item.spec.name}`).join("\n")}\n`
        : "no specs\n",
  }),
};

export const measuresHandler: Read<typeof specMeasuresSpec> = {
  run: runner({
    run: ({ app }: Input<typeof specMeasuresSpec>) =>
      readSpecJson(
        app,
        (context) =>
          `/api/projects/${encodePathSegment(context.project)}/spec-measures`,
        specMeasuresReportSchema,
      ),
  }),
};

const jsonValue = z.json().transform((value): JsonValue => value);
const commentSchema = specCommentsViewSchema.extend({
  comments: z.array(specCommentViewSchema.extend({ anchor: jsonValue })),
});

export const commentsHandler: Read<typeof specCommentsSpec> = {
  run: runner<
    Input<typeof specCommentsSpec>,
    z.infer<typeof commentSchema>,
    CcErrorCode
  >({
    run: ({ app, ctx }) => {
      const query = new URLSearchParams();
      if (ctx.flags.element !== undefined)
        query.set("element", ctx.flags.element);
      if (ctx.flags.open) query.set("open", "true");
      return readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, ctx.args.slug)}/comments${query.size ? `?${query}` : ""}`,
        commentSchema,
        ctx.args.slug,
      );
    },
  }),
};

export const lintHandler: Read<typeof specLintSpec> = {
  run: runner({
    async run({ app, ctx }: Input<typeof specLintSpec>) {
      const response = await readSpecJson(
        app,
        (context) => `${specPath(context.project, ctx.args.slug)}/lint`,
        specLintViewSchema,
        ctx.args.slug,
      );
      if (!response.ok) return response;
      const health = draftHealth(response.data.findings);
      return {
        ok: true,
        data: {
          lint: {
            revisionId: response.data.revisionId,
            total: health.total,
            blocking: health.blocking,
            counts: health.counts,
            groups: health.groups,
          },
        },
      } as const;
    },
  }),
};

function revisionQuery(revision: string | undefined): string {
  return revision === undefined
    ? ""
    : `?${new URLSearchParams({ [/^\d+$/.test(revision) ? "revisionNumber" : "revisionId"]: revision })}`;
}

export const getHandler: Read<typeof specGetSpec> = {
  run: runner({
    async run({ app, ctx }: Input<typeof specGetSpec>) {
      let target;
      try {
        target = parseElementHandle(
          ctx.args.handle ?? ctx.args.target,
          ctx.args.handle === undefined ? undefined : ctx.args.target,
        );
      } catch (error) {
        return {
          ok: false,
          error: ccErrors.error("CC_USAGE", {
            message: "The spec element handle is invalid.",
            details: { cause: getErrorMessage(error) },
          }),
        } as const;
      }
      const response = await readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, target.slug)}/elements/${encodePathSegment(formatElementHandle(target, "bare"))}${revisionQuery(ctx.flags.revision)}`,
        specElementGetResponseSchema,
        target.slug,
      );
      if (!response.ok) return response;
      const view = response.data;
      const identity =
        "element" in view && "version" in view.element
          ? {
              elementId: view.element.element.id,
              kind: view.element.element.kind,
              elementVersion: view.element.version.elementVersion,
            }
          : {};
      return { ok: true, data: { element: view, ...identity } } as const;
    },
  }),
};

export const sectionGetHandler: Read<typeof specSectionGetSpec> = {
  run: runner({
    async run({ app, ctx }: Input<typeof specSectionGetSpec>) {
      const response = await readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, ctx.args.slug)}/sections/${encodePathSegment(ctx.flags.id)}${revisionQuery(ctx.flags.revision)}`,
        specSectionViewSchema,
        ctx.args.slug,
      );
      return response.ok
        ? ({ ok: true, data: { section: response.data } } as const)
        : response;
    },
  }),
};

type SearchData =
  | { scope: "project"; search: z.infer<typeof specProjectSearchViewSchema> }
  | { scope: "spec"; search: z.infer<typeof specSearchViewSchema> };
export const searchHandler: Read<typeof specSearchSpec> = {
  run: runner<Input<typeof specSearchSpec>, SearchData, CcErrorCode>({
    async run({ app, ctx }): Promise<Result<SearchData, CcErrorCode>> {
      const { target, query } = ctx.args;
      if (ctx.flags.all) {
        if (query !== undefined)
          return {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: "spec search --all takes one query argument.",
            }),
          };
        const response = await readSpecJson(
          app,
          (context) =>
            `/api/specs/${encodePathSegment(context.project)}/-/search?${new URLSearchParams({ q: target.trim() })}`,
          specProjectSearchViewSchema,
        );
        return response.ok
          ? { ok: true, data: { scope: "project", search: response.data } }
          : response;
      }
      if (query === undefined || query.trim().length === 0)
        return {
          ok: false,
          error: ccErrors.error("CC_USAGE", {
            message: "spec search requires <slug> <query>, or --all <query>.",
          }),
        };
      const response = await readSpecJson(
        app,
        (context) =>
          `${specPath(context.project, target)}/search?${new URLSearchParams({ q: query.trim() })}`,
        specSearchViewSchema,
        target,
      );
      return response.ok
        ? { ok: true, data: { scope: "spec", search: response.data } }
        : response;
    },
  }),
};
