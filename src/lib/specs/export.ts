import { isDeepStrictEqual } from "node:util";

import {
  isTerminalStatus,
  type GraphWorkflowStatus,
  type SeededWorkflowDocument,
} from "@/lib/workflow-graph/spec-bridge";
import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionContentHash,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import type { LinkedWorkflowObservation } from "./abandon-coordinator";
import { pinnedSpecDocumentPath } from "./delivery-plan";
import type {
  SpecWorkflowCleanupObservation,
  SpecWorkflowCleanupTarget,
} from "./execution-service";
import {
  DISMISS_SUPERSEDED_SURFACE,
  HUMAN_REVIEW_SURFACE,
  liveProposals,
  supersedingRevision,
} from "./proposal-integrity";
import { toLintSnapshot } from "./review-state";
import type { IntegrityReport, SpecConsistencyFinding } from "./view-schemas";

export interface SpecExportRevision {
  readonly snapshot: SpecRevisionSnapshot;
}

/**
 * A delivery execution paired with where its linked run actually stands. The
 * observation is the abandon coordinator's own vocabulary and comes from the
 * same `observe` seam, so verification and cleanup can never disagree about
 * whether a run is still live or still owns the session's slot.
 */
export interface SpecExportExecution {
  readonly execution: SpecExecutionRow;
  readonly linkedWorkflow: LinkedWorkflowObservation;
}

export interface SpecExportState {
  readonly spec: Spec;
  readonly revisions: SpecExportRevision[];
  readonly approvals: SpecApprovalRow[];
  readonly gateAdmissions: SpecGateAdmissionRow[];
  readonly questions: SpecQuestionRow[];
  readonly assumptions: SpecAssumptionRow[];
  readonly executions: SpecExportExecution[];
}

export interface SpecExportDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  delivery: SpecDeliveryRepo;
  /**
   * The `observe` half of the production spec→workflow cleanup port. Verify
   * only ever reads through it: reporting an orphan must never move one.
   */
  observeLinkedWorkflow(
    target: SpecWorkflowCleanupTarget,
  ): Promise<SpecWorkflowCleanupObservation>;
}

export interface CanonicalMarkdownFile {
  readonly path: string;
  readonly content: string;
}

export interface CanonicalSpecBundle {
  readonly markdownFiles: CanonicalMarkdownFile[];
  readonly manifest: string;
}

export const CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION = 3;

export type CanonicalSpecBundleComparison =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "bundle_format_mismatch";
      readonly message: string;
      readonly instruction: string;
      readonly issue: { readonly path: string; readonly message: string };
      readonly currentFormatVersion: number;
      readonly againstFormatVersion: number;
    }
  | {
      readonly ok: false;
      readonly code: "integrity_mismatch";
      readonly message: string;
      readonly instruction: string;
      readonly issue: { readonly path: string; readonly message: string };
    };

function canonicalBundleFormatVersion(
  bundle: CanonicalSpecBundle,
): number | null {
  try {
    const manifest: unknown = JSON.parse(bundle.manifest);
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("formatVersion" in manifest)
    ) {
      return null;
    }
    const formatVersion = manifest.formatVersion;
    return typeof formatVersion === "number" &&
      Number.isSafeInteger(formatVersion) &&
      formatVersion > 0
      ? formatVersion
      : null;
  } catch {
    return null;
  }
}

export function compareCanonicalSpecBundles(
  current: CanonicalSpecBundle,
  against: CanonicalSpecBundle,
): CanonicalSpecBundleComparison {
  const currentFormatVersion = canonicalBundleFormatVersion(current);
  const againstFormatVersion = canonicalBundleFormatVersion(against);
  if (
    currentFormatVersion !== null &&
    againstFormatVersion !== null &&
    currentFormatVersion !== againstFormatVersion
  ) {
    return {
      ok: false,
      code: "bundle_format_mismatch",
      currentFormatVersion,
      againstFormatVersion,
      message: `canonical bundle format ${againstFormatVersion} differs from current format ${currentFormatVersion}`,
      instruction:
        "Export a fresh canonical bundle, then verify against that file.",
      issue: {
        path: "bundle.manifest.formatVersion",
        message: `expected current format ${currentFormatVersion}, found ${againstFormatVersion}`,
      },
    };
  }
  if (isDeepStrictEqual(current, against)) return { ok: true };
  return {
    ok: false,
    code: "integrity_mismatch",
    message: "current canonical export differs",
    instruction:
      "Review the live spec or export a fresh canonical bundle before continuing.",
    issue: { path: "bundle", message: "current canonical export differs" },
  };
}

/**
 * The report type is the schema's, not a parallel hand-written copy: the wire
 * contract and the producer cannot drift apart if there is only one of them.
 */
export type { IntegrityReport };
export type IntegrityMismatch = IntegrityReport["mismatches"][number];

export class SpecExportNotFoundError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} was not found`);
    this.name = "SpecExportNotFoundError";
  }
}

export async function loadSpecExportState(
  deps: SpecExportDeps,
  specId: string,
): Promise<SpecExportState> {
  const spec = await deps.specs.findById(specId);
  if (spec === null) throw new SpecExportNotFoundError(specId);
  const revisions = await deps.specs.listRevisions(spec.id);
  const snapshots = await Promise.all(
    revisions.map((revision) => deps.specs.getRevisionSnapshot(revision.id)),
  );
  const loadedRevisions = snapshots.map((snapshot, index) => {
    if (snapshot === null) {
      throw new SpecExportNotFoundError(revisions[index]!.id);
    }
    return { snapshot };
  });
  const gateAdmissions = loadedRevisions.flatMap(({ snapshot }) =>
    deps.review.findGateAdmissionsByRevision(snapshot.revision.id),
  );
  const executions = await Promise.all(
    deps.delivery.findExecutionsBySpecId(spec.id).map(async (execution) => ({
      execution,
      linkedWorkflow: await observeLinkedWorkflow(
        deps,
        spec.projectPath,
        execution,
      ),
    })),
  );
  return {
    spec,
    revisions: loadedRevisions,
    approvals: deps.review.findApprovalsBySpecId(spec.id),
    gateAdmissions,
    questions: deps.review.findQuestionsBySpecId(spec.id),
    assumptions: deps.review.findAssumptionsBySpecId(spec.id),
    executions,
  };
}

/**
 * The run an execution is answerable for. `linked_workflow_execution_id` is the
 * coordinator's pinned target and wins where it exists; falling back to
 * `workflow_execution_id` is what reaches the pre-coordinator rows, which were
 * abandoned without ever pinning anything and are exactly the orphans verify
 * has to find.
 */
async function observeLinkedWorkflow(
  deps: SpecExportDeps,
  projectPath: string,
  execution: SpecExecutionRow,
): Promise<LinkedWorkflowObservation> {
  const workflowExecutionId =
    execution.linked_workflow_execution_id ?? execution.workflow_execution_id;
  if (workflowExecutionId === null || execution.session_name === null) {
    return { kind: "never_launched" };
  }
  const observation = await deps.observeLinkedWorkflow({
    projectPath,
    sessionName: execution.session_name,
    workflowExecutionId,
  });
  return observation.kind === "missing"
    ? { kind: "missing", workflowExecutionId }
    : { ...observation, workflowExecutionId };
}

function revisionFileName(snapshot: SpecRevisionSnapshot): string {
  return `revisions/${String(snapshot.revision.number).padStart(4, "0")}-${snapshot.revision.state}.md`;
}

function renderElement(row: SpecRevisionElement, handle: string): string {
  const { payload } = row.version;
  switch (payload.kind) {
    case "section":
      return [
        `## ${payload.title}`,
        `<!-- element:${row.element.id} role:${payload.role} -->`,
        payload.body,
      ].join("\n\n");
    case "requirement":
      return [
        `## ${handle} — Requirement`,
        `<!-- element:${row.element.id} -->`,
        payload.statement,
        `- Priority: ${payload.priority}`,
        `- Risk: ${payload.risk}`,
      ].join("\n\n");
    case "criterion":
      return [
        `### ${handle} — Acceptance criterion`,
        `<!-- element:${row.element.id} parent:${row.element.parentElementId} -->`,
        payload.text,
        `Validation strategy: ${payload.validationStrategy.kinds.join(", ")}`,
        ...(payload.validationStrategy.note === undefined
          ? []
          : [payload.validationStrategy.note]),
      ].join("\n\n");
    case "decision":
      return [
        `## ${handle} — ${payload.title}`,
        `<!-- element:${row.element.id} -->`,
        `Chosen approach: ${payload.chosenApproach}`,
        `Reason: ${payload.reason}`,
        "Rejected alternatives:",
        ...(payload.rejectedAlternatives.length === 0
          ? ["- None"]
          : payload.rejectedAlternatives.map(
              (alternative) => `- ${alternative.label}: ${alternative.reason}`,
            )),
      ].join("\n\n");
    case "task":
      return [
        `## ${handle} — ${payload.title}`,
        `<!-- element:${row.element.id} -->`,
        payload.instructions,
        `- Requirements: ${payload.tracedRequirementElementIds.join(", ") || "None"}`,
        `- Criteria: ${payload.coveredCriterionElementIds.join(", ") || "None"}`,
        `- Dependencies: ${payload.dependsOnTaskElementIds.join(", ") || "None"}`,
        ...(payload.laneGroup === undefined
          ? []
          : [`- Lane group: ${payload.laneGroup}`]),
        // Optional payload fields stay absent when undeclared, so two bundles
        // in the same canonical format compare equal; a declared lane is
        // ordinary content that differs like any other field.
        ...(payload.executionLane === undefined
          ? []
          : [`- Execution lane: ${payload.executionLane}`]),
        ...(payload.touchedPaths === undefined
          ? []
          : [`- Touched paths: ${payload.touchedPaths.join(", ") || "None"}`]),
      ].join("\n\n");
  }
}

function renderedRevisionElements(
  elements: readonly SpecRevisionElement[],
): SpecRevisionElement[] {
  const ordered = [...elements].sort((left, right) =>
    left.version.position === right.version.position
      ? left.element.id.localeCompare(right.element.id)
      : left.version.position - right.version.position,
  );
  const childrenByParent = new Map<string, SpecRevisionElement[]>();
  const knownElementIds = new Set(ordered.map(({ element }) => element.id));
  for (const row of ordered) {
    const parentElementId = row.element.parentElementId;
    if (parentElementId === null || !knownElementIds.has(parentElementId)) {
      continue;
    }
    const siblings = childrenByParent.get(parentElementId) ?? [];
    siblings.push(row);
    childrenByParent.set(parentElementId, siblings);
  }

  const rendered: SpecRevisionElement[] = [];
  const emitted = new Set<string>();
  const appendSubtree = (row: SpecRevisionElement): void => {
    if (emitted.has(row.element.id)) return;
    emitted.add(row.element.id);
    rendered.push(row);
    for (const child of childrenByParent.get(row.element.id) ?? []) {
      appendSubtree(child);
    }
  };

  for (const row of ordered) {
    if (
      row.element.parentElementId === null ||
      !knownElementIds.has(row.element.parentElementId)
    ) {
      appendSubtree(row);
    }
  }
  for (const row of ordered) appendSubtree(row);
  return rendered;
}

export function renderRevisionMarkdown(
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
): string {
  const handles = new Map(
    toLintSnapshot(spec, snapshot).elements.map((element) => [
      element.id,
      element.handle,
    ]),
  );
  return [
    `# ${spec.name}`,
    `- Spec: ${spec.slug}`,
    `- Revision: ${snapshot.revision.number}`,
    `- State: ${snapshot.revision.state}`,
    `- Authoring stage: ${snapshot.revision.authoringStage}`,
    `- Content hash: ${snapshot.revision.contentHash ?? "editable"}`,
    ...renderedRevisionElements(snapshot.elements).map((row) =>
      renderElement(row, handles.get(row.element.id) ?? row.element.id),
    ),
    "",
  ].join("\n\n");
}

/**
 * The ordering contract the repository enforces, stated in the export so a
 * reader of a bundle does not have to infer it from the rows (R24.12).
 * `position` is one global order per revision — not a per-parent order — and
 * nesting is read from the parent element alone.
 */
const ELEMENT_ORDERING_CONTRACT = {
  scope: "revision",
  sortKeys: ["position", "elementId"],
  nesting: "parentElementId",
  renderedTraversal: "parent-then-children",
  omittedPositionOnCreate: "append",
} as const;

function manifestFor(state: SpecExportState): unknown {
  return {
    // Format 3 declares parent-first canonical Markdown. Bundle comparison
    // reports this version boundary separately from ordinary content drift.
    formatVersion: CURRENT_CANONICAL_SPEC_BUNDLE_FORMAT_VERSION,
    elementOrdering: ELEMENT_ORDERING_CONTRACT,
    spec: state.spec,
    revisions: state.revisions.map(({ snapshot }) => {
      const handles = new Map(
        toLintSnapshot(state.spec, snapshot).elements.map((element) => [
          element.id,
          element.handle,
        ]),
      );
      return {
        id: snapshot.revision.id,
        number: snapshot.revision.number,
        state: snapshot.revision.state,
        authoringStage: snapshot.revision.authoringStage,
        basedOnRevisionId: snapshot.revision.basedOnRevisionId,
        contentHash: snapshot.revision.contentHash,
        proposedAt: snapshot.revision.proposedAt,
        approvedAt: snapshot.revision.approvedAt,
        createdAt: snapshot.revision.createdAt,
        elements: snapshot.elements.map(({ element, version }) => ({
          id: element.id,
          handle: handles.get(element.id) ?? element.id,
          kind: element.kind,
          number: element.number,
          parentElementId: element.parentElementId,
          position: version.position,
          payload: version.payload,
          payloadHash: version.payloadHash,
          elementVersion: version.elementVersion,
        })),
      };
    }),
    approvals: [...state.approvals].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    gateAdmissions: [...state.gateAdmissions].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    questions: [...state.questions].sort(
      (left, right) => left.number - right.number,
    ),
    assumptions: [...state.assumptions].sort(
      (left, right) => left.number - right.number,
    ),
  };
}

/**
 * Re-exported at the renderer's own surface: the locator is declared beside the
 * governance entry that cites it, in a module the plan-authoring surfaces can
 * import without pulling the export renderer's dependencies with it.
 */
export { pinnedSpecDocumentPath };

/**
 * The pinned spec revision as the document seeded into every lane worktree at
 * launch. Rendered through the same {@link renderRevisionMarkdown} the canonical
 * bundle uses, so a lane reads byte-for-byte what `cctl spec export` writes for
 * that revision — one renderer, no second copy to drift.
 *
 * It renders the SNAPSHOT the caller pins, never live spec state: an amendment
 * proposed mid-run moves the spec's draft, and a validator judging the run must
 * still judge the contract the run was launched against.
 */
export function buildPinnedSpecDocument(
  spec: Spec,
  pinned: SpecRevisionSnapshot,
): SeededWorkflowDocument {
  return {
    relativePath: pinnedSpecDocumentPath(spec.slug),
    contents: renderRevisionMarkdown(spec, pinned),
    description: `The pinned spec ${spec.slug} at revision ${pinned.revision.number} — the contract this run implements.`,
    readWhen:
      "Read before judging whether work satisfies the spec; it is the pinned contract, not live spec state.",
  };
}

export function renderCanonicalBundle(
  state: SpecExportState,
): CanonicalSpecBundle {
  return {
    markdownFiles: state.revisions.map(({ snapshot }) => ({
      path: revisionFileName(snapshot),
      content: renderRevisionMarkdown(state.spec, snapshot),
    })),
    manifest: `${stableStringify(manifestFor(state))}\n`,
  };
}

export function verifyExportState(state: SpecExportState): IntegrityReport {
  const checkedRevisionIds: string[] = [];
  const mismatches: IntegrityMismatch[] = [];
  for (const { snapshot } of state.revisions) {
    const expectedContentHash = snapshot.revision.contentHash;
    if (expectedContentHash === null) continue;
    checkedRevisionIds.push(snapshot.revision.id);
    const actualContentHash = computeSpecRevisionContentHash(
      snapshot.revision.authoringStage,
      snapshot.elements,
    );
    const mismatchedElementIds = snapshot.elements
      .filter(
        ({ version }) =>
          computeSpecElementPayloadHash(version.payload) !==
          version.payloadHash,
      )
      .map(({ element }) => element.id);
    if (
      actualContentHash === expectedContentHash &&
      mismatchedElementIds.length === 0
    ) {
      continue;
    }
    mismatches.push({
      revisionId: snapshot.revision.id,
      expectedContentHash,
      actualContentHash,
      mismatchedElementIds,
    });
  }
  return {
    ok: mismatches.length === 0,
    checkedRevisionIds,
    mismatches,
    consistencyFindings: [
      ...executionLifecycleFindings(state),
      ...proposalIntegrityFindings(state),
    ],
  };
}

/**
 * Whether the pinned run still holds the session's execution lease. Not the
 * row's position: a terminal record left in the active row holds nothing and
 * is normalized into History by the next launch, so reporting it as owning
 * the session would be a finding with no act behind it.
 */
function ownsExecutionSlot(linked: LinkedWorkflowObservation): boolean {
  return linked.kind === "active" && linked.leaseHeld;
}

/** The placed run, or null when nothing was launched or nothing remains. */
function placedWorkflow(linked: LinkedWorkflowObservation): {
  workflowExecutionId: string;
  status: GraphWorkflowStatus;
} | null {
  return linked.kind === "active" || linked.kind === "archived"
    ? { workflowExecutionId: linked.workflowExecutionId, status: linked.status }
    : null;
}

function linkedWorkflowId(linked: LinkedWorkflowObservation): string | null {
  return linked.kind === "never_launched" ? null : linked.workflowExecutionId;
}

/**
 * The two ways a delivery execution can be left in a state nothing will move
 * on its own (design §10).
 *
 * The `abandoning` finding is deliberately NOT gated on the linked run: the
 * two cleanup phases leave different residues — `abort_workflow` can leave the
 * run still holding the lease, and `finalize` leaves it lease-free while the
 * spec execution is still stuck. Gating on liveness would report the first and
 * silently drop the second, which is the one no other surface shows.
 */
function executionLifecycleFindings(
  state: SpecExportState,
): SpecConsistencyFinding[] {
  const findings: SpecConsistencyFinding[] = [];
  for (const { execution, linkedWorkflow } of state.executions) {
    const placed = placedWorkflow(linkedWorkflow);
    const common = {
      family: "execution-lifecycle",
      specExecutionId: execution.id,
      cleanupPhase: execution.cleanup_phase,
      workflowExecutionId: linkedWorkflowId(linkedWorkflow),
      workflowStatus: placed === null ? null : placed.status,
      ownsExecutionSlot: ownsExecutionSlot(linkedWorkflow),
    } as const;
    if (execution.state === "abandoning") {
      findings.push({
        ...common,
        code: "abandon_cleanup_unfinished",
        detail: `Spec execution ${execution.id} stopped mid-abandonment at the ${execution.cleanup_phase ?? "abort_workflow"} phase${
          execution.cleanup_last_error === null
            ? ""
            : `: ${execution.cleanup_last_error}`
        }`,
        remedy: `Retry the same command to resume the cleanup from where it stopped: cctl spec abandon ${state.spec.slug} --execution ${execution.id} --reason <reason>`,
      });
      continue;
    }
    if (execution.state !== "abandoned") continue;
    // Only a run that still HOLDS the lease is an orphan with an exit. A
    // lease-free record — archived, or terminal but not yet normalized —
    // blocks nothing and is relocated by the next launch, so reporting it
    // would be a finding no act could ever clear.
    if (linkedWorkflow.kind !== "active" || !linkedWorkflow.leaseHeld) continue;
    const { workflowExecutionId, status } = linkedWorkflow;
    // Terminality is the lifecycle contract's answer, never a local one.
    const live = !isTerminalStatus(status);
    // No coordinator re-entry exists from `abandoned`, so re-running abandon
    // would report success over the orphan instead of clearing it. The exit is
    // workflow-side, and WHICH verb follows from the blocker's own state: a
    // halted run holds the lease because its halt is resumable, and abandon is
    // the one act that ends that tenure while preserving the halt reason;
    // anything else still holding it is ended by abort, which releases on its
    // own.
    findings.push({
      ...common,
      code: "abandoned_execution_workflow_unreleased",
      detail: `Spec execution ${execution.id} is abandoned, but graph workflow execution ${workflowExecutionId} is ${live ? "still live" : "still holding this session's execution lease"} (${status})`,
      remedy:
        status === "halted"
          ? `Abandon it with 'cctl workflow abandon --reason <reason> --execution ${workflowExecutionId}'`
          : `Abort it with 'cctl workflow live abort --reason <reason>' — that releases the lease`,
    });
  }
  return findings;
}

/**
 * Ticket #50's dead end, reported until it is disposed of. Eligibility comes
 * from the shared supersession predicate, so verify can never offer a dismissal
 * the dismiss act would refuse — or stay silent on one it would accept.
 *
 * A lone live proposal nothing has forked past is the ordinary "awaiting
 * review" state and is not a finding; a second live proposal is, because one of
 * the two has to be disposed of before either can be signed off.
 */
function proposalIntegrityFindings(
  state: SpecExportState,
): SpecConsistencyFinding[] {
  const revisions: SpecRevision[] = state.revisions.map(
    ({ snapshot }) => snapshot.revision,
  );
  const live = liveProposals(revisions);
  return live.flatMap((proposal): SpecConsistencyFinding[] => {
    const superseding = supersedingRevision(revisions, proposal.id);
    if (superseding !== null) {
      return [
        {
          family: "proposal-integrity",
          code: "superseded_proposal",
          revisionId: proposal.id,
          revisionNumber: proposal.number,
          supersededByRevisionId: superseding.id,
          detail: `Revision ${proposal.number} (${proposal.id}) is still proposed, but approved revision ${superseding.number} (${superseding.id}) forked past it`,
          remedy: `Dismiss revision ${proposal.id} from ${DISMISS_SUPERSEDED_SURFACE}`,
        },
      ];
    }
    if (live.length < 2) return [];
    return [
      {
        family: "proposal-integrity",
        code: "competing_live_proposal",
        revisionId: proposal.id,
        revisionNumber: proposal.number,
        supersededByRevisionId: null,
        detail: `Revision ${proposal.number} (${proposal.id}) is one of ${live.length} live proposals on this lineage; nothing has forked past it, so it cannot be dismissed as superseded`,
        // Request Changes, and only it. Sign-off is refused here by definition
        // — this finding exists only where a live sibling does, and the
        // sign-off recheck refuses a target that would fork past one. The
        // agent's `withdraw-proposal` is admitted only for the proposing
        // conversation before a human engages. The human Withdraw act would
        // fit, but Studio ships no control for it, and a remedy pointing at a
        // surface with no button is the same dead end one layer out.
        remedy: `Conclude its review in ${HUMAN_REVIEW_SURFACE}: Request Changes on revision ${proposal.id}, which sends it back to its author as a draft`,
      },
    ];
  });
}
