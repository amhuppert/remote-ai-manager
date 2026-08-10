/**
 * The human rendering of `cctl spec plan preview`. Every fact comes from the
 * server's already-bounded preview projection, so the text and the `--json`
 * payload describe the same plan and report the same omissions.
 */
import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import type { SpecPlanPreviewView } from "@/lib/specs/view-schemas";

type PreviewContext = SpecPlanPreviewView["contexts"][number];
type CriterionBrief = PreviewContext["criterionBriefs"][number];

function headerLines(preview: SpecPlanPreviewView): string[] {
  const shownContexts =
    preview.shownContextCount === preview.totalContextCount
      ? `${preview.totalContextCount}`
      : `${preview.shownContextCount} of ${preview.totalContextCount}`;
  return [
    `plan preview ${preview.spec.slug} rev ${preview.revision.number} (${preview.revision.state}, ${preview.revision.authoringStage} stage)`,
    `  scope ${preview.scopeHash}`,
    `  ${shownContexts} context${preview.totalContextCount === 1 ? "" : "s"}, ${preview.taskCount} task${preview.taskCount === 1 ? "" : "s"}, ${preview.edges.length} edge${preview.edges.length === 1 ? "" : "s"}, ${preview.criterionCount} selected criteri${preview.criterionCount === 1 ? "on" : "a"}`,
    `  launch approval: ${preview.approvalRequired ? "a human approves the compiled definition before the lane runs" : "no human approval gates the launch"}`,
    ...(preview.evidenceGaps.length === 0
      ? []
      : [
          `  evidence gaps: ${preview.evidenceGaps.join(", ")} — nothing in the ingest path mints these, so a criterion requiring one can never be proved`,
        ]),
  ];
}

function charterList(label: string, values: string[] | undefined): string[] {
  if (values === undefined || values.length === 0) return [];
  return [`  ${label}:`, ...values.map((value) => `    ${value}`)];
}

/**
 * The charter as the lane actually receives it. Every optional narrative field
 * the compiler emits is printed rather than a chosen subset: a planner reading
 * the preview to decide whether to launch is reading the contract, and a field
 * that silently never renders is a term of that contract they never see.
 */
function charterLines(charter: SpecPlanPreviewView["charter"]): string[] {
  return [
    "charter:",
    ...charter.mission.split("\n").map((line) => `  ${line}`),
    ...charterList("conventions", charter.conventions),
    ...charterList("non-goals", charter.nonGoals),
    ...charterList("vocabulary", charter.vocabulary),
    ...charterList("known ambiguities", charter.knownAmbiguities),
    ...(charter.testStrategy === undefined
      ? []
      : [`  test strategy: ${charter.testStrategy}`]),
    ...(charter.invariants === undefined || charter.invariants.length === 0
      ? []
      : [
          "  invariants:",
          ...charter.invariants.map(
            (invariant) => `    ${invariant.id}: ${invariant.statement}`,
          ),
        ]),
    "  sources of truth:",
    ...charter.sourcesOfTruth.map(
      (source) =>
        `    ${source.rank}. ${source.label} (${source.type}, ${source.accessPolicy}) — ${source.locator}`,
    ),
  ];
}

function edgeLines(preview: SpecPlanPreviewView): string[] {
  if (preview.edges.length === 0) {
    return ["edges: none — every context starts immediately"];
  }
  return [
    "edges:",
    ...preview.edges.map(
      (edge) => `  ${edge.sourceContextId} -> ${edge.targetContextId}`,
    ),
  ];
}

function briefLines(brief: CriterionBrief): string[] {
  return [
    `    ${brief.criterionHandle}: ${brief.text}`,
    // The compiler's own contract term, phrased as it phrases it, so a planner
    // reading the preview and a validator reading the brief see one demand.
    // The producer rows below annotate it; they do not restate it.
    `      required evidence: ${
      brief.evidence.length === 0
        ? "none declared"
        : brief.evidence.map((row) => row.kind).join(", ")
    }`,
    ...brief.evidence.map(
      (row) =>
        `        ${row.kind}: ${row.producer ?? "NO PRODUCER"} — ${row.detail}`,
    ),
    ...(brief.strategyNote === null
      ? []
      : [`      approved strategy note: ${brief.strategyNote}`]),
  ];
}

function contextLines(context: PreviewContext): string[] {
  const omission =
    context.omittedBriefCount === 0
      ? `${context.totalBriefCount} shown`
      : `${context.shownBriefCount} of ${context.totalBriefCount} shown, ${context.omittedBriefCount} omitted — re-run with --context ${context.contextId} for all of them`;
  return [
    `${context.contextId}: ${context.title}`,
    ...(context.description === null ? [] : [`  ${context.description}`]),
    `  tasks: ${context.taskHandles.length === 0 ? "none" : context.taskHandles.join(", ")}`,
    // The context contract the validator receives is the union of exactly
    // these briefs, so an omitted brief is a piece of that contract unread.
    `  criterion briefs, unioned into this context's acceptance contract (${omission}):`,
    ...context.criterionBriefs.flatMap(briefLines),
  ];
}

export function planPreviewText(preview: SpecPlanPreviewView): string {
  return [
    ...headerLines(preview),
    "",
    ...charterLines(preview.charter),
    "",
    ...edgeLines(preview),
    ...preview.contexts.flatMap((context) => ["", ...contextLines(context)]),
    "",
  ].join("\n");
}

/**
 * The delivery-plan attempt's rendering. It leads with the compiled hash and
 * the approvability sentence, because those are the two facts a reader is here
 * for: which bytes these are, and whether approving binds to them.
 */
export function deliveryPlanPreviewText(
  preview: DeliveryPlanPreviewView,
): string {
  const definition = preview.definition;
  const truncated = preview.packManifests.filter(
    (manifest) => manifest.omitted > 0,
  );
  return [
    `plan preview ${preview.specSlug} — ${preview.stage} (attempt ${preview.attemptId}, draft revision ${preview.draftRevision})`,
    `  pinned revision ${preview.pinnedRevisionId}`,
    `  plan hash              ${preview.planHash}`,
    `  compiled definition    ${preview.compiledDefinitionHash}`,
    ...(preview.snapshotId === null
      ? []
      : [`  frozen snapshot        ${preview.snapshotId}`]),
    ...(preview.candidateId === null
      ? []
      : [`  stored candidate       ${preview.candidateId}`]),
    `  approvable: ${preview.approvable ? "yes" : "no"} — ${preview.approvability}`,
    "",
    `charter mission: ${definition.charter.mission}`,
    ...(definition.charter.invariants ?? []).map(
      (invariant) => `  invariant ${invariant.id}: ${invariant.statement}`,
    ),
    ...definition.charter.sourcesOfTruth.map(
      (source) =>
        `  source ${source.rank}. ${source.id} (${source.type}, ${source.accessPolicy}): ${source.locator}`,
    ),
    "",
    `${definition.executionContexts.length} context${definition.executionContexts.length === 1 ? "" : "s"}, ${definition.tasks.length} task${definition.tasks.length === 1 ? "" : "s"}, ${definition.edges.length} edge${definition.edges.length === 1 ? "" : "s"}`,
    ...definition.edges.map(
      (edge) => `  ${edge.sourceContextId} -> ${edge.targetContextId}`,
    ),
    ...definition.executionContexts.flatMap((context) => [
      "",
      `${context.id} — ${context.title}`,
      "  acceptance contract (copied from the plan, never unioned):",
      ...context.acceptanceCriteria.split("\n").map((line) => `    ${line}`),
      `  tasks: ${definition.tasks
        .filter((task) => task.contextId === context.id)
        .map((task) => task.id)
        .join(", ")}`,
    ]),
    "",
    ...(truncated.length === 0
      ? ["every context pack fits the bound; nothing was omitted"]
      : [
          "context packs truncated to the bound:",
          ...truncated.map(
            (manifest) =>
              `  ${manifest.contextId}: ${manifest.included} of ${manifest.total} criteria included, ${manifest.omitted} omitted`,
          ),
        ]),
    "",
  ].join("\n");
}
