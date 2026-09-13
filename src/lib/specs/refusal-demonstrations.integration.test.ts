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
const ELEMENT_FILE = "/tmp/spine-refusal-element.json";

/**
 * The plan revision the spine proposes is revision 3: requirements and design
 * were signed off ahead of it. Both refusals address it by that number, and
 * both teach the same three exits, including the agent's own.
 */
const AMEND_INSTRUCTION =
  "Revision 3 is under review. Conclude that review before amending: sign off revision 3 in Spec Studio, have a human request changes on it, or — if this conversation proposed it and no human has acted on it yet — run `cctl spec withdraw-proposal <slug> --revision <revision-id>` to take it back and continue in the draft it reopens. Amending now would fork past the reviewed content.";
const ELEMENT_WRITE_INSTRUCTION =
  "Revision 3 is under review. Conclude that review before editing it: sign off revision 3 in Spec Studio, have a human request changes on it, or — if this conversation proposed it and no human has acted on it yet — run `cctl spec withdraw-proposal <slug> --revision <revision-id>` to take it back and continue in the draft it reopens. Writing into it now would change content a reviewer is reading.";

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
        if (segments.length === 5 && segments[4] === "summary") {
          return world.readHandlers.getSpecSummaryGET(request, {
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
        "A task is authored in a delivery plan attempt, not an evergreen revision.",
      ],
      instruction: expect.stringContaining("cctl spec plan open <slug>"),
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

  it("refuses a draft write whose covered criterion the revision does not carry, through the real authoring route", async () => {
    const slug = "dangling-cover";
    const created = await postJson<{
      spec: { id: string };
      draft: { id: string; authoringStage: string };
    }>(
      world.postAction(
        slug,
        "create",
        {
          slug,
          name: "Dangling cover",
          gatePolicy: { preset: "fast-path" },
          initialElement: {
            elementId: "requirement-covered",
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Every covered criterion exists.",
              priority: "must",
              risk: "high",
            },
          },
        },
        "agent",
      ),
    );
    expect(created.draft.authoringStage).toBe("requirements");
    world.db
      .prepare(
        "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
      )
      .run(created.draft.id);
    expect(
      (await world.repos.specs.findRevision(created.draft.id))?.authoringStage,
    ).toBe("plan");

    const response = await world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: created.draft.id,
        elementId: "task-dangling",
        kind: "task",
        parentElementId: null,
        position: 1,
        payload: {
          kind: "task",
          title: "Cover a criterion that was never written",
          instructions: "This write must remain outside the draft.",
          tracedRequirementElementIds: ["requirement-covered"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-never-written"],
          dependsOnTaskElementIds: [],
        },
        baseElementVersion: null,
      },
      "agent",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "dangling_reference",
      unmetConditions: [
        "task-dangling.coveredCriterionElementIds[0] covers criterion criterion-never-written, which is not in this revision.",
      ],
      instruction: expect.stringContaining("task-dangling"),
      details: {
        references: [
          {
            code: "missing_target",
            sourceElementId: "task-dangling",
            field: "coveredCriterionElementIds",
            index: 0,
            targetId: "criterion-never-written",
            expectedKind: "criterion",
            actualKind: null,
            relation: "covers",
          },
        ],
      },
    });
    expect(
      (
        await world.repos.specs.getRevisionSnapshot(created.draft.id)
      )?.elements.map(({ element }) => element.id),
    ).toEqual(["requirement-covered"]);
    expect(interventionRows(world, created.spec.id)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "draft-write-refused",
          refusal: expect.objectContaining({ code: "dangling_reference" }),
        }),
      }),
    ]);
  });

  it("refuses an orphaned element id through the real authoring route, then revives it on the stated retry", async () => {
    const slug = "orphaned-identity";
    const created = await postJson<{
      spec: { id: string };
      draft: { id: string };
    }>(
      world.postAction(
        slug,
        "create",
        {
          slug,
          name: "Orphaned identity",
          gatePolicy: { preset: "fast-path" },
          initialElement: {
            elementId: "requirement-kept",
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Carried by every revision.",
              priority: "must",
              risk: "high",
            },
          },
        },
        "agent",
      ),
    );
    await world.repos.specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-31T10:00:00.000Z",
    });
    await world.repos.specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-31T10:01:00.000Z",
    });
    const design = await postJson<{ revision: { id: string } }>(
      world.postAction(slug, "open-amendment", {}, "agent"),
    );
    await world.repos.specs.proposeRevision({
      revisionId: design.revision.id,
      proposedAt: "2026-07-31T10:01:10.000Z",
    });
    await world.repos.specs.approveRevision({
      revisionId: design.revision.id,
      approvedAt: "2026-07-31T10:01:20.000Z",
    });
    const attempt = await postJson<{ revision: { id: string } }>(
      world.postAction(slug, "open-amendment", {}, "agent"),
    );
    const orphanWrite = {
      elementId: "requirement-orphaned",
      kind: "requirement",
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Authored on the attempt a human ended.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: null,
    };
    expect(
      (
        await world.postAction(
          slug,
          "draft-upsert",
          { revisionId: attempt.revision.id, ...orphanWrite },
          "agent",
        )
      ).status,
    ).toBe(200);
    await world.repos.specs.proposeRevision({
      revisionId: attempt.revision.id,
      proposedAt: "2026-07-31T10:02:00.000Z",
    });
    // The human requested changes, which ends the revision and strands the
    // element id it introduced.
    await world.repos.specs.withdrawRevision({
      revisionId: attempt.revision.id,
    });
    const followUp = await postJson<{ revision: { id: string } }>(
      world.postAction(slug, "open-amendment", {}, "agent"),
    );

    const refused = await world.postAction(
      slug,
      "draft-upsert",
      { revisionId: followUp.revision.id, ...orphanWrite },
      "agent",
    );

    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "historical_element_id",
      instruction: expect.stringContaining('"reintroduceHistorical": true'),
      details: {
        reason: "reintroduction_required",
        elementId: "requirement-orphaned",
        handle: "R2",
        kind: "requirement",
      },
    });

    const revived = await postJson<{
      element: { id: string; number: number };
      version: { elementVersion: number };
      revived: boolean;
      handle: string;
    }>(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: followUp.revision.id,
          ...orphanWrite,
          reintroduceHistorical: true,
        },
        "agent",
      ),
    );

    expect(revived).toMatchObject({
      revived: true,
      handle: "R2",
      element: { id: "requirement-orphaned", number: 2 },
      version: { elementVersion: 1 },
    });
    expect(interventionRows(world, created.spec.id)).toEqual([]);
  });

  it("refuses an amendment and an element write against a revision under review through route and CLI", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    const revisionsBefore = await world.repos.specs.listRevisions(
      authored.specId,
    );

    // Route surface: continuing authoring from the approved base would fork
    // past the revision the reviewer is reading, so the amendment refuses.
    const routeResponse = await world.postAction(
      SLUG,
      "open-amendment",
      {},
      "agent",
    );
    expect(routeResponse.status).toBe(409);
    const refusal = (await routeResponse.json()) as {
      code: string;
      unmetConditions: string[];
      instruction: string;
      details: {
        proposals: Array<{ id: string; number: number }>;
        approvedBaseRevisionId: string | null;
      };
    };
    expect(refusal.code).toBe("revision_in_review");
    expect(refusal.instruction).toBe(AMEND_INSTRUCTION);
    expect(refusal.details).toEqual({
      proposals: [{ id: authored.draftRevisionId, number: 3 }],
      approvedBaseRevisionId: authored.designRevisionId,
    });

    // CLI surface: the same server throw, rendered by the real CLI in both
    // modes — no hand-written body stands between them.
    const cliJson = await runCli(
      ["spec", "amend", SLUG, "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliJson.exitCode).toBe(1);
    expect(JSON.parse(cliJson.stdout)).toMatchObject({
      ok: false,
      code: "revision_in_review",
      instruction: AMEND_INSTRUCTION,
      details: {
        proposals: [{ id: authored.draftRevisionId, number: 3 }],
        approvedBaseRevisionId: authored.designRevisionId,
      },
    });
    const cliText = await runCli(
      ["spec", "amend", SLUG],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliText.exitCode).toBe(1);
    expect(cliText.stderr).toContain(`instruction: ${AMEND_INSTRUCTION}`);

    // The write half of the pair: an element write into the proposed revision
    // names the same revision the same way, and names the act it refused.
    const elementWrite = await runCli(
      ["spec", "draft", SLUG, "--file", ELEMENT_FILE],
      cliEnv,
      bridgeHost(world, {
        [ELEMENT_FILE]: JSON.stringify({
          elementId: "element-requirement-late",
          kind: "requirement",
          parentElementId: null,
          baseElementVersion: null,
          payload: {
            kind: "requirement",
            statement: "Late requirements wait for the review to conclude.",
            priority: "must",
            risk: "low",
          },
        }),
      }),
    );
    expect(elementWrite.exitCode).toBe(1);
    expect(elementWrite.stderr).toContain(
      `instruction: ${ELEMENT_WRITE_INSTRUCTION}`,
    );

    // The refusals blocked every transition: no revision was forked and the
    // reviewed revision still carries exactly the proposed content.
    expect(
      (await world.repos.specs.listRevisions(authored.specId)).map(
        ({ id }) => id,
      ),
    ).toEqual(revisionsBefore.map(({ id }) => id));
    expect(
      (
        await world.repos.specs.getRevisionSnapshot(authored.draftRevisionId)
      )?.elements.map(({ element }) => element.id),
    ).not.toContain("element-requirement-late");
  });

  it("lets the proposing agent take its own proposal back, and refuses every other caller, through route and CLI", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);

    // The revision id is the caller's compare-and-swap token, so the CLI
    // refuses locally at exit 2 rather than inferring the current proposal.
    const missingToken = await runCli(
      ["spec", "withdraw-proposal", SLUG],
      cliEnv,
      bridgeHost(world),
    );
    expect(missingToken.exitCode).toBe(2);
    expect(missingToken.stderr).toContain("--revision <revision-id>");

    // A human transport is not the author: the refusal names the two exits
    // Spec Studio actually offers instead of the agent verb.
    const humanCaller = await world.postAction(
      SLUG,
      "withdraw-proposal",
      { revisionId: authored.draftRevisionId },
      "human",
    );
    expect(humanCaller.status).toBe(409);
    const humanRefusal = (await humanCaller.json()) as {
      code: string;
      instruction: string;
    };
    expect(humanRefusal.code).toBe("proposal_not_owned");
    expect(humanRefusal.instruction).toContain("Request Changes");

    // A stale token — a revision this spec approved earlier — carries no
    // proposal, so the CAS check refuses rather than withdrawing something.
    const staleToken = await runCli(
      [
        "spec",
        "withdraw-proposal",
        SLUG,
        "--revision",
        authored.designRevisionId,
        "--json",
      ],
      cliEnv,
      bridgeHost(world),
    );
    expect(staleToken.exitCode).toBe(1);
    expect(JSON.parse(staleToken.stdout)).toMatchObject({
      ok: false,
      code: "gate_blocked",
    });

    // The proposing conversation's own exit, through the real CLI: the
    // revision the amend refusal named is taken back and reopened as a draft.
    const withdrawn = await runCli(
      [
        "spec",
        "withdraw-proposal",
        SLUG,
        "--revision",
        authored.draftRevisionId,
        "--json",
      ],
      cliEnv,
      bridgeHost(world),
    );
    expect(withdrawn.exitCode).toBe(0);
    const receipt = JSON.parse(withdrawn.stdout) as {
      ok: boolean;
      withdrawal: {
        withdrawn: { id: string; state: string };
        draft: { id: string; state: string; basedOnRevisionId: string };
      };
    };
    expect(receipt).toMatchObject({
      ok: true,
      withdrawal: {
        withdrawn: { id: authored.draftRevisionId, state: "withdrawn" },
        draft: { state: "draft", basedOnRevisionId: authored.draftRevisionId },
      },
    });

    const reloaded = await world.repos.specs.listRevisions(authored.specId);
    expect(
      reloaded.filter((revision) => revision.state === "draft"),
    ).toMatchObject([{ id: receipt.withdrawal.draft.id }]);
    // The follow-up carries evergreen reviewed content forward. Legacy task
    // elements remain readable on the withdrawn Plan revision and are not
    // copied into the design draft that replaces it.
    const withdrawnElements = (
      await world.repos.specs.getRevisionSnapshot(authored.draftRevisionId)
    )?.elements.map(({ element }) => element.id);
    const replacementElements = (
      await world.repos.specs.getRevisionSnapshot(receipt.withdrawal.draft.id)
    )?.elements.map(({ element }) => element.id);
    expect(withdrawnElements).toEqual(
      expect.arrayContaining([authored.taskOneId, authored.taskTwoId]),
    );
    expect(
      replacementElements?.some(
        (elementId) =>
          elementId === authored.taskOneId || elementId === authored.taskTwoId,
      ),
    ).toBe(false);
    expect(replacementElements).toEqual(
      withdrawnElements?.filter(
        (elementId) =>
          elementId !== authored.taskOneId && elementId !== authored.taskTwoId,
      ),
    );
    expect(interventionRows(world, authored.specId)).toEqual([]);
  });

  it("rejects the retired execution scope through route and CLI with the direct-plan remedy", async () => {
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
    expect(routeResponse.status).toBe(400);
    const refusal = (await routeResponse.json()) as {
      code: string;
      unmetConditions: string[];
      instruction: string;
    };
    expect(refusal.code).toBe("validation");
    expect(refusal.unmetConditions).toEqual([
      "Execution scope documents are retired; the approved delivery plan is the execution graph.",
    ]);
    expect(refusal.instruction).toContain(`cctl spec plan open ${SLUG}`);
    expect(refusal.instruction).not.toMatch(/legacy planning|--seed-from/i);

    // CLI rejects locally, before reading the retired file or contacting the
    // route, and returns the same migration act.
    const cliResult = await runCli(
      ["spec", "start", SLUG, "--file", SCOPE_FILE, "--json"],
      cliEnv,
      bridgeHost(world, { [SCOPE_FILE]: JSON.stringify(scope) }),
    );
    expect(cliResult.exitCode).toBe(2);
    expect(JSON.parse(cliResult.stdout)).toMatchObject({
      ok: false,
      instruction: expect.stringContaining(`cctl spec plan open ${SLUG}`),
    });
    expect(JSON.parse(cliResult.stdout).instruction).not.toMatch(
      /legacy planning|--seed-from/i,
    );

    // Both transport guards reject before the execution service is entered,
    // so neither can manufacture a durable transition event.
    const interventions = interventionRows(world, authored.specId);
    expect(interventions).toEqual([]);

    // The refusal blocked the transition: no execution row exists.
    expect(
      world.repos.delivery.findExecutionsBySpecId(authored.specId),
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
    // Every selected criterion is unmet because no authored claimant reached a
    // satisfied outcome, and the execution-keyed row is the integration check
    // the direct gate reports beside them.
    const unmetOutcomes = mergeResult.haltReason?.unmet ?? [];
    expect(unmetOutcomes.map((outcome) => outcome.criterionId).sort()).toEqual(
      [
        authored.criterionOneId,
        authored.criterionTwoId,
        started.specExecutionId,
      ].sort(),
    );
    expect(
      unmetOutcomes
        .filter((outcome) => outcome.criterionId !== started.specExecutionId)
        .every((outcome) => outcome.outcome === "pending"),
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
      preparedSha: "",
    });
    const recordedUnmet = gateIntervention?.payload.unmet as Array<{
      criterionId: string;
      outcome: string;
    }>;
    expect(recordedUnmet.length).toBeGreaterThan(0);
    expect(
      recordedUnmet
        .filter((outcome) => outcome.criterionId !== started.specExecutionId)
        .every((outcome) => outcome.outcome === "pending"),
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
    // and names the halt code; the selector it points at carries the whole
    // machine-readable reason with its instruction.
    const cliStatus = await runCli(
      ["workflow", "status", "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliStatus.exitCode).toBe(0);
    const cliBody = JSON.parse(cliStatus.stdout) as {
      ok: boolean;
      execution: { status: string; halted: boolean; haltType: string | null };
      next: string;
    };
    expect(cliBody.execution.status).toBe("halted");
    expect(cliBody.execution.halted).toBe(true);
    expect(cliBody.execution.haltType).toBe("delivery_gate_failed");
    expect(cliBody.next).toBe("cctl workflow status --halt");

    const cliHalt = await runCli(
      ["workflow", "status", "--halt", "--json"],
      cliEnv,
      bridgeHost(world),
    );
    const haltBody = JSON.parse(cliHalt.stdout) as {
      haltReason: { type: string; instruction: string } | null;
    };
    expect(haltBody.haltReason).toMatchObject({
      type: "delivery_gate_failed",
    });
    expect(haltBody.haltReason?.instruction.length).toBeGreaterThan(0);
    // The compact human rendering names the halt code too.
    const cliHuman = await runCli(
      ["workflow", "status"],
      cliEnv,
      bridgeHost(world),
    );
    expect(cliHuman.stdout).toContain("halted: delivery_gate_failed");
  });
});

/**
 * The D3 incident ticket #42 reported. A withdrawn attempt introduced a
 * requirement change; the follow-up revision carries it while changing nothing
 * against that withdrawn parent, so the requirements gate still owes an
 * admission even though the revision sits at the design stage. The propose
 * receipt and the status read both have to name the gate that is actually
 * outstanding, and both read it from the server projection rather than the
 * revision's authoring stage.
 */
describe("authoring blocks (ticket #42): the CLI renders the server's projection", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    world = createSpecSpineWorld();
  });

  afterEach(() => {
    resetJobQueue();
    _resetPublicationForTesting();
  });

  interface WithdrawnAttempt {
    specId: string;
    approvedRevisionId: string;
    withdrawnRevisionId: string;
    followUpRevisionId: string;
  }

  /**
   * rev1 (requirements) approved → rev2 (design) restates the requirement and
   * adds the decision → the decision is approved and a human requests changes →
   * rev3 carries both, unchanged against rev2.
   */
  async function withdrawnAttempt(slug: string): Promise<WithdrawnAttempt> {
    const created = await postJson<{
      spec: { id: string };
      draft: { id: string };
    }>(
      world.postAction(
        slug,
        "create",
        {
          slug: slug,
          name: "Withdrawn attempt",
          gatePolicy: { preset: "contract-bearing" },
          initialElement: {
            elementId: `${slug}-element-requirement-1`,
            kind: "requirement",
            parentElementId: null,
            position: 0,
            payload: {
              kind: "requirement",
              statement: "Every admitted revision names its admitting human.",
              priority: "must",
              risk: "high",
            },
          },
        },
        "agent",
      ),
    );
    const specId = created.spec.id;
    const approvedRevisionId = created.draft.id;
    await postJson(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: approvedRevisionId,
          elementId: `${slug}-element-criterion-1`,
          kind: "criterion",
          parentElementId: `${slug}-element-requirement-1`,
          position: 1,
          payload: {
            kind: "criterion",
            text: "The admission row carries the human's provenance.",
            validationStrategy: { kinds: ["test_run"] },
          },
          baseElementVersion: null,
        },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "propose",
        { revisionId: approvedRevisionId },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "approve-item",
        {
          revisionId: approvedRevisionId,
          subjectKind: "requirement",
          elementId: `${slug}-element-requirement-1`,
        },
        "human",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "sign-off",
        { revisionId: approvedRevisionId },
        "human",
      ),
    );

    const attempt = await postJson<{ revision: { id: string } }>(
      world.postAction(slug, "open-amendment", {}, "agent"),
    );
    const withdrawnRevisionId = attempt.revision.id;
    world.db
      .prepare(
        "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
      )
      .run(withdrawnRevisionId);
    await postJson(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: withdrawnRevisionId,
          elementId: `${slug}-element-requirement-1`,
          kind: "requirement",
          parentElementId: null,
          payload: {
            kind: "requirement",
            statement:
              "Every admitted revision names its admitting human and the basis.",
            priority: "must",
            risk: "high",
          },
          baseElementVersion: 1,
        },
        "agent",
      ),
    );
    world.db
      .prepare(
        "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
      )
      .run(withdrawnRevisionId);
    await postJson(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: withdrawnRevisionId,
          elementId: `${slug}-element-decision-1`,
          kind: "decision",
          parentElementId: null,
          position: 2,
          payload: {
            kind: "decision",
            title: "Admission provenance",
            chosenApproach: "Persist the actor beside the admission row.",
            rejectedAlternatives: [],
            reason: "The admitting human stays attributable after the fact.",
            tracedRequirementElementIds: [`${slug}-element-requirement-1`],
          },
          baseElementVersion: null,
        },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "propose",
        { revisionId: withdrawnRevisionId },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "approve-item",
        {
          revisionId: withdrawnRevisionId,
          subjectKind: "decision",
          elementId: `${slug}-element-decision-1`,
        },
        "human",
      ),
    );
    const changesRequested = await postJson<{ draft: { id: string } }>(
      world.postAction(
        slug,
        "request-changes",
        { revisionId: withdrawnRevisionId },
        "human",
      ),
    );
    return {
      specId,
      approvedRevisionId,
      withdrawnRevisionId,
      followUpRevisionId: changesRequested.draft.id,
    };
  }

  it("names the requirements gate a design-stage propose still owes", async () => {
    const slug = "withdrawn-attempt";
    const attempt = await withdrawnAttempt(slug);
    const stage = (
      await world.repos.specs.getRevisionSnapshot(attempt.followUpRevisionId)
    )?.revision.authoringStage;
    expect(stage).toBe("design");

    const structured = await runCli(
      ["spec", "propose", slug, "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(structured.exitCode).toBe(0);
    const envelope = JSON.parse(structured.stdout) as {
      blocked: string;
      next: string;
      instruction: string;
      proposal: {
        pendingBlock: {
          display: string;
          instruction: string;
          outstandingSubjects: Array<{ gate: string; subject: string }>;
        };
        nextAction: { kind: string; gate: string; subject: string };
        approvalRequests: Array<{
          gate: string;
          outcome: string;
          attentionId: string | null;
        }>;
      };
    };
    // The gate that is actually outstanding is requirements, introduced
    // through the withdrawn attempt — not the revision's own design stage.
    expect(envelope.proposal.pendingBlock.outstandingSubjects).toEqual([
      {
        gate: "requirements",
        subject: "R1",
        elementId: `${slug}-element-requirement-1`,
      },
    ]);
    expect(envelope.proposal.nextAction).toMatchObject({
      kind: "approve_subject",
      gate: "requirements",
      subject: "R1",
    });
    // The CLI renders the server's block rather than authoring its own.
    expect(envelope.blocked).toBe(envelope.proposal.pendingBlock.display);
    expect(envelope.instruction).toBe(
      envelope.proposal.pendingBlock.instruction,
    );
    // The propose filed an ask per pending gate on its way out — this
    // cumulative propose leaves both the withdrawn attempt's requirements gate
    // and its own design gate open — so the caller is not sent to
    // `request-approval` for requests that already exist.
    expect(envelope.proposal.approvalRequests).toEqual([
      {
        gate: "requirements",
        outcome: "filed",
        attentionId: expect.any(String),
      },
      { gate: "design", outcome: "filed", attentionId: expect.any(String) },
    ]);
    expect(envelope.next).toBe(`cctl spec status ${slug}`);

    // A second spec in the same shape, because the propose above already
    // consumed the first one's draft.
    const textSlug = "withdrawn-attempt-text";
    await withdrawnAttempt(textSlug);
    const text = await runCli(
      ["spec", "propose", textSlug],
      cliEnv,
      bridgeHost(world),
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      `acts next: human — ${envelope.proposal.pendingBlock.display}`,
    );
    expect(text.stdout).toContain("approval requests:\n  requirements filed (");
    expect(text.stdout).toContain(`next: cctl spec status ${textSlug}`);
    // The stage-derived blocker named the wrong gate and offered a subjectless
    // request the server refuses as invalid_subject.
    expect(text.stdout).not.toContain("the design gate needs human sign-off");
    expect(text.stdout).not.toContain("--gate design");
  });

  it("reports the outstanding revision sign-off beside an empty subject list", async () => {
    const slug = "withdrawn-attempt";
    const attempt = await withdrawnAttempt(slug);
    await postJson(
      world.postAction(
        slug,
        "propose",
        { revisionId: attempt.followUpRevisionId },
        "agent",
      ),
    );
    await postJson(
      world.postAction(
        slug,
        "approve-item",
        {
          revisionId: attempt.followUpRevisionId,
          subjectKind: "requirement",
          elementId: `${slug}-element-requirement-1`,
        },
        "human",
      ),
    );

    const structured = await runCli(
      ["spec", "status", slug, "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(structured.exitCode).toBe(0);
    const status = JSON.parse(structured.stdout).status as {
      pendingApprovals: unknown[];
      revisionSignOff: { revisionNumber: number; state: string };
      gates: Array<{ gate: string; state: string }>;
    };
    expect(status.pendingApprovals).toEqual([]);
    expect(status.revisionSignOff).toMatchObject({
      revisionNumber: 3,
      state: "ready",
    });
    expect(
      status.gates.find((gate) => gate.gate === "requirements")?.state,
    ).toBe("pending");

    const text = await runCli(
      ["spec", "status", slug],
      cliEnv,
      bridgeHost(world),
    );
    expect(text.exitCode).toBe(0);
    // The contradiction the ticket reported: an empty subject list must not be
    // the only thing status says while a consulted gate is still pending.
    expect(text.stdout).not.toContain("pending approvals:\n  none");
    expect(text.stdout).toContain("revision sign-off:");
    expect(text.stdout).toContain("outstanding (rev 3)");

    // The inventory rollup reads the same position: a revision whose sign-off
    // a human still owes is not approvals-complete, or it disappears from the
    // "needs a human" counts the specs list is for.
    const summary = await runCli(
      ["spec", "show", slug, "--summary", "--json"],
      cliEnv,
      bridgeHost(world),
    );
    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summary.stdout)).toMatchObject({
      approvalState: "pending",
      pendingApprovalCount: 1,
    });
  });
});
