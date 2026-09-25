import { describe, expect, it } from "vitest";
import { deliveryPlanNextAct } from "@/lib/specs/delivery-plan-next-act";
import {
  deliveryPlanStatus,
  type DeliveryPlanView,
} from "@/lib/specs/delivery-plan-views";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const builderHref = "/projects/project-one/workflows?definition=managed-one";
const plan: DeliveryPlanView = {
  attempt: {
    id: "attempt-one",
    specSlug: "native-sdd",
    status: "draft",
    draftRevision: 4,
    pinnedRevisionId: "approved-three",
    deltaBasisExecutionId: null,
    proposedSnapshotId: null,
    candidateId: null,
    candidateHash: null,
    launchedExecutionId: null,
    workflowDefinitionId: "managed-one",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
  },
  approval: null,
  prelaunch: null,
  document: { schemaVersion: 4, binding: { dispositions: [] } },
  claims: [],
  reviewStatus: { state: "unreviewed" },
  workflowDefinition: {
    id: "managed-one",
    revision: 7,
    definitionHash: "definition-hash",
    builderHref,
  },
  health: { total: 0, blocking: 0, counts: [], findings: [] },
  ledger: {
    selected: 1,
    claimed: 1,
    unclaimed: 0,
    dispositions: [{ kind: "in_scope", count: 1 }],
    charter: { state: "authored", invariantCount: 1, sourceCount: 1 },
  },
  dispositionCounts: [],
  unresolved: [],
  snapshots: [],
  nextAct: {
    actor: "human",
    command: `Review and sign off in Builder: ${builderHref}`,
    reason: "Execution start requires a human to review the draft.",
  },
};

describe("delivery plan operational receipts", () => {
  it.each(["open", "propose", "reopen"])(
    "keeps the plan at the read location for %s",
    async (action) => {
      const mutation = {
        previousHealth: { total: 1, blocking: 0 },
        invalidatedApproval: null,
        executionStartAdmission: null,
      };
      const fixture = createCcRuntimeFixture({
        respond: () => jsonReply({ ...plan, ...mutation }),
      });
      const flags = action === "reopen" ? ["--reason", "Revise the plan"] : [];
      const result = await fixture.run([
        "spec",
        "plan",
        action,
        "native-sdd",
        ...flags,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).payload.data).toEqual({
        plan,
        ...mutation,
      });
    },
  );

  it("exports the same plan location as JSON domain data", async () => {
    const fixture = createCcRuntimeFixture({ respond: () => jsonReply(plan) });
    const result = await fixture.run([
      "spec",
      "plan",
      "get",
      "native-sdd",
      "--full",
      "--out",
      "plan.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const artifact = JSON.parse(result.stdout).payload.artifact;
    expect(artifact.contains).toBe("data");
    const bytes = fixture.kernelHost.filesSnapshot()[artifact.path];
    expect(JSON.parse(new TextDecoder().decode(bytes)).plan).toEqual(plan);
  });

  it("keeps the mutation plan inside the response envelope when a large receipt spills", async () => {
    const largePlan = {
      ...plan,
      nextAct: { ...plan.nextAct, reason: plan.nextAct.reason.repeat(4000) },
    };
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          ...largePlan,
          previousHealth: null,
          invalidatedApproval: null,
          executionStartAdmission: null,
        }),
    });
    const result = await fixture.run(["spec", "plan", "propose", "native-sdd"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const artifact = JSON.parse(result.stdout).payload.artifact;
    expect(artifact.contains).toBe("response");
    const bytes = fixture.kernelHost.filesSnapshot()[artifact.path];
    const saved = JSON.parse(new TextDecoder().decode(bytes));
    expect(saved.effect).toBe("applied");
    expect(saved.payload.data.plan).toEqual(largePlan);
  });

  it("projects operational status from the canonical plan without confusing its two revision guards", () => {
    expect(deliveryPlanStatus(plan)).toEqual({
      attemptId: "attempt-one",
      status: "draft",
      pinnedRevisionId: "approved-three",
      draftRevision: 4,
      workflowDefinition: { id: "managed-one", revision: 7, builderHref },
      nextAct: plan.nextAct,
      reviewStatus: plan.reviewStatus,
    });
  });

  it("hands a ready draft to Builder when execution start requires a human", () => {
    const next = deliveryPlanNextAct({
      status: "draft",
      specSlug: "native-sdd",
      workflowDefinitionId: "managed-one",
      builderHref,
      signOffRequiresHuman: true,
      draftReady: true,
    });
    expect(next).toEqual({
      actor: "human",
      command: `Review and sign off in Builder: ${builderHref}`,
      reason: expect.any(String),
    });
  });

  it("lets the agent's propose freeze a ready draft under a Notify or Off dial", () => {
    const next = deliveryPlanNextAct({
      status: "draft",
      specSlug: "native-sdd",
      workflowDefinitionId: "managed-one",
      builderHref,
      signOffRequiresHuman: false,
      draftReady: true,
    });
    expect(next).toMatchObject({
      actor: "agent",
      command: "cctl spec plan propose native-sdd",
    });
  });

  it.each([true, false])(
    "keeps an unready draft with its author whether or not a human signs off (human dial: %s)",
    (signOffRequiresHuman) => {
      const next = deliveryPlanNextAct({
        status: "draft",
        specSlug: "native-sdd",
        workflowDefinitionId: "managed-one",
        builderHref,
        signOffRequiresHuman,
        draftReady: false,
      });
      expect(next.actor).toBe("agent");
      expect(next.command).toContain(
        "cctl workflow validate --file .cc/temp/plan.json --definition managed-one",
      );
      expect(next.command).not.toContain(builderHref);
    },
  );

  it.each(["approved", "parked"] as const)(
    "starts a signed %s candidate without another sign-off",
    (status) => {
      const next = deliveryPlanNextAct({
        status,
        specSlug: "native-sdd",
        workflowDefinitionId: "managed-one",
        builderHref,
        signOffRequiresHuman: true,
        draftReady: false,
      });
      expect(next).toMatchObject({
        actor: "agent",
        command: "cctl spec start native-sdd --file .cc/temp/inputs.json",
      });
    },
  );

  it("distinguishes structural mapping from the recorded semantic review", async () => {
    const fixture = createCcRuntimeFixture({ respond: () => jsonReply(plan) });
    const result = await fixture.run(
      ["spec", "plan", "status", "native-sdd"],
      "text",
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("Structural validation: valid");
    expect(result.stdout).toContain("Semantic review: unreviewed");
    expect(result.stdout).toContain("Criteria mapping:");
  });
});
