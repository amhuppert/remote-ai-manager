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

import { _resetPublicationForTesting } from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { graphWorkflowHaltReasonSchema } from "@/lib/workflow-graph/schemas";

import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  proposeSpineRevision,
  runSpineWorkflowToEvidence,
  startSpineExecution,
  SPINE_PROJECT_NAME,
  SPINE_PROJECT_PATH,
  type MergeScenario,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";

/**
 * F17/F19 end to end over the real spine composition: a delivery gate halted
 * on the missing human approval opens exactly one durable Needs You request
 * (idempotent per execution, converging with the CLI entry point even under
 * an open amendment) and presents the halt as a wait-on-approval, not an
 * unmet-criteria failure.
 */
describe("delivery-approval reachability across the gate and the request-approval verb", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();

    world = createSpecSpineWorld();
  });

  afterEach(() => {
    resetJobQueue();

    _resetPublicationForTesting();
  });

  function approvalRequestEvents(specId: string) {
    return world.repos.events
      .findBySpecId(specId)
      .filter((event) => event.event_type === "spec-attention-changed")
      .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
      .filter(
        (payload) =>
          payload.kind === "approval-requested" && payload.gate === "delivery",
      );
  }

  function healthyScenario(ref: string): MergeScenario {
    return {
      validation: {
        validationRef: ref,
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
      publications: [],
      publishedCandidates: [],
    };
  }

  it("two refused merges open one durable request; the CLI-shaped ask converges on it under an open amendment", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    const { commitShas } = await runSpineWorkflowToEvidence(world, started);

    // A healthy candidate lineage: the only refusal in play is the missing
    // human delivery approval (never granted in this test).
    const branchHead = commitShas[commitShas.length - 1];
    if (branchHead === undefined) throw new Error("no lane commits produced");
    world.linkCommit("feature-head", [branchHead]);
    world.linkCommit("prepared-candidate", ["feature-head"]);
    world.treeByCommit.set("feature-head", "tree-final");
    world.treeByCommit.set("prepared-candidate", "tree-final");

    const firstMerge = (await world.runMerge(
      "merge-approval-1",
      healthyScenario("validation-approval-1"),
    )) as { status: string; haltReason: unknown };

    // The halt presents as waiting on the human approval — refusalCode and
    // the spec deep-link block ride alongside the preserved pseudo-criteria.
    expect(firstMerge.status).toBe("failed");
    const haltReason = graphWorkflowHaltReasonSchema.parse(
      firstMerge.haltReason,
    );
    if (haltReason.type !== "delivery_gate_failed") {
      throw new Error(`unexpected halt reason type ${haltReason.type}`);
    }
    const spec = await world.repos.specs.resolve(SPINE_PROJECT_PATH, SLUG);
    if (spec === null) throw new Error("spine spec not found");
    expect(haltReason.refusalCode).toBe("approval_required");
    expect(haltReason.spec).toEqual({
      specSlug: SLUG,
      specName: spec.name,
      projectName: SPINE_PROJECT_NAME,
    });
    expect(haltReason.instruction).toContain(
      "Open the delivery review in Spec Studio",
    );

    // Exactly one durable Needs You request, keyed to this run.
    const afterFirst = approvalRequestEvents(authored.specId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      subject: "delivery",
      executionId: started.specExecutionId,
    });
    const deliveryNotices = () =>
      world.reviewNotifications.requested.filter(
        (notice) => notice.gate === "delivery",
      );
    expect(deliveryNotices()).toHaveLength(1);
    const gateRequestId = deliveryNotices()[0]?.gateRequestId;

    // A second refused merge re-ensures the same request — no second durable
    // ask, and every notice carries the same stable attention id.
    const secondMerge = (await world.runMerge(
      "merge-approval-2",
      healthyScenario("validation-approval-2"),
    )) as { status: string };
    expect(secondMerge.status).toBe("failed");
    expect(approvalRequestEvents(authored.specId)).toHaveLength(1);
    expect(
      deliveryNotices().every(
        (notice) => notice.gateRequestId === gateRequestId,
      ),
    ).toBe(true);

    // Open an amendment so the latest revision diverges from the run's pin,
    // then ask through the CLI-shaped route entry point naming the latest
    // revision — the ask must converge on the same durable request.
    await postJson(world.postAction(SLUG, "open-amendment", {}, "agent"));
    const amendmentDraft = (
      await world.repos.specs.listRevisions(authored.specId)
    ).find((revision) => revision.state === "draft");
    if (amendmentDraft === undefined) {
      throw new Error("open-amendment left no draft revision");
    }
    const receipt = await postJson<{
      attentionId: string;
      alreadyRequested: boolean;
    }>(
      world.postAction(
        SLUG,
        "request-approval",
        {
          revisionId: amendmentDraft.id,
          gate: "delivery",
          subject: "delivery",
        },
        "agent",
      ),
    );
    expect(receipt.alreadyRequested).toBe(true);
    expect(receipt.attentionId).toBe(gateRequestId);
    expect(approvalRequestEvents(authored.specId)).toHaveLength(1);
  });
});
