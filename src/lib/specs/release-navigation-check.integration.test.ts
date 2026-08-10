import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import { MEASURE_DEFINITIONS_VERSION } from "./measures";
import type { SpecMeasuresReport } from "./measures";
import { specMeasuresReportSchema } from "./measures";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  proposeSpineRevision,
  runSpineWorkflowToEvidence,
  startLegacySpineExecution,
  SPINE_WORKFLOW_EXECUTION_ID,
  type MergeScenario,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

/**
 * Drives a historical evergreen-plan run to Delivered so this compatibility
 * check continues to exercise the legacy task-to-code navigation contract.
 */
async function deliverGoldenPath(world: SpecSpineWorld) {
  const authored = await authorSpineDraft(world, SLUG);
  await proposeSpineRevision(world, SLUG, authored);
  await approveAndSignOffSpine(world, SLUG, authored);
  const started = await startLegacySpineExecution(world, SLUG, authored);
  const { commitShas } = await runSpineWorkflowToEvidence(world, started);
  await world.ingest.ingestAuthoritatively(started.specExecutionId);

  for (const [taskElementId, criterionElementId] of [
    [authored.taskOneId, authored.criterionOneId],
    [authored.taskTwoId, authored.criterionTwoId],
  ] as const) {
    const evidenceRows = world.repos.delivery.findEvidenceByCriterionRevision(
      criterionElementId,
      authored.draftRevisionId,
    );
    await postJson(
      world.postAction(
        SLUG,
        "claim-task-complete",
        {
          taskElementId,
          executionId: started.specExecutionId,
          evidenceIds: evidenceRows.map((row) => row.id),
        },
        "agent",
      ),
    );
  }

  await postJson(
    world.postAction(
      SLUG,
      "grant-gate-approval",
      {
        revisionId: authored.draftRevisionId,
        executionId: started.specExecutionId,
        gate: "delivery",
      },
      "human",
    ),
  );

  world.registerMergeComposition();
  // Real modeled lineage: the candidate builds on the branch head, which
  // builds on the lane commits — so ancestry into the published merge is a
  // graph fact, not mere existence in the commit universe.
  const branchHead = commitShas[commitShas.length - 1];
  if (branchHead === undefined) throw new Error("no lane commits produced");
  world.linkCommit("feature-head", [branchHead]);
  world.linkCommit("prepared-candidate", ["feature-head"]);
  world.linkCommit("merge-final", ["prepared-candidate"]);
  world.treeByCommit.set("feature-head", "tree-final");
  world.treeByCommit.set("prepared-candidate", "tree-final");
  const scenario: MergeScenario = {
    validation: {
      validationRef: "validation-final",
      validatedSha: "feature-head",
      validatedTreeHash: "tree-final",
      commandIdentity: "bun run test",
      outcome: "pass",
    },
    preparations: [
      {
        status: "prepared",
        preparedSha: "prepared-candidate",
        expectedTargetSha: "target-main",
        parkedRef: "refs/cc-merges/prepared-candidate",
      },
    ],
    publications: [{ status: "completed", mergeHash: "merge-final" }],
    publishedCandidates: [],
  };
  const mergeResult = (await world.runMerge(
    "merge-job-navigation",
    scenario,
  )) as { status: string };
  expect(mergeResult.status).toBe("completed");

  return { authored, started, commitShas };
}

describe("historical evergreen release-evidence navigation check (kiro 19.3): captured state only", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    world = createSpecSpineWorld();
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
  });

  it("reconstructs requirement -> approved revision -> task -> changed code -> valid proof -> merge result for every delivered in-scope criterion, with full traceability coverage and all four measures", async () => {
    const { started, commitShas } = await deliverGoldenPath(world);

    // --- The delivered set comes from durable records, not test memory: the
    // execution row's pinned scope and its per-criterion dispositions.
    const execution = world.repos.delivery.findExecutionById(
      started.specExecutionId,
    );
    expect(execution?.state).toBe("delivered");
    if (!execution) throw new Error("delivered execution row missing");
    const pinnedScope = JSON.parse(execution.scope_json) as {
      selectedCriterionIds: string[];
    };
    const deliveredInScope = world.repos.delivery
      .findCriterionDispositionsByExecution(execution.id)
      .filter(
        (disposition) =>
          disposition.disposition === "in_scope" &&
          disposition.delivered_by_execution_id === execution.id,
      )
      .map((disposition) => disposition.criterion_element_id)
      .sort();
    expect(deliveredInScope).toEqual(
      [...pinnedScope.selectedCriterionIds].sort(),
    );
    expect(deliveredInScope.length).toBeGreaterThan(0);

    // --- The run itself was legally admitted: captured state carries the
    // execution-start approval (admission row + durable event with human
    // provenance), not a fixture bypass.
    const startAdmission = world.repos.review
      .findGateAdmissionsByRevision(execution.revision_id)
      .find(
        (admission) =>
          admission.gate === "execution_start" &&
          admission.execution_id === execution.id,
      );
    expect(startAdmission).toMatchObject({ basis: "human_approval" });
    expect(JSON.parse(startAdmission?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });
    const startApprovalEvent = world.repos.events
      .findBySpecId(execution.spec_id)
      .find((event) =>
        event.payload_json.includes(
          '"kind":"execution-start-approval-granted"',
        ),
      );
    expect(startApprovalEvent).toBeDefined();
    expect(JSON.parse(startApprovalEvent?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });

    // --- The report computes through the real measures route with no manual
    // step: one GET over spec_events + durable records.
    const rawReport = await postJson<unknown>(
      world.getRoute("getSpecMeasuresGET", {}),
    );
    const report: SpecMeasuresReport =
      specMeasuresReportSchema.parse(rawReport);

    // --- Independent-reviewer navigation: every hop of every chain resolves
    // against durable state (no transcript is consulted anywhere below).
    const approvedSnapshot = await world.repos.specs.getRevisionSnapshot(
      execution.revision_id,
    );
    if (approvedSnapshot === null) throw new Error("pinned snapshot missing");
    expect(approvedSnapshot.revision.state).toBe("approved");
    const laneCommitShas = new Set(
      world.repos.workflowEvents
        .findByExecution(SPINE_WORKFLOW_EXECUTION_ID)
        .flatMap((record) =>
          record.event.type === "graph-workflow-lane-commit"
            ? [record.event.sha]
            : [],
        ),
    );
    const publishedMerge =
      world.repos.jobs.findLatestPublishedMergeByExecutionId(
        SPINE_WORKFLOW_EXECUTION_ID,
      );
    expect(publishedMerge).toEqual({
      mergeHash: "merge-final",
      deliveryGatePassed: true,
    });
    if (publishedMerge === null) throw new Error("published merge missing");

    // Control: existence in the commit universe is NOT history membership. An
    // unrelated commit that exists (and even appears alongside real lane
    // commits) must fail the ancestry check against the published merge.
    world.linkCommit("unrelated-lane-commit");
    expect(world.knownCommits.has("unrelated-lane-commit")).toBe(true);
    expect(
      world.isCommitAncestor("unrelated-lane-commit", publishedMerge.mergeHash),
    ).toBe(false);
    // Every real lane commit IS in the published history.
    for (const sha of commitShas) {
      expect(world.isCommitAncestor(sha, publishedMerge.mergeHash)).toBe(true);
    }

    for (const criterionId of deliveredInScope) {
      const chain = report.navigationChains.find(
        (candidate) => candidate.criterionId === criterionId,
      );
      expect(chain, `navigation chain for ${criterionId}`).toBeDefined();
      if (!chain) continue;
      expect(chain.complete, JSON.stringify(chain, null, 2)).toBe(true);

      // Requirement: the chain's requirement is this criterion's parent in
      // the approved revision snapshot.
      const criterionElement = approvedSnapshot.elements.find(
        (item) => item.element.id === criterionId,
      );
      expect(criterionElement?.element.parentElementId).toBe(
        chain.requirementId,
      );

      // Approved revision: the chain pins the execution's revision and that
      // revision is durably Approved.
      expect(chain.approvedRevisionId).toBe(execution.revision_id);

      // Task: every task on the chain covers this criterion at the approved
      // revision, and at least one task carries changed code.
      expect(chain.tasks.length).toBeGreaterThan(0);
      for (const task of chain.tasks) {
        const taskElement = approvedSnapshot.elements.find(
          (item) => item.element.id === task.taskId,
        );
        expect(taskElement?.version.payload.kind).toBe("task");
        if (taskElement?.version.payload.kind === "task") {
          expect(
            taskElement.version.payload.coveredCriterionElementIds,
          ).toContain(criterionId);
        }
      }
      const changedCode = chain.tasks.flatMap((task) => task.changedCode);
      expect(changedCode.length).toBeGreaterThan(0);

      // Changed code: each commit is a durable lane-commit workflow event and
      // is an ANCESTOR of the published merge in the modeled lineage — the
      // same ancestry relation `git merge-base --is-ancestor` answers. Mere
      // existence in the commit universe does not satisfy this (see the
      // unrelated-commit control below).
      for (const change of changedCode) {
        expect(laneCommitShas.has(change.commitSha)).toBe(true);
        expect(
          world.isCommitAncestor(change.commitSha, publishedMerge.mergeHash),
        ).toBe(true);
      }

      // Valid proof: the chain's verdict is a durable, non-stale proof
      // verdict for this criterion at the pinned revision, and every cited
      // evidence id resolves to a durable evidence row for the same target.
      expect(chain.validProof).not.toBeNull();
      if (chain.validProof === null) continue;
      const verdictRows =
        world.repos.delivery.findProofVerdictsByCriterionRevision(
          criterionId,
          execution.revision_id,
        );
      const verdictRow = verdictRows.find(
        (row) => row.id === chain.validProof?.verdictId,
      );
      expect(verdictRow).toBeDefined();
      expect(verdictRow?.stale_at).toBeNull();
      expect(chain.validProof.evidenceIds.length).toBeGreaterThan(0);
      for (const evidenceId of chain.validProof.evidenceIds) {
        const evidenceRow = world.repos.delivery
          .findEvidenceByCriterionRevision(criterionId, execution.revision_id)
          .find((row) => row.id === evidenceId);
        expect(evidenceRow).toBeDefined();
      }

      // Merge result: the chain lands on the published merge for the linked
      // workflow execution.
      expect(chain.mergeResult?.mergeCommitSha).toBe("merge-final");
    }

    // --- The traceability-completeness measure over the same events reports
    // full coverage (20.2).
    expect(report.traceabilityCompleteness).toMatchObject({
      deliveredInScopeCriterionCount: deliveredInScope.length,
      completeChainCount: deliveredInScope.length,
      share: 1,
      incompleteCriterionIds: [],
    });
    expect(
      [...report.traceabilityCompleteness.completeCriterionIds].sort(),
    ).toEqual(deliveredInScope);

    // --- All four measures compute from captured state with no manual step
    // (20.3), under the frozen definitions version.
    expect(report.definitionsVersion).toBe(MEASURE_DEFINITIONS_VERSION);
    expect(report.requirementCausedRework).toMatchObject({
      reopenedClaimCount: 0,
      postApprovalRevisionCount: 0,
      totalReworkEventCount: 0,
    });
    expect(report.approvalFriction.activeReviewTimeMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(report.approvalFriction.reapprovalLoopCount).toBe(0);
    expect(report.automaticEvidenceCapture.totalEvidenceCount).toBeGreaterThan(
      0,
    );
    expect(report.automaticEvidenceCapture.automaticallyIngestedCount).toBe(
      report.automaticEvidenceCapture.totalEvidenceCount,
    );
    expect(report.automaticEvidenceCapture.share).toBe(1);
  });
});
