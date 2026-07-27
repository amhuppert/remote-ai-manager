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

import { runCli } from "@/cli/core";
import type { CliEnv, CliHost } from "@/cli/shared";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { graphWorkflowHaltReasonSchema } from "@/lib/workflow-graph/schemas";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import type { SpecEventRow } from "./schemas";
import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  proposeSpineRevision,
  runSpineWorkflowToEvidence,
  startSpineExecution,
  SPINE_BEARER_TOKEN,
  SPINE_CONVERSATION_ID,
  SPINE_PROJECT_NAME,
  SPINE_SESSION_NAME,
  type MergeScenario,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";
const SCOPE_FILE = "/tmp/spine-refusal-scope.json";

const cliEnv: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: SPINE_BEARER_TOKEN,
  CC_PROJECT: SPINE_PROJECT_NAME,
  CC_SESSION: SPINE_SESSION_NAME,
  CC_CONVERSATION_ID: SPINE_CONVERSATION_ID,
};

/**
 * Bridges the real cctl command implementations onto the spine world's real
 * route handlers, so the CLI demonstrations exercise the same server
 * enforcement path as the route demonstrations — no mocked responses.
 */
function bridgeHost(
  world: SpecSpineWorld,
  files: Record<string, string> = {},
): CliHost {
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (
        segments[0] === "api" &&
        segments[1] === "projects" &&
        segments[3] === "sessions" &&
        segments[5] === "graph-workflow"
      ) {
        if (init.method === "GET" && segments[6] === "execution") {
          return world.postWorkflowRoute("EXECUTION");
        }
        throw new Error(`Unbridged CLI request path: ${parsed.pathname}`);
      }
      if (segments[0] !== "api" || segments[1] !== "specs") {
        throw new Error(`Unbridged CLI request path: ${parsed.pathname}`);
      }
      const request = new Request(`http://cc.test${parsed.pathname}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const name = segments[2] ?? "";
      if (init.method === "GET") {
        const slug = segments[3] ?? "";
        if (segments.length === 4) {
          return world.readHandlers.getSpecGET(request, {
            params: Promise.resolve({ name, slug }),
          });
        }
        if (segments.length === 5 && segments[4] === "status") {
          return world.readHandlers.getSpecStatusGET(request, {
            params: Promise.resolve({ name, slug }),
          });
        }
        if (segments.length === 5 && segments[4] === "edit-context") {
          return world.readHandlers.getSpecEditContextGET(request, {
            params: Promise.resolve({ name, slug }),
          });
        }
        if (segments.length === 6 && segments[4] === "elements") {
          return world.readHandlers.getSpecElementGET(request, {
            params: Promise.resolve({ name, slug, element: segments[5] ?? "" }),
          });
        }
      }
      if (init.method === "POST" && segments[3] === "actions") {
        return world.writeHandlers.projectActionPOST(request, {
          params: Promise.resolve({ name, action: segments[4] ?? "" }),
        });
      }
      if (init.method === "POST" && segments[4] === "actions") {
        return world.writeHandlers.specActionPOST(request, {
          params: Promise.resolve({
            name,
            slug: segments[3] ?? "",
            action: segments[5] ?? "",
          }),
        });
      }
      throw new Error(
        `Unbridged CLI request: ${init.method} ${parsed.pathname}`,
      );
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

interface InterventionRow {
  row: SpecEventRow;
  actor: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function interventionRows(
  world: SpecSpineWorld,
  specId: string,
): InterventionRow[] {
  return world.repos.events
    .findBySpecId(specId)
    .filter((row) => row.event_type === "spec-intervention-recorded")
    .map((row) => ({
      row,
      actor: JSON.parse(row.actor_json) as Record<string, unknown>,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
}

describe("refusal demonstrations (kiro 19.2): the server refuses each illegal transition", () => {
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
    _resetPublicationForTesting();
  });

  it("refuses an out-of-stage task write through the real authoring route", async () => {
    const slug = "premature-plan";
    const created = await postJson<{
      spec: { id: string };
      draft: { id: string; authoringStage: string };
    }>(
      world.postAction(
        slug,
        "create",
        {
          slug,
          name: "Premature plan",
          gatePolicy: { preset: "contract-bearing" },
          initialElement: {
            elementId: "requirement-premature",
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Plan work follows requirements review.",
              priority: "must",
              risk: "high",
            },
          },
        },
        "agent",
      ),
    );
    expect(created.draft.authoringStage).toBe("requirements");

    const response = await world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: created.draft.id,
        elementId: "task-premature",
        kind: "task",
        parentElementId: null,
        position: 1,
        payload: {
          kind: "task",
          title: "Premature plan task",
          instructions: "This write must remain outside the draft.",
          tracedRequirementElementIds: ["requirement-premature"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [],
          dependsOnTaskElementIds: [],
        },
        baseElementVersion: null,
      },
      "agent",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "stage_blocked",
      unmetConditions: [
        "A task cannot be authored during the requirements stage.",
      ],
      instruction: expect.stringContaining("Propose the requirements stage"),
    });
    expect(
      (
        await world.repos.specs.getRevisionSnapshot(created.draft.id)
      )?.elements.map(({ element }) => element.id),
    ).toEqual(["requirement-premature"]);
    expect(interventionRows(world, created.spec.id)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "draft-write-refused",
          refusal: expect.objectContaining({ code: "stage_blocked" }),
        }),
      }),
    ]);
  });

  it("refuses execution start for a proposed plan and an approved non-plan revision through route and CLI", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    const scope = {
      selectedTaskIds: [authored.taskOneId, authored.taskTwoId],
      selectedCriterionIds: [authored.criterionOneId, authored.criterionTwoId],
      exclusionDispositions: [],
    };

    // Route surface: the server refuses with a machine-readable code.
    const routeResponse = await world.postAction(
      SLUG,
      "start-execution",
      {
        revisionId: authored.draftRevisionId,
        scope,
        sessionName: SPINE_SESSION_NAME,
      },
      "agent",
    );
    expect(routeResponse.status).toBe(409);
    const refusal = (await routeResponse.json()) as {
      code: string;
      unmetConditions: string[];
      instruction: string;
    };
    expect(refusal.code).toBe("revision_not_approved");
    expect(refusal.unmetConditions).toEqual([
      "The pinned revision is not approved.",
    ]);
    expect(refusal.instruction).toContain("sign-off");

    // CLI surface: while the plan is proposed, `cctl spec start` falls back to
    // the latest approved design revision, which the stage gate also refuses.
    const cliResult = await runCli(
      ["spec", "start", SLUG, "--file", SCOPE_FILE, "--json"],
      cliEnv,
      bridgeHost(world, { [SCOPE_FILE]: JSON.stringify(scope) }),
    );
    expect(cliResult.exitCode).toBe(1);
    expect(JSON.parse(cliResult.stdout)).toMatchObject({
      ok: false,
      code: "gate_blocked",
      instruction:
        "Complete plan-stage authoring and sign off that revision before starting execution.",
    });

    // Durable event log: both refused attempts land as intervention rows
    // with actor provenance (21.4 counts refusals from these rows).
    const interventions = interventionRows(world, authored.specId);
    expect(interventions).toHaveLength(2);
    for (const intervention of interventions) {
      expect(intervention.actor).toEqual({
        kind: "agent",
        conversationId: SPINE_CONVERSATION_ID,
      });
      expect(intervention.payload).toMatchObject({
        kind: "transition-refused",
        surface: "execution_start",
      });
    }
    expect(interventions.map(({ payload }) => payload.code).sort()).toEqual([
      "gate_blocked",
      "revision_not_approved",
    ]);

    // The refusal blocked the transition: no execution row exists.
    expect(
      world.repos.delivery.findExecutionsBySpecId(authored.specId),
    ).toHaveLength(0);
  });

  it("refuses task completion claims without acceptable evidence through route and CLI, landing intervention rows", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);

    // Route surface: a claim citing no evidence is refused (6.6).
    const emptyClaim = await world.postAction(
      SLUG,
      "claim-task-complete",
      {
        taskElementId: authored.taskOneId,
        executionId: started.specExecutionId,
        evidenceIds: [],
      },
      "agent",
    );
    expect(emptyClaim.status).toBe(409);
    const emptyRefusal = (await emptyClaim.json()) as {
      code: string;
      findings?: Array<{
        ruleId: string;
        severity: string;
        elementHandle: string;
        message: string;
      }>;
      instruction: string;
    };
    expect(emptyRefusal.code).toBe("lint_blocked");
    expect(emptyRefusal.instruction).toContain("evidence");
    expect(emptyRefusal.findings).toEqual([
      {
        ruleId: "9.7.claim-without-evidence",
        severity: "blocks_claim",
        elementHandle: "R1.1",
        message: "T1 cannot be claimed complete because R1.1 has no evidence.",
      },
    ]);

    // Route surface: a claim citing evidence the server cannot resolve is
    // refused as unresolvable (9.7).
    const unresolvableClaim = await world.postAction(
      SLUG,
      "claim-task-complete",
      {
        taskElementId: authored.taskOneId,
        executionId: started.specExecutionId,
        evidenceIds: ["evidence-that-does-not-exist"],
      },
      "agent",
    );
    expect(unresolvableClaim.status).toBe(409);
    const unresolvableRefusal = (await unresolvableClaim.json()) as {
      code: string;
    };
    expect(unresolvableRefusal.code).toBe("unresolvable_evidence");

    // CLI surface: `cctl spec task complete` sends the empty evidence list to
    // the server (no local block) and surfaces the refusal as exit 1 carrying
    // the machine-readable code and the server's instruction (21.3).
    const cliResult = await runCli(
      [
        "spec",
        "task",
        "complete",
        `${SLUG}/T1`,
        "--execution",
        started.specExecutionId,
        "--json",
      ],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliResult.exitCode).toBe(1);
    expect(JSON.parse(cliResult.stdout)).toMatchObject({
      ok: false,
      code: "lint_blocked",
      details: {
        findings: [
          {
            ruleId: "9.7.claim-without-evidence",
            severity: "blocks_claim",
            elementHandle: "R1.1",
            message:
              "T1 cannot be claimed complete because R1.1 has no evidence.",
          },
        ],
      },
      instruction:
        "Cite ingested evidence ids for the task's covered criteria — the server ingests commit and validation evidence from workflow events — and claim again.",
    });

    // Durable event log: all three refused claims are intervention rows with
    // agent provenance.
    const interventions = interventionRows(world, authored.specId);
    expect(interventions).toHaveLength(3);
    expect(
      interventions.map((intervention) => intervention.payload.code),
    ).toEqual(["lint_blocked", "unresolvable_evidence", "lint_blocked"]);
    for (const intervention of interventions) {
      expect(intervention.actor).toEqual({
        kind: "agent",
        conversationId: SPINE_CONVERSATION_ID,
      });
      expect(intervention.payload).toMatchObject({
        kind: "transition-refused",
        surface: "task_claim",
        taskElementId: authored.taskOneId,
        executionId: started.specExecutionId,
      });
    }

    // The refusals blocked the transition: no claim row exists.
    expect(
      world.repos.delivery.findTaskClaimsBySpecId(authored.specId),
    ).toHaveLength(0);
  });

  it("refuses a merge whose selected criterion is in no acceptable state, halting the job and landing an intervention row", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    const { commitShas } = await runSpineWorkflowToEvidence(world, started);

    // A human grants the execution-scoped delivery approval so the policy
    // dial passes and the demonstrated refusal is the criterion-state check.
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
    // Same modeled lineage as a healthy candidate — the demonstrated refusal
    // comes from the divergent candidate tree, not a broken history.
    const branchHead = commitShas[commitShas.length - 1];
    if (branchHead === undefined) throw new Error("no lane commits produced");
    world.linkCommit("feature-head", [branchHead]);
    world.linkCommit("prepared-candidate", ["feature-head"]);
    world.treeByCommit.set("feature-head", "tree-final");
    // The prepared candidate's relevant tree diverges from the validated
    // tree, so the candidate-proof bridge cannot credit the validation and
    // every selected criterion stays without a valid proof verdict.
    world.treeByCommit.set("prepared-candidate", "tree-divergent");
    const scenario: MergeScenario = {
      validation: {
        validationRef: "validation-refused",
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

    // Observe the production SSE wire the UI renders job halts from, at the
    // designed transport seam: every publication layer (job broadcast ->
    // publishEvent -> status bus) runs; only the socket write is captured.
    const wireEvents: SSEEvent[] = [];
    setPublicationBroadcastForTesting((event) => {
      wireEvents.push(event);
    });

    const mergeResult = (await world.runMerge(
      "merge-job-refused",
      scenario,
    )) as {
      status: string;
      haltReason: {
        type: string;
        unmet: Array<{ criterionId: string; outcome: string }>;
        instruction: string;
      } | null;
    };

    // The merge halts with the machine-readable delivery-gate failure; the
    // candidate is never published.
    expect(mergeResult.status).toBe("failed");
    expect(mergeResult.haltReason?.type).toBe("delivery_gate_failed");
    expect(mergeResult.haltReason?.instruction.length).toBeGreaterThan(0);
    const unmetOutcomes = mergeResult.haltReason?.unmet ?? [];
    expect(unmetOutcomes.map((outcome) => outcome.criterionId).sort()).toEqual(
      [authored.criterionOneId, authored.criterionTwoId].sort(),
    );
    expect(
      unmetOutcomes.every((outcome) => outcome.outcome === "proof_required"),
    ).toBe(true);
    expect(scenario.publishedCandidates).toEqual([]);

    // Operator surfaces (21.3): the terminal job landed durably as failed, and
    // the halt rendered on the production SSE wire — the exact `job-status`
    // event the UI consumes — carrying the machine-readable reason.
    expect(world.repos.jobs.getJobRecord("merge-job-refused")).toMatchObject({
      status: "failed",
    });
    const haltEvent = wireEvents.find(
      (event) =>
        event.type === "job-status" &&
        "status" in event &&
        event.status === "failed",
    );
    expect(haltEvent).toMatchObject({
      jobId: "merge-job-refused",
      haltReason: { type: "delivery_gate_failed" },
    });

    // Durable event log: the gate refusal is an intervention row with system
    // provenance (the gate acts on the server's own authority).
    const interventions = interventionRows(world, authored.specId);
    expect(interventions).toHaveLength(1);
    const gateIntervention = interventions[0];
    expect(gateIntervention?.actor).toEqual({ kind: "system" });
    expect(gateIntervention?.payload).toMatchObject({
      kind: "transition-refused",
      surface: "delivery_gate",
      code: "delivery_gate_failed",
      executionId: started.specExecutionId,
      preparedSha: "prepared-candidate",
    });
    const recordedUnmet = gateIntervention?.payload.unmet as Array<{
      outcome: string;
    }>;
    expect(recordedUnmet.length).toBeGreaterThan(0);
    expect(
      recordedUnmet.every((outcome) => outcome.outcome === "proof_required"),
    ).toBe(true);

    // The refusal blocked the transition: the execution is still running.
    expect(
      world.repos.delivery.findExecutionById(started.specExecutionId)?.state,
    ).toBe("running");

    // Production halt propagation: a failed final-publish merge halts the
    // workflow execution with the same structured reason (the execution
    // loop's failed-join path), so the graph-workflow status route carries
    // the machine-readable refusal.
    await world.haltWorkflowExecution(
      graphWorkflowHaltReasonSchema.parse(mergeResult.haltReason),
    );
    const executionResponse = await world.postWorkflowRoute("EXECUTION");
    expect(executionResponse.status).toBe(200);
    const executionBody = (await executionResponse.json()) as {
      execution: {
        status: string;
        haltReason: { type: string; instruction: string } | null;
      } | null;
    };
    expect(executionBody.execution?.status).toBe("halted");
    expect(executionBody.execution?.haltReason).toMatchObject({
      type: "delivery_gate_failed",
    });

    // CLI surface (21.3): `cctl workflow status --json` reads the same route
    // and surfaces the machine-readable halt code with its instruction.
    const cliStatus = await runCli(
      ["workflow", "status", "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliStatus.exitCode).toBe(0);
    const cliBody = JSON.parse(cliStatus.stdout) as {
      ok: boolean;
      execution: {
        status: string;
        haltReason: { type: string; instruction: string } | null;
      };
    };
    expect(cliBody.execution.status).toBe("halted");
    expect(cliBody.execution.haltReason).toMatchObject({
      type: "delivery_gate_failed",
    });
    expect(cliBody.execution.haltReason?.instruction.length).toBeGreaterThan(0);
    // The compact human rendering names the halt code too.
    const cliHuman = await runCli(
      ["workflow", "status"],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliHuman.stdout).toContain("halted: delivery_gate_failed");
  });
});
