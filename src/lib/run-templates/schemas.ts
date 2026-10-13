/**
 * Run template identity, parameters and wire shapes. The template document
 * itself, which reuses the workflow launch request's schemas, lives in
 * `document.ts`.
 */
import { z } from "zod";
import { runTemplateTierSchema } from "@/lib/runs/schemas";

/** A template id: also its file name, so validated before it reaches a path. */
export const runTemplateIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,47}$/,
    "Use 1-48 lowercase letters, digits, - or _, starting with a letter or digit",
  );

/** The name a `{{inputs.<name>}}` token refers to. */
export const PARAMETER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A value the person launching the template supplies, as free text. */
export const runTemplateParameterSchema = z
  .object({
    name: z
      .string()
      .regex(
        PARAMETER_NAME_PATTERN,
        "Use letters, digits, - or _ (the name a {{inputs.<name>}} token uses)",
      )
      .refine(
        (name) => name !== "__proto__",
        "__proto__ cannot name a parameter: a launch's values could not carry it",
      ),
    description: z.string(),
    /** A required value must be given and not blank; an omitted optional one substitutes empty text. */
    required: z.boolean(),
  })
  .strict();
export type RunTemplateParameter = z.infer<typeof runTemplateParameterSchema>;

/** One problem with a template or a launch's values, located by its dotted path. */
export const runTemplateIssueSchema = z
  .object({ path: z.string(), message: z.string() })
  .strict();
export type RunTemplateIssue = z.infer<typeof runTemplateIssueSchema>;

export function issueAt(
  path: ReadonlyArray<string | number>,
  message: string,
): RunTemplateIssue {
  return { path: path.join("."), message };
}

/** One template as the library lists it. */
export const runTemplateSummarySchema = z
  .object({
    tier: runTemplateTierSchema,
    id: runTemplateIdSchema,
    name: z.string(),
    description: z.string(),
    /** How many contexts its workflow has. */
    contexts: z.number().int().min(1),
    parameters: z.array(runTemplateParameterSchema),
    revision: z.number().int().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type RunTemplateSummary = z.infer<typeof runTemplateSummarySchema>;

/** A template file that could not be read; it keeps its id until it is fixed or removed. */
export const runTemplateDiagnosticSchema = z
  .object({
    tier: runTemplateTierSchema,
    id: z.string(),
    /** The file, to fix or remove. */
    path: z.string(),
    reason: z.string(),
  })
  .strict();
export type RunTemplateDiagnostic = z.infer<typeof runTemplateDiagnosticSchema>;

/** The templates a project can launch: its own and the global ones. */
export const runTemplateLibrarySchema = z
  .object({
    items: z.array(runTemplateSummarySchema),
    diagnostics: z.array(runTemplateDiagnosticSchema),
  })
  .strict();
export type RunTemplateLibrary = z.infer<typeof runTemplateLibrarySchema>;

export const runTemplateChangeActionSchema = z.enum([
  "created",
  "updated",
  "deleted",
]);
export type RunTemplateChangeAction = z.infer<
  typeof runTemplateChangeActionSchema
>;

const changeIdentityShape = {
  type: z.literal("run-template-changed"),
  id: runTemplateIdSchema,
  /** The revision the change produced; for a delete, the one it removed. */
  revision: z.number().int().positive(),
  action: runTemplateChangeActionSchema,
};

/**
 * A committed template write. `scope` is the changed template's tier: a global
 * template changed from one project's routes is every project's, so it
 * invalidates every project's template queries; a project template names its
 * project.
 */
export const runTemplateChangedEventSchema = z.discriminatedUnion("scope", [
  z.object({ ...changeIdentityShape, scope: z.literal("global") }).strict(),
  z
    .object({
      ...changeIdentityShape,
      scope: z.literal("project"),
      projectPath: z.string().min(1),
    })
    .strict(),
]);
export type RunTemplateChangedEvent = z.infer<
  typeof runTemplateChangedEventSchema
>;

export const runTemplateDeletedResponseSchema = z
  .object({
    ok: z.literal(true),
    tier: runTemplateTierSchema,
    id: runTemplateIdSchema,
    /** The revision the delete removed. */
    revision: z.number().int().positive(),
  })
  .strict();
export type RunTemplateDeletedResponse = z.infer<
  typeof runTemplateDeletedResponseSchema
>;
