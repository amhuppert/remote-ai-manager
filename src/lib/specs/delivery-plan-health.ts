import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import type { ManagedDefinitionPreflightSummary } from "@/lib/workflows/managed-definition-preflight-contract";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  lintDeliveryPlanBinding,
  deriveDeliveryPlanClaims,
  type DeliveryPlanBindingLintIssue,
  type DeliveryPlanBindingLintIssueCode,
} from "./delivery-plan-binding-lint";
import { renderSeededDeliveryPlanMission } from "./delivery-plan-charter-seed";
import { isServerOwnedDeliveryPlanSource } from "./delivery-plan-finalization";
import type { DeliveryPlanUnresolvedView } from "./delivery-plan-views";
import type { LintFinding } from "./lint";
import {
  CHARTER_UNAUTHORED_RATIONALE,
  CRITERION_MUST_RUN_RATIONALE,
} from "./refusal-rationale";
import { elementHandleInSnapshot } from "./review-state";
import type { SpecRevisionSnapshot } from "./schemas";

/**
 * The one reading of what an authored delivery-plan draft still owes. `plan
 * status`, a mutation receipt, Spec Studio's lifecycle panel, and the propose
 * refusal all render this projection, so a status that reports nothing blocking
 * and a propose that refuses cannot coexist.
 *
 * Both refusal surfaces come out of the same pass: `findings` is the
 * handle-addressed reading a human reads, `refusalConditions` the
 * path-addressed reading the authoring agent corrects its file by.
 */
export interface DeliveryPlanDraftHealth {
  readonly findings: readonly DeliveryPlanGateFinding[];
  readonly unresolved: readonly DeliveryPlanUnresolvedView[];
  readonly refusalConditions: readonly string[];
  /**
   * Both sides of the claims ledger AS THIS PROJECTION JUDGED THEM. It lives on
   * the health rather than being recomputed by each surface because "claimed"
   * is not a property of the binding: a claim only counts when its context is
   * among the graph-declared stable authored accountability sources, which only
   * the admission knows. A ledger that counted claim records instead would
   * report a criterion covered in the same breath the gate refuses it.
   */
  readonly claims: DeliveryPlanClaimsLedger;
}

/** Selected criteria, and how many of them a stable authored source claims. */
export interface DeliveryPlanClaimsLedger {
  readonly selected: number;
  readonly claimed: number;
  readonly unclaimed: number;
}

export interface DeliveryPlanDraftHealthInput {
  readonly pinnedRevision: SpecRevisionSnapshot;
  readonly binding: DeliveryPlanBinding;
  readonly admission: AuthoredWorkflowLaunchAdmissionResult;
  /**
   * The managed definition's charter, typed by the graph's own schema. Native
   * SDD reads the launch document; it never restates its shape.
   */
  readonly draftCharter: WorkflowCharter;
  /** The definition the charter remedy names. */
  readonly workflowDefinitionId: string;
}

/** The rule id a refused graph launch reports under. */
export const LAUNCH_NOT_ADMISSIBLE_RULE_ID = "launch/not-admissible";

/** The rule id an unauthored charter refuses proposal under. */
export const LAUNCH_CHARTER_UNAUTHORED_RULE_ID = "launch/charter-unauthored";

/** The rule id a draft whose pinned revision cannot be read refuses under. */
export const PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID =
  "plan/pinned-revision-unavailable";

/** The rule id a draft whose managed definition is missing refuses under. */
export const PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID =
  "plan/workflow-definition-unavailable";

/**
 * The rule id an admitted launch's graph advisories report under.
 *
 * The shared admission service answers with both halves — `issues` refuse,
 * `warnings` do not — and the ordinary `workflow validate` surface prints both.
 * Reading only the refusing half here would make the same launch bytes read
 * clean through a spec proposal and warned through an ordinary validate, which
 * is the dialect divergence the one-graph-dialect boundary exists to prevent.
 * The advisory is forwarded verbatim rather than re-derived: the graph owns the
 * finding, this projection only carries it.
 */
export const LAUNCH_ADVISORY_RULE_ID = "launch/advisory";

/**
 * The gate rules that are not binding lint: launch admission, the charter
 * check, and the two readability findings the service's `healthOf` raises.
 * Listed as a value so the published taxonomy derives from it — a rule this
 * array does not carry cannot be reported, because {@link
 * DeliveryPlanGateRuleId} is what a finding's `ruleId` has to be.
 */
export const DELIVERY_PLAN_GATE_RULE_IDS = [
  "plan/coverage-upgrade-required",
  LAUNCH_NOT_ADMISSIBLE_RULE_ID,
  LAUNCH_ADVISORY_RULE_ID,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
  PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
  PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
] as const;

export type DeliveryPlanGateRuleId =
  | DeliveryPlanBindingLintIssueCode
  | (typeof DELIVERY_PLAN_GATE_RULE_IDS)[number];

/** A draft-health finding, narrowed to the rules the propose gate publishes. */
export interface DeliveryPlanGateFinding extends LintFinding {
  readonly ruleId: DeliveryPlanGateRuleId;
}

/**
 * The reason a finding's rule exists, for the codes whose friction is the
 * design. The refusal that carries them renders one `why:` line built from
 * these; a code absent here is a document repair that explains itself.
 */
const ISSUE_RATIONALE: Partial<
  Record<DeliveryPlanBindingLintIssueCode, string>
> = {
  "coverage/not-must-run": CRITERION_MUST_RUN_RATIONALE,
};

/**
 * The act each criterion-owed finding names. A code absent here refuses
 * proposal but owes no per-criterion act — a duplicate or unknown id is a
 * document repair, not an outstanding disposition.
 */
const UNRESOLVED_RESOLUTION: Partial<
  Record<DeliveryPlanBindingLintIssueCode, string>
> = {
  "coverage/selected-criterion-uncovered":
    "Add covers on a criterion in a stable authored context with workflow replace, or change its disposition in Spec Studio.",
  "coverage/not-must-run":
    "Add covers on an always-run closeout criterion that verifies whichever route ran, using workflow replace.",
  "binding/pending-reaffirmation":
    "Reaffirm it in Spec Studio, or select it for re-delivery in this plan.",
  "binding/reaffirmed-without-delivery":
    "Name the earlier execution whose delivery this reaffirmation stands on.",
};

/**
 * The one `why:` line a propose refusal carries: the distinct rationales of the
 * findings that refuse it. Composed here rather than at the refusal so the
 * reason a rule exists travels with the rule.
 */
export function deliveryPlanRefusalRationale(
  health: DeliveryPlanDraftHealth,
): string | undefined {
  const rationales = [
    ...new Set(
      health.findings.flatMap((finding) =>
        finding.severity === "blocks_propose" && finding.rationale !== undefined
          ? [finding.rationale]
          : [],
      ),
    ),
  ];
  return rationales.length === 0 ? undefined : rationales.join("; ");
}

/**
 * The ledger the propose-gate surfaces print. It is the preflight's own
 * summary shape rather than a parallel one: `workflow validate --definition`
 * reads it off the wire and the spec verbs read it off the view, and one type
 * is what keeps the two renderings the same reading.
 */
export type DeliveryPlanLedgerSummary = ManagedDefinitionPreflightSummary;

/**
 * Both sides of what a draft owes, counted once (#80 design 3.3). The claims,
 * disposition and charter numbers every propose-gate surface reports come from
 * here — the binding it was linted from and the health projection that judged
 * it — so a status and a preflight cannot disagree about how much is covered.
 */
export function deliveryPlanLedgerSummary(input: {
  readonly binding: DeliveryPlanBinding;
  /** Null only when the managed definition itself is unreadable. */
  readonly workflowCharter: WorkflowCharter | null;
  readonly health: DeliveryPlanDraftHealth;
}): DeliveryPlanLedgerSummary {
  const counts = new Map<string, number>();
  for (const disposition of input.binding.dispositions) {
    counts.set(
      disposition.disposition,
      (counts.get(disposition.disposition) ?? 0) + 1,
    );
  }
  return {
    ...input.health.claims,
    dispositions: [...counts].map(([kind, count]) => ({ kind, count })),
    charter: {
      state: input.health.findings.some(
        (finding) => finding.ruleId === LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      )
        ? "seed_stub"
        : "authored",
      invariantCount: input.workflowCharter?.invariants?.length ?? 0,
      sourceCount: input.workflowCharter?.sourcesOfTruth.length ?? 0,
    },
  };
}

/** The criteria the binding puts in scope, by id. */
export function selectedDeliveryPlanCriterionIds(
  binding: DeliveryPlanBinding,
): Set<string> {
  return new Set(
    binding.dispositions.flatMap((disposition) =>
      disposition.disposition === "in_scope"
        ? [disposition.criterionElementId]
        : [],
    ),
  );
}

/**
 * The claims of a frozen attempt. Propose refuses on every binding finding,
 * including an unstable claimant and an unclaimed selection, so the selection a
 * candidate froze IS the claim set the gate certified — and re-deriving it
 * would need an admission of bytes nobody can still change.
 */
export function certifiedDeliveryPlanClaims(
  binding: DeliveryPlanBinding,
): DeliveryPlanClaimsLedger {
  const selected = selectedDeliveryPlanCriterionIds(binding).size;
  return { selected, claimed: selected, unclaimed: 0 };
}

/**
 * The claims of a draft nothing could judge — an unreadable pinned revision or
 * a missing managed definition. Nothing proves a claimant is stable, so nothing
 * is counted as claimed.
 */
export function unprovenDeliveryPlanClaims(
  binding: DeliveryPlanBinding,
): DeliveryPlanClaimsLedger {
  const selected = selectedDeliveryPlanCriterionIds(binding).size;
  return { selected, claimed: 0, unclaimed: selected };
}

/**
 * Selected criteria claimed by at least one context the graph declared a stable
 * authored accountability source. `stableContextIds` is null when no admission
 * answered, in which case nothing is provably claimed.
 */
function claimsLedger(
  binding: DeliveryPlanBinding,
  definition: WorkflowSemanticDefinition | null,
  stableContextIds: ReadonlySet<string> | null,
): DeliveryPlanClaimsLedger {
  const selected = selectedDeliveryPlanCriterionIds(binding);
  const claimed = new Set(
    stableContextIds === null || definition === null
      ? []
      : deriveDeliveryPlanClaims(binding, definition, [
          ...stableContextIds,
        ]).flatMap((claim) =>
          stableContextIds.has(claim.contextId)
            ? claim.criterionElementIds.filter((criterionElementId) =>
                selected.has(criterionElementId),
              )
            : [],
        ),
  );
  return {
    selected: selected.size,
    claimed: claimed.size,
    unclaimed: selected.size - claimed.size,
  };
}

export function projectDeliveryPlanDraftHealth(
  input: DeliveryPlanDraftHealthInput,
): DeliveryPlanDraftHealth {
  // The governance rule reads the charter, so it is projected whatever the
  // graph says. An inadmissible launch used to short-circuit the projection,
  // which hid the charter refusal until the graph was fixed and then raised it
  // for the first time — one correction reporting two rounds of refusals.
  const charterFindings = charterUnauthoredFindings(input);
  const charterConditions = charterFindings.map(
    (finding) => `${finding.elementHandle}: ${finding.message}`,
  );

  if (!input.admission.ok) {
    return {
      findings: [
        ...input.admission.issues.map(
          (issue): DeliveryPlanGateFinding => ({
            ruleId: LAUNCH_NOT_ADMISSIBLE_RULE_ID,
            severity: "blocks_propose",
            elementHandle: issue.path,
            message: issue.message,
          }),
        ),
        ...charterFindings,
      ],
      unresolved: [],
      refusalConditions: [
        ...input.admission.issues.map(
          (issue) => `${issue.path}: ${issue.message}`,
        ),
        ...charterConditions,
      ],
      claims: claimsLedger(input.binding, null, null),
    };
  }

  const issues = lintDeliveryPlanBinding({
    pinnedRevision: input.pinnedRevision,
    binding: input.binding,
    admission: input.admission,
  });
  const dispositions = new Map(
    input.binding.dispositions.map((entry) => [
      entry.criterionElementId,
      entry,
    ]),
  );

  return {
    findings: [
      ...issues.map(
        (issue): DeliveryPlanGateFinding => ({
          ruleId: issue.code,
          severity: "blocks_propose",
          elementHandle: handleFor(input.pinnedRevision, issue),
          message: issue.message,
          ...rationaleFor(issue.code),
        }),
      ),
      ...charterFindings,
      ...input.admission.warnings.map(
        (warning): DeliveryPlanGateFinding => ({
          ruleId: LAUNCH_ADVISORY_RULE_ID,
          severity: "advisory",
          elementHandle: warning.path,
          message: warning.message,
        }),
      ),
    ],
    unresolved: unresolvedRows(input.pinnedRevision, issues, dispositions),
    refusalConditions: [
      ...issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      ...charterConditions,
    ],
    claims: claimsLedger(
      input.binding,
      input.admission.launch.definition,
      new Set(input.admission.stableAccountabilityContextIds),
    ),
  };
}

function rationaleFor(code: DeliveryPlanBindingLintIssueCode): {
  rationale?: string;
} {
  const rationale = ISSUE_RATIONALE[code];
  return rationale === undefined ? {} : { rationale };
}

/**
 * The governance rule (design 3.5). A draft whose mission is still the text the
 * server seeded, or whose charter names nothing beyond the entries the server
 * injects, has been planned but not governed — and propose is the last moment
 * anyone can say so, because the candidate freezes the charter it carries.
 *
 * Both halves report under one code and one reason, addressed at the charter
 * field that fails, so a planner correcting one is not told twice about it.
 */
function charterUnauthoredFindings(
  input: DeliveryPlanDraftHealthInput,
): DeliveryPlanGateFinding[] {
  const remedy = `store an authored charter with \`cctl workflow replace ${input.workflowDefinitionId} --file <plan.json>\``;
  const findings: DeliveryPlanGateFinding[] = [];
  const seededMission = renderSeededDeliveryPlanMission({
    pinnedRevision: input.pinnedRevision,
  });
  if (input.draftCharter.mission.trim() === seededMission.trim()) {
    findings.push({
      ruleId: LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      severity: "blocks_propose",
      elementHandle: "charter.mission",
      message: `The mission is still the text \`spec plan open\` seeded from the spec's intent; ${remedy}.`,
      rationale: CHARTER_UNAUTHORED_RATIONALE,
    });
  }
  if (
    input.draftCharter.sourcesOfTruth.every(isServerOwnedDeliveryPlanSource)
  ) {
    findings.push({
      ruleId: LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      severity: "blocks_propose",
      elementHandle: "charter.sourcesOfTruth",
      message: `The charter cites only the sources the server injects, so it names no authority an implementer resolves a conflict against; ${remedy}.`,
      rationale: CHARTER_UNAUTHORED_RATIONALE,
    });
  }
  return findings;
}

function handleFor(
  pinnedRevision: SpecRevisionSnapshot,
  issue: DeliveryPlanBindingLintIssue,
): string {
  if (issue.criterionElementId === null) return issue.path.join(".");
  return (
    elementHandleInSnapshot(pinnedRevision, issue.criterionElementId) ??
    issue.criterionElementId
  );
}

/**
 * One row per criterion, not per finding: a criterion that is both unclaimed
 * and outside the must-run set owes one act, and the first finding names it.
 */
function unresolvedRows(
  pinnedRevision: SpecRevisionSnapshot,
  issues: readonly DeliveryPlanBindingLintIssue[],
  dispositions: ReadonlyMap<
    string,
    DeliveryPlanBinding["dispositions"][number]
  >,
): DeliveryPlanUnresolvedView[] {
  const rows: DeliveryPlanUnresolvedView[] = [];
  const named = new Set<string>();
  for (const issue of issues) {
    const criterionElementId = issue.criterionElementId;
    const resolution = UNRESOLVED_RESOLUTION[issue.code];
    if (criterionElementId === null || resolution === undefined) continue;
    if (named.has(criterionElementId)) continue;
    const disposition = dispositions.get(criterionElementId);
    if (disposition === undefined) continue;
    named.add(criterionElementId);
    rows.push({
      criterionElementId,
      handle:
        elementHandleInSnapshot(pinnedRevision, criterionElementId) ??
        criterionElementId,
      disposition: disposition.disposition,
      resolution,
    });
  }
  return rows;
}
