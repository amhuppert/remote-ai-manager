import { describe, it, expect } from "vitest";
import {
  extractProposal,
  validateProposal,
  SPAWN_PROPOSAL_FENCE,
} from "./proposal-validator";

describe("validateProposal", () => {
  it("returns valid with the parsed proposal for a conforming candidate", () => {
    const result = validateProposal({
      sessions: [{ name: "a", agent: "claude", mode: "fast" }],
    });
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.proposal.sessions[0]!.target).toBe("main");
    }
  });

  it("returns invalid with issues when sessions is missing", () => {
    const result = validateProposal({});
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns invalid for an empty sessions array", () => {
    const result = validateProposal({ sessions: [] });
    expect(result.kind).toBe("invalid");
  });

  it("returns invalid for a bad agent", () => {
    const result = validateProposal({
      sessions: [{ name: "a", agent: "nope", mode: "fast" }],
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some((i) => i.includes("agent"))).toBe(true);
    }
  });

  it("returns invalid for a bad mode", () => {
    const result = validateProposal({
      sessions: [{ name: "a", agent: "claude", mode: "x" }],
    });
    expect(result.kind).toBe("invalid");
  });

  it("never throws on arbitrary input", () => {
    expect(() => validateProposal(undefined)).not.toThrow();
    expect(() => validateProposal(42)).not.toThrow();
    expect(() => validateProposal("garbage")).not.toThrow();
    expect(() => validateProposal([])).not.toThrow();
    expect(validateProposal(42).kind).toBe("invalid");
  });
});

describe("extractProposal", () => {
  it("returns an object candidate carrying a sessions key", () => {
    const candidate = { sessions: [{ name: "a" }] };
    expect(extractProposal(candidate)).toBe(candidate);
  });

  it("returns null for an object without a sessions key", () => {
    expect(extractProposal({ foo: "bar" })).toBeNull();
  });

  it("extracts a fenced spawn-proposal JSON block from text", () => {
    const text = [
      "Here is my plan.",
      "```" + SPAWN_PROPOSAL_FENCE,
      JSON.stringify({
        sessions: [{ name: "a", agent: "claude", mode: "fast" }],
      }),
      "```",
      "Let me know.",
    ].join("\n");
    const candidate = extractProposal(text);
    expect(candidate).not.toBeNull();
    const validation = validateProposal(candidate);
    expect(validation.kind).toBe("valid");
  });

  it("returns null for text with no proposal block", () => {
    expect(extractProposal("just some assistant prose")).toBeNull();
  });

  it("returns null for malformed JSON inside a proposal block", () => {
    const text = "```" + SPAWN_PROPOSAL_FENCE + "\n{ not json }\n```";
    expect(extractProposal(text)).toBeNull();
  });

  it("returns null for arbitrary non-proposal input and never throws", () => {
    expect(extractProposal(undefined)).toBeNull();
    expect(extractProposal(null)).toBeNull();
    expect(extractProposal(42)).toBeNull();
    expect(extractProposal([1, 2, 3])).toBeNull();
  });
});
