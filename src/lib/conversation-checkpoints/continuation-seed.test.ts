import { describe, expect, it, vi } from "vitest";

import { CHECKPOINT_PAYLOAD_SCHEMA_VERSION } from "@/lib/conversation-checkpoints/schemas";
import type {
  CheckpointPayload,
  CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";

import {
  resolveContinuationSeed,
  type ContinuationSeedDeps,
} from "./continuation-seed";

const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/projects/alpha",
  sessionName: "csm-alpha",
  conversationId: "conv-1",
};

const SEED_TEXT = "<cc-checkpoint>\nobjective: ship\n</cc-checkpoint>";

function payloadFor(operationId: string): CheckpointPayload {
  return {
    id: operationId,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: { capturedThroughSeq: 3, sourceHash: "sha256:src" },
    artifactProvenance: null,
    versions: {
      generatorVersion: "gen-1",
      builderVersion: "builder-1",
      normalizerVersion: "norm-1",
    },
    modelSelection: { modelId: "claude-opus-5", parameters: {} },
    sections: { workingState: {}, recentDialogue: [], recoveryMap: {} },
    seedText: SEED_TEXT,
    seedSha256: "sha256:seed",
    sectionBytes: {
      total: Buffer.byteLength(SEED_TEXT, "utf8"),
      workingState: 1,
      recentDialogue: 1,
      recoveryFraming: 1,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}

const SYNTHETIC_FORK = {
  sourceConversationId: "source",
  messageIndex: 1,
  sourceBackend: "cursor" as const,
  sourceBackendRef: null,
  forkLocator: null,
  forkMode: "synthetic" as const,
  forkPending: false,
  syntheticSeed: "older fork history",
  syntheticSeedAcceptedRef: { backend: "cursor" as const, ref: "fork-ref" },
};

function makeDeps(
  overrides: Partial<ContinuationSeedDeps> & {
    payload?: CheckpointPayload | null;
    accepted?: boolean;
  } = {},
) {
  const readPayload = vi.fn(async () => overrides.payload ?? null);
  const readContinuity = vi.fn(async () => ({
    accepted: overrides.accepted ?? false,
  }));
  const deps: ContinuationSeedDeps = {
    readPayload,
    readContinuity,
    transcript: { readConversationMessages: async () => [] },
    log: createCapturingLogger(),
    ...overrides,
  };
  return { deps, readPayload, readContinuity };
}

const BASE = {
  key: KEY,
  sessionName: "csm-alpha",
  agentBackend: "cursor" as const,
  transcriptPath: "/transcripts/conv-1.jsonl",
};

describe("resolveContinuationSeed", () => {
  it("selects a ready checkpoint ahead of an older synthetic fork seed and carries the exact frozen payload", async () => {
    const payload = payloadFor("op-1");
    const { deps, readPayload } = makeDeps({ payload });
    const seed = await resolveContinuationSeed(deps, {
      ...BASE,
      checkpoint: { operationId: "op-1", phase: "ready" },
      backendRef: null,
      forkedFrom: SYNTHETIC_FORK,
    });
    expect(seed).toEqual({ kind: "checkpoint", operationId: "op-1", payload });
    expect(readPayload).toHaveBeenCalledWith(KEY, "op-1");
  });

  it("fails fast when a ready checkpoint has no frozen payload to deliver", async () => {
    const { deps } = makeDeps({ payload: null });
    await expect(
      resolveContinuationSeed(deps, {
        ...BASE,
        checkpoint: { operationId: "op-1", phase: "ready" },
        backendRef: null,
        forkedFrom: null,
      }),
    ).rejects.toThrow(/op-1/);
  });

  it("refuses a turn admitted under a checkpoint that is not ready", async () => {
    const { deps } = makeDeps({ payload: payloadFor("op-1") });
    await expect(
      resolveContinuationSeed(deps, {
        ...BASE,
        checkpoint: { operationId: "op-1", phase: "needs_reconciliation" },
        backendRef: null,
        forkedFrom: null,
      }),
    ).rejects.toThrow(/needs_reconciliation/);
  });

  it("resumes an accepted checkpoint continuation without the fork seed the checkpoint superseded", async () => {
    const { deps, readContinuity } = makeDeps({ accepted: true });
    const seed = await resolveContinuationSeed(deps, {
      ...BASE,
      checkpoint: null,
      backendRef: { backend: "cursor", ref: "accepted-ref" },
      forkedFrom: SYNTHETIC_FORK,
    });
    expect(seed).toEqual({ kind: "ordinary" });
    expect(readContinuity).toHaveBeenCalledWith(KEY);
  });

  it("keeps the synthetic fork seed for a conversation no checkpoint has superseded", async () => {
    const { deps } = makeDeps({ accepted: false });
    const seed = await resolveContinuationSeed(deps, {
      ...BASE,
      checkpoint: null,
      backendRef: { backend: "cursor", ref: "other-ref" },
      forkedFrom: SYNTHETIC_FORK,
    });
    expect(seed).toEqual({ kind: "fork", seed: "older fork history" });
  });

  it("makes no continuity read for an ordinary turn with nothing to seed", async () => {
    const { deps, readContinuity, readPayload } = makeDeps();
    const seed = await resolveContinuationSeed(deps, {
      ...BASE,
      checkpoint: null,
      backendRef: { backend: "claude", ref: "live" },
      forkedFrom: null,
    });
    expect(seed).toEqual({ kind: "ordinary" });
    expect(readContinuity).not.toHaveBeenCalled();
    expect(readPayload).not.toHaveBeenCalled();
  });

  it("never consults checkpoint state for an ephemeral lane", async () => {
    const { deps, readContinuity } = makeDeps({ accepted: true });
    const seed = await resolveContinuationSeed(deps, {
      ...BASE,
      key: null,
      checkpoint: null,
      backendRef: null,
      forkedFrom: SYNTHETIC_FORK,
    });
    expect(seed).toEqual({ kind: "fork", seed: "older fork history" });
    expect(readContinuity).not.toHaveBeenCalled();
  });
});
