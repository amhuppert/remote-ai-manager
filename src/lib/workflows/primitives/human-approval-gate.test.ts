import { describe, expect, it } from "vitest";
import { gateResultSchema } from "./gate-vocabulary";
import {
  approveHumanApprovalGate,
  pauseForHumanApproval,
  rejectHumanApprovalGate,
} from "./human-approval-gate";

describe("pauseForHumanApproval", () => {
  it("returns a post-turn pause gate with the supplied resume token", () => {
    const gate = pauseForHumanApproval({
      resumeToken: "rt-approve-1",
      details: { stepName: "merge" },
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pause");
    if (gate.status === "pause") {
      expect(gate.kind).toBe("human_approval");
      expect(gate.pauseKind).toBe("post_turn");
      expect(gate.resumeToken).toBe("rt-approve-1");
      expect(gate.details).toMatchObject({ stepName: "merge" });
    }
  });

  it("omits details when not provided", () => {
    const gate = pauseForHumanApproval({ resumeToken: "rt-1" });
    if (gate.status === "pause") {
      expect("details" in gate).toBe(false);
    }
  });

  it("rejects an empty resume token", () => {
    expect(() => pauseForHumanApproval({ resumeToken: "" })).toThrow();
  });
});

describe("approveHumanApprovalGate", () => {
  it("returns a pass result", () => {
    const gate = approveHumanApprovalGate({ approver: "alex" });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("human_approval");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ approver: "alex" });
    }
  });

  it("omits details when not provided", () => {
    const gate = approveHumanApprovalGate();
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect("details" in gate).toBe(false);
    }
  });
});

describe("rejectHumanApprovalGate", () => {
  it("returns a fail result with the rejection reason", () => {
    const gate = rejectHumanApprovalGate("policy violation");
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.kind).toBe("human_approval");
      expect(gate.reason).toBe("policy violation");
    }
  });

  it("rejects an empty reason", () => {
    expect(() => rejectHumanApprovalGate("")).toThrow();
  });
});
