import { z } from "zod";
import {
  formatOutputSchemaShape,
  outputSchemaShapeSchema,
} from "./workflow-output-schema";

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
    // Absent on outlines from pre-doc-07 servers; render as "never amended".
    charterAmendmentCount: z.number().default(0),
    // Absent on outlines from pre-D1 servers; render as "no repair rounds".
    planRepairRoundCount: z.number().default(0),
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
    // Absent on outlines from pre-D2 servers; renders as "declares none".
    outputSchema: outputSchemaShapeSchema.nullish(),
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
  const amended =
    header.charterAmendmentCount > 0
      ? `  charter amended ×${header.charterAmendmentCount}`
      : "";
  const repaired =
    header.planRepairRoundCount > 0
      ? `  plan-repair ×${header.planRepairRoundCount}`
      : "";
  const base = `execution ${header.executionId}  status=${header.status}  liveRev=${header.liveRevision}  seed=${header.seedDefinitionId}@${header.seedDefinitionRevision}${amended}${repaired}`;
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
    // Trailing and only when declared — the row stays the same width for the
    // free-form contexts that are still the common case.
    const outputSchema = c.outputSchema
      ? `  ${formatOutputSchemaShape(c.outputSchema)}`
      : "";
    return `  ${pad(c.id, idWidth)}  ${pad(c.status, statusWidth)}  ${pad(
      c.editability,
      editWidth,
    )}  ${deps}  tasks=${c.completedTaskCount}/${c.totalTaskCount}  iter=${c.iterationCount}/${c.maxIterations}${outputSchema}`;
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

// ============================================================
// The `--outputs` view (R7.2)
// ============================================================

// Only the fields the text view renders are required — `title` and the context
// `status` ride the projection for `--json` readers, and demanding them here
// would turn a harmless projection change into a fallback JSON dump.
const contextOutputSchema = z
  .object({
    contextId: z.string(),
    schema: outputSchemaShapeSchema.nullish(),
    capture: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("captured"),
          value: z.record(z.string(), z.unknown()),
          capturedAt: z.string(),
          iteration: z.number(),
          parse: z
            .object({
              source: z.string(),
              repaired: z.boolean().optional(),
              repairAttempts: z.number().optional(),
            })
            .loose(),
        })
        .loose(),
      z.object({ kind: z.literal("pending") }).loose(),
    ]),
  })
  .loose();

export const liveOutputsSchema = z
  .object({ outputs: z.array(contextOutputSchema) })
  .loose();

export type LiveOutputsData = z.infer<typeof liveOutputsSchema>;
type LiveContextOutput = LiveOutputsData["outputs"][number];

/** `parse fenced (repaired ×2)` — where the gate found the accepted payload. */
function parseProvenance(
  parse: Extract<LiveContextOutput["capture"], { kind: "captured" }>["parse"],
): string {
  if (!parse.repaired) return `parse ${parse.source}`;
  const attempts = parse.repairAttempts;
  return `parse ${parse.source} (repaired${attempts !== undefined ? ` ×${attempts}` : ""})`;
}

/**
 * Render the outputs view: one summary line per schema-declaring context, and
 * the captured payload indented beneath it. Unlike the outline, the payload IS
 * printed in full — it is the thing the caller asked for, and it is bounded by
 * the declared contract.
 */
export function renderLiveOutputs(data: LiveOutputsData): string {
  if (data.outputs.length === 0) {
    return "outputs: no context declares an outputSchema\n";
  }
  const idWidth = widestOf(data.outputs.map((entry) => entry.contextId));
  const statusWidth = widestOf(data.outputs.map((entry) => entry.capture.kind));
  const lines = [`outputs (${data.outputs.length}):`];
  for (const entry of data.outputs) {
    const parts = [
      pad(entry.contextId, idWidth),
      pad(entry.capture.kind, statusWidth),
    ];
    parts.push(
      entry.schema
        ? formatOutputSchemaShape(entry.schema)
        : "output schema: cleared after capture",
    );
    if (entry.capture.kind === "captured") {
      parts.push(
        `iteration ${entry.capture.iteration}`,
        `captured ${entry.capture.capturedAt}`,
        parseProvenance(entry.capture.parse),
      );
    }
    lines.push(`  ${parts.join("  ")}`);
    if (entry.capture.kind === "captured") {
      const payload = JSON.stringify(entry.capture.value, null, 2);
      lines.push(...payload.split("\n").map((line) => `    ${line}`));
    }
  }
  return `${lines.join("\n")}\n`;
}
