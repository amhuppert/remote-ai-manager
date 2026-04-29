import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactRegistry } from "./artifact-registry";
import { createInMemoryWorkflowEnvelopeStore } from "./workflow-envelope-store";
import { writeFeatureSnapshotAsArtifact } from "./workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "./workflow-envelope-repository";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

let WORKTREE_DIR: string;

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-large",
    workflowType: "collaboration",
    status: "running",
    phase: "round-7",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

beforeEach(async () => {
  WORKTREE_DIR = await mkdtemp(path.join(tmpdir(), "cc-envelope-artifact-"));
});

afterEach(async () => {
  await rm(WORKTREE_DIR, { recursive: true, force: true });
});

describe("writeFeatureSnapshotAsArtifact — bounded envelope payload via artifact reference", () => {
  it("writes the snapshot to disk through the artifact registry and returns the reference shape used in the envelope", async () => {
    const registry = createArtifactRegistry({
      writeFile: async (absolute, contents) => {
        await writeFile(absolute, contents);
      },
      ensureDir: async (absolute) => {
        await mkdir(absolute, { recursive: true });
      },
      now: () => "2026-04-28T10:00:00.000Z",
      newId: () => "art-snapshot-1",
    });

    const largeSnapshot = {
      rounds: Array.from({ length: 50 }, (_, i) => ({
        index: i,
        body: "x".repeat(2_000),
      })),
    };

    const reference = await writeFeatureSnapshotAsArtifact({
      registry,
      worktreePath: WORKTREE_DIR,
      workflowId: "wf-large",
      snapshot: largeSnapshot,
    });

    expect(reference.kind).toBe("artifact_reference");
    expect(reference.artifactId).toBe("art-snapshot-1");
    expect(reference.relativePath).toBe(".cc/workflow/wf-large/snapshot.json");

    const written = await readFile(
      path.join(WORKTREE_DIR, reference.relativePath),
      "utf-8",
    );
    expect(JSON.parse(written)).toEqual(largeSnapshot);
  });

  it("stores the artifact reference in the envelope so the durable payload stays bounded", async () => {
    const registry = createArtifactRegistry({
      writeFile: async (absolute, contents) => {
        await writeFile(absolute, contents);
      },
      ensureDir: async (absolute) => {
        await mkdir(absolute, { recursive: true });
      },
      now: () => "2026-04-28T10:00:00.000Z",
      newId: () => "art-snapshot-bounded",
    });

    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
    });
    await repo.create(
      buildEnvelope({
        workflowId: "wf-bounded",
        featureSnapshot: { placeholder: true },
      }),
    );

    const oversizedSnapshot = {
      rounds: Array.from({ length: 25 }, (_, i) => ({
        round: i,
        debate: "y".repeat(5_000),
      })),
    };

    const reference = await writeFeatureSnapshotAsArtifact({
      registry,
      worktreePath: WORKTREE_DIR,
      workflowId: "wf-bounded",
      snapshot: oversizedSnapshot,
    });

    const updated = await repo.update("wf-bounded", {
      featureSnapshot: reference,
    });

    expect(updated.featureSnapshot).toEqual({
      kind: "artifact_reference",
      artifactId: "art-snapshot-bounded",
      relativePath: ".cc/workflow/wf-bounded/snapshot.json",
    });

    const inlinePayloadSize = JSON.stringify(updated).length;
    expect(inlinePayloadSize).toBeLessThan(1_000);

    const writtenContent = await readFile(
      path.join(WORKTREE_DIR, ".cc/workflow/wf-bounded/snapshot.json"),
      "utf-8",
    );
    expect(JSON.parse(writtenContent)).toEqual(oversizedSnapshot);
  });

  it("propagates ArtifactRequiredFailure when the underlying registry write fails", async () => {
    const registry = createArtifactRegistry({
      writeFile: async () => {
        throw new Error("disk full");
      },
      ensureDir: async () => undefined,
      now: () => "2026-04-28T10:00:00.000Z",
    });

    await expect(
      writeFeatureSnapshotAsArtifact({
        registry,
        worktreePath: WORKTREE_DIR,
        workflowId: "wf-fail",
        snapshot: { round: 1 },
      }),
    ).rejects.toThrow(/disk full/);
  });

  it("keeps the envelope payload bounded compared to inlining the same large snapshot", async () => {
    const registry = createArtifactRegistry({
      writeFile: async (absolute, contents) => {
        await writeFile(absolute, contents);
      },
      ensureDir: async (absolute) => {
        await mkdir(absolute, { recursive: true });
      },
      now: () => "2026-04-28T10:00:00.000Z",
      newId: () => "art-snapshot-compare",
    });

    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
    });
    const massiveSnapshot = {
      transcript: Array.from({ length: 100 }, (_, i) => ({
        round: i,
        body: "z".repeat(10_000),
      })),
    };

    const inlineEnvelope = await repo.create(
      buildEnvelope({
        workflowId: "wf-inline",
        featureSnapshot: massiveSnapshot,
      }),
    );
    const inlineSize = JSON.stringify(inlineEnvelope).length;

    const reference = await writeFeatureSnapshotAsArtifact({
      registry,
      worktreePath: WORKTREE_DIR,
      workflowId: "wf-fallback",
      snapshot: massiveSnapshot,
    });
    const fallbackEnvelope = await repo.create(
      buildEnvelope({
        workflowId: "wf-fallback",
        featureSnapshot: reference,
      }),
    );
    const fallbackSize = JSON.stringify(fallbackEnvelope).length;

    expect(inlineSize).toBeGreaterThan(900_000);
    expect(fallbackSize).toBeLessThan(1_000);
    expect(fallbackSize * 100).toBeLessThan(inlineSize);
  });
});
