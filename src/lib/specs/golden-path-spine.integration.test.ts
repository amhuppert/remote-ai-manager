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
import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  resetGraphExecutionLifecycleCallbacksForTesting,
} from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import { deliveryPlanCompiledHash } from "./delivery-plan-materializer";
import type { SpecEvidenceRow, SpecProofVerdictRow } from "./schemas";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  proposeSpineRevision,
  runSpineWorkflowToEvidence,
  startLegacySpineExecution,
  startSpineExecution,
  SPINE_WORKFLOW_EXECUTION_ID,
  type MergeScenario,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

describe("golden-path spine (kiro 19.1/20.8): staged authoring -> review -> execution -> delivery", () => {
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

  it("drives create -> draft -> propose -> approve -> start -> running -> evidence -> gate -> Delivered with per-criterion proof", async () => {
    // --- Authoring: create on first save, partial draft visible immediately.
    const authored = await authorSpineDraft(world, SLUG);
    const detailAfterDraft = await postJson<{
      spec: { id: string };
      currentRevision: {
        revision: { state: string; authoringStage: string };
        elements: Array<{ element: { id: string; kind: string } }>;
      };
    }>(world.getRoute("getSpecGET", { slug: SLUG }));
    expect(detailAfterDraft.spec.id).toBe(authored.specId);
    expect(detailAfterDraft.currentRevision.revision.state).toBe("draft");
    expect(detailAfterDraft.currentRevision.revision.authoringStage).toBe(
      "plan",
    );
    expect(
      detailAfterDraft.currentRevision.elements.map((item) => item.element.id),
    ).toEqual(
      expect.arrayContaining([
        authored.requirementId,
        authored.criterionOneId,
        authored.criterionTwoId,
        authored.taskOneId,
        authored.taskTwoId,
      ]),
    );

    // --- Propose: freeze + semantic change list for review.
    const proposed = await proposeSpineRevision(world, SLUG, authored);
    expect(proposed.proposeResponse.revision.state).toBe("proposed");
    expect(proposed.proposeResponse.absorbedSignOff).toBe(false);
    const changedElementIds = proposed.proposeResponse.diff.changeList.map(
      (change) => change.elementId,
    );
    expect(changedElementIds).toEqual([authored.taskOneId, authored.taskTwoId]);
    expect(
      proposed.proposeResponse.diff.changeList.every(
        (change) => change.change === "added",
      ),
    ).toBe(true);

    // --- Human review: item approvals + plan approval + sign-off.
    await approveAndSignOffSpine(world, SLUG, authored);
    const statusAfterSignOff = await postJson<{
      phase: { primary: string };
    }>(world.getRoute("getSpecStatusGET", { slug: SLUG }));
    expect(statusAfterSignOff.phase.primary).toBe("approved");
    expect(
      [
        authored.requirementsRevisionId,
        authored.designRevisionId,
        authored.draftRevisionId,
      ].map((revisionId) =>
        world.repos.review
          .findGateAdmissionsByRevision(revisionId)
          .map(({ gate, basis }) => ({ gate, basis })),
      ),
    ).toEqual([
      [{ gate: "requirements", basis: "human_approval" }],
      [{ gate: "design", basis: "human_approval" }],
      [{ gate: "plan", basis: "human_approval" }],
    ]);
    // Every granting act reached the notifier port through the route surface —
    // the runtime seam that creates spec approval notification rows
    // (remediation: spec-attention-runtime-wiring).
    expect(world.reviewNotifications.granted.length).toBeGreaterThanOrEqual(3);
    const planAdmission = world.repos.review
      .findGateAdmissionsByRevision(authored.draftRevisionId)
      .find((admission) => admission.gate === "plan");
    expect(
      world.reviewNotifications.granted.some(
        (notice) =>
          notice.approvalId !== null &&
          notice.approvalId === planAdmission?.approval_id,
      ),
    ).toBe(true);

    // --- Execution start: the approved delivery-plan candidate launches in
    // the same act, with no second definition-approval gate.
    const started = await startSpineExecution(world, SLUG, authored);
    const executionRow = world.repos.delivery.findExecutionById(
      started.specExecutionId,
    );
    expect(executionRow).toMatchObject({
      state: "running",
      workflow_execution_id: SPINE_WORKFLOW_EXECUTION_ID,
    });
    expect(started.definition.definition.approvalRequired).toBe(false);
    expect(started.deliveryPlan).toBeDefined();
    expect(deliveryPlanCompiledHash(started.definition.definition)).toBe(
      started.deliveryPlan?.compiledDefinitionHash,
    );
    const lockedRegions = started.definition.definition.lockedRegions ?? [];
    expect(lockedRegions.length).toBeGreaterThan(0);
    expect(lockedRegions.every((region) => region.sourceUri.length > 0)).toBe(
      true,
    );
    const scopeJson = JSON.parse(executionRow?.scope_json ?? "{}") as {
      selectedCriterionIds: string[];
    };
    expect(scopeJson.selectedCriterionIds).toEqual([
      authored.criterionOneId,
      authored.criterionTwoId,
    ]);

    // The human delivery-plan sign-off admitted execution_start for these
    // exact bytes, so launch opens no duplicate Needs You request.
    expect(
      world.reviewNotifications.requested.some(
        (notice) => notice.gate === "execution_start",
      ),
    ).toBe(false);
    expect(
      world.repos.review
        .findGateAdmissionsByRevision(authored.draftRevisionId)
        .filter((admission) => admission.gate === "execution_start"),
    ).toHaveLength(1);

    // --- Running with evidence flow-back through idempotent ingestion.
    const { commitShas } = await runSpineWorkflowToEvidence(world, started);
    expect(
      world.repos.delivery.findExecutionById(started.specExecutionId)?.state,
    ).toBe("running");
    expect(
      world.reviewNotifications.requested.some(
        (notice) => notice.gate === "execution_start",
      ),
    ).toBe(false);

    // The sign-off admission is rebound to the execution the approved
    // candidate launched; no later approval row substitutes for it.
    const startAdmissions = world.repos.review
      .findGateAdmissionsByRevision(authored.draftRevisionId)
      .filter((admission) => admission.gate === "execution_start");
    expect(startAdmissions).toHaveLength(1);
    expect(startAdmissions[0]).toMatchObject({
      basis: "human_approval",
      execution_id: null,
    });
    // The launched candidate carries approvalRequired:false because sign-off
    // is the deciding gate act, so the post-launch projection owes no act.
    const statusAfterStartApproval = await postJson<{
      gates: Array<{ gate: string; state: string }>;
    }>(world.getRoute("getSpecStatusGET", { slug: SLUG }));
    expect(
      statusAfterStartApproval.gates.find(
        (gate) => gate.gate === "execution_start",
      ),
    ).toMatchObject({ state: "not_required" });

    const firstIngest = await world.ingest.ingestAuthoritatively(
      started.specExecutionId,
    );
    expect(firstIngest.materializedEvidenceCount).toBeGreaterThan(0);
    const secondIngest = await world.ingest.ingestAuthoritatively(
      started.specExecutionId,
    );
    expect(secondIngest.materializedEvidenceCount).toBe(0);
    expect(secondIngest.existingEvidenceCount).toBe(
      firstIngest.materializedEvidenceCount,
    );

    // --- Evidence-backed task completion claims through the agent route.
    for (const [taskElementId, criterionElementId] of [
      [authored.taskOneId, authored.criterionOneId],
      [authored.taskTwoId, authored.criterionTwoId],
    ] as const) {
      const evidenceRows = world.repos.delivery.findEvidenceByCriterionRevision(
        criterionElementId,
        authored.draftRevisionId,
      );
      expect(evidenceRows.length).toBeGreaterThan(0);
      const claim = await postJson<{ status: string }>(
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
      expect(claim.status).toBe("accepted");
    }

    // --- The delivery dial is Gate under contract-bearing: a human grants
    // the execution-scoped delivery approval through the Studio route, and an
    // agent attempting the same grant is refused as a human act.
    const agentGrant = await world.postAction(
      SLUG,
      "grant-gate-approval",
      {
        revisionId: authored.draftRevisionId,
        executionId: started.specExecutionId,
        gate: "delivery",
      },
      "agent",
    );
    expect(agentGrant.status).toBe(403);
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

    // The granted admission is on the detail view a Studio refetch reads, so
    // the execution panel renders the admitted state instead of a stale
    // "blocked" prompt.
    const detailAfterGrant = await postJson<{
      gateAdmissions: Array<{ gate: string; executionId: string | null }>;
    }>(world.getRoute("getSpecGET", { slug: SLUG }));
    expect(detailAfterGrant.gateAdmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: "delivery",
          executionId: started.specExecutionId,
        }),
      ]),
    );

    // --- Delivery gate over the wired merge machinery, then Delivered. The
    // candidate lineage builds on the lane commits so the gate's ancestry
    // probe answers from the modeled history, not mere commit existence.
    world.registerMergeComposition();
    const branchHead = commitShas[commitShas.length - 1];
    if (branchHead === undefined) throw new Error("no lane commits produced");
    world.linkCommit("feature-head", [branchHead]);
    world.linkCommit("prepared-candidate", ["feature-head"]);
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
    const mergeResult = await world.runMerge("merge-job-spine", scenario);
    expect(mergeResult).toMatchObject({
      status: "completed",
      mergeHash: "merge-final",
    });
    expect(scenario.publishedCandidates).toEqual(["prepared-candidate"]);

    const lifecycle = createRegisteredGraphExecutionLifecycleCallbacks();
    await lifecycle.markDelivered(SPINE_WORKFLOW_EXECUTION_ID, "merge-final");
    expect(
      world.repos.delivery.findExecutionById(started.specExecutionId),
    ).toMatchObject({ state: "delivered" });

    const statusAfterDelivery = await postJson<{
      phase: { primary: string };
      delivery: { provenCriteria: number; totalCriteria: number } | null;
    }>(world.getRoute("getSpecStatusGET", { slug: SLUG }));
    expect(statusAfterDelivery.phase.primary).toBe("delivered");

    // --- Per-criterion proof is retrievable through the evidence queries:
    // "what proves this?" is answerable for every in-scope criterion.
    for (const [handle, criterionElementId] of [
      ["R1.1", authored.criterionOneId],
      ["R1.2", authored.criterionTwoId],
    ] as const) {
      const elementView = await postJson<{
        evidenceState: Array<{
          criterionElementId: string;
          evidence: SpecEvidenceRow[];
          verdicts: SpecProofVerdictRow[];
        }>;
      }>(world.getRoute("getSpecElementGET", { slug: SLUG, element: handle }));
      const proof = elementView.evidenceState.find(
        (state) => state.criterionElementId === criterionElementId,
      );
      expect(proof).toBeDefined();
      expect(proof?.evidence.length ?? 0).toBeGreaterThan(0);
      const validVerdicts = (proof?.verdicts ?? []).filter(
        (verdict) => verdict.stale_at === null,
      );
      expect(validVerdicts.length).toBeGreaterThan(0);
      for (const verdict of validVerdicts) {
        const citedIds = JSON.parse(verdict.evidence_ids_json) as string[];
        expect(citedIds.length).toBeGreaterThan(0);
        for (const evidenceId of citedIds) {
          expect(proof?.evidence.some((row) => row.id === evidenceId)).toBe(
            true,
          );
        }
      }
    }
    expect(commitShas.length).toBeGreaterThan(0);

    // --- Liveness rehearsal: every stage published its typed SSE event so
    // Studio updates without refresh (the browser pass itself is a live check
    // outside this fixture). Execution and evidence changes must publish
    // after commit, not only land as durable rows
    // (remediation: execution-evidence-sse).
    const sseTypes = new Set(world.publishedSse.map((event) => event.type));
    for (const expected of [
      "spec-changed",
      "spec-revision-changed",
      "spec-approval-changed",
      "spec-execution-changed",
      "spec-evidence-changed",
    ] as const) {
      expect(sseTypes.has(expected)).toBe(true);
    }
    const durableTypes = new Set(
      world.repos.events
        .findBySpecId(authored.specId)
        .map((event) => event.event_type),
    );
    expect(durableTypes.has("spec-execution-changed")).toBe(true);
    expect(durableTypes.has("spec-evidence-changed")).toBe(true);
  });

  it("rejects a retired scope document and names the delivery-plan importer", async () => {
    const slug = "non-plan-execution";
    const authored = await authorSpineDraft(world, slug);

    const response = await world.postAction(
      slug,
      "start-execution",
      {
        revisionId: authored.requirementsRevisionId,
        scope: {
          selectedTaskIds: [],
          selectedCriterionIds: [],
          exclusionDispositions: [],
        },
        sessionName: "non-plan-session",
      },
      "agent",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation",
      unmetConditions: [expect.stringContaining("scope documents are retired")],
      instruction: expect.stringContaining(
        `cctl spec plan open ${slug} --seed-from last`,
      ),
    });
    expect(world.definitions.records).toHaveLength(0);
  });

  it("keeps fast-path evergreen authoring single-pass at design, then opens delivery planning", async () => {
    const slug = "fast-path-single-pass";
    const created = await postJson<{
      spec: { id: string };
      draft: { id: string; authoringStage: string };
    }>(
      world.postAction(
        slug,
        "create",
        {
          slug,
          name: "Fast-path single pass",
          gatePolicy: { preset: "fast-path" },
          initialElement: {
            elementId: "fast-requirement",
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Fast-path authoring remains a single pass.",
              priority: "must",
              risk: "high",
            },
          },
        },
        "agent",
      ),
    );
    expect(created.draft.authoringStage).toBe("design");

    await postJson(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: created.draft.id,
          elementId: "fast-criterion",
          kind: "criterion",
          parentElementId: "fast-requirement",
          position: 1,
          payload: {
            kind: "criterion",
            text: "The approved plan starts a workflow without staged amendments.",
            validationStrategy: { kinds: ["test_run"] },
          },
          baseElementVersion: null,
        },
        "agent",
      ),
    );
    const retiredTaskWrite = await world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: created.draft.id,
        elementId: "fast-task",
        kind: "task",
        parentElementId: null,
        position: 2,
        payload: {
          kind: "task",
          title: "Ship the single-pass plan",
          instructions: "Implement and validate the fast-path contract.",
          tracedRequirementElementIds: ["fast-requirement"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["fast-criterion"],
          dependsOnTaskElementIds: [],
        },
        baseElementVersion: null,
      },
      "agent",
    );
    expect(retiredTaskWrite.status).toBe(409);
    await expect(retiredTaskWrite.json()).resolves.toMatchObject({
      code: "stage_blocked",
      instruction: expect.stringContaining("cctl spec plan open"),
    });
    await postJson(
      world.postAction(
        slug,
        "propose",
        { revisionId: created.draft.id },
        "agent",
      ),
    );
    const signedOff = await postJson<{
      revision: { state: string; authoringStage: string };
    }>(
      world.postAction(
        slug,
        "sign-off",
        { revisionId: created.draft.id },
        "human",
      ),
    );
    expect(signedOff.revision).toMatchObject({
      state: "approved",
      authoringStage: "design",
    });

    const opened = await postJson<{
      attempt: { pinnedRevisionId: string; status: string };
    }>(world.postAction(slug, "plan-open", { seedFromLast: false }, "agent"));
    expect(opened.attempt).toMatchObject({
      pinnedRevisionId: created.draft.id,
      status: "draft",
    });
  });

  it.each([
    {
      dial: "gate",
      approvalRequired: true,
      initialStartStatus: 409,
      expectedBasis: "human_approval",
      expectedHumanActs: 1,
    },
    {
      dial: "notify",
      approvalRequired: false,
      initialStartStatus: 202,
      expectedBasis: "notify_policy",
      expectedHumanActs: 0,
    },
    {
      dial: "off",
      approvalRequired: false,
      initialStartStatus: 202,
      expectedBasis: "off_policy",
      expectedHumanActs: 0,
    },
  ] as const)(
    "continues a historical $dial definition with exactly $expectedHumanActs execution-start human acts",
    async ({
      dial,
      approvalRequired,
      initialStartStatus,
      expectedBasis,
      expectedHumanActs,
    }) => {
      const slug = `execution-start-${dial}`;
      const authored = await authorSpineDraft(world, slug, dial);
      await proposeSpineRevision(world, slug, authored);
      await approveAndSignOffSpine(world, slug, authored);
      const started = await startLegacySpineExecution(world, slug, authored);
      expect(started.definition.definition.approvalRequired).toBe(
        approvalRequired,
      );

      world.registerMergeComposition();
      const startResponse = await world.postWorkflowRoute("START", {
        definitionId: started.definition.id,
      });
      expect(startResponse.status).toBe(initialStartStatus);

      let humanActs = 0;
      if (dial === "gate") {
        await expect(startResponse.json()).resolves.toMatchObject({
          code: "definition_approval_required",
        });
        expect(world.readActiveWorkflowExecution()?.status).toBe("pending");
        const approval = await world.postAction(
          slug,
          "approve-execution-start",
          { executionId: started.specExecutionId },
          "human",
        );
        humanActs += 1;
        expect(approval.status).toBe(200);
      }

      expect(humanActs).toBe(expectedHumanActs);
      expect(
        world.repos.delivery.findExecutionById(started.specExecutionId),
      ).toMatchObject({
        state: "running",
        workflow_execution_id: SPINE_WORKFLOW_EXECUTION_ID,
      });
      expect(world.readActiveWorkflowExecution()?.status).toBe("running");

      const executionStartAdmissions = world.repos.review
        .findGateAdmissionsByRevision(authored.draftRevisionId)
        .filter((admission) => admission.gate === "execution_start");
      expect(executionStartAdmissions).toHaveLength(1);
      expect(executionStartAdmissions[0]).toMatchObject({
        basis: expectedBasis,
        execution_id: started.specExecutionId,
      });
      expect(
        world.reviewNotifications.requested.filter(
          (notice) => notice.gate === "execution_start",
        ),
      ).toHaveLength(expectedHumanActs);
      expect(
        world.reviewNotifications.policyAdmitted.filter(
          (notice) => notice.gate === "execution_start",
        ),
      ).toHaveLength(dial === "notify" ? 1 : 0);
    },
  );

  it("keeps a historical Gate-compiled definition recoverable after the live dial changes to Notify", async () => {
    const slug = "execution-start-policy-drift";
    const authored = await authorSpineDraft(world, slug, "gate");
    await proposeSpineRevision(world, slug, authored);
    await approveAndSignOffSpine(world, slug, authored);
    const started = await startLegacySpineExecution(world, slug, authored);
    expect(started.definition.definition.approvalRequired).toBe(true);

    const policyChange = await world.postAction(
      slug,
      "change-policy",
      {
        proposedPolicy: {
          preset: "contract-bearing",
          overrides: { execution_start: "notify" },
        },
        hardConfirmed: true,
      },
      "human",
    );
    expect(policyChange.status).toBe(200);

    const detail = await postJson<{
      spec: {
        gatePolicy: {
          overrides?: { execution_start?: string };
        };
      };
      executions: Array<{
        id: string;
        definitionApprovalRequired: boolean | null;
      }>;
    }>(world.getRoute("getSpecGET", { slug }));
    expect(detail.spec.gatePolicy.overrides?.execution_start).toBe("notify");
    expect(detail.executions).toContainEqual(
      expect.objectContaining({
        id: started.specExecutionId,
        definitionApprovalRequired: true,
      }),
    );

    world.registerMergeComposition();
    const startResponse = await world.postWorkflowRoute("START", {
      definitionId: started.definition.id,
    });
    expect(startResponse.status).toBe(409);
    await expect(startResponse.json()).resolves.toMatchObject({
      code: "definition_approval_required",
    });
    const pendingExecution = world.readActiveWorkflowExecution();
    expect(pendingExecution).toMatchObject({
      status: "pending",
      seedDefinitionId: started.definition.id,
    });
    if (pendingExecution === null) {
      throw new Error("workflow execution did not park for approval");
    }
    expect(
      world.reviewNotifications.requested.filter(
        (notice) => notice.gate === "execution_start",
      ),
    ).toHaveLength(1);

    const approval = await world.postWorkflowRoute("APPROVE_DEFINITION", {
      executionId: pendingExecution.id,
      definitionId: pendingExecution.seedDefinitionId,
      definitionRevision: pendingExecution.seedDefinitionRevision,
    });
    expect(approval.status).toBe(200);
    expect(world.readActiveWorkflowExecution()?.status).toBe("running");
    expect(
      world.repos.review
        .findGateAdmissionsByRevision(authored.draftRevisionId)
        .filter((admission) => admission.gate === "execution_start"),
    ).toEqual([
      expect.objectContaining({
        basis: "human_approval",
        execution_id: started.specExecutionId,
      }),
    ]);
  });

  it.each([
    {
      compiledDial: "notify",
      expectedBasis: "notify_policy",
      expectedNoticeCount: 1,
    },
    {
      compiledDial: "off",
      expectedBasis: "off_policy",
      expectedNoticeCount: 0,
    },
  ] as const)(
    "keeps a historical definition's frozen $compiledDial admission basis after the live dial changes to Gate",
    async ({ compiledDial, expectedBasis, expectedNoticeCount }) => {
      const slug = `execution-start-reverse-drift-${compiledDial}`;
      const authored = await authorSpineDraft(world, slug, compiledDial);
      await proposeSpineRevision(world, slug, authored);
      await approveAndSignOffSpine(world, slug, authored);
      const started = await startLegacySpineExecution(world, slug, authored);
      expect(started.definition.definition.approvalRequired).toBe(false);

      const policyChange = await world.postAction(
        slug,
        "change-policy",
        {
          proposedPolicy: { preset: "contract-bearing" },
          hardConfirmed: true,
        },
        "human",
      );
      expect(policyChange.status).toBe(200);

      world.registerMergeComposition();
      const startResponse = await world.postWorkflowRoute("START", {
        definitionId: started.definition.id,
      });
      expect(startResponse.status).toBe(202);
      expect(world.readActiveWorkflowExecution()?.status).toBe("running");
      expect(
        world.repos.delivery.findExecutionById(started.specExecutionId),
      ).toMatchObject({
        state: "running",
        workflow_execution_id: SPINE_WORKFLOW_EXECUTION_ID,
      });

      expect(
        world.repos.review
          .findGateAdmissionsByRevision(authored.draftRevisionId)
          .filter((admission) => admission.gate === "execution_start"),
      ).toEqual([
        expect.objectContaining({
          basis: expectedBasis,
          execution_id: started.specExecutionId,
          approval_id: null,
        }),
      ]);
      expect(
        world.reviewNotifications.requested.filter(
          (notice) => notice.gate === "execution_start",
        ),
      ).toHaveLength(0);
      expect(
        world.reviewNotifications.policyAdmitted.filter(
          (notice) => notice.gate === "execution_start",
        ),
      ).toHaveLength(expectedNoticeCount);

      const status = await postJson<{
        gates: Array<{ gate: string; dial: string; state: string }>;
      }>(world.getRoute("getSpecStatusGET", { slug }));
      expect(
        status.gates.find((gate) => gate.gate === "execution_start"),
      ).toMatchObject({
        dial: compiledDial,
        state: "admitted",
      });
    },
  );

  it("records the historical execution's spec admission when a human approves it from the workflow route", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startLegacySpineExecution(world, SLUG, authored);
    world.registerMergeComposition();

    // The workflow START parks awaiting definition approval and opens the
    // durable Needs You request through the lifecycle port.
    const startResponse = await world.postWorkflowRoute("START", {
      definitionId: started.definition.id,
    });
    expect(startResponse.status).toBe(409);
    await expect(startResponse.json()).resolves.toMatchObject({
      code: "definition_approval_required",
    });
    expect(
      world.reviewNotifications.requested.some(
        (notice) => notice.gate === "execution_start",
      ),
    ).toBe(true);

    const pendingExecution = world.readActiveWorkflowExecution();
    if (pendingExecution === null) {
      throw new Error("workflow execution did not park for approval");
    }

    // Browser-human approval on the workflow route (no agent token): the
    // route coordinates with the spec-side gate, so the same execution-scoped
    // bookkeeping lands as Studio's approve-execution-start — no bypass.
    const approve = await world.postWorkflowRoute("APPROVE_DEFINITION", {
      executionId: pendingExecution.id,
      definitionId: pendingExecution.seedDefinitionId,
      definitionRevision: pendingExecution.seedDefinitionRevision,
    });
    expect(approve.status).toBe(200);

    expect(
      world.repos.delivery.findExecutionById(started.specExecutionId),
    ).toMatchObject({
      state: "running",
      workflow_execution_id: SPINE_WORKFLOW_EXECUTION_ID,
    });
    const startAdmissions = world.repos.review
      .findGateAdmissionsByRevision(authored.draftRevisionId)
      .filter((admission) => admission.gate === "execution_start");
    expect(startAdmissions).toHaveLength(1);
    expect(startAdmissions[0]).toMatchObject({
      basis: "human_approval",
      execution_id: started.specExecutionId,
    });
    expect(JSON.parse(startAdmissions[0]?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });
    expect(
      world.repos.review.hasValidHumanGateApproval({
        specId: authored.specId,
        revisionId: authored.draftRevisionId,
        executionId: started.specExecutionId,
        gate: "execution_start",
      }),
    ).toBe(true);
    const grantEvents = world.repos.events
      .findBySpecId(authored.specId)
      .filter((event) =>
        event.payload_json.includes(
          '"kind":"execution-start-approval-granted"',
        ),
      );
    expect(grantEvents).toHaveLength(1);
    expect(JSON.parse(grantEvents[0]?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });
    // The grant cleared the waiting request through the notifier port.
    const startRequestIds = world.reviewNotifications.requested
      .filter((notice) => notice.gate === "execution_start")
      .map((notice) => notice.gateRequestId);
    expect(startRequestIds.length).toBeGreaterThan(0);
    expect(
      world.reviewNotifications.granted.some((notice) =>
        notice.satisfiedAttentionIds.some((id) => startRequestIds.includes(id)),
      ),
    ).toBe(true);
  });
});
