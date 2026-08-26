import { describe, it, expect } from "vitest";
import { sessionCreationModeSchema } from "@/lib/sessions/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
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

  it("keeps an optional complete model selection when provided", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "codex",
      mode: "normal",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelSelection).toEqual({
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      });
    }
  });

  it("leaves modelSelection undefined when omitted", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "normal",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelSelection).toBeUndefined();
    }
  });

  it("rejects the split legacy fields", () => {
    const result = proposedSessionSchema.safeParse({
      name: "x",
      agent: "claude",
      mode: "normal",
      model: "opus",
      reasoningEffort: "high",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["effort", "high"],
    ["reasoning", "high"],
    ["fast", "true"],
    ["context", "max"],
    ["thinking", "enabled"],
  ])(
    "rejects a top-level %s model parameter instead of silently dropping it",
    (field, value) => {
      const result = proposedSessionSchema.safeParse({
        name: "x",
        agent: "cursor",
        mode: "normal",
        [field]: value,
      });

      expect(result.success).toBe(false);
    },
  );
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

  it("rejects model controls outside the proposed session", () => {
    const result = spawnProposalSchema.safeParse({
      sessions: [{ name: "a", agent: "cursor", mode: "normal" }],
      thinking: "enabled",
    });

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

  // Derived from the canonical backend enum plus `dual`, so registering a
  // backend extends the spawn surface instead of silently leaving it unnamed.
  it("spawnAgentSchema covers every registered backend plus dual", () => {
    expect(spawnAgentSchema.options).toEqual([
      ...agentBackendSchema.options,
      "dual",
    ]);
  });
});
