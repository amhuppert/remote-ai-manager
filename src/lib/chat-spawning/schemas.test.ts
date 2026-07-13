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
      mode: "normal",
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
      mode: "normal",
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
      mode: "normal",
      initialPrompt: "Implement the login form",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target).toBe("develop");
      expect(result.data.initialPrompt).toBe("Implement the login form");
    }
  });

  it("keeps ordered images with their initial prompt", () => {
    const result = proposedSessionSchema.safeParse({
      name: "Add login",
      agent: "claude",
      mode: "normal",
      initialPrompt: "Use the screenshot as the reference",
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "two",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images?.map((image) => image.attachmentId)).toEqual([
        "first",
        "second",
      ]);
    }
  });

  it("accepts images as the complete initial turn", () => {
    const result = proposedSessionSchema.safeParse({
      name: "Add login",
      agent: "claude",
      mode: "normal",
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.initialPrompt).toBeUndefined();
      expect(result.data.images).toHaveLength(1);
    }
  });

  it("rejects an out-of-range agent", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "gpt",
      mode: "normal",
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

  it("rejects the removed legacy modes (fast, focus)", () => {
    for (const mode of ["fast", "focus"]) {
      const result = proposedSessionSchema.safeParse({
        name: "x",
        agent: "claude",
        mode,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an empty initialPrompt after trim", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "normal",
      initialPrompt: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("keeps an optional model and reasoningEffort when provided", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "codex",
      mode: "normal",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("gpt-5.4");
      expect(result.data.reasoningEffort).toBe("high");
    }
  });

  it("leaves model and reasoningEffort undefined when omitted", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "normal",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBeUndefined();
      expect(result.data.reasoningEffort).toBeUndefined();
    }
  });

  it("rejects a reasoningEffort outside the effort-level union", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "normal",
      reasoningEffort: "turbo",
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
        { name: "a", agent: "claude", mode: "normal" },
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
      mode: "normal" as const,
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
          initialPromptQueued: true,
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
