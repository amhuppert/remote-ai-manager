import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";
import { runCli } from "@/cli/core";
import type { CliHost } from "@/cli/shared";

import { MEASURE_DEFINITIONS_VERSION } from "./measures";
import { createMeasuresQuery } from "./measures-query";

const PROJECT_PATH = "/repos/measures";
const SPEC_ID = "spec-measures";
const REVISION_ID = "revision-measures";
const SPEC_EXECUTION_ID = "spec-execution-measures";
const WORKFLOW_EXECUTION_ID = "workflow-execution-measures";
const AT = "2026-07-18T12:00:00.000Z";

describe("MeasuresQuery", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "measure-session",
      "/tmp/measure-session",
      "csm/measure",
      AT,
      AT,
    );
    db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json,
         abandoned_at, abandoned_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      SPEC_ID,
      PROJECT_PATH,
      "measure-spec",
      "Measure Spec",
      '{"preset":"contract-bearing"}',
      AT,
      AT,
    );
    db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, based_on_revision_id, content_hash,
         proposed_at, approved_at, created_at
       ) VALUES (?, ?, 1, 'approved', NULL, 'hash', ?, ?, ?)`,
    ).run(REVISION_ID, SPEC_ID, AT, AT, AT);

    createSpecDeliveryRepo(db).insertExecution({
      id: SPEC_EXECUTION_ID,
      spec_id: SPEC_ID,
      revision_id: REVISION_ID,
      scope_json: "{}",
      state: "delivered",
      workflow_definition_id: "workflow-definition-measures",
      workflow_execution_id: WORKFLOW_EXECUTION_ID,
      session_name: "measure-session",
      delivered_at: AT,
      abandoned_reason: null,
      created_at: AT,
      updated_at: AT,
    });

    const specEvents = createSpecEventsRepo(db);
    const append = (
      eventType:
        | "spec-evidence-changed"
        | "spec-execution-changed"
        | "spec-review-commented"
        | "spec-review-revision-signed-off",
      payload: Record<string, unknown>,
      second: number,
    ) =>
      specEvents.append({
        spec_id: SPEC_ID,
        occurred_at: `2026-07-18T12:00:${String(second).padStart(2, "0")}.000Z`,
        event_type: eventType,
        actor_json: '{"kind":"system"}',
        payload_json: JSON.stringify(
          payload.kind === "execution_delivered"
            ? payload
            : { kind: "lifecycle-measure", measureEvents: [payload] },
        ),
      });
    append(
      "spec-review-revision-signed-off",
      {
        kind: "review-action",
        action: "sign_off",
        reviewAttemptId: "attempt-1",
        activeStartedAt: "2026-07-18T11:59:58.000Z",
        revisionId: REVISION_ID,
      },
      1,
    );
    append(
      "spec-review-commented",
      {
        kind: "review-action",
        action: "comment",
        reviewAttemptId: "attempt-1",
        activeStartedAt: "2026-07-18T12:00:01.000Z",
      },
      2,
    );
    append(
      "spec-evidence-changed",
      {
        kind: "task-claim-reopened",
        claimId: "claim-1",
        taskId: "task-1",
        changedIntentElementIds: ["requirement-1"],
      },
      3,
    );
    append(
      "spec-execution-changed",
      {
        kind: "criterion-delivered-in-scope",
        criterionId: "criterion-1",
        requirementId: "requirement-1",
        revisionId: REVISION_ID,
        executionId: SPEC_EXECUTION_ID,
        taskIds: ["task-1", "task-2"],
      },
      4,
    );
    append(
      "spec-evidence-changed",
      {
        kind: "evidence-attached",
        evidenceId: "evidence-1",
        criterionId: "criterion-1",
        revisionId: REVISION_ID,
        evidenceKind: "commit",
        source: "execution_ingest",
        evaluatedCommitSha: "task-sha",
      },
      5,
    );
    append(
      "spec-evidence-changed",
      {
        kind: "proof-verdict-recorded",
        verdictId: "verdict-1",
        criterionId: "criterion-1",
        revisionId: REVISION_ID,
        evidenceIds: ["evidence-1"],
        valid: true,
      },
      6,
    );
    append(
      "spec-execution-changed",
      {
        kind: "execution_delivered",
        executionId: SPEC_EXECUTION_ID,
        revisionId: REVISION_ID,
        mergeHash: "merge-sha",
      },
      7,
    );

    createGraphWorkflowEventsRepo(db).appendMany(
      PROJECT_PATH,
      "measure-session",
      WORKFLOW_EXECUTION_ID,
      AT,
      [
        {
          occurredAt: AT,
          preReset: false,
          event: {
            type: "graph-workflow-lane-commit",
            projectName: "measures",
            sessionName: "measure-session",
            executionId: WORKFLOW_EXECUTION_ID,
            contextId: "context-regrouped",
            laneId: "lane-1",
            sha: "task-sha",
            committedAt: AT,
          },
        },
      ],
    );
  });

  afterEach(() => db.close());

  it("computes all measures and attributes a regrouped context commit to every compiled task", async () => {
    const query = createMeasuresQuery({
      specs: createSpecsRepo(db, createWriteQueue()),
      events: createSpecEventsRepo(db),
      delivery: createSpecDeliveryRepo(db),
      workflowEvents: createGraphWorkflowEventsRepo(db),
      async loadOriginMap(workflowDefinitionId, projectPath) {
        expect(workflowDefinitionId).toBe("workflow-definition-measures");
        expect(projectPath).toBe(PROJECT_PATH);
        return ["task-1", "task-2"].map((taskElementId) => ({
          contextId: "context-regrouped",
          taskElementId,
          taskHandle: taskElementId === "task-1" ? "T1" : "T2",
          criterionElementIds: ["criterion-1"],
          criterionHandles: ["R1.1"],
          validationStrategies: {
            "criterion-1": { kinds: ["commit"] as const },
          },
          criterionBriefs: { "criterion-1": "Run the committed proof." },
        }));
      },
      now: () => "2026-07-18T12:01:00.000Z",
    });

    const host: CliHost = {
      async fetch(url, init) {
        expect(new URL(url).pathname).toBe(
          "/api/projects/measures/spec-measures",
        );
        expect(init.method).toBe("GET");
        return Response.json(await query.forProject(PROJECT_PATH));
      },
      async readTextFile() {
        return null;
      },
      async readFileBytes() {
        return null;
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
    const env = { CC_SERVER_URL: "http://cc.test", CC_PROJECT: "measures" };
    const firstResult = await runCli(["spec", "measures", "--json"], env, host);
    const secondResult = await runCli(
      ["spec", "measures", "--json"],
      env,
      host,
    );
    const { ok: firstOk, ...first } = JSON.parse(firstResult.stdout);
    const { ok: secondOk, ...second } = JSON.parse(secondResult.stdout);

    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(0);
    expect(firstOk).toBe(true);
    expect(secondOk).toBe(true);
    expect(first).toMatchObject({
      definitionsVersion: MEASURE_DEFINITIONS_VERSION,
      requirementCausedRework: { totalReworkEventCount: 1 },
      approvalFriction: { interventionCount: 1 },
      traceabilityCompleteness: { share: 1 },
      automaticEvidenceCapture: { share: 1 },
      navigationChains: [
        {
          criterionId: "criterion-1",
          approvedRevisionId: REVISION_ID,
          tasks: [
            { taskId: "task-1", changedCode: [{ commitSha: "task-sha" }] },
            { taskId: "task-2", changedCode: [{ commitSha: "task-sha" }] },
          ],
          validProof: { verdictId: "verdict-1" },
          mergeResult: { mergeCommitSha: "merge-sha" },
          complete: true,
        },
      ],
    });
    expect(second).toEqual(first);
    const frozen = createSpecEventsRepo(db)
      .findBySpecId(SPEC_ID)
      .filter(
        (event) =>
          JSON.parse(event.payload_json).kind === "measure-definitions-frozen",
      );
    expect(frozen).toHaveLength(1);
    expect(JSON.parse(frozen[0]?.payload_json ?? "null")).toEqual({
      kind: "measure-definitions-frozen",
      definitionsVersion: MEASURE_DEFINITIONS_VERSION,
    });
  });
});
