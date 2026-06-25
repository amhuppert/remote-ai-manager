import { describe, it, expect } from "vitest";
import { sessionCreationModeSchema } from "@/lib/sessions/schemas";
import {
  proposedSessionSchema,
  spawnAgentSchema,
  spawnModeSchema,
  spawnProposalSchema,
  spawnResultSchema,
} from "./schemas";

describe("proposedSessionSchema", () => {
  it("parses a conforming session and defaults target to 'main'", () => {
    const result = proposedSessionSchema.safeParse({
      name: "Add login",
      agent: "claude",
      mode: "fast",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target).toBe("main");
      expect(result.data.initialPrompt).toBeUndefined();
    }
  });

  it("does not carry a branch — CC derives it from the name", () => {
    const result = proposedSessionSchema.safeParse({
      name: "Add login",
      agent: "claude",
      mode: "fast",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("branch" in result.data).toBe(false);
    }
  });

  it("keeps an explicit target and optional initialPrompt", () => {
    const result = proposedSessionSchema.safeParse({
      name: "Add login",
      target: "develop",
      agent: "dual",
      mode: "focus",
      initialPrompt: "Implement the login form",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target).toBe("develop");
      expect(result.data.initialPrompt).toBe("Implement the login form");
    }
  });

  it("rejects an out-of-range agent", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "gpt",
      mode: "fast",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range mode", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "turbo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty initialPrompt after trim", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "fast",
      initialPrompt: "   ",
    });
    expect(result.success).toBe(false);
  });
});

describe("spawnProposalSchema", () => {
  it("requires at least one proposed session", () => {
    const result = spawnProposalSchema.safeParse({ sessions: [] });
    expect(result.success).toBe(false);
  });

  it("parses a multi-session proposal", () => {
    const result = spawnProposalSchema.safeParse({
      sessions: [
        { name: "a", agent: "claude", mode: "fast" },
        { name: "b", agent: "codex", mode: "optimistic" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessions).toHaveLength(2);
    }
  });

  it("rejects more than 20 proposed sessions", () => {
    const sessions = Array.from({ length: 21 }, (_, i) => ({
      name: `s${i}`,
      agent: "claude" as const,
      mode: "fast" as const,
    }));
    const result = spawnProposalSchema.safeParse({ sessions });
    expect(result.success).toBe(false);
  });
});

describe("spawnResultSchema", () => {
  it("parses a created/failed result", () => {
    const result = spawnResultSchema.safeParse({
      created: [
        {
          name: "a",
          sessionName: "a",
          branchName: "feat/a",
          initialPromptDispatched: true,
        },
      ],
      failed: [{ name: "b", error: "duplicate name" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("spawn-mode sync guard", () => {
  // The spawn mode enum deliberately duplicates the session creation modes
  // (so the wire shape does not import the discriminated request schema). This
  // guard fails CI if the two enums drift — added, removed, or reordered modes.
  it("spawnModeSchema members exactly match sessionCreationModeSchema", () => {
    expect(spawnModeSchema.options).toEqual(sessionCreationModeSchema.options);
  });

  it("spawnAgentSchema covers claude, codex, and dual", () => {
    expect(spawnAgentSchema.options).toEqual(["claude", "codex", "dual"]);
  });
});
