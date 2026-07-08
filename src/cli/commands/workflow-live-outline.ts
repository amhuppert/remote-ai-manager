import { z } from "zod";

/**
 * CLI-side rendering of the `GET …/graph-workflow/live-outline` projection
 * (docs/design/cc-cli/06 "Read API — live outline"). The endpoint owns the
 * projection AND the editability policy (server-side, D10); the CLI only renders
 * the returned JSON as text. The schema below is a deliberately permissive local
 * mirror — the CLI never imports the server schema graph — so an added field on
 * the projection never breaks the render.
 */

const agentSummarySchema = z
  .object({
    backend: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  })
  .loose();

const validatorSummarySchema = z
  .object({
    type: z.string(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
  })
  .loose();

const contextConfigSchema = z
  .object({
    contextId: z.string(),
    implementer: agentSummarySchema,
    validator: validatorSummarySchema.nullable(),
    scriptValidator: z.boolean(),
    humanApprovalGate: z.boolean(),
    askUserQuestions: z.boolean(),
  })
  .loose();

const headerSchema = z
  .object({
    executionId: z.string(),
    liveRevision: z.number(),
    status: z.string(),
    seedDefinitionId: z.string(),
    seedDefinitionRevision: z.number(),
    editable: z.boolean(),
    notEditableReason: z.string().optional(),
  })
  .loose();

const contextRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    editability: z.string(),
    deps: z.array(z.string()),
    completedTaskCount: z.number(),
    totalTaskCount: z.number(),
    iterationCount: z.number(),
    maxIterations: z.number(),
  })
  .loose();

const taskRowSchema = z
  .object({
    contextId: z.string(),
    order: z.number(),
    id: z.string(),
    status: z.string(),
    title: z.string(),
    instructionChars: z.number(),
  })
  .loose();

export const liveOutlineSchema = z
  .object({
    header: headerSchema,
    contexts: z.array(contextRowSchema),
    tasks: z.array(taskRowSchema),
    config: z.array(contextConfigSchema),
  })
  .loose();

export type LiveOutlineData = z.infer<typeof liveOutlineSchema>;
type LiveOutlineContextConfig = z.infer<typeof contextConfigSchema>;

function humanChars(chars: number): string {
  return chars >= 1000
    ? `${(chars / 1000).toFixed(1)}k chars`
    : `${chars} chars`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function widestOf(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function headerLine(header: LiveOutlineData["header"]): string {
  const base = `execution ${header.executionId}  status=${header.status}  liveRev=${header.liveRevision}  seed=${header.seedDefinitionId}@${header.seedDefinitionRevision}`;
  if (header.editable) return base;
  const reason = header.notEditableReason ?? "not editable";
  return `${base}  read-only (${reason})`;
}

function contextsBlock(contexts: LiveOutlineData["contexts"]): string {
  if (contexts.length === 0) return "contexts:\n  (none)";
  const idWidth = widestOf(contexts.map((c) => c.id));
  const statusWidth = widestOf(contexts.map((c) => c.status));
  const editWidth = widestOf(contexts.map((c) => c.editability));
  const depsStrings = contexts.map((c) =>
    c.deps.length > 0 ? c.deps.join(",") : "-",
  );
  const depsWidth = widestOf(depsStrings.map((d) => `deps=${d}`));
  const rows = contexts.map((c, i) => {
    const deps = pad(`deps=${depsStrings[i]}`, depsWidth);
    return `  ${pad(c.id, idWidth)}  ${pad(c.status, statusWidth)}  ${pad(
      c.editability,
      editWidth,
    )}  ${deps}  tasks=${c.completedTaskCount}/${c.totalTaskCount}  iter=${c.iterationCount}/${c.maxIterations}`;
  });
  return `contexts:\n${rows.join("\n")}`;
}

function tasksBlock(tasks: LiveOutlineData["tasks"]): string {
  if (tasks.length === 0) return "tasks:\n  (none)";
  const ctxWidth = widestOf(tasks.map((t) => t.contextId));
  const idWidth = widestOf(tasks.map((t) => t.id));
  const statusWidth = widestOf(tasks.map((t) => t.status));
  const titleWidth = widestOf(tasks.map((t) => `"${t.title}"`));
  let lastContext: string | null = null;
  const rows = tasks.map((t) => {
    const ctxLabel = t.contextId === lastContext ? "" : t.contextId;
    lastContext = t.contextId;
    const title = pad(`"${t.title}"`, titleWidth);
    return `  ${pad(ctxLabel, ctxWidth)}  ${t.order} ${pad(t.id, idWidth)}  ${pad(
      t.status,
      statusWidth,
    )}  ${title}  (${humanChars(t.instructionChars)})`;
  });
  return `tasks:\n${rows.join("\n")}`;
}

function validatorSummary(config: LiveOutlineContextConfig): string {
  if (!config.validator) return "validator off";
  const parts = [
    "validator",
    config.validator.type,
    config.validator.model,
    config.validator.reasoningEffort,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.join(" ");
}

function configLine(config: LiveOutlineContextConfig): string {
  const impl = `${config.implementer.backend} ${config.implementer.model} ${config.implementer.reasoningEffort}`;
  const parts = [
    impl,
    validatorSummary(config),
    `script ${config.scriptValidator ? "on" : "off"}`,
  ];
  if (config.humanApprovalGate) parts.push("approval on");
  if (config.askUserQuestions) parts.push("questions on");
  return parts.join("; ");
}

function configBlock(config: LiveOutlineData["config"]): string {
  if (config.length === 0) return "config:\n  (none)";
  const idWidth = widestOf(config.map((c) => c.contextId));
  const rows = config.map(
    (c) => `  ${pad(c.contextId, idWidth)}  ${configLine(c)}`,
  );
  return `config:\n${rows.join("\n")}`;
}

/** Render the full live-outline projection as the doc-06 text table. */
export function renderLiveOutline(outline: LiveOutlineData): string {
  return [
    headerLine(outline.header),
    contextsBlock(outline.contexts),
    tasksBlock(outline.tasks),
    configBlock(outline.config),
  ].join("\n");
}
