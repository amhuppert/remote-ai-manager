import { describe, expect, it } from "vitest";
import {
  collaborationFeatureSnapshotSchema,
  type CollaborationFeatureSnapshot,
} from "./feature-snapshot";

function buildUserSnapshotWithoutOrigin(): Record<string, unknown> {
  return {
    mode: "asymmetric",
    brief: "Should we adopt Postgres?",
    primaryAgentBackend: "claude",
    primaryBackend: "claude",
    secondaryBackend: "codex",
    negotiationRounds: 3,
    negotiationRoundsCompleted: 1,
    autonomousResolutionThreshold: "minor",
    userAnswersByQuestionId: {},
  };
}

function buildResolvedConfig(): Record<string, unknown> {
  return {
    secondAgent: {
      value: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "workflow" },
    autonomousResolutionThreshold: { value: "minor", source: "per-node" },
  };
}

function buildWorkflowSnapshot(): Record<string, unknown> {
  return {
    origin: "workflow",
    parentImplementerTurnId: "turn-7",
    executionContextId: "context-implement",
    conversationId: "conv-abc",
    resolvedConfig: buildResolvedConfig(),
  };
}

describe("collaborationFeatureSnapshotSchema", () => {
  it("parses a user-shaped snapshot that omits origin (defaults to user)", () => {
    const snapshot = buildUserSnapshotWithoutOrigin();
    const result = collaborationFeatureSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.origin).toBe("user");
  });

  it("parses a user-shaped snapshot that explicitly sets origin to user", () => {
    const snapshot = {
      ...buildUserSnapshotWithoutOrigin(),
      origin: "user",
    };
    const result = collaborationFeatureSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.origin).toBe("user");
  });

  it("preserves all fields on the user-shaped snapshot after round-trip", () => {
    const snapshot = buildUserSnapshotWithoutOrigin();
    const result = collaborationFeatureSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.data as Record<string, unknown>;
    expect(parsed["brief"]).toBe("Should we adopt Postgres?");
    expect(parsed["primaryAgentBackend"]).toBe("claude");
    expect(parsed["secondaryBackend"]).toBe("codex");
    expect(parsed["negotiationRounds"]).toBe(3);
    expect(parsed["negotiationRoundsCompleted"]).toBe(1);
    expect(parsed["autonomousResolutionThreshold"]).toBe("minor");
  });

  it("decodes the captured session context as a typed field on the user variant", () => {
    const sessionContext = {
      alignment: {
        version: 3,
        contentHash: "hash-3",
        text: "## Charter",
        snapshotPath: ".cc/session-alignment/snapshots/hash-3.md",
      },
      activeTicketBlock: "<active-ticket>\n</active-ticket>",
    };
    const result = collaborationFeatureSnapshotSchema.safeParse({
      ...buildUserSnapshotWithoutOrigin(),
      sessionContext,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.origin !== "user") return;
    expect(result.data.sessionContext).toEqual(sessionContext);
  });

  it("still decodes a user snapshot captured before session context existed", () => {
    const result = collaborationFeatureSnapshotSchema.safeParse(
      buildUserSnapshotWithoutOrigin(),
    );
    expect(result.success).toBe(true);
    if (!result.success || result.data.origin !== "user") return;
    expect(result.data.sessionContext).toBeUndefined();
  });

  it("rejects a user snapshot whose captured session context is malformed", () => {
    const result = collaborationFeatureSnapshotSchema.safeParse({
      ...buildUserSnapshotWithoutOrigin(),
      sessionContext: { alignment: { version: "three" } },
    });
    expect(result.success).toBe(false);
  });

  it("parses a workflow-shaped snapshot", () => {
    const snapshot = buildWorkflowSnapshot();
    const result = collaborationFeatureSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.origin).toBe("workflow");
    if (result.data.origin !== "workflow") return;
    expect(result.data.parentImplementerTurnId).toBe("turn-7");
    expect(result.data.executionContextId).toBe("context-implement");
    expect(result.data.conversationId).toBe("conv-abc");
    expect(result.data.resolvedConfig.negotiationRounds.value).toBe(3);
    expect(result.data.resolvedConfig.negotiationRounds.source).toBe(
      "workflow",
    );
    expect(
      result.data.resolvedConfig.autonomousResolutionThreshold.source,
    ).toBe("per-node");
    expect(result.data.resolvedConfig.secondAgent.value.backend).toBe("claude");
  });

  it("rejects a workflow-shaped snapshot missing parentImplementerTurnId", () => {
    const snapshot = buildWorkflowSnapshot();
    delete snapshot["parentImplementerTurnId"];
    const result = collaborationFeatureSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(",");
    expect(flat).toContain("parentImplementerTurnId");
  });

  it("rejects a workflow-shaped snapshot missing executionContextId", () => {
    const snapshot = buildWorkflowSnapshot();
    delete snapshot["executionContextId"];
    expect(collaborationFeatureSnapshotSchema.safeParse(snapshot).success).toBe(
      false,
    );
  });

  it("rejects a workflow-shaped snapshot missing conversationId", () => {
    const snapshot = buildWorkflowSnapshot();
    delete snapshot["conversationId"];
    expect(collaborationFeatureSnapshotSchema.safeParse(snapshot).success).toBe(
      false,
    );
  });

  it("rejects a workflow-shaped snapshot missing resolvedConfig", () => {
    const snapshot = buildWorkflowSnapshot();
    delete snapshot["resolvedConfig"];
    expect(collaborationFeatureSnapshotSchema.safeParse(snapshot).success).toBe(
      false,
    );
  });

  it("rejects a workflow-shaped snapshot whose resolvedConfig omits per-field provenance", () => {
    const snapshot = buildWorkflowSnapshot();
    (snapshot["resolvedConfig"] as Record<string, unknown>)[
      "negotiationRounds"
    ] = 3;
    expect(collaborationFeatureSnapshotSchema.safeParse(snapshot).success).toBe(
      false,
    );
  });

  it("rejects a workflow-shaped snapshot with an unknown provenance source", () => {
    const snapshot = buildWorkflowSnapshot();
    (
      (snapshot["resolvedConfig"] as Record<string, unknown>)[
        "negotiationRounds"
      ] as Record<string, unknown>
    )["source"] = "made-up-source";
    expect(collaborationFeatureSnapshotSchema.safeParse(snapshot).success).toBe(
      false,
    );
  });

  it("infers a discriminated union TS type usable in switch statements", () => {
    const workflowParsed = collaborationFeatureSnapshotSchema.parse(
      buildWorkflowSnapshot(),
    );
    const userParsed = collaborationFeatureSnapshotSchema.parse(
      buildUserSnapshotWithoutOrigin(),
    );
    const both: CollaborationFeatureSnapshot[] = [workflowParsed, userParsed];
    const seenOrigins: string[] = [];
    for (const snapshot of both) {
      switch (snapshot.origin) {
        case "user":
          seenOrigins.push("user");
          break;
        case "workflow":
          expect(snapshot.parentImplementerTurnId).toBe("turn-7");
          seenOrigins.push("workflow");
          break;
      }
    }
    expect(seenOrigins.sort()).toEqual(["user", "workflow"]);
  });
});
