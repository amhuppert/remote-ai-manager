import type { LiveOutlineAssignmentProvenance } from "@/lib/workflow-graph/live-outline-schemas";

import { formatOutputSchemaShape } from "./workflow-output-schema";

import {
  formatAgentModelSelection,
  formatCommandSelector,
  formatLaneMergeSelection,
} from "./workflow-outline";

/**
 * CLI-side rendering of the `GET …/graph-workflow/live-outline` projection
 * (docs/design/cc-cli/06 "Read API — live outline"). The endpoint owns the
 * projection AND the editability policy (server-side, D10); the CLI only renders
 * the returned JSON as text. Structural fields parse the shared read
 * contract, whose unknown-field acceptance preserves navigation annotations;
 * the validation selector blocks parse the foundation schemas from
 * `@/lib/workflow-graph/config-schemas` (charter invariant
 * contracts-from-foundation — selector shapes are never privately redefined).
 */

import type {
  LiveOutline as LiveOutlineData,
  LiveOutlineContextConfig,
  LiveOutlineContext as LiveOutlineContextRow,
  LiveOutputsData,
} from "@/lib/workflow-graph/live-outline-schemas";

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
  // A round still open is the live fact; the count is the history. Said in
  // that order because a halted run reads the same in both cases, and only
  // this clause distinguishes an agent mid-turn from a run waiting on a human.
  const repaired =
    header.openPlanRepairRound != null
      ? `  plan-repair round ${header.openPlanRepairRound.seq} working ${header.openPlanRepairRound.contextId} (since ${header.openPlanRepairRound.startedAt})`
      : header.planRepairRoundCount > 0
        ? `  plan-repair ×${header.planRepairRoundCount}`
        : "";
  const seed =
    header.seedDefinitionId === null
      ? "inline plan"
      : `${header.seedDefinitionId}@${header.seedDefinitionRevision}`;
  const base = `execution ${header.executionId}  status=${header.status}  liveRev=${header.liveRevision}  seed=${seed}${amended}${repaired}`;
  if (header.editable) return base;
  const reason = header.notEditableReason ?? "not editable";
  return `${base}  read-only (${reason})`;
}

/**
 * The D4 suffixes a context row carries when there is something conditional to
 * say about it (R13.2). Each is trailing and conditional for the same reason
 * the output-schema summary is: the row keeps its pre-D4 width for the
 * unguarded, loop-free, planner-authored contexts that are the common case.
 */
function d4RowSuffixes(context: LiveOutlineContextRow): string {
  const parts: string[] = [];
  if (context.skip) {
    const verdicts = context.skip.edgeEvaluations
      .map((evaluation) => `${evaluation.edgeId}:${evaluation.verdict}`)
      .join(",");
    parts.push(`skip=${verdicts}`);
  }
  if (context.loop) {
    const template =
      context.loop.templateVersion == null
        ? ""
        : ` template v${context.loop.templateVersion}`;
    parts.push(
      `loop=${context.loop.loopGroupId} pass ${context.loop.pass}/${context.loop.maxPasses}${template}`,
    );
  }
  if (context.provenance) {
    parts.push(`added-by=${context.provenance.requestId}`);
  }
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
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
    )}  ${deps}  tasks=${c.completedTaskCount}/${c.totalTaskCount}  iter=${c.iterationCount}/${c.maxIterations}${outputSchema}${d4RowSuffixes(c)}`;
  });
  return `contexts:\n${rows.join("\n")}`;
}

/**
 * The routes block, printed only when the graph has something CONDITIONAL to
 * report — a guard, or a route the engine resolved onto an instance other than
 * its authored source. A pre-D4 graph's outline is byte-identical without it,
 * and `deps=` on the context rows already carries plain topology.
 */
function routesBlock(routes: LiveOutlineData["routes"]): string | null {
  const notable = routes.filter(
    (route) =>
      route.guard !== "none" ||
      (route.effectiveSource != null && route.effectiveSource !== route.source),
  );
  if (notable.length === 0) return null;
  const idWidth = widestOf(routes.map((route) => route.id));
  const pairs = routes.map((route) => `${route.source} → ${route.target}`);
  const pairWidth = widestOf(pairs);
  const guardWidth = widestOf(
    routes.map((route) => (route.guard === "none" ? "-" : route.guard)),
  );
  const rows = routes.map((route, index) => {
    const guard = route.guard === "none" ? "-" : route.guard;
    const via =
      route.effectiveSource != null && route.effectiveSource !== route.source
        ? `  via ${route.effectiveSource}`
        : "";
    return `  ${pad(route.id, idWidth)}  ${pad(pairs[index]!, pairWidth)}  ${pad(
      guard,
      guardWidth,
    )}  ${route.resolution}${via}`;
  });
  return `routes:\n${rows.join("\n")}`;
}

function loopsBlock(loops: LiveOutlineData["loops"]): string | null {
  if (loops.length === 0) return null;
  const idWidth = widestOf(loops.map((loop) => loop.loopGroupId));
  const activationWidth = widestOf(loops.map((loop) => loop.activation));
  const rows = loops.map((loop) => {
    // The logical exit is what the author wired; the concluding instance is
    // what actually satisfied it (D1), so the row names both.
    const exit =
      loop.concludingExitContextId == null
        ? `exit=${loop.logicalExitContextId}`
        : `exit=${loop.logicalExitContextId} → ${loop.concludingExitContextId}`;
    return `  ${pad(loop.loopGroupId, idWidth)}  ${pad(
      loop.activation,
      activationWidth,
    )}  pass ${loop.passCount}/${loop.maxPasses}  ${exit}  control rev ${loop.loopControlRevision}`;
  });
  return `loops:\n${rows.join("\n")}`;
}

function expansionsBlock(
  expansions: LiveOutlineData["expansions"],
): string | null {
  if (expansions.accepted.length === 0 && expansions.refusals.length === 0) {
    return null;
  }
  const rows = [
    ...expansions.accepted.map((receipt) => {
      const added = [
        ...receipt.addedContextIds.map((id) => `+${id}`),
        ...receipt.addedTaskIds.map((id) => `+task ${id}`),
      ].join(" ");
      const rejoins =
        receipt.rejoinContextIds.length > 0
          ? `  rejoins ${receipt.rejoinContextIds.join(",")}`
          : "";
      return `  accepted  ${receipt.requestId}  by ${receipt.invokerContextId}  ${added}${rejoins}  ${receipt.acceptedAt}\n    "${receipt.rationale}"`;
    }),
    ...expansions.refusals.map(
      (receipt) =>
        `  refused   ${receipt.requestId}  by ${receipt.invokerContextId}  ${receipt.refusalCode}  ${receipt.refusedAt}`,
    ),
  ];
  return `expansions:\n${rows.join("\n")}`;
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
  // The `config:` line is a RUNTIME line: a disabled cohort reads "validator
  // off" however many assignments it retains, because none of them is invoked.
  if (!config.validatorCohortEnabled) return "validator off";
  // One clause per assignment: the cohort's identity is the set, and printing
  // only the first would hide the reviewers a context actually configured.
  return config.validators
    .map(
      (validator) =>
        `validator ${validator.assignmentId} ${validator.strategy} ${formatAgentModelSelection(validator.backend, validator.modelSelection)}`,
    )
    .join(", ");
}

function scriptGateSummary(
  scriptValidator: LiveOutlineContextConfig["scriptValidator"],
): string {
  return scriptValidator.commands.length > 0
    ? `script ${scriptValidator.commands.join("+")}`
    : "script off";
}

function configLine(config: LiveOutlineContextConfig): string {
  const impl = formatAgentModelSelection(
    config.implementer.backend,
    config.implementer.modelSelection,
  );
  const parts = [
    impl,
    validatorSummary(config),
    scriptGateSummary(config.scriptValidator),
  ];
  if (config.agentValidation != null) {
    parts.push(
      `roles implementer ${formatCommandSelector(config.agentValidation.implementer)}, validator ${formatCommandSelector(config.agentValidation.contextValidator)}`,
    );
  }
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

/**
 * `sha256:ab12…` → `#ab12…`, truncated to a comparison-sized prefix.
 *
 * The full digest is in `--json`; the text row exists so two rows can be told
 * apart at a glance — which is the question provenance actually gets asked
 * ("are these two lanes running the same instructions?").
 */
function shortHash(hash: string): string {
  const digest = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
  return `#${digest.slice(0, 12)}`;
}

/**
 * The staffing block: what this execution IS RUNNING, snapshot by snapshot.
 *
 * Deliberately a mirror of `cctl workflow get`'s "staffing (references)" block
 * with two columns the saved surface cannot have — the seeded revision and the
 * resolved-instruction hash. A reader comparing the two surfaces sees exactly
 * one difference, and that difference is the whole point: an authored document
 * names a profile the library still owns, a running execution replays bytes
 * nothing can reach.
 */
function staffingBlock(config: LiveOutlineData["config"]): string {
  interface Row {
    scope: string;
    role: string;
    id: string;
    profile: string;
    hash: string;
    detail: string;
  }

  const profileOf = (assignment: LiveOutlineAssignmentProvenance): string =>
    `${assignment.profile}@${assignment.revision}`;

  const hashOf = (assignment: LiveOutlineAssignmentProvenance): string =>
    shortHash(assignment.resolvedInstructionHash);

  const detailOf = (
    assignment: LiveOutlineAssignmentProvenance,
    runtime: string,
  ): string =>
    `${runtime}${assignment.focus ? `  focus "${assignment.focus}"` : ""}`;

  const rows: Row[] = config.flatMap((context) => [
    {
      scope: context.contextId,
      role: "implementer",
      id: context.implementer.assignmentId,
      profile: profileOf(context.implementer),
      hash: hashOf(context.implementer),
      detail: detailOf(
        context.implementer,
        formatAgentModelSelection(
          context.implementer.backend,
          context.implementer.modelSelection,
        ),
      ),
    },
    // Dormant rows are reported and MARKED, the same way the saved surface
    // marks them: the execution holds these snapshots, so a reader deciding
    // whether to re-enable the cohort can see exactly what would start running.
    ...context.validators.map((validator) => ({
      scope: context.contextId,
      role: "validator",
      id: validator.assignmentId,
      profile: profileOf(validator),
      hash: hashOf(validator),
      detail: `${detailOf(
        validator,
        `${validator.strategy} ${formatAgentModelSelection(validator.backend, validator.modelSelection)}`,
      )}${context.validatorCohortEnabled ? "" : "  (cohort disabled)"}`,
    })),
  ]);

  if (rows.length === 0) return "staffing (snapshots):\n  (none)";
  const scopeWidth = widestOf(rows.map((row) => row.scope));
  const roleWidth = widestOf(rows.map((row) => row.role));
  const idWidth = widestOf(rows.map((row) => row.id));
  const profileWidth = widestOf(rows.map((row) => row.profile));
  const hashWidth = widestOf(rows.map((row) => row.hash));
  const lines = rows.map(
    (row) =>
      `  ${pad(row.scope, scopeWidth)}  ${pad(row.role, roleWidth)}  ${pad(
        row.id,
        idWidth,
      )}  ${pad(row.profile, profileWidth)}  ${pad(row.hash, hashWidth)}  ${
        row.detail
      }`,
  );
  return `staffing (snapshots):\n${lines.join("\n")}`;
}

/** Render the full live-outline projection as the doc-06 text table. */
export function renderLiveOutline(outline: LiveOutlineData): string {
  const blocks = [
    headerLine(outline.header),
    contextsBlock(outline.contexts),
    routesBlock(outline.routes),
    loopsBlock(outline.loops),
    expansionsBlock(outline.expansions),
    tasksBlock(outline.tasks),
    configBlock(outline.config),
    staffingBlock(outline.config),
  ].filter((block): block is string => block !== null);
  // Workflow-scope, so it renders once below the per-context config rows;
  // absent for legacy executions and pre-selector servers alike.
  if (outline.laneMergeValidation != null) {
    blocks.push(
      `laneMerge: ${formatLaneMergeSelection(outline.laneMergeValidation)}`,
    );
  }
  return blocks.join("\n");
}

// ============================================================
// The `--outputs` view (R7.2)
// ============================================================

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
