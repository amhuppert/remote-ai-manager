import type {
  CriterionDeliveryClass,
  CriterionFreshness,
} from "./delivery-delta";
import type { EarlierMergedDeliveryVerdict } from "./delivery-gate";
import {
  DELIVERY_PLAN_DISPOSITIONS,
  type DeliveryPlanContext,
  type DeliveryPlanDisposition,
  type DeliveryPlanDocument,
  type DeliveryPlanReaffirmation,
  type DeliveryPlanWiringEntry,
} from "./delivery-plan";
import { draftHealth, type DraftHealth } from "./draft-health";
import type { LintFinding } from "./lint";
import type { Refusal } from "./schemas";

/**
 * The delivery plan's own lint, judged as a staged snapshot: the caller stages
 * the document the attempt would carry once the write commits and asks for the
 * complete verdict before committing any of it, exactly as the element write
 * guard does for revision content. Nothing here reads the mutable evergreen
 * head — every criterion judgment is made against the revision the attempt
 * pinned, which is what makes a plan's scope stable while the spec moves on.
 *
 * One projection serves every surface (`single-lint-projection`): edit
 * receipts, `spec plan status`, Studio, and propose enforcement all call
 * `deliveryPlanDraftHealth` and read the same findings through the same
 * `draftHealth` grouping the evergreen lint uses.
 */

/** One pinned criterion, with the freshness the delta projection computed. */
export interface PlanLintCriterion {
  readonly criterionElementId: string;
  readonly handle: string;
  /** P1/P2 classification against the delta basis (`projectDeliveryDelta`). */
  readonly deliveryClass: CriterionDeliveryClass;
  /**
   * The governing elements that made the criterion stale, as the delta named
   * them right now. A `reaffirmed` disposition is checked against this: the
   * act covered the basis a human actually read, and a basis that has moved
   * since is a basis nobody judged.
   */
  readonly freshness: CriterionFreshness | null;
}

/**
 * Whether an audited reaffirmation still covers the criterion's current
 * staleness basis. Comparing the recorded element hashes against the ones the
 * delta reports now is what makes "the basis changed again" observable without
 * persisting a verdict (`computed-projections`), and it lives here — beside
 * the rule that refuses on it — so the lint finding and every read surface
 * answer the question with one implementation (`single-lint-projection`).
 */
export function reaffirmationCoversBasis(
  reaffirmation: DeliveryPlanReaffirmation,
  freshness: CriterionFreshness | null,
): boolean {
  const covered = new Set(
    reaffirmation.basis.map(
      (entry) =>
        `${entry.elementId}:${entry.reason}:${entry.currentHash ?? ""}`,
    ),
  );
  return (freshness?.basis ?? []).every((entry) =>
    covered.has(
      `${entry.elementId}:${entry.reason}:${entry.currentHash ?? ""}`,
    ),
  );
}

/**
 * The delivery gate's verdict on a claimed `delivered_elsewhere` base. The
 * plan never re-derives "earlier merged delivery" — it consumes
 * `classifyEarlierMergedDelivery` so a claim the gate would refuse can never
 * read as legal here.
 */
export interface PlanLintDeliveredElsewhereVerdict {
  readonly criterionElementId: string;
  readonly verdict: EarlierMergedDeliveryVerdict;
}

export interface DeliveryPlanLintInput {
  /** The revision every criterion judgment is made against. */
  readonly pinnedRevisionId: string;
  /** The document the attempt would carry once the staged write commits. */
  readonly document: DeliveryPlanDocument;
  readonly pinnedCriteria: readonly PlanLintCriterion[];
  readonly deliveredElsewhereVerdicts: readonly PlanLintDeliveredElsewhereVerdict[];
}

const DISPOSITION_CHOICES = DELIVERY_PLAN_DISPOSITIONS.join(", ");

/**
 * Where the audited reaffirmation act is performed. Named in the refusal
 * because a `reaffirmed` disposition an agent wrote by hand is refused, and an
 * author told only "not attested" has nowhere to go.
 */
const REAFFIRM_ACT =
  "Reaffirm it in Spec Studio (the audited human act), or set it to selected to re-deliver it";

export const DELIVERY_PLAN_LINT_RULES = [
  { ruleId: "plan/disposition-unknown-criterion", severity: "blocks_propose" },
  { ruleId: "plan/disposition-duplicate", severity: "blocks_propose" },
  { ruleId: "plan/disposition-missing", severity: "blocks_propose" },
  { ruleId: "plan/selected-unowned", severity: "blocks_propose" },
  { ruleId: "plan/selected-multi-owned", severity: "blocks_propose" },
  { ruleId: "plan/nonselected-owned", severity: "blocks_propose" },
  { ruleId: "plan/delivered-elsewhere-basis", severity: "blocks_propose" },
  { ruleId: "plan/delivered-elsewhere-stale", severity: "blocks_propose" },
  { ruleId: "plan/reaffirmed-not-soft-stale", severity: "blocks_propose" },
  { ruleId: "plan/reaffirmed-unattested", severity: "blocks_propose" },
  { ruleId: "plan/reaffirmed-stale-basis", severity: "blocks_propose" },
  { ruleId: "plan/pending-reaffirmation", severity: "blocks_propose" },
  { ruleId: "plan/duplicate-context-id", severity: "blocks_propose" },
  { ruleId: "plan/duplicate-task-id", severity: "blocks_propose" },
  { ruleId: "plan/duplicate-edge-id", severity: "blocks_propose" },
  { ruleId: "plan/dangling-task-context", severity: "blocks_propose" },
  { ruleId: "plan/dangling-edge-endpoint", severity: "blocks_propose" },
  { ruleId: "plan/self-edge", severity: "blocks_propose" },
  { ruleId: "plan/edge-cycle", severity: "blocks_propose" },
  { ruleId: "plan/empty-context", severity: "blocks_propose" },
  { ruleId: "plan/typed-context-contract-missing", severity: "blocks_propose" },
  { ruleId: "plan/duplicate-task-order", severity: "blocks_propose" },
  { ruleId: "plan/non-contiguous-task-order", severity: "blocks_propose" },
  { ruleId: "plan/dangling-criterion-reference", severity: "blocks_propose" },
  { ruleId: "plan/wiring-duplicate-capability", severity: "blocks_propose" },
  { ruleId: "plan/wiring-owner-unresolved", severity: "blocks_propose" },
] as const satisfies readonly {
  readonly ruleId: string;
  readonly severity: LintFinding["severity"];
}[];

export type DeliveryPlanLintRuleId =
  (typeof DELIVERY_PLAN_LINT_RULES)[number]["ruleId"];

const deliveryPlanLintRulesById = new Map(
  DELIVERY_PLAN_LINT_RULES.map((definition) => [definition.ruleId, definition]),
);

/** Every finding this module can raise, in the order surfaces present them. */
export function lintDeliveryPlan(input: DeliveryPlanLintInput): LintFinding[] {
  const findings: LintFinding[] = [
    ...dispositionFindings(input),
    ...graphFindings(input),
    ...wiringFindings(input),
  ];
  // `draftHealth` re-ranks by severity and preserves order within a group, so
  // a stable total order here is what makes a top-N stable across runs.
  return findings.sort(
    (left, right) =>
      left.ruleId.localeCompare(right.ruleId) ||
      left.elementHandle.localeCompare(right.elementHandle) ||
      left.message.localeCompare(right.message),
  );
}

/** The ONE plan projection every surface reads. */
export function deliveryPlanDraftHealth(
  input: DeliveryPlanLintInput,
): DraftHealth {
  return draftHealth(lintDeliveryPlan(input));
}

/**
 * The propose refusal, built from the same projection the draft receipts
 * showed. Null when nothing blocks, so a caller cannot invent its own reading
 * of "proposable".
 */
export function deliveryPlanProposeRefusal(
  health: DraftHealth,
): Refusal | null {
  if (health.blocking === 0) return null;
  return {
    code: "lint_blocked",
    unmetConditions: health.blockingFindings.map(
      (finding) => `${finding.elementHandle}: ${finding.message}`,
    ),
    instruction: `Nothing was proposed. Resolve the ${health.blocking} blocking finding${health.blocking === 1 ? "" : "s"} above — \`cctl spec plan status\` lists them at any time — then re-run \`cctl spec plan propose\`.`,
    details: {
      blocking: health.blocking,
      ruleIds: [
        ...new Set(health.blockingFindings.map((finding) => finding.ruleId)),
      ],
    },
  };
}

/**
 * The resolved wiring list for one context, rendered for its validator pack.
 * Ownership is structured in the plan precisely so this list can be produced
 * mechanically instead of a validator reading prose about "production wiring".
 */
export function wiringOwnershipForContext(
  document: DeliveryPlanDocument,
  contextId: string,
): string[] {
  return document.wiring
    .filter((entry) => entry.owner.contextId === contextId)
    .map(
      (entry) =>
        `${entry.capabilityId} — ${ownerClause(entry)}${coverageClause(entry)}`,
    )
    .sort((left, right) => left.localeCompare(right));
}

function ownerClause(entry: DeliveryPlanWiringEntry): string {
  return entry.owner.kind === "call_site"
    ? `reached from the call site ${entry.owner.locator}`
    : "wired downstream by this context";
}

function coverageClause(entry: DeliveryPlanWiringEntry): string {
  return entry.criterionElementIds.length === 0
    ? ""
    : `; covers ${entry.criterionElementIds.join(", ")}`;
}

function blocking(
  ruleId: DeliveryPlanLintRuleId,
  elementHandle: string,
  message: string,
): LintFinding {
  const definition = deliveryPlanLintRulesById.get(ruleId);
  if (definition === undefined) {
    throw new Error(`Unknown delivery-plan lint rule ${ruleId}.`);
  }
  return { ruleId, severity: definition.severity, elementHandle, message };
}

function dispositionFindings(input: DeliveryPlanLintInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const pinnedById = new Map(
    input.pinnedCriteria.map((criterion) => [
      criterion.criterionElementId,
      criterion,
    ]),
  );
  const ownersByCriterion = ownersByCriterionId(input.document.contexts);
  const verdicts = new Map(
    input.deliveredElsewhereVerdicts.map(({ criterionElementId, verdict }) => [
      criterionElementId,
      verdict,
    ]),
  );

  const seen = new Map<string, number>();
  for (const entry of input.document.dispositions) {
    seen.set(
      entry.criterionElementId,
      (seen.get(entry.criterionElementId) ?? 0) + 1,
    );
  }

  for (const [criterionElementId, count] of seen) {
    const pinned = pinnedById.get(criterionElementId);
    if (pinned === undefined) {
      findings.push(
        blocking(
          "plan/disposition-unknown-criterion",
          criterionElementId,
          `This plan dispositions ${criterionElementId}, which revision ${input.pinnedRevisionId} does not carry. Drop the entry, or open a new attempt pinned to a revision that carries it.`,
        ),
      );
      continue;
    }
    if (count > 1) {
      findings.push(
        blocking(
          "plan/disposition-duplicate",
          pinned.handle,
          `${pinned.handle} (${criterionElementId}) carries ${count} dispositions; every criterion of the pinned revision carries exactly one. Delete the extra entries.`,
        ),
      );
    }
  }

  for (const criterion of input.pinnedCriteria) {
    if (!seen.has(criterion.criterionElementId)) {
      findings.push(
        blocking(
          "plan/disposition-missing",
          criterion.handle,
          `${criterion.handle} (${criterion.criterionElementId}) has no disposition. Give it exactly one of: ${DISPOSITION_CHOICES}.`,
        ),
      );
    }
  }

  for (const entry of input.document.dispositions) {
    const pinned = pinnedById.get(entry.criterionElementId);
    if (pinned === undefined) continue;
    const owners = ownersByCriterion.get(entry.criterionElementId) ?? [];
    findings.push(
      ...ownershipFindings(pinned, entry.disposition, owners),
      ...freshnessFindings(pinned, entry, verdicts),
    );
  }

  return findings;
}

function ownershipFindings(
  pinned: PlanLintCriterion,
  disposition: DeliveryPlanDisposition,
  owners: readonly string[],
): LintFinding[] {
  if (disposition === "selected") {
    if (owners.length === 0) {
      return [
        blocking(
          "plan/selected-unowned",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is selected but no context owns it. Add it to exactly one context's criterionElementIds, or change its disposition.`,
        ),
      ];
    }
    if (owners.length > 1) {
      return [
        blocking(
          "plan/selected-multi-owned",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is owned by ${owners.join(", ")}; exactly one context must own it. Split the criterion, or make one context its sole owner and give the others an integration contract.`,
        ),
      ];
    }
    return [];
  }
  if (owners.length === 0) return [];
  return [
    blocking(
      "plan/nonselected-owned",
      pinned.handle,
      `${pinned.handle} (${pinned.criterionElementId}) is ${disposition}, so no context may own it, but ${owners.join(", ")} still list${owners.length === 1 ? "s" : ""} it. Remove it from those contexts, or select it.`,
    ),
  ];
}

function freshnessFindings(
  pinned: PlanLintCriterion,
  entry: DeliveryPlanDocument["dispositions"][number],
  verdicts: ReadonlyMap<string, EarlierMergedDeliveryVerdict>,
): LintFinding[] {
  if (entry.disposition === "delivered_elsewhere") {
    const verdict = verdicts.get(entry.criterionElementId) ?? {
      code: "missing_base" as const,
      baseExecutionId: null,
    };
    if (verdict.code !== "accepted") {
      return [
        blocking(
          "plan/delivered-elsewhere-basis",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) claims delivered_elsewhere, but ${basisReason(verdict)}. Name an earlier merged execution of this spec that delivered it, or select it.`,
        ),
      ];
    }
    if (pinned.deliveryClass === "soft_stale") {
      return [
        blocking(
          "plan/delivered-elsewhere-stale",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is soft_stale against ${verdict.baseExecutionId}, so its earlier delivery no longer stands unexamined. ${REAFFIRM_ACT}.`,
        ),
      ];
    }
    if (pinned.deliveryClass === "hard_stale") {
      return [
        blocking(
          "plan/delivered-elsewhere-stale",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is hard_stale against ${verdict.baseExecutionId}: the earlier proof proved different words. Select it and re-prove it.`,
        ),
      ];
    }
    return [];
  }

  if (entry.disposition === "reaffirmed") {
    if (pinned.deliveryClass !== "soft_stale") {
      return [
        blocking(
          "plan/reaffirmed-not-soft-stale",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is ${pinned.deliveryClass}, and only a soft_stale criterion can be reaffirmed. ${pinned.deliveryClass === "hard_stale" ? "Its text or validation strategy changed, so select it and re-prove it." : "Give it the disposition its class allows."}`,
        ),
      ];
    }
    const reaffirmation = entry.reaffirmation;
    if (reaffirmation === null || reaffirmation.actor.kind !== "human") {
      return [
        blocking(
          "plan/reaffirmed-unattested",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) is marked reaffirmed with ${reaffirmation === null ? "no audited act" : "an agent's attestation; only a human act counts"}. ${REAFFIRM_ACT}.`,
        ),
      ];
    }
    if (!reaffirmationCoversBasis(reaffirmation, pinned.freshness)) {
      return [
        blocking(
          "plan/reaffirmed-stale-basis",
          pinned.handle,
          `${pinned.handle} (${pinned.criterionElementId}) was reaffirmed against a basis that has since moved, so the act covered content nobody is now looking at. ${REAFFIRM_ACT}.`,
        ),
      ];
    }
    return [];
  }

  if (entry.disposition === "pending_reaffirmation") {
    return [
      blocking(
        "plan/pending-reaffirmation",
        pinned.handle,
        `${pinned.handle} (${pinned.criterionElementId}) is still pending_reaffirmation, which a draft may carry but a proposal may not. ${REAFFIRM_ACT}.`,
      ),
    ];
  }

  return [];
}

function basisReason(verdict: EarlierMergedDeliveryVerdict): string {
  switch (verdict.code) {
    case "missing_base":
      return "it names no earlier execution";
    case "self_reference":
      return `it names its own execution ${verdict.baseExecutionId}`;
    case "unknown_base":
      return `execution ${verdict.baseExecutionId} does not exist`;
    case "foreign_spec":
      return `execution ${verdict.baseExecutionId} belongs to another spec`;
    case "not_merged":
      return `execution ${verdict.baseExecutionId} never merged`;
    case "not_earlier":
      return `execution ${verdict.baseExecutionId} is not earlier than this plan`;
    case "base_did_not_deliver":
      return `execution ${verdict.baseExecutionId} did not deliver this criterion`;
    default:
      return `execution ${verdict.baseExecutionId} is not an earlier merged delivery`;
  }
}

function ownersByCriterionId(
  contexts: readonly DeliveryPlanContext[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const context of contexts) {
    for (const criterionElementId of context.criterionElementIds) {
      const existing = owners.get(criterionElementId);
      if (existing === undefined) {
        owners.set(criterionElementId, [context.contextId]);
      } else if (!existing.includes(context.contextId)) {
        existing.push(context.contextId);
      }
    }
  }
  return owners;
}

function graphFindings(input: DeliveryPlanLintInput): LintFinding[] {
  const { document } = input;
  const findings: LintFinding[] = [];
  const contextIds = new Set<string>();
  const pinnedIds = new Set(
    input.pinnedCriteria.map((criterion) => criterion.criterionElementId),
  );

  for (const id of duplicates(document.contexts.map((c) => c.contextId))) {
    findings.push(
      blocking(
        "plan/duplicate-context-id",
        id,
        `Two contexts share the id ${id}. Context ids address the compiled graph's nodes, so give each one its own.`,
      ),
    );
  }
  for (const context of document.contexts) contextIds.add(context.contextId);

  for (const id of duplicates(document.tasks.map((task) => task.taskId))) {
    findings.push(
      blocking(
        "plan/duplicate-task-id",
        id,
        `Two tasks share the id ${id}. Task ids address the task an agent completes, so give each one its own.`,
      ),
    );
  }
  for (const id of duplicates(document.edges.map((edge) => edge.edgeId))) {
    findings.push(
      blocking(
        "plan/duplicate-edge-id",
        id,
        `Two edges share the id ${id}. Give each dependency its own edge id.`,
      ),
    );
  }

  for (const task of document.tasks) {
    if (!contextIds.has(task.contextId)) {
      findings.push(
        blocking(
          "plan/dangling-task-context",
          task.taskId,
          `Task ${task.taskId} names context ${task.contextId}, which this plan does not carry. Point it at a context in the plan, or add that context.`,
        ),
      );
    }
  }

  findings.push(...taskOrderFindings(document, contextIds));
  findings.push(...danglingCriterionFindings(input, pinnedIds));

  for (const edge of document.edges) {
    if (edge.fromContextId === edge.toContextId) {
      findings.push(
        blocking(
          "plan/self-edge",
          edge.edgeId,
          `Edge ${edge.edgeId} runs from ${edge.fromContextId} to itself. A context cannot depend on itself; delete the edge.`,
        ),
      );
      continue;
    }
    for (const endpoint of [edge.fromContextId, edge.toContextId]) {
      if (!contextIds.has(endpoint)) {
        findings.push(
          blocking(
            "plan/dangling-edge-endpoint",
            edge.edgeId,
            `Edge ${edge.edgeId} names context ${endpoint}, which this plan does not carry. Repoint the edge, or add that context.`,
          ),
        );
      }
    }
  }

  const cycle = findCycle(document, contextIds);
  if (cycle !== null) {
    findings.push(
      blocking(
        "plan/edge-cycle",
        cycle[0] ?? "",
        `The context dependencies form a cycle: ${cycle.join(" -> ")}. A compiled graph must be acyclic; drop one of these edges.`,
      ),
    );
  }

  for (const context of document.contexts) {
    if (context.criterionElementIds.length > 0) continue;
    if (context.contextType === "delivery") {
      findings.push(
        blocking(
          "plan/empty-context",
          context.contextId,
          `Context ${context.contextId} owns no criterion. Give it one, or type it as an integration or closeout context with its own acceptance contract.`,
        ),
      );
      continue;
    }
    if (context.acceptanceContract.length === 0) {
      findings.push(
        blocking(
          "plan/typed-context-contract-missing",
          context.contextId,
          `Context ${context.contextId} is a ${context.contextType} context owning no criterion, so its acceptance contract is the only thing a validator can hold it to — and it is empty. Author what this context must make observable.`,
        ),
      );
    }
  }

  return findings;
}

function taskOrderFindings(
  document: DeliveryPlanDocument,
  contextIds: ReadonlySet<string>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const contextId of contextIds) {
    const orders = document.tasks
      .filter((task) => task.contextId === contextId)
      .map((task) => task.order)
      .sort((left, right) => left - right);
    if (orders.length === 0) continue;
    const duplicated = duplicates(orders.map(String));
    if (duplicated.length > 0) {
      findings.push(
        blocking(
          "plan/duplicate-task-order",
          contextId,
          `Context ${contextId} has more than one task at order ${duplicated.join(", ")}. Tasks run in order, so renumber them 0..${orders.length - 1}.`,
        ),
      );
      // Contiguity is unreadable while positions collide; the renumber above
      // is the same repair, so reporting both would only duplicate the ask.
      continue;
    }
    const contiguous = orders.every((order, index) => order === index);
    if (!contiguous) {
      findings.push(
        blocking(
          "plan/non-contiguous-task-order",
          contextId,
          `Context ${contextId} has task orders ${orders.join(", ")}. Renumber them 0..${orders.length - 1} so the sequence has no gap.`,
        ),
      );
    }
  }
  return findings;
}

function danglingCriterionFindings(
  input: DeliveryPlanLintInput,
  pinnedIds: ReadonlySet<string>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const report = (
    holder: string,
    relation: string,
    criterionElementIds: readonly string[],
  ) => {
    for (const criterionElementId of criterionElementIds) {
      if (pinnedIds.has(criterionElementId)) continue;
      findings.push(
        blocking(
          "plan/dangling-criterion-reference",
          holder,
          `${relation} ${criterionElementId}, which revision ${input.pinnedRevisionId} does not carry. Repoint it at a criterion the pinned revision carries, or drop the reference.`,
        ),
      );
    }
  };

  for (const context of input.document.contexts) {
    report(
      context.contextId,
      `Context ${context.contextId} owns`,
      context.criterionElementIds,
    );
    report(
      context.contextId,
      `Context ${context.contextId} plans proof for`,
      context.proofPlan.map((step) => step.criterionElementId),
    );
  }
  for (const task of input.document.tasks) {
    report(
      task.taskId,
      `Task ${task.taskId} contributes to`,
      task.contributesToCriterionElementIds,
    );
  }
  for (const entry of input.document.wiring) {
    report(
      entry.capabilityId,
      `Capability ${entry.capabilityId} covers`,
      entry.criterionElementIds,
    );
  }
  return findings;
}

/**
 * Depth-first cycle search over the context dependency edges, returning the
 * contexts on the first cycle found so the refusal can name them.
 */
function findCycle(
  document: DeliveryPlanDocument,
  contextIds: ReadonlySet<string>,
): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (!contextIds.has(edge.fromContextId)) continue;
    if (!contextIds.has(edge.toContextId)) continue;
    const existing = outgoing.get(edge.fromContextId);
    if (existing === undefined)
      outgoing.set(edge.fromContextId, [edge.toContextId]);
    else existing.push(edge.toContextId);
  }

  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  function visit(contextId: string): string[] | null {
    if (onPath.has(contextId)) {
      return [...path.slice(path.indexOf(contextId)), contextId];
    }
    if (settled.has(contextId)) return null;
    onPath.add(contextId);
    path.push(contextId);
    for (const next of outgoing.get(contextId) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    onPath.delete(contextId);
    settled.add(contextId);
    return null;
  }

  for (const contextId of contextIds) {
    const cycle = visit(contextId);
    if (cycle !== null) return cycle;
  }
  return null;
}

function wiringFindings(input: DeliveryPlanLintInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const contextIds = new Set(
    input.document.contexts.map((context) => context.contextId),
  );

  for (const capabilityId of duplicates(
    input.document.wiring.map((entry) => entry.capabilityId),
  )) {
    findings.push(
      blocking(
        "plan/wiring-duplicate-capability",
        capabilityId,
        `Capability ${capabilityId} is declared more than once, so it resolves to no single owner. Keep the one entry that names the context responsible for wiring it.`,
      ),
    );
  }

  for (const entry of input.document.wiring) {
    if (contextIds.has(entry.owner.contextId)) continue;
    findings.push(
      blocking(
        "plan/wiring-owner-unresolved",
        entry.capabilityId,
        `Capability ${entry.capabilityId} names owner context ${entry.owner.contextId}, which this plan does not carry — so nothing in this delivery wires it into production. Point it at a context in the plan, or add the context that will call it.`,
      ),
    );
  }

  return findings;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  return [...repeated].sort((left, right) => left.localeCompare(right));
}
