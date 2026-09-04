import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyDefinitionEdits } from "@/lib/workflow-graph/definition-edits";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import { workflowDefinitionHash } from "./delivery-plan-hash";
import { createManagedWorkflowDefinitionService } from "./managed-workflow-definition-service";
import type { Spec } from "./schemas";

const SPEC: Spec = {
  id: "spec-1",
  projectPath: "/repo",
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:00:00.000Z",
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-managed-definition-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("managed workflow definition service", () => {
  it("discovers the sole unlinked open or reopen definition and refuses ambiguity", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const service = createManagedWorkflowDefinitionService({ storage });
    const launch = createWorkflowDefinitionRecord();
    const first = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "orphan-open-1",
      launch,
    });

    await expect(
      service.findOpenOrphan({
        spec: SPEC,
        pinnedRevisionId: "revision-1",
        existingAttemptIds: [],
      }),
    ).resolves.toEqual(first);
    await expect(
      service.findOpenOrphan({
        spec: SPEC,
        pinnedRevisionId: "revision-1",
        existingAttemptIds: [first.id],
      }),
    ).resolves.toBeNull();

    const clone = await service.clone({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: first.id,
      sourceDefinitionId: first.id,
      cloneDefinitionId: "orphan-reopen-1",
    });
    await expect(
      service.findReopenOrphan({
        spec: SPEC,
        pinnedRevisionId: "revision-1",
        attemptId: first.id,
        linkedDefinitionIds: [first.id],
      }),
    ).resolves.toEqual(clone);

    await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "orphan-open-2",
      launch,
    });
    await expect(
      service.findOpenOrphan({
        spec: SPEC,
        pinnedRevisionId: "revision-1",
        existingAttemptIds: [],
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("removes only the exact definition identity named by a failed commit", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const service = createManagedWorkflowDefinitionService({ storage });
    const record = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "failed-commit",
      launch: createWorkflowDefinitionRecord(),
    });

    await expect(
      service.removeExact({
        projectPath: SPEC.projectPath,
        workflowDefinitionId: record.id,
        revision: record.revision,
        definitionHash: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    await expect(
      service.get({
        projectPath: SPEC.projectPath,
        workflowDefinitionId: record.id,
      }),
    ).resolves.toEqual(record);

    await expect(
      service.removeExact({
        projectPath: SPEC.projectPath,
        workflowDefinitionId: record.id,
        revision: record.revision,
        definitionHash: workflowDefinitionHash(record),
      }),
    ).resolves.toBe(true);
  });

  it("opens idempotently, clones finalized ownership, and verifies exact identity", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const service = createManagedWorkflowDefinitionService({ storage });
    const launch = createWorkflowDefinitionRecord();

    const first = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-1",
      launch,
    });
    const replay = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-1",
      launch,
    });
    const clone = await service.clone({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-1",
      sourceDefinitionId: first.id,
      cloneDefinitionId: "candidate-2",
    });

    expect(replay).toEqual(first);
    expect(clone.id).toBe("candidate-2");
    expect(clone.layout.workflowId).toBe("candidate-2");
    expect(clone.definition.origin?.sourceUri).toContain(
      "/candidates/candidate-2",
    );
    await expect(
      service.getExact({
        projectPath: SPEC.projectPath,
        workflowDefinitionId: clone.id,
        revision: clone.revision,
        definitionHash: workflowDefinitionHash(clone),
      }),
    ).resolves.toEqual(clone);
  });

  it("restages a draft into a frozen candidate and back through storage revisions", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const service = createManagedWorkflowDefinitionService({ storage });
    const opened = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-restage",
      launch: createWorkflowDefinitionRecord(),
    });
    expect(
      opened.definition.lockedRegions?.flatMap((lock) => lock.paths),
    ).not.toContain("/charter");

    const frozen = await service.restage({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-restage",
      workflowDefinitionId: opened.id,
      expectedRevision: opened.revision,
      stage: "candidate",
    });
    expect(frozen.revision).toBe(opened.revision + 1);
    expect(frozen.definition.lockedRegions?.map((lock) => lock.paths)).toEqual([
      ["/charter"],
      ["/origin", "/approvalRequired"],
    ]);
    await expect(
      service.getExact({
        projectPath: SPEC.projectPath,
        workflowDefinitionId: opened.id,
        revision: frozen.revision,
        definitionHash: workflowDefinitionHash(frozen),
      }),
    ).resolves.toEqual(frozen);

    const thawed = await service.restage({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-restage",
      workflowDefinitionId: opened.id,
      expectedRevision: frozen.revision,
      stage: "draft",
    });
    expect(thawed.revision).toBe(frozen.revision + 1);
    expect(thawed.definition).toEqual(opened.definition);

    const clone = await service.clone({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-restage",
      sourceDefinitionId: opened.id,
      cloneDefinitionId: "attempt-restage-clone",
    });
    const cloneSourceIds = clone.definition.charter.sourcesOfTruth.map(
      (source) => source.id,
    );
    expect(new Set(cloneSourceIds).size).toBe(cloneSourceIds.length);
    expect(
      clone.definition.lockedRegions?.flatMap((lock) => lock.paths),
    ).not.toContain("/charter");
  });

  it("keeps authored edge ids through a replace, the propose freeze and the reopen clone", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
      // The freeze changes the lock table, and that check consults the live
      // execution list; no execution is seeded from this definition.
      listActiveExecutions: async () => new Map(),
    });
    const service = createManagedWorkflowDefinitionService({ storage });
    const scope = { kind: "project" as const, projectPath: SPEC.projectPath };
    const opened = await service.open({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-edges",
      launch: createWorkflowDefinitionRecord(),
    });
    const edges = [
      {
        id: "edge-plan-to-implement",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
      {
        id: "edge-implement-to-verify",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
    ];

    // What `workflow replace` persists for a managed draft: the stored record
    // with the planner's graph, server-owned fields carried across.
    const replaced = await storage.update(scope, opened.id, opened.revision, {
      name: opened.name,
      description: opened.description,
      definition: { ...opened.definition, edges },
      layout: opened.layout,
    });
    expect(replaced.definition.edges).toEqual(edges);

    const frozen = await service.restage({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-edges",
      workflowDefinitionId: opened.id,
      expectedRevision: replaced.revision,
      stage: "candidate",
    });
    expect(frozen.definition.edges).toEqual(edges);

    const clone = await service.clone({
      spec: SPEC,
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-edges",
      sourceDefinitionId: opened.id,
      cloneDefinitionId: "attempt-edges-clone",
    });
    expect(clone.definition.edges).toEqual(edges);

    const removed = applyDefinitionEdits(clone, [
      { type: "remove-edge", edgeId: "edge-plan-to-implement" },
    ]);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.record.definition.edges.map((edge) => edge.id)).toEqual([
      "edge-implement-to-verify",
    ]);
  });
});
