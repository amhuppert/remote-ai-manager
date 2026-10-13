/**
 * The run template document: what a template stores, how it is checked on
 * save, and how it becomes a workflow launch request.
 *
 * A template is a `cctl run workflow` definition with its settings lifted out
 * into two tiers (the template's `defaults`, and each context's `settings`)
 * and `{{inputs.<name>}}` tokens left in its text. It materialises into the
 * launch request the workflow route already takes: settings cascade per
 * context, parameters substitute, and `workflowLaunchRequestSchema` applies
 * every topology rule. A setting neither tier sets stays out of the request,
 * so the launch resolver supplies the global tier as for any workflow launch.
 *
 * Server-side: it reuses the workflow request schemas, which reach Node I/O.
 */
import { z } from "zod";
import {
  cascadeSettings,
  type SettingsTier,
} from "@/lib/config/settings-cascade";
import { runDocumentRequestSchema } from "@/lib/runs/documents";
import { runCharterSchema } from "@/lib/runs/schemas";
import {
  RUN_SETTING_DEFAULTS,
  SETTING_REQUEST_FIELD_MASK,
  isSettingRequestField,
  requestFieldsOf,
  runSettingsPatchSchema,
  runSettingsSchema,
  settingPathOf,
  settingsSetAbove,
  type RunSettingKey,
  type RunSettings,
} from "@/lib/runs/settings";
import {
  workflowContextRequestSchema,
  workflowLaneRequestSchema,
  workflowLaunchRequestSchema,
  workflowLoopRequestSchema,
  type WorkflowLaunchRequest,
} from "@/lib/runs/workflow-definition";
import {
  issueAt,
  runTemplateIdSchema,
  runTemplateParameterSchema,
  type RunTemplateIssue,
} from "./schemas";
import {
  bindParameterValues,
  lintParameterTokens,
  substituteParameters,
} from "./parameters";

/** Why a setting cannot be written inside a context, when one is. */
function settingInContextMessage(keys: readonly string[]): string | undefined {
  const settings = keys.filter(isSettingRequestField);
  if (settings.length === 0) return undefined;
  const others = keys.filter((key) => !isSettingRequestField(key));
  const one = settings.length === 1;
  return `${settings.join(", ")} ${one ? "is a setting" : "are settings"}: set ${one ? "it" : "them"} in this context's settings, or in the template's defaults for every context${others.length === 0 ? "" : `. Not a context field: ${others.join(", ")}`}`;
}

/** A workflow context as a template writes it: its content, and the settings it overrides. */
export const runTemplateContextSchema = z.strictObject(
  {
    ...workflowContextRequestSchema.omit(SETTING_REQUEST_FIELD_MASK).shape,
    settings: runSettingsPatchSchema.optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? settingInContextMessage(issue.keys)
        : undefined,
  },
);
export type RunTemplateContext = z.infer<typeof runTemplateContextSchema>;

export const runTemplateWorkflowSchema = z
  .object({
    contexts: z.array(runTemplateContextSchema).min(1),
    loops: z.array(workflowLoopRequestSchema).optional(),
    lanes: z.array(workflowLaneRequestSchema).optional(),
    /** Declared as for a workflow launch; a `from` file is read when the template is launched. */
    documents: z
      .array(runDocumentRequestSchema.omit({ revision: true }))
      .optional(),
    charter: runCharterSchema.optional(),
  })
  .strict();

/** What an author writes and the editor changes. */
export const runTemplateContentSchema = z
  .object({
    /** The run's title. */
    name: z.string().trim().min(1).max(120),
    description: z.string(),
    parameters: z.array(runTemplateParameterSchema),
    /** The template tier: only the settings it sets. */
    defaults: runSettingsPatchSchema,
    workflow: runTemplateWorkflowSchema,
  })
  .strict();
export type RunTemplateContent = z.infer<typeof runTemplateContentSchema>;

/** A stored template: its content, with the identity and revision storage owns. */
export const runTemplateRecordSchema = runTemplateContentSchema
  .extend({
    format: z.literal(1),
    id: runTemplateIdSchema,
    revision: z.number().int().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type RunTemplateRecord = z.infer<typeof runTemplateRecordSchema>;

/** A template as its read and its write answer: the stored record, and on a read the global tier it falls back to. */
export const runTemplateDetailResponseSchema = z
  .object({
    template: runTemplateRecordSchema,
    /** Its implementer names no backend or model: those are the configured default's. */
    globals: runSettingsSchema,
  })
  .strict();
export type RunTemplateDetailResponse = z.infer<
  typeof runTemplateDetailResponseSchema
>;
export const runTemplateSavedResponseSchema = z
  .object({ template: runTemplateRecordSchema })
  .strict();

type IssuePath = ReadonlyArray<PropertyKey>;

/** Where a materialised request's issue lives in the template: a setting's at the tier that set it. */
function templatePathOf(
  path: IssuePath,
  tierOf: (contextIndex: number, key: RunSettingKey) => SettingsTier,
): Array<string | number> {
  const segments = path.map((segment) =>
    typeof segment === "symbol" ? String(segment) : segment,
  );
  const [root, index, ...rest] = segments;
  if (root === "title" && segments.length === 1) return ["name"];
  if (root !== "contexts" || typeof index !== "number")
    return ["workflow", ...segments];
  const setting = settingPathOf(rest);
  const tier = setting === null ? null : tierOf(index, setting.key);
  if (setting !== null && tier === "template")
    return ["defaults", ...setting.path];
  if (setting !== null && tier === "context")
    return ["workflow", "contexts", index, "settings", ...setting.path];
  return ["workflow", "contexts", index, ...rest];
}

/**
 * The workflow launch request a template's content and a launch's parameter
 * values make, or the located issues that refuse it: an unknown, missing or
 * blank value at `parameters.<name>`, anything else at its path in the
 * template. The one entry point that binds values, so no launch can skip it.
 */
export function materializeRunTemplate(
  content: RunTemplateContent,
  values: Readonly<Record<string, string>>,
):
  | { ok: true; request: WorkflowLaunchRequest }
  | { ok: false; issues: RunTemplateIssue[] } {
  const bound = bindParameterValues(content.parameters, values);
  if (!bound.ok) return bound;
  const contexts = content.workflow.contexts.map(({ settings, ...fields }) => {
    const cascaded = cascadeSettings<RunSettings>({
      global: RUN_SETTING_DEFAULTS,
      template: content.defaults,
      ...(settings !== undefined ? { context: settings } : {}),
    });
    return {
      cascaded,
      request: { ...fields, ...requestFieldsOf(settingsSetAbove(cascaded)) },
    };
  });
  const unsubstituted = {
    ...content.workflow,
    title: content.name,
    contexts: contexts.map(({ request }) => request),
  };
  const parsed = workflowLaunchRequestSchema.safeParse(
    substituteParameters(unsubstituted, bound.values),
  );
  if (parsed.success) return { ok: true, request: parsed.data };
  const tierOf = (index: number, key: RunSettingKey): SettingsTier =>
    contexts[index]?.cascaded[key].from ?? "global";
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) =>
      issueAt(templatePathOf(issue.path, tierOf), issue.message),
    ),
  };
}

function issueOf(issue: z.core.$ZodIssue): RunTemplateIssue {
  return issueAt(
    issue.path.map((segment) =>
      typeof segment === "symbol" ? String(segment) : segment,
    ),
    issue.message,
  );
}

function duplicateParameters(
  parameters: RunTemplateContent["parameters"],
): RunTemplateIssue[] {
  const seen = new Set<string>();
  return parameters.flatMap(({ name }, index) => {
    if (!seen.has(name)) {
      seen.add(name);
      return [];
    }
    return [
      issueAt(
        ["parameters", index, "name"],
        `Parameter "${name}" is declared twice`,
      ),
    ];
  });
}

/**
 * A template as saved: content that parses, tokens that lint, and a workflow
 * that materialises (required parameters filled, optional ones empty) into a
 * launch request the workflow route accepts. Each stage reports all of its
 * problems; a later stage runs only once the earlier ones pass. Profile
 * references are checked by the service, which can read the profile library.
 */
export function validateRunTemplate(
  raw: unknown,
):
  | { ok: true; content: RunTemplateContent }
  | { ok: false; issues: RunTemplateIssue[] } {
  const parsed = runTemplateContentSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.map(issueOf) };
  const content = parsed.data;
  const tokens = [
    ...duplicateParameters(content.parameters),
    ...lintParameterTokens(content),
  ];
  if (tokens.length > 0) return { ok: false, issues: tokens };
  // An omitted optional parameter is empty text, which can empty a field a launch requires.
  const placeholders = Object.fromEntries(
    content.parameters.map(({ name, required }) => [
      name,
      required ? name : "",
    ]),
  );
  const materialized = materializeRunTemplate(content, placeholders);
  return materialized.ok ? { ok: true, content } : materialized;
}
