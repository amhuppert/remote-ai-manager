import { describe, it, expect } from "vitest";
import type {
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  resolveContextCollaboration,
  resolveWorkflowCollaboration,
} from "./collaboration-cascade";

const GLOBAL: WorkflowCollaborationConfig = {
  secondAgent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

const WORKFLOW_FULL: WorkflowCollaborationConfigOverride = {
  secondAgent: {
    backend: "codex",
    model: "gpt-5.4",
    reasoningEffort: "medium",
  },
  negotiationRounds: 5,
  autonomousResolutionThreshold: "major",
};

describe("resolveContextCollaboration (whole-block, 3 layers)", () => {
  it("falls back to global when nothing overrides", () => {
    const result = resolveContextCollaboration(undefined, undefined, GLOBAL);
    expect(result.source).toBe("global");
    expect(result.value).toEqual(GLOBAL);
  });

  it("reports workflow source when only the workflow layer overrides", () => {
    const result = resolveContextCollaboration(
      undefined,
      WORKFLOW_FULL,
      GLOBAL,
    );
    expect(result.source).toBe("workflow");
    expect(result.value).toEqual(WORKFLOW_FULL);
  });

  it("reports context-override source when the context layer overrides", () => {
    const context: WorkflowCollaborationConfigOverride = {
      secondAgent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      negotiationRounds: 8,
      autonomousResolutionThreshold: "blocking",
    };
    const result = resolveContextCollaboration(context, WORKFLOW_FULL, GLOBAL);
    expect(result.source).toBe("context-override");
    expect(result.value).toEqual(context);
  });

  it("merges a partial workflow override field-by-field over global", () => {
    const result = resolveContextCollaboration(
      undefined,
      { negotiationRounds: 7 },
      GLOBAL,
    );
    expect(result.source).toBe("workflow");
    expect(result.value.negotiationRounds).toBe(7);
    expect(result.value.secondAgent).toEqual(GLOBAL.secondAgent);
    expect(result.value.autonomousResolutionThreshold).toBe("minor");
  });

  it("layers context over workflow over global per field", () => {
    const result = resolveContextCollaboration(
      { autonomousResolutionThreshold: "blocking" },
      { negotiationRounds: 7 },
      GLOBAL,
    );
    expect(result.source).toBe("context-override");
    expect(result.value.negotiationRounds).toBe(7); // from workflow
    expect(result.value.autonomousResolutionThreshold).toBe("blocking"); // from context
    expect(result.value.secondAgent).toEqual(GLOBAL.secondAgent); // from global
  });
});

describe("resolveWorkflowCollaboration (whole-block, 2 layers)", () => {
  it("falls back to global when the workflow layer does not override", () => {
    const result = resolveWorkflowCollaboration(undefined, GLOBAL);
    expect(result.source).toBe("global");
    expect(result.value).toEqual(GLOBAL);
  });

  it("reports an override at the workflow level as context-override", () => {
    const result = resolveWorkflowCollaboration(
      { negotiationRounds: 9 },
      GLOBAL,
    );
    expect(result.source).toBe("context-override");
    expect(result.value.negotiationRounds).toBe(9);
    expect(result.value.secondAgent).toEqual(GLOBAL.secondAgent);
    expect(result.value.autonomousResolutionThreshold).toBe("minor");
  });
});
