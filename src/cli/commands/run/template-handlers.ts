import {
  count,
  invocation,
  type JsonData,
  mutation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
  type CommandSpec,
  type HandlerInput,
  type MutationHandler,
  type Omission,
  type ReadHandler,
  type WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import {
  runTemplateContentSchema,
  runTemplateDetailResponseSchema,
  runTemplateSavedResponseSchema,
  validateRunTemplate,
  type RunTemplateContent,
} from "@/lib/run-templates/document";
import {
  runTemplateDeletedResponseSchema,
  runTemplateLibrarySchema,
  type RunTemplateDiagnostic,
  type RunTemplateSummary,
} from "@/lib/run-templates/schemas";
import {
  runTemplateLaunchedResponseSchema,
  runTemplateParameterValuesSchema,
  type RunTemplateLaunchedResponse,
  type RunTemplateTier,
} from "@/lib/runs/schemas";
import { quoteLiteralText } from "../../framework/literal-text";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcProject,
  type CcContextResult,
  type CcErrorCode,
} from "../../framework/context";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import {
  cliRequest,
  encodePathSegment,
  type ProjectContext,
  type SessionContext,
} from "../../transport";
import { launchedText, postLaunch, prepareSession } from "./handlers";
import {
  runTemplateListCommand,
  runTemplateShowCommand,
  type runTemplateDeleteSpec,
  type runTemplateLaunchSpec,
  type runTemplateListSpec,
  type runTemplateSaveSpec,
  type runTemplateShowSpec,
} from "./template-definitions";

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
type Save = MutationHandler<
  typeof runTemplateSaveSpec,
  CcApplication,
  { context: ProjectContext },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  RunTemplateContent
>;

/** The file `run template launch` takes. */
const launchInputsSchema = z
  .object({
    parameters: runTemplateParameterValuesSchema,
    /** The revision the launching agent read; a template changed since is refused. */
    revision: z.number().int().min(1).optional(),
  })
  .strict();
type LaunchInputs = z.infer<typeof launchInputsSchema>;

type Launch = MutationHandler<
  typeof runTemplateLaunchSpec,
  CcApplication,
  { context: SessionContext },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  LaunchInputs
>;

const invalid = (message: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  }) as const;
const usage = (message: string) =>
  ({ ok: false, error: ccErrors.error("CC_USAGE", { message }) }) as const;

function libraryPath(context: ProjectContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/run-templates`;
}
function templatePath(
  context: ProjectContext,
  tier: RunTemplateTier,
  id: string,
): string {
  return `${libraryPath(context)}/${tier}/${encodePathSegment(id)}`;
}
const label = (tier: RunTemplateTier, id: string) => `${tier}:${id}`;

/** JSON safe to print and paste: separators and C1 controls escaped. */
function escapedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

type Held = RunTemplateSummary | RunTemplateDiagnostic;

/** Every template, readable or not, that uses `id` in either tier. */
async function templatesUsing(
  app: CcApplication,
  context: ProjectContext,
  id: string,
): Promise<CcContextResult<Held[]>> {
  const response = await cliRequest(app.host, {
    ...context,
    method: "GET",
    path: libraryPath(context),
  });
  if (response.kind !== "ok") return ccRequestFailure(response);
  const parsed = runTemplateLibrarySchema.safeParse(response.body);
  if (!parsed.success) return invalid("The run template library is invalid.");
  return {
    ok: true,
    value: [
      ...parsed.data.items.filter((item) => item.id === id),
      ...parsed.data.diagnostics.filter((diagnostic) => diagnostic.id === id),
    ],
  };
}

function describeHeld(entry: Held): string {
  return "name" in entry
    ? `${label(entry.tier, entry.id)} ("${entry.name}")`
    : `${label(entry.tier, entry.id)} (unreadable: fix or remove ${entry.path})`;
}

/**
 * The tier of the template an id addresses: the one given, or the only tier
 * holding the id. An id both tiers use is refused, naming both, rather than
 * guessed.
 */
async function resolveTier(
  app: CcApplication,
  context: ProjectContext,
  id: string,
  given: RunTemplateTier | undefined,
): Promise<CcContextResult<RunTemplateTier>> {
  if (given !== undefined) return { ok: true, value: given };
  const held = await templatesUsing(app, context, id);
  if (!held.ok) return held;
  const [only, other] = held.value;
  if (only === undefined)
    return usage(
      `No run template "${id}" in this project or the global library; run template list shows them.`,
    );
  if (other !== undefined)
    return usage(
      `Run template "${id}" exists in both tiers: ${held.value.map(describeHeld).join(" and ")}. Pass --tier project or --tier global.`,
    );
  if (!("name" in only))
    return usage(
      `Run template ${label(only.tier, id)} cannot be read (${only.reason}); fix or remove ${only.path}.`,
    );
  return { ok: true, value: only.tier };
}

/**
 * The tier a save writes: the one given; for a replacement, the tier holding
 * the template; for a create, this project's, unless the global library
 * already uses the id, which is refused rather than quietly shadowed.
 */
async function saveTier(
  app: CcApplication,
  context: ProjectContext,
  id: string,
  given: RunTemplateTier | undefined,
  basedOn: number | undefined,
): Promise<CcContextResult<RunTemplateTier>> {
  if (given !== undefined || basedOn !== undefined)
    return resolveTier(app, context, id, given);
  const held = await templatesUsing(app, context, id);
  if (!held.ok) return held;
  const global = held.value.find((entry) => entry.tier === "global");
  if (global !== undefined)
    return usage(
      `${describeHeld(global)} already uses id "${id}". Replace it with --tier global --based-on <revision>, or pass --tier project to create a project template with the same id.`,
    );
  return { ok: true, value: "project" };
}

interface SavedData {
  tier: RunTemplateTier;
  id: string;
  revision: number;
  action: "created" | "updated";
}

const saveImplementation: Save = {
  decode: runTemplateContentSchema,
  async prepare({ app, payload }) {
    const context = await resolveCcProject(app);
    if (!context.ok) return context;
    const validated = validateRunTemplate(payload);
    if (!validated.ok)
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: `The run template has ${validated.issues.length} ${validated.issues.length === 1 ? "problem" : "problems"}.`,
          issues: validated.issues.map((issue) => ({
            code: "CC_INPUT_ISSUE",
            message: issue.message,
            path: [issue.path],
          })),
        }),
      };
    return { ok: true, value: { context: context.value } };
  },
  commit: writeRunner<Parameters<Save["commit"]>[0], SavedData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const { context } = prepared.value;
      const id = ctx.args.id;
      const basedOn = ctx.flags["based-on"];
      const resolved = await saveTier(
        app,
        context,
        id,
        ctx.flags.tier,
        basedOn,
      );
      if (!resolved.ok)
        return { effect: "not_applied" as const, result: resolved };
      const tier = resolved.value;
      const recovery = recoveryFacts([
        { kind: "run-template", id: label(tier, id) },
      ]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "PUT",
        path: templatePath(context, tier, id),
        body: { expectedRevision: basedOn ?? null, template: payload },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = runTemplateSavedResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.template.id !== id)
        return {
          effect: "unknown" as const,
          recovery,
          result: invalid(
            "The save acknowledgement is invalid; read run template list before retrying.",
          ),
        };
      return {
        effect: "applied" as const,
        recovery,
        result: {
          ok: true as const,
          data: {
            tier,
            id,
            revision: parsed.data.template.revision,
            action: basedOn === undefined ? "created" : "updated",
          },
          hint: hint(
            invocation(runTemplateShowCommand, {
              flags: { ...explicitScopeFlags(app), tier },
              args: { id },
            }),
            "Read the saved template",
          ),
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        `Run template ${label(data.tier, data.id)} ${data.action} at revision ${data.revision}.\n`,
      ),
  }),
};
export const saveHandler = mutation(saveImplementation);

interface ListData {
  templates: RunTemplateSummary[];
  diagnostics: RunTemplateDiagnostic[];
  omission: Omission;
  revealCommand: string | null;
}

function templateRow(template: JsonData<RunTemplateSummary>): string {
  const parameters =
    template.parameters.length === 0
      ? "no parameters"
      : `parameters: ${template.parameters
          .map((p) => (p.required ? `${p.name} (required)` : p.name))
          .join(", ")}`;
  const description =
    template.description.length > 0 ? ` — ${template.description}` : "";
  return `${label(template.tier, template.id)} (rev ${template.revision}) ${template.name}${description} [${template.contexts} ${template.contexts === 1 ? "context" : "contexts"}; ${parameters}]`;
}

export const listHandler: Read<typeof runTemplateListSpec> = {
  run: runner<Input<typeof runTemplateListSpec>, ListData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: libraryPath(resolved.value),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = runTemplateLibrarySchema.safeParse(response.body);
      if (!parsed.success)
        return invalid("The run template library is invalid.");
      const only = ctx.flags.tier;
      const templates = parsed.data.items.filter(
        (item) => only === undefined || item.tier === only,
      );
      const diagnostics = parsed.data.diagnostics.filter(
        (diagnostic) => only === undefined || diagnostic.tier === only,
      );
      const source = {
        items: templates.slice(0, ctx.flags.limit),
        total: { kind: "known", count: count(templates.length) } as const,
      };
      const bounded = page(
        templates.length > ctx.flags.limit
          ? {
              ...source,
              more: true,
              reveal: invocation(runTemplateListCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  ...(only === undefined ? {} : { tier: only }),
                  limit: templates.length,
                },
              }),
            }
          : { ...source, more: false },
      );
      const first = bounded.items[0];
      return {
        ok: true,
        data: {
          templates: bounded.items,
          diagnostics,
          omission: bounded.omission,
          revealCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
        ...(first
          ? {
              hint: hint(
                invocation(runTemplateShowCommand, {
                  flags: { ...explicitScopeFlags(app), tier: first.tier },
                  args: { id: first.id },
                }),
                "Read a template to edit it",
              ),
            }
          : {}),
      };
    },
    text: ({ templates, diagnostics, omission, revealCommand }) => {
      const total =
        omission.total.kind === "known"
          ? String(omission.total.count)
          : "unknown";
      return quoteLiteralText(
        `${[
          `run templates: ${total} total, ${omission.returned} shown`,
          ...(revealCommand === null ? [] : [`next: ${revealCommand}`]),
          ...templates.map(templateRow),
          ...diagnostics.map(
            (diagnostic) =>
              `unreadable ${label(diagnostic.tier, diagnostic.id)}: ${diagnostic.reason}; fix or remove ${diagnostic.path}`,
          ),
        ].join("\n")}\n`,
      );
    },
  }),
};

interface ShowData {
  tier: RunTemplateTier;
  id: string;
  revision: number;
  /** The content run template save takes, JSON-encoded. */
  template: string;
}

export const showHandler: Read<typeof runTemplateShowSpec> = {
  run: runner<Input<typeof runTemplateShowSpec>, ShowData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const id = ctx.args.id;
      const tier = await resolveTier(app, resolved.value, id, ctx.flags.tier);
      if (!tier.ok) return tier;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: templatePath(resolved.value, tier.value, id),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = runTemplateDetailResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.template.id !== id)
        return invalid("The run template is invalid.");
      const {
        format: _format,
        id: _id,
        revision,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...content
      } = parsed.data.template;
      return {
        ok: true,
        data: {
          tier: tier.value,
          id,
          revision,
          template: escapedJson(content),
        },
      };
    },
    // The content alone, so it can be saved to a file, edited and saved again.
    text: (data) => quoteLiteralText(`${data.template}\n`),
  }),
};

interface DeletedData {
  tier: RunTemplateTier;
  id: string;
  revision: number;
}

export const deleteHandler: Write<typeof runTemplateDeleteSpec> = {
  run: writeRunner<
    Input<typeof runTemplateDeleteSpec>,
    DeletedData,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const id = ctx.args.id;
      const tier = await resolveTier(app, resolved.value, id, ctx.flags.tier);
      if (!tier.ok) return { effect: "not_applied", result: tier };
      const recovery = recoveryFacts([
        { kind: "run-template", id: label(tier.value, id) },
      ]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "DELETE",
        path: templatePath(resolved.value, tier.value, id),
        body: { expectedRevision: ctx.flags["based-on"] },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = runTemplateDeletedResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalid(
            "The delete acknowledgement is invalid; read run template list before retrying.",
          ),
        };
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: { tier: parsed.data.tier, id, revision: parsed.data.revision },
        },
      };
    },
    text: (data) =>
      quoteLiteralText(
        `Run template ${label(data.tier, data.id)} deleted (it was at revision ${data.revision}).\n`,
      ),
  }),
};

// The caller owns the run, so the receipt and hint are run workflow's.
const launchImplementation: Launch = {
  decode: launchInputsSchema,
  prepare: prepareSession,
  commit: writeRunner<
    Parameters<Launch["commit"]>[0],
    RunTemplateLaunchedResponse,
    CcErrorCode
  >({
    async run({ app, ctx, payload, prepared }) {
      const { context } = prepared.value;
      const id = ctx.args.id;
      const tier = await resolveTier(app, context, id, ctx.flags.tier);
      if (!tier.ok) return { effect: "not_applied" as const, result: tier };
      return postLaunch({
        app,
        context,
        suffix: "/template",
        payload: {
          template: {
            tier: tier.value,
            id,
            ...(payload.revision !== undefined
              ? { revision: payload.revision }
              : {}),
          },
          parameters: payload.parameters,
        },
        receipt: runTemplateLaunchedResponseSchema,
      });
    },
    text: launchedText,
  }),
};
export const launchHandler = mutation(launchImplementation);
